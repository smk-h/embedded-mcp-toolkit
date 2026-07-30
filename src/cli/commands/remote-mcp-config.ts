/**
 * @file src/cli/commands/remote-mcp-config.ts
 * @brief embedded-mcp-toolkit remote-mcp-config 命令
 *
 * 交互式引导完成"在远程 Linux 服务器上配置 claude/zcode 的 MCP 桥接"。
 * 与 sshd-config 命令（ch14 之前，配 Windows 免密登录）形成对偶：
 *   - sshd-config        ：Windows 当 SSH 服务器，让 Linux 免密登录进来
 *   - remote-mcp-config  ：Windows 当 SSH 客户端，登录 Linux 后在其上写 MCP 配置
 *
 * 命令本质是"Windows 通过 SSH/SFTP 登录 Linux，读写 Linux 上几个 JSON 文件"。Linux 端
 * 不需安装 node、不需本工具包、不需设备配置——MCP 本体始终由 Windows 的
 * remote-start-mcp.bat 启动，Linux 只配一个 SSH 桥接 server（ssh -i ... <user>@<ip> <bat>）。
 *
 * 三类落点（固定 server key 名 "embedded-board"）：
 *   - Claude 全局 ：Linux ~/.claude.json 顶层 mcpServers
 *   - Claude 项目 ：Linux <proj>/.mcp.json（mcpServers）+ .claude/settings.local.json（enabledMcpjsonServers）
 *   - ZCode  项目 ：Linux <proj>/.zcode/config.json（mcp.servers，含 type/enabled）
 *   （ZCode 全局本期不做）
 *
 * 所有文件读写通过 SFTP 完成（整文件下载→本地 JSON 按字段改写→整文件上传），
 * 不通过 shell exec 改文件，规避 JSON 引号转义与远端编码问题。
 */

import { Client, type SFTPWrapper } from "ssh2";
import { select, isCancel, log, text, password, confirm } from "@clack/prompts";

import {
  parseServerAddress,
  sshConnect,
  sshExec,
  sshDisconnect,
  type LinuxServerInfo,
} from "../shared/ssh.js";
import {
  clearScreen,
  pauseForMenu,
  collectConnectionInfo,
} from "../shared/cli-helpers.js";

// ============================================================
// 类型与常量
// ============================================================

/**
 * @brief remote-mcp-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。本期无命令行选项。
 */
export type RemoteMcpConfigOptions = Record<string, never>;

/** @brief MCP server 固定 key 名（与 sshd-config 模板、项目 .mcp.json 一致） */
const SERVER_KEY = "embedded-board";

/** @brief SSH 专用密钥名（与 sshd-config 生成的密钥一致） */
const SSH_KEY_PATH = "~/.ssh/id_mcp_server";

/** @brief 菜单选项：配置 MCP */
const MENU_CONFIGURE = "1";
/** @brief 菜单选项：查看远端当前 MCP 配置状态（只读诊断） */
const MENU_CHECK = "2";
/** @brief 菜单选项：删除已配置的 MCP */
const MENU_REMOVE = "3";
/** @brief 菜单选项：退出 */
const MENU_EXIT = "0";

/** @brief 主菜单可选 value 联合类型（供 clack select 泛型约束，switch 分支穷举） */
type MenuChoice =
  | typeof MENU_CONFIGURE
  | typeof MENU_CHECK
  | typeof MENU_REMOVE
  | typeof MENU_EXIT;

/** @brief 客户端类型 */
type McpClient = "claude" | "zcode";

/** @brief Claude 配置范围 */
type ClaudeScope = "global" | "project";

/**
 * @brief SSH 桥接 server 对象（写入目标文件的 server 定义）
 * @details zcode 落点额外带 type:"stdio" / enabled:true（通过扩展字段表达）
 */
interface BridgeServer {
  command: string;
  args: string[];
  type?: string;
  enabled?: boolean;
}

/**
 * @brief 配置落点描述符（配置驱动，核心抽象）
 * @details 一个 TargetFile 完整描述"在远端哪个文件、哪个 JSON 路径下、如何读写
 *          embedded-board"。三类落点的所有差异都收敛为该结构的不同字段取值，
 *          读写逻辑对三落点完全通用。
 * @param remotePath       远端绝对路径
 * @param label            用户可见的落点描述（如 "Claude 全局"）
 * @param serverPath       server 容器的 JSON 路径（claude:["mcpServers"]，zcode:["mcp","servers"]）；
 *                         无 server 定义时留空（仅做使能数组操作的文件）
 * @param withTypeEnabled  server 对象是否带 type:"stdio"/enabled:true（仅 zcode:true）
 * @param enableArrayPath  使能数组的 JSON 路径（仅 claude 项目 settings.local.json）
 * @param enableValue      使能数组中追加/移除的值（"embedded-board"）
 */
