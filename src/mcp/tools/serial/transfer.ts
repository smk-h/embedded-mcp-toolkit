/**
 * @file MCP Serial ZMODEM 文件传输工具
 *
 * 在已建立的串口会话上，通过 ZMODEM 协议（依赖设备端 lrzsz 的 rz/sz）传输二进制文件。
 * 复用同一条串口连接，传输全程不释放串口、会话保持不断。
 *   - serial_upload   MCP 当发送端，设备端 rz 接收
 *   - serial_download MCP 当接收端，设备端 sz 发送
 *
 * 工具采用阻塞式调用（对齐 serial_exec 风格），传输过程中通过 logger 在 stderr 输出进度，
 * 完成或失败或超时后返回传输摘要（字节数/耗时/速率）。
 */

import { basename } from "node:path";
import { stat } from "node:fs/promises";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import { formatTransferSummary } from "../../../shared/transfer-result.js";
import { serialStore } from "./sessions.js";
import { zmodemSend, zmodemReceive } from "../../../services/zmodem/index.js";

// ── 常量 ────────────────────────────────────────────────────

/** @brief 默认传输超时（秒），覆盖大多数中等文件传输 */
const DEFAULT_TIMEOUT_SEC = 300;

/** @brief 进度日志节流间隔（毫秒），避免长传输刷屏 */
const PROGRESS_LOG_THROTTLE_MS = 1000;

/** @brief 关闭设备端 TTY 软件流控的命令（ZMODEM 前置：ixon/ixoff 会拦截 0x11/0x13 破坏协议帧） */
const STTY_DISABLE_FLOW_CTRL = "stty -ixon -ixoff";

/** @brief stty 命令执行后等待提示符返回的延时（毫秒） */
const STTY_SETTLE_MS = 500;

/** @brief ZMODEM 结束后恢复 shell 提示符的等待时间（毫秒） */
const SHELL_RECOVER_MS = 800;

/** @brief recoverShell 排空缓冲的最大轮次（防止无限循环） */
const SHELL_RECOVER_MAX_DRAINS = 5;

/** @brief recoverShell 每次排空间隔（毫秒） */
const SHELL_RECOVER_DRAIN_MS = 300;

// ── 内部辅助 ────────────────────────────────────────────────

/**
 * @brief 关闭设备端 TTY 软件流控（ZMODEM 前置）
 *
 * 多数 Linux 终端默认开启 ixon/ixoff 软件流控，会拦截 XON(0x11)/XOFF(0x13) 字节，
 * 破坏 ZMODEM 协议帧（这些字节在 ZMODEM 数据流中是合法的）。
 * 发 rz/sz 前先关流控，是 ZMODEM over serial 的标准前置步骤。
 *
 * @param shell 已建立的串口会话
 */
async function disableFlowControl(shell: {
  write: (cmd: string, clear?: number) => void;
}): Promise<void> {
  shell.write(STTY_DISABLE_FLOW_CTRL, 1);
  await new Promise((r) => setTimeout(r, STTY_SETTLE_MS));
}

/**
 * @brief ZMODEM 传输结束后清理 shell 缓冲，恢复正常提示符
 *
 * 正常路径下（session.has_ended() 为真）rz/sz 已通过 ZFIN/OO 干净退出、
 * shell 回到提示符，本函数只是排空缓冲里残留的协议字节回显，属于轻量清理。
 * 失败路径下（超时/异常，finally 已发 abort 序列让 rz/sz 退出）shell 可能
 * 停在异常态，本函数发回车触发重新输出提示符 + 循环排空残留字节。
 *
 * @param shell 已建立的串口会话
 */
