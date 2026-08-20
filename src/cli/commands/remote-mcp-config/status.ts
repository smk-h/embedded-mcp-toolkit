/**
 * @file src/cli/commands/remote-mcp-config/status.ts
 * @brief C3. 状态判定与 bridge 构造
 *
 * 构造本次的 SSH 桥接 server 对象、比较现有 server 与桥接定义是否一致、
 * 读取单个落点的状态（三态 + error）、判断落点是否已配置 embedded-board。
 */

import { type SFTPWrapper } from "ssh2";

import {
  type BridgeServer,
  type TargetFile,
  type StatusResult,
  SERVER_KEY,
  SSH_KEY_PATH,
} from "./types.js";
import { sftpReadText } from "./sftp.js";
import { getAtPath, getValueAtPath } from "./json-mutate.js";

// ============================================================
// C3. 状态判定与 bridge 构造
// ============================================================

/**
 * @brief 构造本次的 SSH 桥接 server 对象（逻辑定义，与客户端写法无关）
 * @details server 的 command 固定为 ssh，args 为专用密钥 + <user>@<ip> + bat 路径。
 *          具体写入文件的形态（command+args 分体 / command 数组、type/enabled）由
 *          TargetFile.serverStyle / serverType 决定，见 renderServerObject。
 * @param sshUser   Windows ssh 用户名（来自 collectConnectionInfo）
 * @param primaryIp Windows 主 IP（来自 collectConnectionInfo）
 * @param batPath   remote-start-mcp.bat 绝对路径（正斜杠）
 * @returns 桥接 server 对象
 */
export function buildBridgeServer(
  sshUser: string,
  primaryIp: string,
  batPath: string
): BridgeServer {
  return {
    command: "ssh",
    args: ["-i", SSH_KEY_PATH, `${sshUser}@${primaryIp}`, batPath],
  };
}

/**
 * @brief 按落点渲染桥接 server 对象（写入目标文件的实际形态）
 * @details 收敛各客户端的写法差异：
 *          - claude（split，无 serverType）：{ command, args } 分体
 *          - zcode（split，serverType:"stdio"）：分体 + type:"stdio" / enabled:true
 *          - opencode（array）：command 为数组（合并 command+args），
 *            type:"local" / enabled:true / timeout:600000
 * @param file   落点描述符（serverStyle / serverType 决定形态）
 * @param bridge 逻辑桥接定义
 * @returns 写入目标文件的 server 对象
 */
export function renderServerObject(
  file: TargetFile,
  bridge: BridgeServer
): Record<string, unknown> {
  if (file.serverStyle === "array") {
    // opencode 风格：command 为数组，type:"local"，enabled:true，timeout
    return {
      type: "local",
      command: [bridge.command, ...bridge.args],
      enabled: true,
      timeout: 600000,
    };
  }
  // claude/zcode 风格：command + args 分体
  const server: Record<string, unknown> = {
    command: bridge.command,
    args: bridge.args,
  };
  if (file.serverType) {
    server.type = file.serverType;
    server.enabled = true;
  }
  return server;
}

/**
 * @brief 比较现有 server 与桥接定义是否一致
 * @details 一致性基准仅看 command（+args）：
 *          - split 风格（claude/zcode）：command 必须为 "ssh"，且 args 与桥接定义完全相等
 *          - array 风格（opencode）：command 必须为数组，且等于 [command, ...args] 逐项相等
 *          type/enabled 是开关，不影响桥接定义，不参与比较。
 * @param existing 现有 server 对象
 * @param bridge   本次桥接定义
 * @param file     落点描述符（serverStyle 决定比较形态）
 * @returns "consistent" | "inconsistent"
 */
export function compareServer(
  existing: Record<string, unknown>,
  bridge: BridgeServer,
  file: TargetFile
): "consistent" | "inconsistent" {
  // array 风格（opencode）：command 为合并后的数组
  if (file.serverStyle === "array") {
    if (!Array.isArray(existing.command)) {
      return "inconsistent";
    }
    const expected = [bridge.command, ...bridge.args];
    const actual = existing.command as unknown[];
    if (actual.length !== expected.length) {
      return "inconsistent";
    }
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        return "inconsistent";
      }
    }
    return "consistent";
  }

  // split 风格（claude/zcode）：command 为 "ssh"，args 为分体数组
  const existingCommand = existing.command;
  const existingArgs = existing.args;
  // command 必须为字符串 "ssh"
  if (
    typeof existingCommand !== "string" ||
    existingCommand !== bridge.command
  ) {
    return "inconsistent";
  }
  // args 必须为字符串数组，且与桥接定义逐项相等
  if (!Array.isArray(existingArgs)) {
    return "inconsistent";
  }
  if (existingArgs.length !== bridge.args.length) {
    return "inconsistent";
  }
  for (let i = 0; i < bridge.args.length; i++) {
    if (existingArgs[i] !== bridge.args[i]) {
      return "inconsistent";
    }
  }
  return "consistent";
}