interface TargetFile {
  remotePath: string;
  label: string;
  serverPath: string[];
  withTypeEnabled: boolean;
  enableArrayPath?: string[];
  enableValue?: string;
}

/**
 * @brief 一个配置目标（对应一次用户选择的 client + scope/路径）
 * @param client 客户端类型
 * @param files  1~2 个落点文件（claude 项目 = 2 个，其余 = 1 个）
 */
interface Target {
  client: McpClient;
  files: TargetFile[];
}

/** @brief 状态判定结果 */
type ServerStatus = "absent" | "consistent" | "inconsistent" | "error";

/**
 * @brief 单个落点的状态读取结果
 * @param status    状态枚举
 * @param detail    给用户看的状态说明
 * @param existing  现有 server 对象（展示用；absent/error 时为 undefined）
 */
interface StatusResult {
  status: ServerStatus;
  detail: string;
  existing?: Record<string, unknown>;
}

// ============================================================
// C1. SFTP 文件操作（远端整文件读写）
// ============================================================

/**
 * @brief 打开一个 SFTP 会话（复用单一句柄）
 * @details 一次配置操作涉及多次 SFTP 读写，若每次都 client.sftp() 新开 channel 会
 *          叠加打开大量 channel，触发远端 sshd 的会话/通道限制（表现为
 *          "Channel open failure: open failed"）。本函数在登录后开一个会话贯穿整个
 *          菜单循环，所有文件操作复用此句柄。
 * @param client 已连接的 ssh2 Client
 * @returns SFTPWrapper 句柄
 * @throws 打开 SFTP 会话失败时抛出
 */
function openSftpSession(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

/**
 * @brief 关闭 SFTP 会话
 * @details 释放句柄，忽略关闭异常（连接即将断开）。
 * @param sftp SFTPWrapper 句柄
 */
function closeSftpSession(sftp: SFTPWrapper): void {
  try {
    sftp.end();
  } catch {
    // 忽略关闭异常
  }
}

/**
 * @brief 读取远端文本文件
 * @details 先用 stat 探测文件是否存在（不存在返回 {exists:false}，不视为错误）；
 *          存在则用 readFile 读取全文为 UTF-8 字符串。
 * @param sftp      已打开的 SFTP 会话句柄
 * @param remotePath 远端文件绝对路径
 * @returns 读取结果；exists=false 表示文件不存在
 * @throws 读取失败时抛出（存在性探测本身不抛）
 */
function sftpReadText(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ exists: boolean; content?: string }> {
  return new Promise((resolve, reject) => {
    // 先探测存在性：stat 失败（ENOENT 等）视为不存在
    sftp.stat(remotePath, (statErr) => {
      if (statErr) {
        resolve({ exists: false });
        return;
      }
      // 存在则读取全文（readFile 回调返回 Buffer）
      sftp.readFile(remotePath, (readErr, data) => {
        if (readErr) return reject(readErr);
        resolve({ exists: true, content: data.toString("utf8") });
      });
    });
  });
}

/**
 * @brief 递归创建远端目录（mkdir -p）
 * @details SFTP 的 mkdir 不递归，需逐级 stat 检查 + mkdir。
 *          已存在的目录跳过，不视为错误。
 * @param sftp    已打开的 SFTP 会话句柄
 * @param dirPath 远端目录绝对路径
 * @throws 创建失败时抛出
 */
function sftpEnsureDir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 拆分路径逐级创建（绝对路径以 / 开头，首段为空字符串跳过）
    const segments = dirPath.split("/").filter((s) => s.length > 0);
    let current = "";

    /**
     * @brief 递归处理下一级目录
     */
    function next(): void {
      if (segments.length === 0) {
        resolve();
        return;
      }
      current += "/" + segments.shift();
      sftp.stat(current, (statErr) => {
        if (!statErr) {
          // 已存在，继续下一级
          next();
          return;
        }
        // 不存在则创建
        sftp.mkdir(current, (mkdirErr) => {
          if (mkdirErr) return reject(mkdirErr);
          next();
        });
      });
    }

    next();
  });
}

/**
 * @brief 写入远端文本文件
 * @details 先确保父目录存在（递归创建），再 writeFile 写入 UTF-8 文本。
 * @param sftp       已打开的 SFTP 会话句柄
 * @param remotePath 远端目标文件绝对路径
 * @param content    要写入的文本内容
 * @throws 写入失败时抛出
 */