async function recoverShell(shell: {
  write: (cmd: string, clear?: number) => void;
  read: (clear?: number) => string;
}): Promise<void> {
  // 先丢弃缓冲区中可能残留的 ZMODEM 协议字节
  shell.read(1);
  // 发回车触发 shell 重新输出提示符
  shell.write("", 1);
  await new Promise((r) => setTimeout(r, SHELL_RECOVER_MS));
  // 循环排空：rz 退出后设备会持续吐出残留 ZMODEM 字节和回显，
  // 单次读不够，需循环读直到缓冲稳定（连续空读）或达到上限
  for (let i = 0; i < SHELL_RECOVER_MAX_DRAINS; i++) {
    const drained = shell.read(1);
    if (!drained) break;
    await new Promise((r) => setTimeout(r, SHELL_RECOVER_DRAIN_MS));
  }
}

// ── serial_upload ───────────────────────────────────────────

/**
 * @brief serial_upload 工具配置
 *
 * 将本地二进制文件上传到设备端，复用已有串口会话。
 * 设备端需安装 lrzsz（rz 命令）。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param local_path  本地源文件路径
 * @param remote_name 远端文件名（默认取 local_path basename）
 * @param remote_dir  远端目录提示（仅提示用，rz 默认写当前目录）
 * @param recv_cmd    设备端接收命令（默认 "rz"，可传 "rz -e" 等）
 * @param timeout     超时秒数（默认 300）
 */
export const serialUploadConfig = {
  description:
    "Upload a binary file to the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (rz command). " +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    local_path: string;
    remote_name?: string;
    remote_dir?: string;
    recv_cmd?: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      local_path: {
        type: "string",
        description: "Local source file path",
      },
      remote_name: {
        type: "string",
        description:
          "Remote file name (default: basename of local_path). The device rz will name the file accordingly.",
      },
      remote_dir: {
        type: "string",
        description:
          "Remote directory hint (the rz command writes to its current dir by default; cd before rz if needed)",
      },
      recv_cmd: {
        type: "string",
        description:
          "Device receive command (default: 'rz'). e.g. 'rz -e' to escape control chars",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 300)",
      },
    },
    required: ["session_id", "local_path"],
  }),
};

/**
 * @brief serial_upload 处理函数
 *
 * 流程：
 *   1. 查会话；本地文件存在性校验
 *   2. 触发设备端 rz（recv_cmd 可覆盖）
 *   3. 短延时让设备进 ZMODEM 等待态
 *   4. 构造 AbortController，按 timeout 设超时
 *   5. 调 zmodemSend，进度回调节流输出 logger
 *   6. 收 shell 提示符确认会话活着，返回摘要
 *
 * @param args 工具参数
 * @return MCP 响应，含传输摘要文本
 */
