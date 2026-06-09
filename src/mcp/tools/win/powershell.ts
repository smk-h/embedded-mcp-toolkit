/**
 * @brief PowerShell 交互式 Shell MCP 工具
 *
 * 提供对本地 Windows PowerShell 进程的会话管理，
 * 支持 open / close / write / read / list / exec 六个操作。
 *
 * 会话模式与 serial_shell / ssh_shell 保持一致，
 * 区别在于 PowerShell 连接的是本地持久化 powershell.exe 进程，
 * 而非远程串口或 SSH。
 */
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import {
  PowerShellShell,
  type PowerShellShellConfig,
} from "../../../transport/powershell.js";
import { registry } from "../../sessions/registry.js";

// ── 会话存储 ────────────────────────────────────────────────

/**
 * @brief PowerShell Shell 会话存储表
 *
 * 以 session_id 为键，PowerShellShell 实例为值，
 * 所有 PowerShell MCP 工具通过此表查找和共享会话。
 */
const sessions = new Map<string, PowerShellShell>();

/** @brief 会话自增计数器，用于生成唯一 session_id */
let sessionCounter = 0;

// ── power_shell_open ────────────────────────────────────────

/**
 * @brief power_shell_open 工具配置
 *
 * 打开一个本地交互式 PowerShell Shell 会话，返回初始 banner 输出。
 *
 * @param workingDir  工作目录（可选，默认使用当前进程的工作目录）
 */
export const powerShellOpenConfig = {
  description:
    "Open an interactive PowerShell shell session on the local Windows machine. Returns the initial banner output.",
  inputSchema: fromJsonSchema<{
    workingDir?: string;
  }>({
    type: "object",
    properties: {
      workingDir: {
        type: "string",
        description:
          "Working directory for the PowerShell process (default: current working directory)",
      },
    },
  }),
};

/**
 * @brief power_shell_open 处理函数
 *
 * 流程：
 *   1. 根据参数构建 PowerShellShellConfig 配置
 *   2. 创建 PowerShellShell 实例并启动 powershell.exe 进程
 *   3. 读取 banner 输出（PowerShell 启动提示信息）
 *   4. 将 shell 存入会话表，返回 session_id
 *
 * @param args  工具参数，包含可选的 workingDir
 * @return MCP 响应，包含 session_id 和 banner 内容
 */
export async function powerShellOpenHandler(args: { workingDir?: string }) {
  logger.info(`[power_shell_open] workingDir=${args.workingDir ?? "(cwd)"}`);

  if (process.platform !== "win32") {
    return {
      content: [text("This tool only works on Windows.")],
    };
  }

  const config: PowerShellShellConfig = {
    workingDir: args.workingDir,
  };

  const shell = new PowerShellShell(config);
  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return {
      content: [
        text(
          `PowerShell open failed: ${err instanceof Error ? err.message : String(err)}`
        ),
      ],
    };
  }

  const sessionId = `power_${++sessionCounter}`;
  sessions.set(sessionId, shell);
  registry.register({
    id: sessionId,
    type: "powershell",
    deviceName: "local",
    connectionInfo: shell.getWorkingDir(),
    createdAt: new Date().toISOString(), // UTC
  });
  logger.info(`[power_shell_open] session opened: ${sessionId}`);

  return {
    content: [
      text(
        `Session ${sessionId} opened. Working dir: ${shell.getWorkingDir()}\n${banner || "(no banner)"}`
      ),
    ],
  };
}

// ── power_shell_close ───────────────────────────────────────

/**
 * @brief power_shell_close 工具配置
 *
 * 关闭指定的 PowerShell Shell 会话并终止 powershell.exe 进程。
 *
 * @param session_id  由 power_shell_open 返回的会话 ID
 */