async function sftpWriteText(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  // 确保父目录存在（SFTP 不会自动建目录）
  const dirPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
  if (dirPath) {
    await sftpEnsureDir(sftp, dirPath);
  }

  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(remotePath, content, "utf8", (writeErr) => {
      if (writeErr) return reject(writeErr);
      resolve();
    });
  });
}

/**
 * @brief 备份远端文件为 <path>.bak
 * @details 原文件存在则读取内容写到 .bak；.bak 已存在则跳过（保留首次备份）。
 *          原文件不存在时返回 false（无需备份）。
 * @param sftp       已打开的 SFTP 会话句柄
 * @param remotePath 远端文件绝对路径
 * @returns true=产生了新备份；false=原文件不存在或 .bak 已存在
 * @throws 备份失败时抛出
 */
async function sftpBackup(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<boolean> {
  const bakPath = remotePath + ".bak";

  // 检查 .bak 是否已存在（已存在则保留首次备份，跳过）
  const bakInfo = await sftpReadText(sftp, bakPath);
  if (bakInfo.exists) {
    return false;
  }

  // 检查原文件是否存在
  const srcInfo = await sftpReadText(sftp, remotePath);
  if (!srcInfo.exists) {
    return false;
  }

  // 写备份
  await sftpWriteText(sftp, bakPath, srcInfo.content ?? "");
  return true;
}

// ============================================================
// C2. JSON 按 path 操作（纯函数，操作本地内存中的 JSON 对象）
// ============================================================

/**
 * @brief 按 path 取嵌套对象
 * @details 沿 path 逐层取键；任一层缺失或非对象则返回 null。
 * @param obj  根对象
 * @param path JSON 路径（如 ["mcp","servers"]）
 * @returns path 指向的对象；不存在返回 null
 */
function getAtPath(
  obj: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  let current: unknown = obj;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (
    current === null ||
    current === undefined ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return null;
  }
  return current as Record<string, unknown>;
}

/**
 * @brief 按 path 取任意类型值（不排斥数组）
 * @details 与 getAtPath 的区别：本函数用于取"使能数组"这类叶子值，末层若是数组也
 *          原样返回（getAtPath 会把数组当无效对象返回 null）。中间层仍要求为普通
 *          对象（数组不能作为中间容器）。
 * @param obj  根对象
 * @param path JSON 路径（如 ["enabledMcpjsonServers"]）
 * @returns path 指向的值；中间层缺失或非对象返回 null
 */
function getValueAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  // 中间层（path[0..n-2]）必须为普通对象
  for (let i = 0; i < path.length - 1; i++) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[path[i]];
  }
  if (
    current === null ||
    current === undefined ||
    typeof current !== "object"
  ) {
    return null;
  }
  // 末层：取值（可为任意类型，含数组）
  return (current as Record<string, unknown>)[path[path.length - 1]];
}

/**
 * @brief 在 path 指向的容器中设置 server（保留同容器其它 key）
 * @details 沿 path 逐层取/建对象（缺失则创建空对象），最后设置 container[key]=server。
 * @param obj    根对象（会被原地修改）
 * @param path   server 容器的 JSON 路径
 * @param key    server key 名
 * @param server server 对象
 */
function setServerAtPath(
  obj: Record<string, unknown>,
  path: string[],
  key: string,
  server: object
): void {
  let current: Record<string, unknown> = obj;
  for (const segment of path) {
    let next = current[segment];
    // 缺失或非对象则创建/重建为空对象
    if (
      next === null ||
      next === undefined ||
      typeof next !== "object" ||
      Array.isArray(next)
    ) {
      next = {};
      current[segment] = next;
    }
    current = next as Record<string, unknown>;
  }
  current[key] = server;
}

/**
 * @brief 从 path 指向的容器中删除 server key
 * @param obj  根对象
 * @param path server 容器的 JSON 路径
 * @param key  server key 名
 * @returns 是否实际删除（容器存在且含 key 返回 true）
 */
function removeServerAtPath(
  obj: Record<string, unknown>,
  path: string[],
  key: string
): boolean {
  const container = getAtPath(obj, path);
  if (!container) return false;
  if (!(key in container)) return false;
  delete container[key];
  return true;
}

/**
 * @brief 使能数组去重追加
 * @param arr   使能数组
 * @param value 要追加的值
 * @returns 是否新增（已存在返回 false）
 */
function ensureInArray(arr: unknown[], value: string): boolean {
  if (arr.includes(value)) return false;
  arr.push(value);
  return true;
}

