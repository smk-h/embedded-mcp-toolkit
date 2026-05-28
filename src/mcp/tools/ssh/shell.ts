import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { SSHShell, type SSHShellConfig } from "../../../transport/ssh.js";
import { getSSHConfig, getKeyProviderConfig } from "../../../infra/config.js";
import { PshHandler, PshState } from "../../../transport/psh.js";
import { KeyProvider } from "../../../utils/key-provider.js";

// ── 会话存储 ────────────────────────────────────────────────

/**
 * @brief SSH Shell 会话存储表
 *
 * 以 session_id 为键，SSHShell 实例为值，
 * 所有 SSH MCP 工具通过此表查找和共享会话。
 */
const sessions = new Map<string, SSHShell>();

/** @brief 会话自增计数器，用于生成唯一 session_id */
let sessionCounter = 0;

// ── ssh_shell_open ─────────────────────────────────────────

/**
 * @brief ssh_shell_open 工具配置
 *
 * 打开一个交互式 SSH Shell 会话，返回初始 banner 输出。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param timeout  连接超时时间（秒，默认 10）
 */
export const sshShellOpenConfig = {
  description:
    "Open an interactive SSH shell session to the board. Returns the initial banner output.",
  inputSchema: fromJsonSchema<{ device?: string; timeout?: number }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
      timeout: {
        type: "number",
        description: "Connection timeout in seconds (default: 10)",
      },
    },
  }),
};

/**
 * @brief ssh_shell_open 处理函数
 *
 * 流程：
 *   1. 根据设备名获取 SSH 连接配置
 *   2. 创建 SSHShell 实例并建立连接
 *   3. 读取 banner 输出
 *   4. 将 shell 存入会话表，返回 session_id
 *
 * @param args  工具参数，包含 device 和 timeout
 * @return MCP 响应，包含 session_id 和 banner 内容
 */
export async function sshShellOpenHandler(args: {
  device?: string;
  timeout?: number;
}) {
  logger.info(
    `[ssh_shell_open] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 10}`
  );
  const config: SSHShellConfig = getSSHConfig(args.device);

  if (config.host === "none") {
    const msg = `Device '${args.device ?? "(default)"}' does not support SSH (host is none).`;
    logger.warn(msg);
    return { content: [text(msg)] };
  }

  const shell = new SSHShell(config);

  const banner = await shell.open();

  const sessionId = `ssh_${++sessionCounter}`;
  sessions.set(sessionId, shell);
  logger.info(`[ssh_shell_open] session opened: ${sessionId}`);

  return {
    content: [text(`Session ${sessionId} opened.\n${banner || "(no banner)"}`)],
  };
}

// ── ssh_shell_close ─────────────────────────────────────────

/**
 * @brief ssh_shell_close 工具配置
 *
 * 关闭指定的 SSH Shell 会话并释放连接资源。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 */
