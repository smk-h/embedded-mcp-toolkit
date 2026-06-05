import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import {
  SerialShell,
  type SerialShellConfig,
} from "../../../transport/serial.js";
import {
  getSerialConfig,
  getKeyProviderConfig,
} from "../../../infra/config.js";
import { PshState, PshStateMachine, PSH_STATE_DESC } from "../../../transport/psh.js";
import { KeyProvider } from "../../../utils/key-provider.js";
// ── 会话存储 ────────────────────────────────────────────────

/**
 * @brief 串口 Shell 会话存储表
 *
 * 以 session_id 为键，SerialShell 实例为值，
 * 所有串口 MCP 工具通过此表查找和共享会话。
 */
const sessions = new Map<string, SerialShell>();

/** @brief COM 口到 session_id 的映射，用于防止同一串口被重复打开 */
const portToSession = new Map<string, string>();

/** @brief 会话自增计数器，用于生成唯一 session_id */
let sessionCounter = 0;

// ── serial_open ─────────────────────────────────────────────

/**
 * @brief serial_open 工具配置
 *
 * 打开一个串口连接并启动交互式 shell 会话，返回初始 banner 输出。
 *
 * @param device    设备名（可选，默认使用当前活跃设备）
 * @param port      串口设备路径（如 COM3、/dev/ttyUSB0）
 * @param baudRate  波特率（默认 115200）
 * @param dataBits  数据位（5/6/7/8，默认 8）
 * @param stopBits  停止位（1/1.5/2，默认 1）
 * @param parity    校验位（none/even/odd，默认 none）
 */
export const serialOpenConfig = {
  description:
    "Open a serial port connection and start an interactive shell session. Returns the initial banner output.",
  inputSchema: fromJsonSchema<{
    device?: string;
    port?: string;
    baudRate?: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
  }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
      port: {
        type: "string",
        description:
          "Serial port path (e.g. COM3, /dev/ttyUSB0). Overrides device config if provided.",
      },
      baudRate: {
        type: "number",
        description: "Baud rate (default: 115200)",
      },
      dataBits: {
        type: "number",
        description: "Data bits: 5, 6, 7, or 8 (default: 8)",
      },
      stopBits: {
        type: "number",
        description: "Stop bits: 1, 1.5, or 2 (default: 1)",
      },
      parity: {
        type: "string",
        description: "Parity: none, even, or odd (default: none)",
      },
    },
  }),
};

/**
 * @brief serial_open 处理函数
 *
 * 流程：
 *   1. 根据设备名获取串口连接配置，参数覆盖优先级：显式参数 > 设备配置
 *   2. 创建 SerialShell 实例并打开串口连接
 *   3. 读取 banner 输出
 *   4. 将 shell 存入会话表，返回 session_id
 *
 * @param args  工具参数
 * @return MCP 响应，包含 session_id 和 banner 内容
 */
export async function serialOpenHandler(args: {
  device?: string;
  port?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
}) {
  logger.info(
    `[serial_open] device=${args.device ?? "(default)"} port=${args.port ?? "(auto)"} baudRate=${args.baudRate ?? 115200}`
  );
  // 获取设备配置，显式参数覆盖设备配置
  const baseConfig: SerialShellConfig = getSerialConfig(args.device);
  const config: SerialShellConfig = {
    port: args.port ?? baseConfig.port,
    baudRate: args.baudRate ?? baseConfig.baudRate,
    dataBits: (args.dataBits ?? baseConfig.dataBits) as
      | 8
      | 5
      | 6
      | 7
      | undefined,
    stopBits: (args.stopBits ?? baseConfig.stopBits) as 1 | 1.5 | 2 | undefined,
    parity: (args.parity ?? baseConfig.parity) as
      | "none"
      | "even"
      | "odd"
      | undefined,
    lineEnding: baseConfig.lineEnding,
  };

  if (config.port === "none") {
    const msg = `Device '${args.device ?? "(default)"}' does not support serial (port is none).`;
    logger.warn(msg);
    return { content: [text(msg)] };
  }

  // 检查该 COM 口是否已有活跃会话
  const existingId = portToSession.get(config.port);
  if (existingId && sessions.has(existingId)) {
    return {
      content: [
        text(
          `Serial port ${config.port} is already open as session ${existingId}.`
        ),
      ],
    };
  }

  const shell = new SerialShell(config);

  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return {
      content: [
        text(
          `Serial open failed: ${err instanceof Error ? err.message : String(err)}`
        ),
      ],
    };
  }

  const sessionId = `serial_${++sessionCounter}`;
  sessions.set(sessionId, shell);
  portToSession.set(config.port, sessionId);
  logger.info(`[serial_open] session opened: ${sessionId} port=${config.port}`);
  shell.fileLogger.enableFromEnv(sessionId);

  return {
    content: [
      text(
        `Session ${sessionId} opened on ${config.port} @ ${config.baudRate ?? 115200}.\n${banner || "(no banner)"}`
      ),
    ],
  };
}