/**
 * @brief 读取单个 TargetFile 的状态（三态 + error）
 * @details 通过 SFTP 读取目标文件，本地 JSON 解析后判断 embedded-board 的状态：
 *          - absent       ：文件不存在，或无 serverPath，或 serverPath 容器中无该 key
 *          - consistent   ：存在该 key 且 command/args 与桥接定义一致
 *          - inconsistent ：存在该 key 但 command/args 不一致
 *          - error        ：文件存在但 JSON 解析失败
 *          对仅含使能数组（无 serverPath）的文件，按"数组是否含 enableValue"判定 absent。
 * @param sftp  已打开的 SFTP 会话句柄
 * @param file  落点描述符
 * @param bridge 本次桥接定义
 * @returns 状态读取结果
 */
export async function readStatus(
  sftp: SFTPWrapper,
  file: TargetFile,
  bridge: BridgeServer
): Promise<StatusResult> {
  // 仅含使能数组（Claude 项目 settings.local.json）：按数组是否含 enableValue 判定
  if (file.serverPath.length === 0) {
    const info = await sftpReadText(sftp, file.remotePath);
    if (!info.exists) {
      return { status: "absent", detail: "文件不存在" };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(info.content ?? "{}") as Record<string, unknown>;
    } catch {
      return { status: "error", detail: "JSON 解析失败" };
    }
    if (file.enableArrayPath && file.enableValue) {
      const arr = getValueAtPath(json, file.enableArrayPath);
      if (Array.isArray(arr) && arr.includes(file.enableValue)) {
        return {
          status: "consistent",
          detail: `已使能（在 ${file.enableArrayPath.join(".")} 中）`,
        };
      }
    }
    return { status: "absent", detail: "未使能" };
  }

  // 含 server 定义的文件
  const info = await sftpReadText(sftp, file.remotePath);
  if (!info.exists) {
    return { status: "absent", detail: "文件不存在" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(info.content ?? "{}") as Record<string, unknown>;
  } catch {
    return { status: "error", detail: "JSON 解析失败" };
  }

  const container = getAtPath(json, file.serverPath);
  if (!container || !(SERVER_KEY in container)) {
    return { status: "absent", detail: "未配置 embedded-board" };
  }

  const existing = container[SERVER_KEY] as Record<string, unknown>;
  const result = compareServer(existing, bridge, file);
  if (result === "consistent") {
    return {
      status: "consistent",
      detail: "已配置且一致",
      existing,
    };
  }
  return {
    status: "inconsistent",
    detail: "已配置但 command/args 与当前桥接定义不一致（将覆盖更新）",
    existing,
  };
}

/**
 * @brief 判断目标落点是否已配置 embedded-board（仅存在性，不做一致性比对）
 * @details 删除场景只关心"是否已配置、能否删除"，不需要也不应该做桥接定义比对
 *          （比对是配置操作的语义，删除时展示"不一致/将覆盖更新"会误导用户）。
 *          判定规则：
 *          - 含 serverPath 的文件：server 容器中存在该 key 即"已配置"
 *          - 仅含使能数组的文件：数组中含 enableValue 即"已配置"
 *          - 文件不存在或 JSON 解析失败：视为未配置
 * @param sftp 已打开的 SFTP 会话句柄
 * @param file 落点描述符
 * @returns true=已配置可删除；false=未配置
 */
export async function checkExists(
  sftp: SFTPWrapper,
  file: TargetFile
): Promise<boolean> {
  const info = await sftpReadText(sftp, file.remotePath);
  if (!info.exists) return false;

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(info.content ?? "{}") as Record<string, unknown>;
  } catch {
    return false;
  }

  // 含 server 定义的文件：server 容器中是否有该 key
  if (file.serverPath.length > 0) {
    const container = getAtPath(json, file.serverPath);
    return !!container && SERVER_KEY in container;
  }

  // 仅含使能数组的文件：数组中是否含 enableValue
  if (file.enableArrayPath && file.enableValue) {
    const arr = getValueAtPath(json, file.enableArrayPath);
    return Array.isArray(arr) && arr.includes(file.enableValue);
  }

  return false;
}