export async function serialUploadHandler(args: {
  session_id: string;
  local_path: string;
  remote_name?: string;
  remote_dir?: string;
  recv_cmd?: string;
  timeout?: number;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  logger.info(
    `[serial_upload] session_id=${args.session_id} local=${args.local_path} remote_name=${args.remote_name ?? "(auto)"} recv_cmd=${args.recv_cmd ?? "(default rz)"} timeout=${args.timeout ?? DEFAULT_TIMEOUT_SEC}`
  );

  const lookup = serialStore.getOrNotFound(args.session_id);
  if (!lookup.ok) {
    return lookup.response;
  }
  const shell = lookup.shell;

  // 本地文件存在性校验
  try {
    await stat(args.local_path);
  } catch (err) {
    const msg = `Local file not found: ${args.local_path} (${err instanceof Error ? err.message : String(err)})`;
    logger.warn(`[serial_upload] ${msg}`);
    return { content: [text(msg)] };
  }

  const remoteName = args.remote_name ?? basename(args.local_path);
  const recvCmd = args.recv_cmd ?? "rz";

  // ZMODEM 前置：关闭设备端软件流控，避免 XON/XOFF 拦截协议字节
  await disableFlowControl(shell);

  // 超时控制：timeout 秒后 abort
  const controller = new AbortController();
  const timeoutSec = args.timeout ?? DEFAULT_TIMEOUT_SEC;
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  // 进度节流：每 PROGRESS_LOG_THROTTLE_MS 毫秒最多一条 logger
  let lastLogAt = 0;
  try {
    // recvCmd 由 zmodemSend→establishSession 挂完字节旁路后发出，
    // 确保设备 rz 回的 ZRINIT 进预缓冲区而非文本态
    const result = await zmodemSend(
      shell,
      args.local_path,
      remoteName,
      {
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastLogAt >= PROGRESS_LOG_THROTTLE_MS) {
            logger.info(
              `[serial_upload] progress ${p.bytes}/${p.total ?? "?"} bytes`
            );
            lastLogAt = now;
          }
        },
        signal: controller.signal,
      },
      recvCmd
    );

    logger.info(
      `[serial_upload] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
    );
    return { content: [text(formatTransferSummary(result))] };
  } finally {
    clearTimeout(timer);
    // ZMODEM 结束后恢复 shell 到正常提示符状态（rz 退出后 shell 可能停在异常终端态）
    await recoverShell(shell);
  }
}

// ── serial_download ─────────────────────────────────────────

/**
 * @brief serial_download 工具配置
 *
 * 将远端文件从设备下载到本地，复用已有串口会话。
 * 设备端需安装 lrzsz（sz 命令）。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param remote_path 远端源文件路径
 * @param local_path  本地目标文件路径
 * @param send_cmd    设备端发送命令模板（默认 "sz {remote}"，{remote} 替换为 remote_path）
 * @param timeout     超时秒数（默认 300）
 */
export const serialDownloadConfig = {
  description:
    "Download a binary file from the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (sz command). " +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    remote_path: string;
    local_path: string;
    send_cmd?: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      remote_path: {
        type: "string",
        description: "Remote source file path on the device",
      },
      local_path: {
        type: "string",
        description: "Local destination file path",
      },
      send_cmd: {
        type: "string",
        description:
          "Device send command template (default: 'sz {remote}'). {remote} is replaced by remote_path",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 300)",
      },
    },
    required: ["session_id", "remote_path", "local_path"],
  }),
};

/**
 * @brief serial_download 处理函数
 *
 * 流程与 serial_upload 对称：
 *   1. 查会话
 *   2. 触发设备端 sz（send_cmd 模板，{remote} 占位符替换）
 *   3. 调 zmodemReceive，进度节流输出 logger
 *   4. 收 shell 提示符，返回摘要
 *
 * @param args 工具参数
 * @return MCP 响应，含传输摘要文本
 */
export async function serialDownloadHandler(args: {
  session_id: string;
  remote_path: string;
  local_path: string;
  send_cmd?: string;
  timeout?: number;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  logger.info(
    `[serial_download] session_id=${args.session_id} remote=${args.remote_path} local=${args.local_path} send_cmd=${args.send_cmd ?? "(default sz)"} timeout=${args.timeout ?? DEFAULT_TIMEOUT_SEC}`
  );

  const lookup = serialStore.getOrNotFound(args.session_id);
  if (!lookup.ok) {
    return lookup.response;
  }
  const shell = lookup.shell;

  // 触发设备端 sz（{remote} 占位符替换为远端路径）
  const sendCmd = (args.send_cmd ?? "sz {remote}").replace(
    "{remote}",
    args.remote_path
  );

  // ZMODEM 前置：关闭设备端软件流控，避免 XON/XOFF 拦截协议字节
  await disableFlowControl(shell);

  const controller = new AbortController();
  const timeoutSec = args.timeout ?? DEFAULT_TIMEOUT_SEC;
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let lastLogAt = 0;
  try {
    // sendCmd 由 zmodemReceive→establishSession 挂完字节旁路后发出
    const result = await zmodemReceive(
      shell,
      args.local_path,
      {
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastLogAt >= PROGRESS_LOG_THROTTLE_MS) {
            logger.info(
              `[serial_download] progress ${p.bytes}/${p.total ?? "?"} bytes`
            );
            lastLogAt = now;
          }
        },
        signal: controller.signal,
      },
      sendCmd
    );

    logger.info(
      `[serial_download] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
    );
    return { content: [text(formatTransferSummary(result))] };
  } finally {
    clearTimeout(timer);
    // ZMODEM 结束后恢复 shell 到正常提示符状态
    await recoverShell(shell);
  }
}