export const powerShellCloseConfig = {
  description: "Close a PowerShell shell session and terminate the process.",
  inputSchema: fromJsonSchema<{ session_id: string }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by power_shell_open",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief power_shell_close 处理函数
 *
 * 流程：
 *   1. 从会话表中查找指定 session_id
 *   2. 调用 shell.close() 发送 exit 命令并终止进程
 *   3. 从会话表中移除该条目
 *
 * @param args  工具参数，包含 session_id
 * @return MCP 响应，确认会话已关闭
 */
export async function powerShellCloseHandler(args: { session_id: string }) {
  logger.info(`[power_shell_close] session_id=${args.session_id}`);
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  await shell.close();
  sessions.delete(args.session_id);
  registry.unregister(args.session_id);

  return { content: [text(`Session ${args.session_id} closed.`)] };
}

// ── power_shell_write ───────────────────────────────────────

/**
 * @brief power_shell_write 工具配置
 *
 * 向指定的 PowerShell Shell 会话发送命令。
 *
 * @param session_id  由 power_shell_open 返回的会话 ID
 * @param command     要发送的 PowerShell 命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const powerShellWriteConfig = {
  description: "Send a command to a PowerShell shell session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    clear?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by power_shell_open",
      },
      command: {
        type: "string",
        description: "The PowerShell command to send",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
    },
    required: ["session_id", "command"],
  }),
};

/**
 * @brief power_shell_write 处理函数
 *
 * 向 PowerShell 进程发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 power_shell_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @return MCP 响应，确认命令已发送
 */
export function powerShellWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[power_shell_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  shell.write(args.command, args.clear ?? 1);

  return { content: [text(`Command sent: ${args.command}`)] };
}

// ── power_shell_read ────────────────────────────────────────

/**
 * @brief power_shell_read 工具配置
 *
 * 读取指定 PowerShell Shell 会话的输出数据。
 *
 * @param session_id  由 power_shell_open 返回的会话 ID
 * @param clear       缓冲区清空标志（1=读取后清空，0=保留缓冲区，默认 1）
 */
export const powerShellReadConfig = {
  description: "Read output from a PowerShell shell session.",
  inputSchema: fromJsonSchema<{ session_id: string; clear?: number }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by power_shell_open",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer after reading, 0 = keep buffer",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief power_shell_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @return MCP 响应，包含读取到的输出内容
 */
export function powerShellReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[power_shell_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  const output = shell.read(args.clear ?? 1);

  return { content: [text(output || "(no output)")] };
}

// ── power_shell_exec ────────────────────────────────────────

/**
 * @brief power_shell_exec 工具配置
 *
 * 向 PowerShell Shell 会话发送命令并等待输出，合并 write + delay + read 为一次调用。
 *
 * @param session_id  由 power_shell_open 返回的会话 ID
 * @param command     要执行的 PowerShell 命令字符串
 * @param delay       发送后等待时间（毫秒，默认 1000）
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const powerShellExecConfig = {
  description:
    "Send a command to a PowerShell shell session and wait for the output. Combines write + delay + read in one call.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    delay?: number;
    clear?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by power_shell_open",
      },
      command: {
        type: "string",
        description: "The PowerShell command to execute",
      },
      delay: {
        type: "number",
        description:
          "Wait time in milliseconds before reading output (default: 1000)",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
    },
    required: ["session_id", "command"],
  }),
};

/**
 * @brief power_shell_exec 处理函数
 *
 * 一次性完成命令发送、等待、读取三个步骤，适用于简单的命令执行场景。
 * 对于需要精细控制缓冲区或多次交互的场景，应分别使用 write + read。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear
 * @return MCP 响应，包含命令执行后的输出内容
 */
export async function powerShellExecHandler(args: {
  session_id: string;
  command: string;
  delay?: number;
  clear?: number;
}) {
  logger.info(
    `[power_shell_exec] session_id=${args.session_id} command=${args.command} delay=${args.delay ?? 1000} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  shell.write(args.command, args.clear ?? 1);

  // 等待命令执行完成，让 stdout/stderr 数据积累到内部缓冲区
  await new Promise((r) => setTimeout(r, args.delay ?? 1000));

  const output = shell.read(1);

  return { content: [text(output || "(no output)")] };
}

// ── 进程退出自动清理 ────────────────────────────────────────

/**
 * @brief 关闭所有活跃的 PowerShell 会话
 *
 * 在 MCP Server 进程退出时调用，确保所有 powershell.exe 子进程被终止，
 * 避免僵尸进程残留。
 */
export async function disposeAllPowerShellSessions(): Promise<void> {
  const entries = [...sessions.entries()];
  for (const [id, shell] of entries) {
    try {
      await shell.close();
      logger.info(`[power_dispose] session ${id} closed`);
    } catch (err) {
      logger.error(`[power_dispose] session ${id} close failed:`, err);
    }
    registry.unregister(id);
  }
  sessions.clear();
}
