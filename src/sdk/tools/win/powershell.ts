/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : powershell.ts
 * Author     : sumu
 * Date       : 2026/05/28
 * Version    : x.x.x
 * Description: PowerShell 交互式 Shell SDK 工具（协议无关，MCP 注册见 src/mcp/tools/win）
 *
 * 提供对本地 Windows PowerShell 进程的会话管理，
 * 支持 open / close / write / read / list / exec 六个操作。
 *
 * 会话模式与 serial_shell / ssh_shell 保持一致，
 * 区别在于 PowerShell 连接的是本地持久化 powershell.exe 进程，
 * 而非远程串口或 SSH。
 * ======================================================
 */
import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";
import {
  PowerShellShell,
  type PowerShellShellConfig,
} from "../../../transports/powershell.js";
import { powerStore } from "./sessions.js";

// ── power_shell_open ────────────────────────────────────────

/**
 * @brief power_shell_open 工具配置
 *
 * 打开一个本地交互式 PowerShell Shell 会话，返回初始 banner 输出。
 *
 * @param workingDir  工作目录（可选，默认使用当前进程的工作目录）
 */
export const powerShellOpenConfig: SdkToolConfig = {
  description:
    "Open an interactive PowerShell shell session on the local Windows machine. Returns the initial banner output.",
  inputSchema: {
    type: "object",
    properties: {
      workingDir: {
        type: "string",
        description:
          "Working directory for the PowerShell process (default: current working directory)",
      },
    },
  },
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
 * @return 响应文本，包含 session_id 和 banner 内容
 */
export async function powerShellOpenHandler(args: { workingDir?: string }) {
  logger.info(`[power_shell_open] workingDir=${args.workingDir ?? "(cwd)"}`);

  if (process.platform !== "win32") {
    return "This tool only works on Windows.";
  }

  const config: PowerShellShellConfig = {
    workingDir: args.workingDir,
  };

  const shell = new PowerShellShell(config);
  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return `PowerShell open failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const sessionId = powerStore.create(shell, {
    type: "powershell",
    deviceName: "local",
    connectionInfo: shell.getWorkingDir(),
  });
  logger.info(`[power_shell_open] session opened: ${sessionId}`);
  shell.fileLogger.enableFromEnv(sessionId, "local");

  return `Session ${sessionId} opened. Working dir: ${shell.getWorkingDir()}\n${banner || "(no banner)"}`;
}

// ── power_shell_close ───────────────────────────────────────

/**
 * @brief power_shell_close 工具配置
 *
 * 关闭指定的 PowerShell Shell 会话并终止 powershell.exe 进程。
 *
 * @param session_id  由 power_shell_open 返回的会话 ID
 */
export const powerShellCloseConfig: SdkToolConfig = {
  description: "Close a PowerShell shell session and terminate the process.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by power_shell_open",
      },
    },
    required: ["session_id"],
  },
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
 * @return 响应文本，确认会话已关闭
 */
export async function powerShellCloseHandler(args: { session_id: string }) {
  logger.info(`[power_shell_close] session_id=${args.session_id}`);
  const shell = powerStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  await powerStore.withLock(args.session_id, async () => {
    await shell.close();
  });
  powerStore.remove(args.session_id);

  return `Session ${args.session_id} closed.`;
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
export const powerShellWriteConfig: SdkToolConfig = {
  description:
    "Send a command to a PowerShell shell session. " +
    "Do NOT call this concurrently with power_shell_exec/power_shell_read on the same session_id — " +
    "concurrent access to the same PowerShell process corrupts the output buffer.",
  inputSchema: {
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
  },
};

/**
 * @brief power_shell_write 处理函数
 *
 * 向 PowerShell 进程发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 power_shell_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @return 响应文本，确认命令已发送
 */
export async function powerShellWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[power_shell_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = powerStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return powerStore.withLock(args.session_id, async () => {
    shell.write(args.command, args.clear ?? 1);
    return `Command sent: ${args.command}`;
  });
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
export const powerShellReadConfig: SdkToolConfig = {
  description:
    "Read output from a PowerShell shell session. " +
    "Do NOT call this concurrently with power_shell_exec/power_shell_write on the same session_id — " +
    "concurrent access to the same PowerShell process corrupts the output buffer.",
  inputSchema: {
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
  },
};

/**
 * @brief power_shell_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @return 响应文本，读取到的输出内容
 */
export async function powerShellReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[power_shell_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = powerStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return powerStore.withLock(args.session_id, async () => {
    const output = shell.read(args.clear ?? 1);
    return output || "(no output)";
  });
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
export const powerShellExecConfig: SdkToolConfig = {
  description:
    "Send a command to a PowerShell shell session and wait for the output. Combines write + delay + read in one call. " +
    "IMPORTANT: Do NOT issue concurrent commands to the same session_id — the PowerShell process is a single " +
    "channel; concurrent calls will interleave output and corrupt results. " +
    "Always wait for the previous command to finish before sending the next one.",
  inputSchema: {
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
  },
};

/**
 * @brief power_shell_exec 处理函数
 *
 * 一次性完成命令发送、等待、读取三个步骤，适用于简单的命令执行场景。
 * 对于需要精细控制缓冲区或多次交互的场景，应分别使用 write + read。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear
 * @return 响应文本，命令执行后的输出内容
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
  const shell = powerStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return powerStore.withLock(args.session_id, async () => {
    shell.write(args.command, args.clear ?? 1);

    // 等待命令执行完成，让 stdout/stderr 数据积累到内部缓冲区
    await new Promise((r) => setTimeout(r, args.delay ?? 1000));

    const output = shell.read(1);

    return output || "(no output)";
  });
}