/**
 * @brief 使能数组移除
 * @param arr   使能数组
 * @param value 要移除的值
 * @returns 是否实际移除
 */
function removeFromArray(arr: unknown[], value: string): boolean {
  const idx = arr.indexOf(value);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}

// ============================================================
// C3. 状态判定与 bridge 构造
// ============================================================

/**
 * @brief 构造本次的 SSH 桥接 server 对象
 * @details server 的 command 固定为 ssh，args 为专用密钥 + <user>@<ip> + bat 路径。
 *          zcode 落点额外带 type:"stdio" / enabled:true。
 * @param withTypeEnabled 是否带 type/enabled（zcode:true）
 * @param sshUser         Windows ssh 用户名（来自 collectConnectionInfo）
 * @param primaryIp       Windows 主 IP（来自 collectConnectionInfo）
 * @param batPath         remote-start-mcp.bat 绝对路径（正斜杠）
 * @returns 桥接 server 对象
 */
function buildBridgeServer(
  withTypeEnabled: boolean,
  sshUser: string,
  primaryIp: string,
  batPath: string
): BridgeServer {
  const server: BridgeServer = {
    command: "ssh",
    args: ["-i", SSH_KEY_PATH, `${sshUser}@${primaryIp}`, batPath],
  };
  if (withTypeEnabled) {
    server.type = "stdio";
    server.enabled = true;
  }
  return server;
}

/**
 * @brief 比较现有 server 与桥接定义是否一致
 * @details 一致性基准仅看 command + args（F8）：command 必须为 "ssh"，且 args 与桥接定义
 *          完全相等。type/enabled 是开关，不影响桥接定义，不参与比较。
 * @param existing 现有 server 对象
 * @param bridge   本次桥接定义
 * @returns "consistent" | "inconsistent"
 */