// ── serial_close ─────────────────────────────────────────────

/**
 * @brief serial_close 工具配置
 *
 * 关闭指定的串口会话并释放串口资源。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 */
export const serialCloseConfig = {
  description: "Close a serial port session and release the port.",
  inputSchema: fromJsonSchema<{ session_id: string }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief serial_close 处理函数
 *
 * 流程：
 *   1. 从会话表中查找指定 session_id
 *   2. 调用 shell.close() 关闭串口连接
 *   3. 从会话表和端口映射表中移除该条目
 *
 * @param args  工具参数，包含 session_id
 * @return MCP 响应，确认会话已关闭
 */
export async function serialCloseHandler(args: { session_id: string }) {
  logger.info(`[serial_close] session_id=${args.session_id}`);
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  const port = shell.getPort();
  await shell.close();
  sessions.delete(args.session_id);
  if (port) {
    portToSession.delete(port);
  }

  return { content: [text(`Session ${args.session_id} closed.`)] };
}

// ── serial_write ─────────────────────────────────────────────

/**
 * @brief serial_write 工具配置
 *
 * 向指定的串口会话发送命令。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param command     要发送的命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const serialWriteConfig = {
  description: "Send a command to a serial shell session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    clear?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
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
 * @brief serial_write 处理函数
 *
 * 向串口 shell 发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 serial_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @return MCP 响应，确认命令已发送
 */
export function serialWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[serial_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  shell.write(args.command, args.clear ?? 1);

  return { content: [text(`Command sent: ${args.command}`)] };
}

// ── serial_read ──────────────────────────────────────────────

/**
 * @brief serial_read 工具配置
 *
 * 读取指定串口会话的输出数据。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param clear       缓冲区清空标志（1=读取后清空，0=保留缓冲区，默认 1）
 */
export const serialReadConfig = {
  description: "Read output from a serial shell session.",
  inputSchema: fromJsonSchema<{ session_id: string; clear?: number }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
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
 * @brief serial_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @return MCP 响应，包含读取到的输出内容
 */
export function serialReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[serial_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  const output = shell.read(args.clear ?? 1);

  return { content: [text(output || "(no output)")] };
}

// ── serial_list ──────────────────────────────────────────────

/**
 * @brief serial_list 工具配置
 *
 * 列出当前所有活跃的串口会话及其端口信息。
 */
export const serialListConfig = {
  description: "List all active serial sessions with port and session ID.",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

/**
 * @brief serial_list 处理函数
 *
 * 遍历会话存储表，返回每个活跃会话的 session_id 和对应端口。
 *
 * @return MCP 响应，包含活跃会话列表或"无活跃会话"提示
 */
export function serialListHandler() {
  logger.info("[serial_list]");
  if (sessions.size === 0) {
    return { content: [text("No active serial sessions.")] };
  }

  const lines: string[] = [];
  for (const [sessionId, shell] of sessions) {
    lines.push(`${sessionId} -> ${shell.getPort()}`);
  }

  return { content: [text(`Active serial sessions:\n${lines.join("\n")}`)] };
}

// ── serial_exec ──────────────────────────────────────────────

/**
 * @brief serial_exec 工具配置
 *
 * 向串口会话发送命令并等待输出，合并 write + delay + read 为一次调用。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param command     要执行的命令字符串
 * @param delay       发送后等待时间（毫秒，默认 1000）
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const serialExecConfig = {
  description:
    "Send a command to a serial shell session and wait for the output. Combines write + delay + read in one call.",
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
        description: "The session ID returned by serial_open",
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
 * @brief serial_exec 处理函数
 *
 * 一次性完成命令发送、等待、读取三个步骤，适用于简单的命令执行场景。
 * 对于需要精细控制缓冲区或多次交互的场景，应分别使用 write + read。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear
 * @return MCP 响应，包含命令执行后的输出内容
 */
export async function serialExecHandler(args: {
  session_id: string;
  command: string;
  delay?: number;
  clear?: number;
}) {
  logger.info(
    `[serial_exec] session_id=${args.session_id} command=${args.command} delay=${args.delay ?? 1000} clear=${args.clear ?? 1}`
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

// ── serial_shell_login ──────────────────────────────────────────

/**
 * @brief serial_shell_login 工具配置
 *
 * 一键登录串口：自动连接、检测 PSH 状态、如锁定则自动解锁，返回就绪会话。
 * 将 open + PSH 检测 + 解锁合并为单次调用，适用于需要快速获取可用串口 shell 的场景。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param key      解锁密钥（可选，提供时直接使用；未提供时走 KeyProvider 获取）
 * @param timeout  解锁步骤间等待时间（毫秒，默认 1500）
 */
export const serialShellLoginConfig = {
  description:
    "One-click serial login: connect, detect PSH state, auto-unlock if locked, and return a ready session. Combines open + PSH detect + unlock into a single call.",
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
 * @brief serial_shell_login 处理函数 — 串口一键登录
 *
 * 使用 PshStateMachine 状态机替代手动 if-else 探测逻辑：
 *   1. 打开串口（或复用已有 session），读取 banner
 *   2. 状态机自动完成 profile 匹配 + 状态检测（含探测/二次确认）
 *   3. 根据状态机终态分支处理：
 *      - READY       → PSH 已解锁或无 PSH，直接返回可用 session
 *      - LOCKED      → 执行解锁序列（key 参数直接传入，或走 KeyProvider 回调）
 *      - UNLOCKING   → 悬挂的密码提示，提供 key 完成输入
 *      - ERROR       → 前次解锁失败，关闭连接并提示
 *      - UNKNOWN     → 状态不明，返回 session 但可能需手动交互
 *   4. 解锁成功后将 shell 存入会话表，返回 session_id
 *
 * key 参数说明：
 *   - 传入 key：直接使用该密钥解锁，适用于密钥已知的自动化场景
 *   - 不传 key：通过 KeyProvider（文件 IPC 或终端提示）获取密钥，
 *     适用于交互式或外部工具提供密钥的场景
 *
 * @param args  工具参数，包含可选的 device、key 和 timeout
 * @return MCP 响应，包含 session_id 和登录结果信息
 */
export async function serialShellLoginHandler(args: {
  device?: string;
  key?: string;
  timeout?: number;
}) {
  logger.info(
    `[serial_shell_login] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 1500} key=${args.key ? "***" : "(none)"}`
  );
  const baseConfig: SerialShellConfig = getSerialConfig(args.device);

  if (baseConfig.port === "none") {
    const msg = `Device '${args.device ?? "(default)"}' does not support serial (port is none).`;
    logger.warn(msg);
    return { content: [text(msg)] };
  }

  const stepDelay = args.timeout ?? 1500;

  // ===== 打开串口（或复用已有 session）=====
  const existingId = portToSession.get(baseConfig.port);
  let shell: SerialShell;
  let banner: string;

  if (existingId && sessions.has(existingId)) {
    shell = sessions.get(existingId)!;
    banner = shell.read(0);
  } else {
    shell = new SerialShell({
      port: baseConfig.port,
      baudRate: baseConfig.baudRate,
      dataBits: baseConfig.dataBits as 8 | 5 | 6 | 7 | undefined,
      stopBits: baseConfig.stopBits as 1 | 1.5 | 2 | undefined,
      parity: baseConfig.parity as "none" | "even" | "odd" | undefined,
      lineEnding: baseConfig.lineEnding,
    });
    try {
      banner = await shell.open();
    } catch (err) {
      return {
        content: [
          text(
            `Serial open failed: ${err instanceof Error ? err.message : String(err)}`
          ),
        ],
      };
    }
    // open 成功后立即注册会话并启用日志，确保解锁/探测过程的串口数据被保存
    const newId = `serial_${++sessionCounter}`;
    sessions.set(newId, shell);
    portToSession.set(baseConfig.port, newId);
    shell.fileLogger.enableFromEnv(newId);
  }

  // ===== 状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("serial");
  let action = sm.start(banner);

  while (!action.done) {
    shell.write(action.send!, 1);
    await new Promise((r) => setTimeout(r, action.waitMs));
    action = await sm.feed(shell, shell.read(1));
  }

  const handler = action.handler;
  logger.info(
    `[serial_shell_login] PshSM 检测完成 → state=${action.state} (${PSH_STATE_DESC[action.state]}), profile=${handler?.profile.name ?? "(无)"}`
  );

  // ===== 根据状态机终态分支处理 =====

  // --- 已解锁 / 无 PSH ---
  if (action.state === PshState.READY) {
    logger.info(`[serial_shell_login] shell已可用, profile=${handler?.profile.name ?? "(无)"}`);
    const detail = handler
      ? `(PSH already unlocked)\nProfile: ${handler.profile.name}`
      : "(no PSH detected, shell is ready)";
    return registerSession(shell, baseConfig.port, existingId, detail);
  }

  // --- 解锁中：悬挂的密码提示，需 key 完成输入 ---
  if (action.state === PshState.UNLOCKING) {
    if (!args.key) {
      logger.warn(`[serial_shell_login] PSH处于UNLOCKING状态但未提供密钥`);
      if (!existingId) await shell.close();
      return {
        content: [
          text(
            "PSH is in UNLOCKING state (dangling password prompt). Provide a key to complete login."
          ),
        ],
      };
    }
    logger.info(`[serial_shell_login] PSH处于UNLOCKING状态, 使用提供的密钥完成解锁`);
    shell.write(args.key, 1);
    await new Promise((r) => setTimeout(r, stepDelay));
    const output = shell.read(1);
    const state = handler?.detectState(output) ?? PshState.UNKNOWN;
    if (state === PshState.READY) {
      logger.info(`[serial_shell_login] UNLOCKING状态解锁成功`);
      return registerSession(
        shell,
        baseConfig.port,
        existingId,
        `(PSH unlock completed from UNLOCKING state)\nProfile: ${handler!.profile.name}`
      );
    }
    logger.error(`[serial_shell_login] UNLOCKING状态解锁失败, finalState=${state}`);
    if (!existingId) await shell.close();
    return {
      content: [
        text(
          `PSH unlock from UNLOCKING state failed. State: ${state}\nOutput: ${output}`
        ),
      ],
    };
  }

  // --- 错误状态：前次解锁失败 ---
  if (action.state === PshState.ERROR) {
    logger.error(`[serial_shell_login] PSH处于ERROR状态`);
    if (!existingId) await shell.close();
    return {
      content: [
        text(
          "PSH is in ERROR state (previous unlock may have failed). Close and retry."
        ),
      ],
    };
  }

  // --- 锁定状态：执行解锁序列 ---
  if (action.state === PshState.LOCKED) {
    if (!handler) {
      logger.warn(`[serial_shell_login] PSH已锁定但无匹配handler`);
      if (!existingId) await shell.close();
      return { content: [text("PSH LOCKED but no matching handler found.")] };
    }

    const unlockKey = args.key ?? "";
    const onKeyRequest = args.key
      ? undefined
      : (output: string) => {
          const keyProvider = new KeyProvider(
            getKeyProviderConfig("serial", args.device)
          );
          return keyProvider.getKey(output);
        };

    logger.info(`[serial_shell_login] 开始解锁 (profile=${handler.profile.name}, key=${args.key ? "已提供" : "走KeyProvider"})`);
    const result = await handler.unlock(
      shell,
      unlockKey,
      stepDelay,
      onKeyRequest
    );

    if (result.success) {
      logger.info(`[serial_shell_login] 解锁成功`);
      return registerSession(
        shell,
        baseConfig.port,
        existingId,
        `(PSH unlock succeeded)\nProfile: ${handler.profile.name}\nChallenge: ${result.challengeCode ?? "(none)"}`
      );
    }

    logger.error(`[serial_shell_login] 解锁失败, state=${result.state}, error=${result.error ?? "无"}`);
    if (!existingId) await shell.close();
    return {
      content: [
        text(
          `PSH unlock failed.\nState: ${result.state}\nChallenge: ${result.challengeCode ?? "(none)"}\nAttempts left: ${result.attemptsLeft ?? "(unknown)"}\nError: ${result.error ?? "(none)"}`
        ),
      ],
    };
  }

  // --- 未知状态：探测后仍无法判断，返回 session 但可能需手动交互 ---
  logger.info(`[serial_shell_login] PSH状态不明, 可能需手动交互`);
  const detail = handler
    ? `(PSH state unknown)\nProfile: ${handler.profile.name}`
    : "(PSH state unknown)";
  return registerSession(shell, baseConfig.port, existingId, detail);
}

// ── serial_enter_uboot ────────────────────────────────────────

/**
 * @brief serial_enter_uboot 工具配置
 *
 * 通过串口重启设备并在 U-Boot 自动引导倒计时期间发送按键中断引导，
 * 进入 U-Boot 命令行。支持检测多种 autoboot 提示和 U-Boot 命令提示符。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param timeout     等待 autoboot 提示的总超时时间（秒，默认 60）
 */
export const serialEnterUbootConfig = {
  description:
    "Enter U-Boot by rebooting the device and stopping autoboot. Detects 'Hit any key' or 'Hit Ctrl+u' prompts, and '=>' or 'U-Boot>' command prompts.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      timeout: {
        type: "number",
        description:
          "Total timeout in seconds to wait for autoboot prompt (default: 60)",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief serial_enter_uboot 处理函数
 *
 * 流程：
 *   1. 发送 reboot 命令重启设备
 *   2. 轮询串口输出，检测 autoboot 提示：
 *      - "Hit any key to stop autoboot" → 发送换行键
 *      - "Hit Ctrl+u to stop autoboot"  → 发送 \x15（Ctrl+u）
 *   3. 根据提示内容自动判断发送换行还是 Ctrl+u
 *   4. 继续轮询检测 U-Boot 命令提示符：
 *      - "=>" (标准 U-Boot 提示符)
 *      - "U-Boot>" (部分厂商自定义提示符)
 *   5. 返回 U-Boot 命令行输出
 *
 * @param args  工具参数，包含 session_id 和可选的 timeout
 * @return MCP 响应，包含进入 U-Boot 的结果和输出
 */
export async function serialEnterUbootHandler(args: {
  session_id: string;
  timeout?: number;
}) {
  const timeoutSec = args.timeout ?? 60;
  logger.info(
    `[serial_enter_uboot] session_id=${args.session_id} timeout=${timeoutSec}s`
  );

  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  // Autoboot 提示模式
  const AUTOBOOT_ANY_KEY_RE = /Hit\s+any\s+key\s+to\s+stop\s+autoboot/i;
  const AUTOBOOT_CTRL_U_RE = /Hit\s+Ctrl\+u\s+to\s+stop\s+autoboot/i;

  // U-Boot 命令提示符模式
  const UBOOT_PROMPT_RE = /(?:=>|U-Boot>)\s*$/;

  // 发送 reboot 重启设备
  shell.write("reboot", 1);
  logger.info(
    `[serial_enter_uboot] cmd=reboot sent, waiting for autoboot prompt...`
  );
  const deadline = Date.now() + timeoutSec * 1000;
  let allOutput = "";
  let enteredUboot = false;
  let interruptKey = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const chunk = shell.read(0); // 不清空缓冲区，持续累积
    if (chunk) allOutput += chunk;

    // 检测 autoboot 提示 — 优先匹配 Ctrl+u，再匹配 any key
    if (!enteredUboot) {
      if (AUTOBOOT_CTRL_U_RE.test(allOutput)) {
        interruptKey = "Ctrl+u";
        logger.info("[serial_enter_uboot] detected Ctrl+u autoboot prompt");
      } else if (AUTOBOOT_ANY_KEY_RE.test(allOutput)) {
        interruptKey = "Enter";
        logger.info("[serial_enter_uboot] detected any-key autoboot prompt");
      }

      if (interruptKey) {
        if (interruptKey === "Ctrl+u") {
          shell.sendRaw("\x15", 1); // 发送 Ctrl+u
        } else {
          shell.sendRaw("\n", 1); // 发送换行键
        }
        enteredUboot = true;
        allOutput = ""; // 重置，接下来只收集 U-Boot 输出
        continue;
      }
    }

    // 检测 U-Boot 命令提示符
    if (enteredUboot && UBOOT_PROMPT_RE.test(allOutput)) {
      const finalOutput = shell.read(1);
      if (finalOutput) allOutput += finalOutput;
      return {
        content: [
          text(
            `Entered U-Boot successfully (interrupt: ${interruptKey}).\n\n${allOutput.trim()}`
          ),
        ],
      };
    }
  }

  // 超时
  const remaining = shell.read(1);
  if (remaining) allOutput += remaining;

  return {
    content: [
      text(
        `Timeout after ${timeoutSec}s waiting for U-Boot.\n\n${allOutput.trim() || "(no output)"}`
      ),
    ],
  };
}

/** 注册 session（复用已有或新建），返回统一的 MCP 响应 */
function registerSession(
  shell: SerialShell,
  port: string,
  existingId: string | undefined,
  detail: string
) {
  // 若已通过 portToSession 注册（如提前在 shell.login 中注册），直接复用
  const registeredId = existingId ?? portToSession.get(port);
  if (registeredId && sessions.has(registeredId)) {
    logger.info(
      `[serial_shell_login] session reused: ${registeredId} port=${port}`
    );
    return {
      content: [text(`Session ${registeredId} on ${port} (existing, ${detail})`)],
    };
  }
  const sessionId = `serial_${++sessionCounter}`;
  sessions.set(sessionId, shell);
  portToSession.set(port, sessionId);
  logger.info(`[serial_shell_login] session opened: ${sessionId} port=${port}`);
  shell.fileLogger.enableFromEnv(sessionId);
  return {
    content: [text(`Session ${sessionId} opened on ${port} ${detail}`)],
  };
}

// ── 进程退出自动清理 ────────────────────────────────────────

/**
 * @brief 关闭所有活跃的串口会话
 *
 * 在 MCP Server 进程退出时调用，确保所有串口连接被正确关闭，
 * 释放端口资源，避免串口残留占用。
 */
export async function disposeAllSerialSessions(): Promise<void> {
  const entries = [...sessions.entries()];
  for (const [id, shell] of entries) {
    try {
      await shell.close();
      logger.info(`[serial_dispose] session ${id} closed`);
    } catch (err) {
      logger.error(`[serial_dispose] session ${id} close failed:`, err);
    }
  }
  sessions.clear();
  portToSession.clear();
}