export const sshShellCloseConfig = {
  description: "Close an SSH shell session and release the connection.",
  inputSchema: fromJsonSchema<{ session_id: string }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief ssh_shell_close 处理函数
 *
 * 流程：
 *   1. 从会话表中查找指定 session_id
 *   2. 调用 shell.close() 关闭连接
 *   3. 从会话表中移除该条目
 *
 * @param args  工具参数，包含 session_id
 * @return MCP 响应，确认会话已关闭
 */
export async function sshShellCloseHandler(args: { session_id: string }) {
  logger.info(`[ssh_shell_close] session_id=${args.session_id}`);
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  await shell.close();
  sessions.delete(args.session_id);

  return { content: [text(`Session ${args.session_id} closed.`)] };
}

// ── ssh_shell_write ─────────────────────────────────────────

/**
 * @brief ssh_shell_write 工具配置
 *
 * 向指定的 SSH Shell 会话发送命令。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param command     要发送的命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const sshShellWriteConfig = {
  description: "Send a command to an SSH shell session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    clear?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
      command: {
        type: "string",
        description: "The command to send to the shell",
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
 * @brief ssh_shell_write 处理函数
 *
 * 向远端 shell 发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 ssh_shell_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @return MCP 响应，确认命令已发送
 */
export function sshShellWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[ssh_shell_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  shell.write(args.command, args.clear ?? 1);

  return { content: [text(`Command sent: ${args.command}`)] };
}

// ── ssh_shell_read ──────────────────────────────────────────

/**
 * @brief ssh_shell_read 工具配置
 *
 * 读取指定 SSH Shell 会话的输出数据。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param clear       缓冲区清空标志（1=读取后清空，0=保留缓冲区，默认 1）
 */
export const sshShellReadConfig = {
  description: "Read output from an SSH shell session.",
  inputSchema: fromJsonSchema<{ session_id: string; clear?: number }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
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
 * @brief ssh_shell_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @return MCP 响应，包含读取到的输出内容
 */
export function sshShellReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[ssh_shell_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  const output = shell.read(args.clear ?? 1);

  return { content: [text(output || "(no output)")] };
}

// ── ssh_shell_list ──────────────────────────────────────────

/**
 * @brief ssh_shell_list 工具配置
 *
 * 列出当前所有活跃的 SSH Shell 会话。
 */
export const sshShellListConfig = {
  description: "List all active SSH shell sessions.",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

/**
 * @brief ssh_shell_list 处理函数
 *
 * 遍历会话存储表，返回所有活跃会话的 session_id 列表。
 *
 * @return MCP 响应，包含活跃会话列表或"无活跃会话"提示
 */
export function sshShellListHandler() {
  logger.info("[ssh_shell_list]");
  const ids = [...sessions.keys()];

  if (ids.length === 0) {
    return { content: [text("No active sessions.")] };
  }

  return { content: [text(`Active sessions: ${ids.join(", ")}`)] };
}

// ── ssh_shell_exec ──────────────────────────────────────────

/**
 * @brief ssh_shell_exec 工具配置
 *
 * 向 SSH Shell 会话发送命令并等待输出，合并 write + delay + read 为一次调用。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param command     要执行的命令字符串
 * @param delay       发送后等待时间（毫秒，默认 1000）
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const sshShellExecConfig = {
  description:
    "Send a command to an SSH shell session and wait for the output. Combines write + delay + read in one call.",
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
        description: "The session ID returned by ssh_shell_open",
      },
      command: {
        type: "string",
        description: "The command to send to the shell",
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
 * @brief ssh_shell_exec 处理函数
 *
 * 一次性完成命令发送、等待、读取三个步骤，适用于简单的命令执行场景。
 * 对于需要精细控制缓冲区或多次交互的场景，应分别使用 write + read。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear
 * @return MCP 响应，包含命令执行后的输出内容
 */
export async function sshShellExecHandler(args: {
  session_id: string;
  command: string;
  delay?: number;
  clear?: number;
}) {
  logger.info(
    `[ssh_shell_exec] session_id=${args.session_id} command=${args.command} delay=${args.delay ?? 1000} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  shell.write(args.command, args.clear ?? 1);

  await new Promise((r) => setTimeout(r, args.delay ?? 1000));

  const output = shell.read(1);

  return { content: [text(output || "(no output)")] };
}

// ── ssh_connections ────────────────────────────────────────

/**
 * @brief ssh_connections 工具配置
 *
 * 检查远端板卡上活跃的 SSH 连接，显示连接到 SSH 服务（端口 22）的客户端 IP。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 */
export const sshConnectionsConfig = {
  description:
    "Check active SSH connections on the remote board. Shows which client IPs are connected to the SSH service (port 22).",
  inputSchema: fromJsonSchema<{ session_id: string }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief ssh_connections 处理函数
 *
 * 依次尝试 netstat、ss、/proc/net/tcp 三种方式获取 SSH 连接信息，
 * 首个返回有效结果的命令即停止，兼容不同嵌入式 Linux 环境。
 *
 * @param args  工具参数，包含 session_id
 * @return MCP 响应，包含 SSH 连接信息
 */
export async function sshConnectionsHandler(args: { session_id: string }) {
  logger.info(`[ssh_shell_connection] session_id=${args.session_id}`);
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  const commands = [
    "netstat -tn 2>/dev/null | grep :22",
    "ss -tn 2>/dev/null | grep :22",
    "cat /proc/net/tcp",
  ];

  let output = "";
  for (const cmd of commands) {
    shell.write(cmd, 1);
    await new Promise((r) => setTimeout(r, 1000));
    output = shell.read(1).trim();
    if (
      output &&
      !output.includes("not found") &&
      !output.includes("command not found")
    ) {
      break;
    }
  }

  return { content: [text(output || "No SSH connection info available.")] };
}

// ── ssh_shell_login ──────────────────────────────────────────

/**
 * @brief ssh_shell_login 工具配置
 *
 * 一键登录 SSH：自动连接、检测 PSH 状态、如锁定则自动解锁，返回就绪会话。
 * 将 open + PSH 检测 + 解锁合并为单次调用，适用于需要快速获取可用 shell 的场景。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param key      解锁密钥（可选，提供时直接使用；未提供时走 KeyProvider 获取）
 * @param timeout  解锁步骤间等待时间（毫秒，默认 1500）
 */
export const sshShellLoginConfig = {
  description:
    "One-click SSH login: connect, detect PSH state, auto-unlock if locked, and return a ready session. Combines open + PSH detect + unlock into a single call.",
  inputSchema: fromJsonSchema<{
    device?: string;
    key?: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
      key: {
        type: "string",
        description:
          "Unlock key/password. If not provided, uses the configured KeyProvider (file IPC or terminal prompt)",
      },
      timeout: {
        type: "number",
        description: "Unlock step delay in milliseconds (default: 1500)",
      },
    },
  }),
};

/**
 * @brief ssh_shell_login 处理函数 — 一键登录
 *
 * 完整流程：
 *   1. 建立 SSH 连接，读取 banner
 *   2. 自动匹配 PSH profile（psh / psh_busybox）
 *   3. 探测当前 PSH 状态（UNKNOWN 时发送探测命令）
 *   4. 根据状态分支处理：
 *      - 无 PSH     → 直接返回可用 session
 *      - READY      → PSH 已解锁，直接返回可用 session
 *      - LOCKED     → 执行解锁序列（key 参数直接传入，或走 KeyProvider 回调获取）
 *      - UNLOCKING  → 悬挂的密码提示，需提供 key 完成输入
 *      - ERROR      → 前次解锁失败，关闭连接并提示
 *      - UNKNOWN    → 状态不明，返回 session 但可能需手动交互
 *   5. 解锁成功后将 shell 存入会话表，返回 session_id
 *
 * key 参数说明：
 *   - 传入 key：直接使用该密钥解锁，适用于密钥已知的自动化场景
 *   - 不传 key：通过 KeyProvider（文件 IPC 或终端提示）获取密钥，
 *     适用于交互式或外部工具提供密钥的场景
 *
 * @param args  工具参数，包含可选的 device、key 和 timeout
 * @return MCP 响应，包含 session_id 和登录结果信息
 */
export async function sshShellLoginHandler(args: {
  device?: string;
  key?: string;
  timeout?: number;
}) {
  logger.info(
    `[ssh_shell_login] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 1500} key=${args.key ? "***" : "(none)"}`
  );
  const config: SSHShellConfig = getSSHConfig(args.device);

  if (config.host === "none") {
    const msg = `Device '${args.device ?? "(default)"}' does not support SSH (host is none).`;
    logger.warn(msg);
    return { content: [text(msg)] };
  }

  const stepDelay = args.timeout ?? 1500;

  // ===== 步骤 1：建立 SSH 连接 =====
  const shell = new SSHShell(config);
  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return {
      content: [
        text(
          `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`
        ),
      ],
    };
  }

  // ===== 步骤 2：自动识别 PSH profile =====
  const handler = PshHandler.matchFromOutput(banner);

  if (!handler) {
    // 未检测到 PSH — shell 已就绪
    const sessionId = `ssh_${++sessionCounter}`;
    sessions.set(sessionId, shell);
    logger.info(`[ssh_shell_login] session opened: ${sessionId} (no PSH)`);
    return {
      content: [
        text(
          `Session ${sessionId} opened (no PSH detected, shell is ready).\n${banner || "(no banner)"}`
        ),
      ],
    };
  }

  // ===== 步骤 3：探测当前 PSH 状态 =====
  let detect = handler.detect(banner);
  if (detect.state === PshState.UNKNOWN) {
    detect = await handler.probeState(shell);
  }

  // ===== 步骤 4：根据状态执行对应操作 =====

  // --- 已解锁：直接返回可用 session ---
  if (detect.state === PshState.READY) {
    const sessionId = `ssh_${++sessionCounter}`;
    sessions.set(sessionId, shell);
    logger.info(
      `[ssh_shell_login] session opened: ${sessionId} (PSH already unlocked)`
    );
    return {
      content: [
        text(
          `Session ${sessionId} opened (PSH already unlocked).\nProfile: ${handler.profile.name}`
        ),
      ],
    };
  }

  // --- 解锁中：悬挂的密码提示，需 key 完成输入 ---
  if (detect.state === PshState.UNLOCKING) {
    if (!args.key) {
      await shell.close();
      return {
        content: [
          text(
            `PSH is in UNLOCKING state (dangling password prompt). Provide a key to complete login.`
          ),
        ],
      };
    }
    shell.write(args.key, 1);
    await new Promise((r) => setTimeout(r, stepDelay));
    const output = shell.read(1);
    const state = handler.detectState(output);
    if (state === PshState.READY) {
      const sessionId = `ssh_${++sessionCounter}`;
      sessions.set(sessionId, shell);
      logger.info(
        `[ssh_shell_login] session opened: ${sessionId} (UNLOCKING resolved)`
      );
      return {
        content: [
          text(
            `Session ${sessionId} opened (PSH unlock completed from UNLOCKING state).\nProfile: ${handler.profile.name}`
          ),
        ],
      };
    }
    await shell.close();
    return {
      content: [
        text(
          `PSH unlock from UNLOCKING state failed. State: ${state}\nOutput: ${output}`
        ),
      ],
    };
  }

  // --- 错误状态：前次解锁失败 ---
  if (detect.state === PshState.ERROR) {
    await shell.close();
    return {
      content: [
        text(
          `PSH is in ERROR state (previous unlock may have failed). Close and retry.`
        ),
      ],
    };
  }

  // --- 锁定状态：执行解锁序列 ---
  if (detect.state === PshState.LOCKED) {
    // key 参数决定密钥获取方式：
    //   传入 key → 直接使用，不走 KeyProvider 回调
    //   未传 key → 通过 KeyProvider（文件 IPC 或终端提示）获取
    const unlockKey = args.key ?? "";
    const onKeyRequest = args.key
      ? undefined
      : (output: string) => {
        const keyProvider = new KeyProvider(
          getKeyProviderConfig("ssh", args.device)
        );
        return keyProvider.getKey(output);
      };

    const result = await handler.unlock(
      shell,
      unlockKey,
      stepDelay,
      onKeyRequest
    );

    if (result.success) {
      const sessionId = `ssh_${++sessionCounter}`;
      sessions.set(sessionId, shell);
      logger.info(
        `[ssh_shell_login] session opened: ${sessionId} (unlock succeeded)`
      );
      return {
        content: [
          text(
            `Session ${sessionId} opened (PSH unlock succeeded).\nProfile: ${handler.profile.name}\nChallenge: ${result.challengeCode ?? "(none)"}`
          ),
        ],
      };
    }

    await shell.close();
    return {
      content: [
        text(
          `PSH unlock failed.\nState: ${result.state}\nChallenge: ${result.challengeCode ?? "(none)"}\nAttempts left: ${result.attemptsLeft ?? "(unknown)"}\nError: ${result.error ?? "(none)"}`
        ),
      ],
    };
  }

  // --- 未知状态：探测后仍无法判断，返回 session 但可能需手动交互 ---
  const sessionId = `ssh_${++sessionCounter}`;
  sessions.set(sessionId, shell);
  logger.info(
    `[ssh_shell_login] session opened: ${sessionId} (PSH state unknown)`
  );
  return {
    content: [
      text(
        `Session ${sessionId} opened (PSH state unknown, shell may need manual interaction).\nProfile: ${handler.profile.name}\nBanner: ${banner}`
      ),
    ],
  };
}

// ── 进程退出自动清理 ────────────────────────────────────────

/**
 * @brief 关闭所有活跃的 SSH 会话
 *
 * 在 MCP Server 进程退出时调用，确保所有 SSH 连接被正确关闭，
 * 释放网络资源。
 */
export async function disposeAllSshSessions(): Promise<void> {
  const entries = [...sessions.entries()];
  for (const [id, shell] of entries) {
    try {
      await shell.close();
      logger.info(`[ssh_dispose] session ${id} closed`);
    } catch (err) {
      logger.error(`[ssh_dispose] session ${id} close failed:`, err);
    }
  }
  sessions.clear();
}