function compareServer(
  existing: Record<string, unknown>,
  bridge: BridgeServer
): "consistent" | "inconsistent" {
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
async function readStatus(
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
  const result = compareServer(existing, bridge);
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
async function checkExists(
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

// ============================================================
// C4-前半. 落点描述符与 askTarget（落点路由）
// ============================================================

/**
 * @brief 获取远端家目录绝对路径（展开 ~）
 * @details SFTP 不识别 ~，需先通过 ssh exec 取远端 $HOME。结果去空白。
 * @param client 已连接的 ssh2 Client
 * @returns 远端家目录绝对路径
 * @throws 获取失败时抛出
 */
async function getRemoteHome(client: Client): Promise<string> {
  const home = await sshExec(client, "echo $HOME");
  return home.replace(/\s+/g, "");
}

/**
 * @brief 拼接远端项目绝对路径（规范化分隔符）
 * @details 用户输入的项目路径可能带尾斜杠，远端统一用 / 分隔。本项目路径与子文件
 *          相对路径拼接为绝对路径。
 * @param projectPath 项目绝对路径（用户输入）
 * @param relSub      项目内相对子路径（如 ".mcp.json"）
 * @returns 远端绝对路径
 */
function joinRemotePath(projectPath: string, relSub: string): string {
  const base = projectPath.replace(/\/+$/, "");
  return `${base}/${relSub}`;
}

/**
 * @brief 交互式选择客户端类型与配置范围，组装配置目标
 * @details 落点路由（F3）：
 *          - claude → select(全局/项目)；项目则 text(项目绝对路径)
 *          - zcode  → 直接 text(项目绝对路径)（本期 zcode 仅项目级）
 *          按选择组装 Target：
 *            Claude 全局  → 1 文件：~/.claude.json（serverPath:["mcpServers"]）
 *            Claude 项目  → 2 文件：.mcp.json（serverPath）+ settings.local.json（enableArray）
 *            ZCode  项目  → 1 文件：.zcode/config.json（serverPath:["mcp","servers"]，withTypeEnabled）
 * @param client     已连接的 ssh2 Client（用于展开 ~）
 * @returns 配置目标；用户取消返回 null
 * @throws 获取远端家目录失败时抛出
 */
async function askTarget(client: Client): Promise<Target | null> {
  // 1. 选择客户端
  const clientChoice = await select<McpClient>({
    message: "选择客户端类型",
    options: [
      { value: "claude", label: "Claude Code" },
      { value: "zcode", label: "ZCode" },
    ],
  });
  if (isCancel(clientChoice)) {
    log.message("    已取消");
    return null;
  }

  // 2. 按客户端类型确定范围与路径
  if (clientChoice === "zcode") {
    // zcode：直接项目级
    const projRaw = await text({
      message: "项目绝对路径（远端 Linux）",
      placeholder: "如 /home/sumu/my-project",
    });
    if (isCancel(projRaw)) {
      log.message("    已取消");
      return null;
    }
    const projectPath = projRaw.trim();
    if (!projectPath) {
      log.message("    项目路径为空");
      return null;
    }
    return {
      client: "zcode",
      files: [
        {
          remotePath: joinRemotePath(projectPath, ".zcode/config.json"),
          label: "ZCode 项目",
          serverPath: ["mcp", "servers"],
          withTypeEnabled: true,
        },
      ],
    };
  }

  // claude：选择全局/项目
  const scopeChoice = await select<ClaudeScope>({
    message: "选择配置范围",
    options: [
      { value: "global", label: "全局（~/.claude.json，所有项目可用）" },
      { value: "project", label: "项目（指定项目路径）" },
    ],
  });
  if (isCancel(scopeChoice)) {
    log.message("    已取消");
    return null;
  }

  if (scopeChoice === "global") {
    const home = await getRemoteHome(client);
    return {
      client: "claude",
      files: [
        {
          remotePath: `${home}/.claude.json`,
          label: "Claude 全局",
          serverPath: ["mcpServers"],
          withTypeEnabled: false,
        },
      ],
    };
  }

  // claude 项目
  const projRaw = await text({
    message: "项目绝对路径（远端 Linux）",
    placeholder: "如 /home/sumu/my-project",
  });
  if (isCancel(projRaw)) {
    log.message("    已取消");
    return null;
  }
  const projectPath = projRaw.trim();
  if (!projectPath) {
    log.message("    项目路径为空");
    return null;
  }
  return {
    client: "claude",
    files: [
      {
        remotePath: joinRemotePath(projectPath, ".mcp.json"),
        label: "Claude 项目（.mcp.json server 定义）",
        serverPath: ["mcpServers"],
        withTypeEnabled: false,
      },
      {
        remotePath: joinRemotePath(projectPath, ".claude/settings.local.json"),
        label: "Claude 项目（settings.local.json 使能）",
        serverPath: [],
        withTypeEnabled: false,
        enableArrayPath: ["enabledMcpjsonServers"],
        enableValue: SERVER_KEY,
      },
    ],
  };
}

// ============================================================
// C4-后半. 配置 / 删除 / 诊断 业务流程
// ============================================================

/**
 * @brief 计算本次桥接定义所需的 Windows 端参数
 * @details 采集本机连接信息并确定主 IP：
 *          - 无可用 IP  → 返回 null（配置场景中止；诊断场景用占位端点）
 *          - 仅 1 个 IP → 直接采用，无需用户介入
 *          - 多个 IP    → 交互式让用户选择（多网卡时取首个不可靠，需用户确认）
 *          bat 路径取 cwd/remote-start-mcp.bat（转正斜杠，与 sshd-config 模板一致）。
 * @returns {sshUser, primaryIp, batPath} 或 null（无可用 IP / 多 IP 时用户取消选择）
 */
async function resolveLocalEndpoint(): Promise<{
  sshUser: string;
  primaryIp: string;
  batPath: string;
} | null> {
  const { sshUser, ipList } = collectConnectionInfo();
  if (ipList.length === 0) {
    return null;
  }
  // 单个 IP 直接采用；多个 IP 让用户选择（多网卡场景无法可靠自动判定，取首个可能
  // 选到 Linux 路由不可达的网段，导致反向 SSH 连接失败）
  let primaryIp: string;
  if (ipList.length === 1) {
    primaryIp = ipList[0].ip;
  } else {
    const choice = await select<string>({
      message: "选择 Windows 主 IP（远程反连地址）",
      options: ipList.map((entry) => ({
        value: entry.ip,
        label: `${entry.ip}  (${entry.iface})`,
      })),
    });
    if (isCancel(choice)) {
      return null;
    }
    primaryIp = choice;
  }
  // cwd/remote-start-mcp.bat 转正斜杠（JSON 无需转义反斜杠，且 node/ssh 支持正斜杠）
  const batPath = (
    process.cwd().replace(/\\/g, "/") + "/remote-start-mcp.bat"
  ).replace(/\/+/g, "/");
  return { sshUser, primaryIp, batPath };
}

/**
 * @brief 单文件变异操作（配置/删除共用）
 * @details 统一"备份→读→本地改写→序列化→写→失败回滚"流程：
 *          1. 备份原文件为 .bak（已存在则跳过，保留首次备份）
 *          2. 读取原文件（不存在则当作空 JSON {}）
 *          3. JSON.parse
 *          4. 调用 mutate 在本地对象上做 set/remove + 使能数组增删
 *          5. 序列化（2 空格缩进 + 尾换行）
 *          6. 写回远端；写失败用 .bak 回滚
 * @param sftp    已打开的 SFTP 会话句柄
 * @param file    落点描述符
 * @param mutate  本地变异回调（原地修改 json 对象）；返回 false 表示无需改动
 * @returns 是否实际写入了文件
 * @throws 读/写/解析失败时抛出（已尝试回滚）
 */
async function mutateFile(
  sftp: SFTPWrapper,
  file: TargetFile,
  mutate: (json: Record<string, unknown>) => boolean
): Promise<boolean> {
  // 1. 备份
  await sftpBackup(sftp, file.remotePath);

  // 2. 读取（不存在则当作空对象）
  const info = await sftpReadText(sftp, file.remotePath);
  const rawContent = info.exists ? (info.content ?? "{}") : "{}";

  // 3. 解析
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawContent) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `JSON 解析失败 ${file.remotePath}: ${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }

  // 4. 本地变异；返回 false 表示无需改动
  const changed = mutate(json);
  if (!changed) {
    return false;
  }

  // 5. 序列化（2 空格 + 尾换行，N4）
  const newContent = JSON.stringify(json, null, 2) + "\n";

  // 6. 写回；失败用 .bak 回滚
  try {
    await sftpWriteText(sftp, file.remotePath, newContent);
  } catch (err) {
    // 回滚：若备份存在，恢复原文件内容
    try {
      const bakInfo = await sftpReadText(sftp, file.remotePath + ".bak");
      if (bakInfo.exists && info.exists) {
        await sftpWriteText(sftp, file.remotePath, bakInfo.content ?? "");
      }
    } catch {
      // 回滚失败不掩盖原始写入错误
    }
    throw new Error(
      `写入失败 ${file.remotePath}: ${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }
  return true;
}

/**
 * @brief 配置 MCP（F5）
 * @details 采集本机端点 → 路由落点 → 展示状态 → 确认 → 写入 → 回显。
 * @param client 已连接的 ssh2 Client
 */
async function doConfigure(client: Client, sftp: SFTPWrapper): Promise<void> {
  log.info("配置 MCP 桥接 ...");

  // 采集本机端点（无可用 IP 或多 IP 用户取消则中止）
  const endpoint = await resolveLocalEndpoint();
  if (!endpoint) {
    log.message("    未检测到本机可用 IPv4 地址，无法生成桥接配置");
    log.message("    请确认网络连接正常后重试");
    return;
  }
  log.message(`    Windows 用户名: ${endpoint.sshUser}`);
  log.message(`    Windows 主 IP: ${endpoint.primaryIp}`);
  log.message(`    bat 路径:      ${endpoint.batPath}`);

  // 路由落点
  const target = await askTarget(client);
  if (!target) return;

  // 展示各落点当前状态（F4）
  log.info("当前状态");
  let hasError = false;
  for (const file of target.files) {
    const bridge = buildBridgeServer(
      file.withTypeEnabled,
      endpoint.sshUser,
      endpoint.primaryIp,
      endpoint.batPath
    );
    try {
      const status = await readStatus(sftp, file, bridge);
      log.message(`    [${file.label}] ${status.detail}`);
      log.message(`        路径: ${file.remotePath}`);
      if (status.existing) {
        log.message(
          `        现有: ${JSON.stringify({ command: status.existing.command, args: status.existing.args })}`
        );
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 状态读取失败: ${err instanceof Error ? err.message : err}`
      );
      hasError = true;
    }
  }
  if (hasError) {
    log.message("    存在状态读取异常，已中止");
    return;
  }

  // 确认
  const ok = await confirm({
    message: "确认写入以上配置?",
    active: "确认写入",
    inactive: "取消",
    initialValue: true,
  });
  if (isCancel(ok) || !ok) {
    log.message("    已取消");
    return;
  }

  // 写入各落点
  log.info("写入配置 ...");
  for (const file of target.files) {
    const bridge = buildBridgeServer(
      file.withTypeEnabled,
      endpoint.sshUser,
      endpoint.primaryIp,
      endpoint.batPath
    );
    try {
      const written = await mutateFile(sftp, file, (json) => {
        let changed = false;
        // server 定义（serverPath 非空）
        if (file.serverPath.length > 0) {
          setServerAtPath(json, file.serverPath, SERVER_KEY, bridge);
          changed = true;
        }
        // 使能数组（enableArrayPath 非空）
        if (file.enableArrayPath && file.enableValue) {
          // 取使能数组；不存在或非数组则创建为空数组
          let arr = getValueAtPath(json, file.enableArrayPath);
          if (!Array.isArray(arr)) {
            // 沿父路径建对象，末层设为空数组
            setServerAtPath(
              json,
              file.enableArrayPath.slice(0, -1),
              file.enableArrayPath[file.enableArrayPath.length - 1],
              []
            );
            arr = getValueAtPath(json, file.enableArrayPath);
          }
          if (Array.isArray(arr) && ensureInArray(arr, file.enableValue)) {
            changed = true;
          }
        }
        return changed;
      });
      if (written) {
        log.message(`    [${file.label}] 已写入: ${file.remotePath}`);
      } else {
        log.message(`    [${file.label}] 无需改动: ${file.remotePath}`);
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 写入失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // 回显最终关键字段
  log.info("写入的桥接定义");
  const finalBridge = buildBridgeServer(
    target.files[0].withTypeEnabled,
    endpoint.sshUser,
    endpoint.primaryIp,
    endpoint.batPath
  );
  log.message(`    command: ${finalBridge.command}`);
  log.message(`    args:    ${JSON.stringify(finalBridge.args)}`);
  log.success("配置完成");
  log.message("    需重启对应 client（claude/zcode）使配置生效");
}

/**
 * @brief 删除已配置的 MCP（F6）
 * @details 路由落点 → 展示状态 → 确认 → 从各文件移除 embedded-board → 回显。
 *          文件不存在或无该项时提示"无需删除"而非报错。
 * @param client 已连接的 ssh2 Client
 */
async function doRemove(client: Client, sftp: SFTPWrapper): Promise<void> {
  log.info("删除 MCP 桥接配置 ...");

  // 删除不依赖本机端点（不需要 bridge 比对，只按 key 名移除），但仍走落点路由
  const target = await askTarget(client);
  if (!target) return;

  // 展示状态：删除只关心"是否已配置"，不做一致性比对（比对是配置操作的语义，
  // 删除场景展示"将覆盖更新"会误导用户）。此处用专门的"存在性"展示。
  log.info("当前状态");
  for (const file of target.files) {
    try {
      const exists = await checkExists(sftp, file);
      log.message(
        `    [${file.label}] ${exists ? "已配置，可删除" : "未配置"}`
      );
      log.message(`        路径: ${file.remotePath}`);
    } catch (err) {
      log.message(
        `    [${file.label}] 状态读取失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // 确认
  const ok = await confirm({
    message: "确认删除 embedded-board 配置?",
    active: "确认删除",
    inactive: "取消",
    initialValue: false,
  });
  if (isCancel(ok) || !ok) {
    log.message("    已取消");
    return;
  }

  // 移除
  log.info("移除配置 ...");
  for (const file of target.files) {
    try {
      const changed = await mutateFile(sftp, file, (json) => {
        let changedFlag = false;
        if (file.serverPath.length > 0) {
          if (removeServerAtPath(json, file.serverPath, SERVER_KEY)) {
            changedFlag = true;
          }
        }
        if (file.enableArrayPath && file.enableValue) {
          const arr = getValueAtPath(json, file.enableArrayPath);
          if (Array.isArray(arr) && removeFromArray(arr, file.enableValue)) {
            changedFlag = true;
          }
        }
        return changedFlag;
      });
      if (changed) {
        log.message(`    [${file.label}] 已移除: ${file.remotePath}`);
      } else {
        log.message(
          `    [${file.label}] 无需删除（未配置）: ${file.remotePath}`
        );
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 删除失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  log.success("删除完成");
}

/**
 * @brief 只读诊断：查看目标落点状态（F7）
 * @details 路由落点后只读取并展示状态，不修改任何文件。
 * @param client 已连接的 ssh2 Client
 */
async function doCheckStatus(client: Client, sftp: SFTPWrapper): Promise<void> {
  log.info("查看远端 MCP 配置状态（只读诊断）");

  const endpoint = await resolveLocalEndpoint();
  // 诊断允许无可用 IP（仅展示，不写入），用占位端点做比对
  const sshUser = endpoint?.sshUser ?? "(unknown)";
  const primaryIp = endpoint?.primaryIp ?? "(unknown)";
  const batPath = endpoint?.batPath ?? "(unknown)";

  const target = await askTarget(client);
  if (!target) return;

  for (const file of target.files) {
    const bridge = buildBridgeServer(
      file.withTypeEnabled,
      sshUser,
      primaryIp,
      batPath
    );
    log.info(`[${file.label}]`);
    log.message(`    路径: ${file.remotePath}`);
    try {
      const status = await readStatus(sftp, file, bridge);
      log.message(`    状态: ${status.detail}`);
      if (status.existing) {
        log.message(
          `    现有: ${JSON.stringify({ command: status.existing.command, args: status.existing.args })}`
        );
      }
    } catch (err) {
      log.message(
        `    状态读取失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  log.message("    提示: 仅展示状态，未修改任何文件");
}

// ============================================================
// C5. 主菜单与主入口
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择（F2）
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "远程 MCP 配置",
    options: [
      { value: MENU_CONFIGURE, label: `[${MENU_CONFIGURE}] 配置 MCP 桥接` },
      {
        value: MENU_CHECK,
        label: `[${MENU_CHECK}] 查看远端当前 MCP 配置状态（只读）`,
      },
      { value: MENU_REMOVE, label: `[${MENU_REMOVE}] 删除已配置的 MCP` },
      { value: MENU_EXIT, label: `[${MENU_EXIT}] 退出` },
    ],
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

/**
 * @brief 打印命令 banner
 */
function printBanner(): void {
  console.log("===================================");
  console.log("  embedded-mcp-toolkit remote-mcp-config");
  console.log("===================================");
}

/**
 * @brief remote-mcp-config 命令主入口
 * @details 执行流程：交互收集地址+密码 → SSH 连接（失败报错中止）→ 交互式菜单循环。
 *          本命令是 SSH 客户端角色，无 Windows 管理操作，不做管理员权限检查。
 * @param opts 命令选项（本期为空，预留扩展）
 */
export async function runRemoteMcpConfig(
  opts: RemoteMcpConfigOptions
): Promise<void> {
  void opts;

  // 1. 交互收集连接信息
  const addressRaw = await text({
    message: "远程 Linux 服务器地址",
    placeholder: "user@host[:port]，如 sumu@1.2.3.4 或 root@1.2.3.4:2222",
  });
  if (isCancel(addressRaw)) {
    console.log("[info] 已取消");
    return;
  }
  const addressInput = (addressRaw ?? "").trim();
  if (!addressInput) {
    console.log("[info] 已取消");
    return;
  }

  const parsed = parseServerAddress(addressInput);
  if (!parsed) {
    console.error(
      "[err] 地址格式错误，应为 user@host[:port]（如 root@1.2.3.4 或 root@1.2.3.4:2222）"
    );
    return;
  }

  const pwdRaw = await password({ message: "登录密码" });
  if (isCancel(pwdRaw)) {
    console.log("[info] 已取消");
    return;
  }

  const info: LinuxServerInfo = { ...parsed, password: pwdRaw };

  // 2. SSH 连接（失败报错中止，不进入菜单，F1）
  let client: Client;
  try {
    console.log(`[run] 连接 ${info.username}@${info.host}:${info.port} ...`);
    client = await sshConnect(info);
    console.log("[info] SSH 连接成功");
  } catch (err) {
    console.error(
      `[err] 无法连接远程服务器: ${err instanceof Error ? err.message : err}`
    );
    console.error("     请检查地址/端口/凭据，以及远端 sshd 是否可达");
    return;
  }

  // 2.5 打开 SFTP 会话（贯穿整个菜单循环复用，避免反复开 channel 触发远端限制）
  let sftp: SFTPWrapper;
  try {
    sftp = await openSftpSession(client);
  } catch (err) {
    console.error(
      `[err] 打开 SFTP 会话失败: ${err instanceof Error ? err.message : err}`
    );
    sshDisconnect(client);
    return;
  }

  // 3. 交互式菜单循环（F2）
  try {
    while (true) {
      clearScreen();
      printBanner();
      const choice = await mainMenu();

      if (choice === null || choice === MENU_EXIT) {
        console.log("[info] 再见");
        return;
      }

      switch (choice) {
        case MENU_CONFIGURE:
          await doConfigure(client, sftp);
          break;
        case MENU_CHECK:
          await doCheckStatus(client, sftp);
          break;
        case MENU_REMOVE:
          await doRemove(client, sftp);
          break;
        default:
          // clack select 只会返回已定义的 value，保留兜底分支防扩展遗漏
          break;
      }

      // step 执行完毕：按 Enter 回菜单，按 q 退出
      if (await pauseForMenu()) {
        console.log("[info] 再见");
        return;
      }
    }
  } finally {
    // 先关 SFTP 会话，再断开 SSH 连接
    closeSftpSession(sftp);
    sshDisconnect(client);
  }
}
