/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : shell.ts
 * Author     : sumu
 * Date       : 2026/05/26
 * Version    : x.x.x
 * Description: Serial 交互式 Shell SDK 工具（协议无关，MCP 注册见 src/mcp/tools/serial）
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";
import {
  SerialShell,
  type SerialShellConfig,
} from "../../../transports/serial.js";
import {
  getPromptPattern,
  getExecTimeoutConfig,
  getSerialConfig,
  getKeyProviderConfig,
  getUbootConfig,
  resolveDeviceName,
} from "../../../shared/config.js";
import {
  PshState,
  PshStateMachine,
  PshHandler,
  PSH_STATE_DESC,
} from "../../../services/psh.js";
import {
  UserLoginHandler,
  UserLoginStatus,
} from "../../../services/user-login.js";
import { KeyProvider } from "../../../services/key-provider.js";
import {
  serialStore,
  portToSession,
  isUbootSession,
  markUbootSession,
  clearUbootSession,
} from "./sessions.js";
import {
  CONTROL_CHAR_MAP,
  type ControlChar,
  PromptDetector,
  UbootDetector,
} from "../../shared/prompt-detector.js";
import { sendControlChar } from "../../shared/send-ctrl.js";
import { runExec } from "../../shared/exec-runner.js";

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
export const serialOpenConfig: SdkToolConfig = {
  description:
    "Open a serial port connection and start an interactive shell session. Returns the initial banner output.",
  inputSchema: {
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
  },
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
  const deviceName = args.device ?? process.env.DEVICE ?? "default";
  const baseConfig: SerialShellConfig = getSerialConfig(args.device);
  const config: SerialShellConfig = {
    port: args.port ?? baseConfig.port,
    baudRate: args.baudRate ?? baseConfig.baudRate,
    dataBits: (args.dataBits ?? baseConfig.dataBits) as
      8 | 5 | 6 | 7 | undefined,
    stopBits: (args.stopBits ?? baseConfig.stopBits) as 1 | 1.5 | 2 | undefined,
    parity: (args.parity ?? baseConfig.parity) as
      "none" | "even" | "odd" | undefined,
    lineEnding: baseConfig.lineEnding,
    deviceName,
  };

  if (config.port === "none") {
    const msg = `Device '${deviceName}' does not support serial (port is none).`;
    logger.warn(msg);
    return msg;
  }

  // 检查该 COM 口是否已有活跃会话
  const existingId = portToSession.get(config.port);
  if (existingId && serialStore.get(existingId)) {
    return `Serial port ${config.port} is already open as session ${existingId}.`;
  }

  const shell = new SerialShell(config);

  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return `Serial open failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = serialStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  serialStore.create(shell, {
    type: "serial",
    deviceName,
    connectionInfo: `${config.port} @ ${config.baudRate ?? 115200}`,
    logPath,
  });
  portToSession.set(config.port, sessionId);
  logger.info(`[serial_open] session opened: ${sessionId} port=${config.port}`);

  return `Session ${sessionId} opened on ${config.port} @ ${config.baudRate ?? 115200}.\n${banner || "(no banner)"}`;
}

// ── serial_close ─────────────────────────────────────────────

/**
 * @brief serial_close 工具配置
 *
 * 关闭指定的串口会话并释放串口资源。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 */
export const serialCloseConfig: SdkToolConfig = {
  description: "Close a serial port session and release the port.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
    },
    required: ["session_id"],
  },
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
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  const port = shell.getPort();
  // 在锁内执行 close，确保没有其他操作正在使用 shell
  await serialStore.withLock(args.session_id, async () => {
    await shell.close();
  });
  // close 完成后再 remove（同时清理 mutex）
  serialStore.remove(args.session_id);
  if (port) {
    portToSession.delete(port);
  }
  clearUbootSession(args.session_id);

  return `Session ${args.session_id} closed.`;
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
export const serialWriteConfig: SdkToolConfig = {
  description:
    "Send a command to a serial shell session. " +
    "Do NOT call this concurrently with serial_exec/serial_read on the same session_id — " +
    "concurrent access to the same serial console corrupts the output buffer.",
  inputSchema: {
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
  },
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
export async function serialWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[serial_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    shell.write(args.command, args.clear ?? 1);
    return `Command sent: ${args.command}`;
  });
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
export const serialReadConfig: SdkToolConfig = {
  description:
    "Read output from a serial shell session. " +
    "Do NOT call this concurrently with serial_exec/serial_write on the same session_id — " +
    "concurrent access to the same serial console corrupts the output buffer.",
  inputSchema: {
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
  },
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
export async function serialReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[serial_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    const output = shell.read(args.clear ?? 1);
    return output || "(no output)";
  });
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
export const serialExecConfig: SdkToolConfig = {
  description:
    "Send a command to a serial shell session and wait for the output. Combines write + delay + read in one call. " +
    "IMPORTANT: Do NOT issue concurrent commands to the same session_id — the serial console is a single " +
    "channel; concurrent calls will interleave output and corrupt results. " +
    "Always wait for the previous command to finish before sending the next one. " +
    "If you need parallel execution, open multiple sessions via serial_open.",
  inputSchema: {
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
          "Minimum polling duration in milliseconds (default: 1000), kept for backward compat",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
      maxDuration: {
        type: "number",
        description:
          "Execution cap in ms — ALWAYS estimate and pass a timeout matching the command's expected runtime; " +
          "do not omit it. Suggested ranges: instant info commands (ls/ip addr/cat/echo) 3000-5000; " +
          "medium tasks (apt install, dd, service restart) 30000-120000; " +
          "long builds/flashes (make, flash_image) up to 600000; " +
          "streaming/resident commands (ping/logcat/top, or sampling a fixed window of live output) " +
          "10000 (Ctrl+C auto-sent to stop). If omitted, safety-valve defaults apply: " +
          "resident commands 10000ms (sampling, Ctrl+C sent on timeout), " +
          "other commands 300000ms (5min fallback, NO interrupt sent — the command may still be running, " +
          "terminate via send_ctrl if needed). Timeout type is annotated in the returned output.",
      },
    },
    required: ["session_id", "command"],
  },
};

/**
 * @brief serial_exec 处理函数
 *
 * 通过 runExec 统一编排完成命令发送、轮询、提示符检测、超时熔断。
 * 常驻命令超时自动采样（发 Ctrl+C，返回采样超时标注）；
 * 普通命令靠提示符检测返回，仅提示符未匹配时走兜底超时（不发 Ctrl+C，返回兜底超时标注）。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear、maxDuration
 * @return MCP 响应，包含命令执行后的输出内容（超时时按类型追加采样/兜底超时标注）
 */
export async function serialExecHandler(args: {
  session_id: string;
  command: string;
  delay?: number;
  clear?: number;
  maxDuration?: number;
}) {
  const delayVal = args.delay ?? 1000;
  const clearVal = args.clear ?? 1;
  const maxDurationVal = args.maxDuration;
  logger.info(
    `[serial_exec] session_id=${args.session_id} command=${args.command} delay=${delayVal} clear=${clearVal} maxDuration=${maxDurationVal ?? "(default)"}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  const deviceName = resolveDeviceName();

  const execTimeoutConfig = getExecTimeoutConfig(deviceName);

  const sendCtrl = (key: ControlChar): void => {
    shell.write(CONTROL_CHAR_MAP[key], 1, false);
  };

  return serialStore.withLock(args.session_id, async () => {
    const wasUboot = isUbootSession(args.session_id);

    // U-Boot 态的 2级回落检测用默认提示符正则，而非设备 promptPattern：
    // promptPattern 是为 Linux PS1 配置的，在 U-Boot 态（=> 提示符）可能永不
    // 命中——marker 失败的场景（hush 解析错误、无 echo）会等满兜底超时。
    // 默认正则同时覆盖 U-Boot 与常见 Linux/Android 提示符：留在 U-Boot 时
    // 锚定 => ，离开 U-Boot 落到 Linux 提示符时也能尽快返回（配合下方自校正）。
    const promptDetector = new PromptDetector(
      wasUboot ? undefined : getPromptPattern(deviceName)
    );

    const execResult = await runExec({
      shell,
      command: args.command,
      delay: delayVal,
      clear: clearVal,
      maxDuration: maxDurationVal,
      promptDetector,
      sendCtrl,
      logPrefix: "[serial_exec]",
      execTimeoutConfig,
      // U-Boot 态会话（serial_enter_uboot 标记）marker 用 plain 风格：
      // 去掉子 shell 括号（hush 无该语法），`; echo` 仍无条件执行，
      // 1级 marker 检测照常生效
      markerStyle: wasUboot ? "plain" : "subshell",
    });

    // U-Boot 态执行后自校正标记：若本次执行表明已离开 U-Boot，清除会话标记，
    // 后续 serial_exec 恢复 subshell 包装。覆盖两类离开场景：
    //   1. reset/boot/bootm 等离开 U-Boot：输出出现内核启动特征（任意完成路径均可命中）
    //   2. 设备自动重启回到内核：exec 经 2级提示符锚定正常结束，且末尾提示符
    //      已非 U-Boot 提示符。注意仅限 completedBy=prompt——marker 完成的输出
    //      截断于 marker、不含末尾提示符，无法据此判定环境（此时标记保留：
    //      plain 包装在 Linux 下同样可用，仅失去子 shell 防护，无功能性破坏）
    if (wasUboot) {
      let leftUboot = false;
      try {
        const ubootDetector = new UbootDetector(getUbootConfig(deviceName));
        leftUboot =
          ubootDetector.matchKernelBoot(execResult.output) ||
          (execResult.completedBy === "prompt" &&
            !ubootDetector.matchPrompt(execResult.output));
      } catch (err) {
        // uboot 配置含非法正则时不应阻断 exec 主流程，跳过本次自校正
        logger.warn(
          `[serial_exec] uboot detector config error, skip self-correction: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (leftUboot) {
        clearUbootSession(args.session_id);
        logger.info(`[serial_exec] left U-Boot detected, cleared session mark`);
      }
    }

    let output = execResult.output;
    if (execResult.timeoutKind === "none" && execResult.exitCode !== null) {
      output =
        (output ? output + "\n" : "") + `[exit code: ${execResult.exitCode}]`;
    } else if (execResult.timeoutKind === "sampling") {
      output =
        (output ? output + "\n" : "") +
        `[采样超时: 已收集 ${execResult.elapsedMs}ms 输出，已发送 Ctrl+C 终止常驻命令]`;
    } else if (execResult.timeoutKind === "fallback") {
      output =
        (output ? output + "\n" : "") +
        `[兜底超时: 已收集 ${execResult.elapsedMs}ms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`;
    }

    return output || "(no output)";
  });
}

// ── serial_send_ctrl ───────────────────────────────────────────

/**
 * @brief 控制字符可读名称映射（用于返回信息展示）
 */
const CTRL_LABEL: Readonly<Record<ControlChar, string>> = {
  c: "Ctrl+C",
  u: "Ctrl+U",
  d: "Ctrl+D",
  z: "Ctrl+Z",
};

/**
 * @brief serial_send_ctrl 工具配置
 *
 * 向串口 Shell 会话发送控制字符（不追加换行），用于终止/控制前台命令。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param key         控制字符类型：c(Ctrl+C)/u(Ctrl+U)/d(Ctrl+D)/z(Ctrl+Z)
 */
export const serialSendCtrlConfig: SdkToolConfig = {
  description:
    "Send a control character (Ctrl+C/U/D/Z) to a serial shell session without appending a newline.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      key: {
        type: "string",
        enum: ["c", "u", "d", "z"],
        description:
          "Control character: c=Ctrl+C(SIGINT), u=Ctrl+U(clear line), d=Ctrl+D(EOF), z=Ctrl+Z(suspend)",
      },
    },
    required: ["session_id", "key"],
  },
};

/**
 * @brief serial_send_ctrl 处理函数
 *
 * 复用共享 sendControlChar，以不追加换行的方式发送控制字符。
 *
 * @param args  工具参数，包含 session_id 和 key
 * @return MCP 响应，确认控制字符已发送
 */
export async function serialSendCtrlHandler(args: {
  session_id: string;
  key: ControlChar;
}) {
  logger.info(
    `[serial_send_ctrl] session_id=${args.session_id} key=${args.key}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    const byte = await sendControlChar(shell, args.key);
    const label = CTRL_LABEL[args.key];
    return `${label} sent (${byte})`;
  });
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
export const serialShellLoginConfig: SdkToolConfig = {
  description:
    "One-click serial login: connect, detect PSH state, auto-unlock if locked, and return a ready session. Combines open + PSH detect + unlock into a single call.",
  inputSchema: {
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
  },
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
  const deviceName = args.device ?? process.env.DEVICE ?? "default";
  const baseConfig: SerialShellConfig = getSerialConfig(args.device);

  if (baseConfig.port === "none") {
    const msg = `Device '${deviceName}' does not support serial (port is none).`;
    logger.warn(msg);
    return msg;
  }

  const stepDelay = args.timeout ?? 1500;

  // ===== 打开串口（或复用已有 session）=====
  const existingId = portToSession.get(baseConfig.port);

  // 锁的 sessionId：复用已有 session 用 existingId，新建 session 用预览 id（= create 生成的 id）
  const lockId = existingId ?? serialStore.peekNextId();

  // 整个 session 操作流程（open/复用 → 探测 → 解锁 → 注册）都在锁保护内，
  // 避免并发 exec/write/read/send_ctrl 注入命令或污染 buffer
  return serialStore.withLock(lockId, () =>
    serialShellLoginInner(args, deviceName, baseConfig, stepDelay, existingId)
  );
}

/**
 * @brief serial_shell_login 的内部实现（在 session 锁保护内执行）
 *
 * 从 session 复用/新建判定到最终注册返回的完整流程。所有 shell 操作
 * （read/write/sendRaw/状态机探测/解锁序列）都在调用方的 withLock 保护内。
 */
async function serialShellLoginInner(
  args: { device?: string; key?: string; timeout?: number },
  deviceName: string,
  baseConfig: SerialShellConfig,
  stepDelay: number,
  existingId: string | undefined
) {
  let newSessionId: string | undefined;
  let shell: SerialShell;
  let banner: string;

  // 失败时清理新建会话的辅助函数
  const cleanupNewSession = async (): Promise<void> => {
    if (newSessionId) {
      await shell.close();
      serialStore.remove(newSessionId);
      portToSession.delete(baseConfig.port);
    }
  };

  if (existingId && serialStore.get(existingId)) {
    shell = serialStore.get(existingId)!;
    banner = shell.read(0);
  } else {
    shell = new SerialShell({
      port: baseConfig.port,
      baudRate: baseConfig.baudRate,
      dataBits: baseConfig.dataBits as 8 | 5 | 6 | 7 | undefined,
      stopBits: baseConfig.stopBits as 1 | 1.5 | 2 | undefined,
      parity: baseConfig.parity as "none" | "even" | "odd" | undefined,
      lineEnding: baseConfig.lineEnding,
      deviceName,
    });
    try {
      banner = await shell.open();
    } catch (err) {
      return `Serial open failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    // open 成功后立即注册会话并启用日志，确保解锁/探测过程的串口数据被保存
    // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
    const newId = serialStore.peekNextId();
    const logPath = shell.fileLogger.enableFromEnv(newId, deviceName);
    serialStore.create(shell, {
      type: "serial",
      deviceName,
      connectionInfo: `${baseConfig.port} @ ${baseConfig.baudRate ?? 115200}`,
      logPath,
    });
    newSessionId = newId;
    portToSession.set(baseConfig.port, newId);
  }

  // ===== 用户登录判定（先于 PSH 探测，二者互斥）=====
  // 正常系统登录（getty/login）停在 "login:" 提示符；PSH 设备提示符为 locked> / #，
  // 不会出现 login:。先发一个回车唤醒 getty 重绘 login: 提示符（对 shell / PSH 无害），
  // 命中 login: 则走用户名/密码登录；否则照常走 PSH 状态机。
  if (await detectUserLoginPrompt(shell, banner, stepDelay)) {
    logger.info(`[serial_shell_login] 检测到 login: 提示符, 走用户登录`);
    return performUserLogin(
      shell,
      baseConfig,
      existingId,
      deviceName,
      stepDelay
    );
  }

  // ===== 状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("serial");
  let action = sm.start(banner);

  while (!action.done) {
    shell.write(action.send!, 1);
    await new Promise((r) => setTimeout(r, action.waitMs));
    const probeOut = shell.read(1);
    // 探测命令被 login 提示符当用户名吞掉 → 转用户登录
    if (probeOut && isLoginPrompt(probeOut)) {
      return performUserLogin(
        shell,
        baseConfig,
        existingId,
        deviceName,
        stepDelay
      );
    }
    action = await sm.feed(shell, probeOut);
  }

  const handler = action.handler;
  logger.info(
    `[serial_shell_login] PshSM 检测完成 → state=${action.state} (${PSH_STATE_DESC[action.state]}), profile=${handler?.profile.name ?? "(无)"}`
  );

  // ===== 根据状态机终态分支处理 =====

  // --- 已解锁 / 无 PSH ---
  if (action.state === PshState.READY) {
    logger.info(
      `[serial_shell_login] shell已可用, profile=${handler?.profile.name ?? "(无)"}`
    );
    const detail = handler
      ? `(PSH already unlocked)\nProfile: ${handler.profile.name}`
      : "(no PSH detected, shell is ready)";
    return registerSession(
      shell,
      baseConfig.port,
      existingId,
      deviceName,
      detail
    );
  }

  // --- 解锁中：悬挂的密码提示，需 key 完成输入 ---
  if (action.state === PshState.UNLOCKING) {
    // 兜底：若 PshSM 误判（探测被 login 提示符当用户名/密码吞掉），
    // 而设备配置了 loginUsername/loginPassword，则转用户登录流程
    if (baseConfig.loginUsername && baseConfig.loginPassword) {
      logger.info(
        `[serial_shell_login] UNLOCKING但配置了login凭据, 转用户登录`
      );
      return performUserLogin(
        shell,
        baseConfig,
        existingId,
        deviceName,
        stepDelay
      );
    }
    if (!args.key) {
      logger.warn(`[serial_shell_login] PSH处于UNLOCKING状态但未提供密钥`);
      if (!existingId) {
        await cleanupNewSession();
      }
      return "PSH is in UNLOCKING state (dangling password prompt). Provide a key to complete login.";
    }
    logger.info(
      `[serial_shell_login] PSH处于UNLOCKING状态, 使用提供的密钥完成解锁`
    );
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
        deviceName,
        `(PSH unlock completed from UNLOCKING state)\nProfile: ${handler!.profile.name}`
      );
    }
    logger.error(
      `[serial_shell_login] UNLOCKING状态解锁失败, finalState=${state}`
    );
    if (!existingId) await shell.close();
    return `PSH unlock from UNLOCKING state failed. State: ${state}\nOutput: ${output}`;
  }

  // --- 错误状态：前次解锁失败 ---
  if (action.state === PshState.ERROR) {
    logger.error(`[serial_shell_login] PSH处于ERROR状态`);
    if (!existingId) await shell.close();
    return "PSH is in ERROR state (previous unlock may have failed). Close and retry.";
  }

  // --- 锁定状态：执行解锁序列 ---
  if (action.state === PshState.LOCKED) {
    if (!handler) {
      logger.warn(`[serial_shell_login] PSH已锁定但无匹配handler`);
      if (!existingId) {
        await cleanupNewSession();
      }
      return "PSH LOCKED but no matching handler found.";
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

    logger.info(
      `[serial_shell_login] 开始解锁 (profile=${handler.profile.name}, key=${args.key ? "已提供" : "走KeyProvider"})`
    );
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
        deviceName,
        `(PSH unlock succeeded)\nProfile: ${handler.profile.name}\nChallenge: ${result.challengeCode ?? "(none)"}`
      );
    }

    logger.error(
      `[serial_shell_login] 解锁失败, state=${result.state}, error=${result.error ?? "无"}`
    );
    if (!existingId) await shell.close();
    return `PSH unlock failed.\nState: ${result.state}\nChallenge: ${result.challengeCode ?? "(none)"}\nAttempts left: ${result.attemptsLeft ?? "(unknown)"}\nError: ${result.error ?? "(none)"}`;
  }

  // --- 未知状态：探测后仍无法判断，返回 session 但可能需手动交互 ---
  logger.info(`[serial_shell_login] PSH状态不明, 可能需手动交互`);
  const detail = handler
    ? `(PSH state unknown)\nProfile: ${handler.profile.name}`
    : "(PSH state unknown)";
  return registerSession(
    shell,
    baseConfig.port,
    existingId,
    deviceName,
    detail
  );
}

/**
 * @brief login: 提示符判定正则（正常系统登录，getty/login 标准提示符）
 *
 * 匹配行尾的 "login:"（getty 的标准用户名提示）。PSH 设备提示符为 locked> / #，
 * 不会命中此正则，因此可作为用户登录与 PSH 的互斥判定条件。
 */
const LOGIN_PROMPT_RE = /login:\s*$/im;

/**
 * @brief 判定一段终端输出是否停在 "login:" 提示符
 *
 * 纯文本判定，不产生任何终端交互（不发命令、不读端口）。
 *
 * @param text 终端累积输出
 * @returns true = 已停在 login: 提示符（需走用户登录）
 */
function isLoginPrompt(text: string): boolean {
  return LOGIN_PROMPT_RE.test(text);
}

/**
 * @brief 探测终端是否处于用户登录提示符（先于 PSH 探测的互斥判定）
 *
 * 流程：
 *   1. banner 已含 "login:" → 直接判定命中（不打扰终端）
 *   2. banner 匹配 PSH profile → 判定不命中（PSH 设备优先走 PSH 流程）
 *   3. 否则发一个回车唤醒 getty 重绘 login: 提示符（对 shell / PSH 无害），
 *      再结合唤醒输出判定
 *
 * @param shell     串口 shell 实例
 * @param banner    连接后读取到的初始输出
 * @param stepDelay 唤醒后的等待时间（毫秒）
 * @returns true = 终端处于 login: 提示符，应走用户登录
 */
async function detectUserLoginPrompt(
  shell: SerialShell,
  banner: string,
  stepDelay: number
): Promise<boolean> {
  if (isLoginPrompt(banner)) {
    return true;
  }
  if (PshHandler.matchFromOutput(banner, "serial")) {
    return false;
  }
  shell.write("", 1);
  await new Promise((r) => setTimeout(r, stepDelay));
  const wakeOut = shell.read(1);
  return !!wakeOut && isLoginPrompt(banner + "\n" + wakeOut);
}

/**
 * @brief 串口用户名/密码登录（正常系统登录，非 PSH）
 *
 * 终端停在 "login:" 提示符（getty/login 标准登录）时调用。
 * 复用 UserLoginHandler 的登录序列：发用户名 → 等待 Password: → 发密码 → 探测验证。
 * 登录成功后注册会话并返回，失败时关闭新建会话并返回错误信息。
 *
 * @param shell     串口 shell 实例
 * @param config    串口配置（需含 loginUsername / loginPassword）
 * @param existingId 已有会话 ID（复用时不关闭）
 * @param deviceName 设备名
 * @param stepDelay 步骤间等待时间（毫秒）
 * @return MCP 响应，成功含 session_id，失败含原因
 */
async function performUserLogin(
  shell: SerialShell,
  config: SerialShellConfig,
  existingId: string | undefined,
  deviceName: string,
  stepDelay: number
) {
  const username = config.loginUsername ?? "";
  const password = config.loginPassword ?? "";
  if (!username || !password) {
    logger.warn(
      `[serial_shell_login] 用户登录失败: 未配置 loginUsername/loginPassword`
    );
    if (!existingId) await shell.close();
    return "User login required but loginUsername/loginPassword not configured for this device.";
  }

  logger.info(`[serial_shell_login] 用户登录开始 (username=${username})`);

  // 终端复位：若探测命令被 login 提示符当用户名吞掉，终端停在 Password:。
  // 发送 Ctrl+C 中止当前登录并返回 login:，避免用户名被当成密码输入。
  const danglingPassword = /Password:\s*$/im;
  let pending = shell.read(0);
  for (
    let attempt = 0;
    attempt < 3 && danglingPassword.test(pending);
    attempt++
  ) {
    logger.info(
      `[serial_shell_login] 检测到悬挂的 Password:, 发 Ctrl+C 复位登录`
    );
    shell.write(CONTROL_CHAR_MAP["c"], 1, false);
    await new Promise((r) => setTimeout(r, stepDelay));
    pending = shell.read(1);
  }

  const handler = new UserLoginHandler({ username, password });
  const stepDelays: Record<string, number> = {
    [UserLoginStatus.WAITING_PASSWORD]: stepDelay,
    [UserLoginStatus.LOGGED_IN]: stepDelay,
  };
  const result = await handler.login(shell, undefined, stepDelays);

  if (!result.success) {
    logger.error(
      `[serial_shell_login] 用户登录失败, status=${result.status}, error=${result.error ?? "无"}`
    );
    if (!existingId) await shell.close();
    return `User login failed.\nStatus: ${result.status}\nError: ${result.error ?? "(none)"}\nOutput: ${result.output}`;
  }

  logger.info(`[serial_shell_login] 用户登录成功`);
  return registerSession(
    shell,
    config.port,
    existingId,
    deviceName,
    `(user login succeeded)\nUser: ${username}`
  );
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
export const serialEnterUbootConfig: SdkToolConfig = {
  description:
    "Enter U-Boot by rebooting the device and stopping autoboot. " +
    "Detection rules (autoboot prompts, command prompt, verify env keys) " +
    "are configurable via device config serial.uboot; falls back to built-in defaults. " +
    "Two-layer strategy: prompt match first; if not matched within a short window, " +
    "sends 'printenv' and verifies U-Boot env keys. Fails fast on kernel boot or verify timeout.",
  inputSchema: {
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
  },
};

/**
 * @brief serial_enter_uboot 处理函数
 *
 * 流程（两层检测，对应 spec F3）：
 *   1. 从设备配置读 serial.uboot 构造 UbootDetector；配置非法立即返回错误
 *   2. 发送 reboot 重启设备
 *   3. 阶段 1 — autoboot 提示检测：命中配置的 autobootPrompts 即发对应中断键
 *      （含 "Ctrl+c" 字样发 \x03，含 "Ctrl+u" 字样发 \x15，否则发换行）
 *   4. 阶段 2 — 主层：中断后窗口内，命中命令提示符即成功返回（via prompt）；
 *      内核启动特征则立即失败
 *   5. 阶段 3 — 验证层：主层窗口耗尽，发 printenv 一次，命中环境变量键即成功
 *      （via verify）；窗口耗尽或内核启动特征则快速失败
 *   6. 总超时兜底
 *
 * @param args  工具参数，包含 session_id 和可选的 timeout（默认 60 秒）
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

  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    // 构造 U-Boot 检测器：从设备配置读 uboot 子段，未配置走默认值
    // 配置非法（re: 后跟无效正则）时立即返回配置错误，不进入轮询
    let detector: UbootDetector;
    try {
      detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[serial_enter_uboot] config error: ${msg}`);
      return `Failed to build U-Boot detector (config error): ${msg}`;
    }

    // 发送 reboot 重启设备
    shell.write("reboot", 1);
    logger.info(
      `[serial_enter_uboot] cmd=reboot sent, waiting for autoboot prompt...`
    );

    const deadline = Date.now() + timeoutSec * 1000;
    const verifyTimeoutMs = detector.verifyTimeoutMs;
    let allOutput = "";
    let interruptKey = "";
    let interruptedAt = 0; // 中断键发送时刻，用于主层窗口计时
    let verifyStarted = false; // 是否已发 printenv（保证只发一次）
    let verifyStartedAt = 0; // printenv 发送时刻，用于验证层窗口计时

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const chunk = shell.read(0); // 不清空缓冲区，持续累积
      if (chunk) allOutput += chunk;

      // 阶段 1：autoboot 提示检测（未中断时）
      if (!interruptKey) {
        const key = detector.matchAutoboot(allOutput);
        if (key) {
          shell.sendRaw(key, 1);
          interruptKey =
            key === "\x03" ? "Ctrl+C" : key === "\x15" ? "Ctrl+u" : "Enter";
          interruptedAt = Date.now();
          allOutput = ""; // 重置，接下来只收集 U-Boot 阶段输出
          logger.info(
            `[serial_enter_uboot] detected autoboot prompt, sent ${interruptKey}`
          );
          continue;
        }
      }

      // 已中断后才进入主层 / 验证层判定
      if (!interruptKey) {
        continue;
      }

      // 内核启动特征 → 立即失败（不论主层还是验证层）
      if (detector.matchKernelBoot(allOutput)) {
        logger.warn(
          "[serial_enter_uboot] kernel boot detected, abort (device bypassed U-Boot)"
        );
        return `Failed to enter U-Boot: kernel boot detected (device bypassed U-Boot).\n\n${allOutput.trim() || "(no output)"}\n\nRetry recommended.`;
      }

      // 阶段 2：主层 — 提示符命中即成功
      if (!verifyStarted && detector.matchPrompt(allOutput)) {
        const finalOutput = shell.read(1);
        if (finalOutput) allOutput += finalOutput;
        logger.info(
          `[serial_enter_uboot] prompt matched (via prompt), entered U-Boot`
        );
        markUbootSession(args.session_id);
        return `Entered U-Boot successfully (via prompt, interrupt: ${interruptKey}).\n\n${allOutput.trim()}`;
      }

      // 主层窗口耗尽 → 触发验证层（仅一次）
      if (!verifyStarted && Date.now() - interruptedAt >= verifyTimeoutMs) {
        shell.sendRaw("\nprintenv\n", 1);
        verifyStarted = true;
        verifyStartedAt = Date.now();
        allOutput = ""; // 重置，接下来只收集 printenv 输出
        logger.info(
          "[serial_enter_uboot] prompt not matched in main window, sent printenv for verification"
        );
        continue;
      }

      // 阶段 3：验证层 — 环境变量键命中即成功
      if (verifyStarted) {
        if (detector.matchVerifyKey(allOutput)) {
          const finalOutput = shell.read(1);
          if (finalOutput) allOutput += finalOutput;
          logger.info(
            "[serial_enter_uboot] verify key matched (via verify), entered U-Boot"
          );
          markUbootSession(args.session_id);
          return `Entered U-Boot successfully (via verify, interrupt: ${interruptKey}).\n\n${allOutput.trim()}`;
        }

        // 验证层窗口耗尽 → 快速失败
        if (Date.now() - verifyStartedAt >= verifyTimeoutMs) {
          logger.warn(
            `[serial_enter_uboot] verify timeout (${verifyTimeoutMs}ms), no env key matched`
          );
          return `Failed to enter U-Boot: no U-Boot env key matched within ${verifyTimeoutMs}ms.\n\n${allOutput.trim() || "(no output)"}\n\nRetry recommended.`;
        }
      }
    }

    // 总超时兜底
    const remaining = shell.read(1);
    if (remaining) allOutput += remaining;

    logger.warn(
      `[serial_enter_uboot] overall timeout after ${timeoutSec}s, interruptKey=${interruptKey || "(none)"}`
    );
    return `Timeout after ${timeoutSec}s waiting for U-Boot.\n\n${allOutput.trim() || "(no output)"}`;
  });
}

// ── serial_uboot_state ────────────────────────────────────────

/**
 * @brief serial_uboot_state 工具配置
 *
 * 查询 / 主动检测 / 强制设置会话的 U-Boot 标记。标记决定 serial_exec 在该
 * 会话的 marker 包装风格（U-Boot 态用 plain 无子 shell，其余用 subshell）。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param action      detect（默认）/ set / clear / status
 */
export const serialUbootStateConfig: SdkToolConfig = {
  description:
    "Query, detect, or force-set the U-Boot mark of a serial session. " +
    "The mark decides serial_exec's marker wrapping (U-Boot sessions use plain style without subshell). " +
    "Actions: 'detect' (default) — classify the live environment from buffered tail evidence first " +
    "(zero side effects); if inconclusive, send a bare Enter to redraw the prompt. " +
    "Conclusive results sync the mark automatically. " +
    "WARNING: do NOT detect while a command may still be running or waiting for interactive input (e.g. Y/N) — " +
    "the probe Enter could answer it. " +
    "'set'/'clear' — force the mark when auto-detection is out of sync; " +
    "'status' — read the mark only, no device I/O.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      action: {
        type: "string",
        enum: ["detect", "set", "clear", "status"],
        description:
          "detect (default) = probe live environment and sync mark; set/clear = force mark; status = read mark only",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief 环境分类结论
 *
 * detect 动作对一段累积输出的分类结果：
 *   - uboot   ：末尾停靠在 U-Boot 提示符
 *   - system  ：末尾停靠在非 U-Boot 的 shell 提示符（Linux/Android）
 *   - login   ：末尾停靠在 login:/Password: 登录提示（系统侧，未登录）
 *   - booting ：输出含内核启动特征（过渡态）
 *   - autoboot：输出含 autoboot 倒计时提示（过渡态）
 */
type UbootEnvKind = "uboot" | "system" | "login" | "booting" | "autoboot";

/** @brief 尾部锚定的登录提示符（getty login: / Password:），判定"当前停在登录提示" */
const TAIL_LOGIN_PROMPT_RE = /(?:login|password):\s*$/i;

/**
 * @brief 对一段累积输出做环境分类
 *
 * 判定顺序即优先级：先看输出末尾的「当前停靠点」（U-Boot 提示符 → 登录提示 →
 * 通用提示符），末尾无提示符再看「过程特征」（内核启动 → autoboot 倒计时），
 * 均未命中返回 null（无结论）。
 * @param detector      U-Boot 检测器（提示符/内核特征/autoboot）
 * @param promptDetector 通用提示符检测器（默认正则，覆盖 Linux/Android）
 * @param output        累积输出
 * @returns 环境分类；无结论返回 null
 */
function classifyUbootEnv(
  detector: UbootDetector,
  promptDetector: PromptDetector,
  output: string
): UbootEnvKind | null {
  if (output === "") {
    return null;
  }
  if (detector.matchPrompt(output)) {
    return "uboot";
  }
  if (TAIL_LOGIN_PROMPT_RE.test(output)) {
    return "login";
  }
  if (promptDetector.detect(output)) {
    return "system";
  }
  if (detector.matchKernelBoot(output)) {
    return "booting";
  }
  if (detector.matchAutoboot(output)) {
    return "autoboot";
  }
  return null;
}

/** @brief 标记状态文本 */
function ubootMarkText(marked: boolean, note: string): string {
  return `U-Boot mark: ${marked ? "set" : "clear"} (${note})`;
}

/**
 * @brief serial_uboot_state 处理函数
 *
 * 四个动作：
 *   - status：只读标记，无设备 I/O
 *   - set / clear：强制覆盖标记（自动检测失同步时的权威手动入口）
 *   - detect：分类当前真实环境并同步标记。两级策略：
 *     1. 被动优先——缓冲区未消费内容的尾部就是设备最近输出，命中即零副作用判定
 *     2. 主动兜底——发空回车让设备重绘提示符（500ms × 3 轮轮询）
 *   结论性结果（uboot/system/login）同步标记；过渡态（booting/autoboot）与
 *   无结论（unknown，可能命令仍在跑）不动标记。
 *
 * @param args 工具参数，包含 session_id 和可选 action
 * @return MCP 响应，包含环境分类结论与标记状态
 */
export async function serialUbootStateHandler(args: {
  session_id: string;
  action?: "detect" | "set" | "clear" | "status";
}) {
  const action = args.action ?? "detect";
  logger.info(
    `[serial_uboot_state] session_id=${args.session_id} action=${action}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    const wasMarked = isUbootSession(args.session_id);

    if (action === "status") {
      return ubootMarkText(wasMarked, "queried, no device I/O");
    }
    if (action === "set") {
      markUbootSession(args.session_id);
      return ubootMarkText(
        true,
        "forced set — serial_exec will use plain marker (no subshell)"
      );
    }
    if (action === "clear") {
      clearUbootSession(args.session_id);
      return ubootMarkText(
        false,
        "forced clear — serial_exec will use subshell marker wrapper"
      );
    }

    // ── detect ──
    let detector: UbootDetector;
    try {
      detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[serial_uboot_state] config error: ${msg}`);
      return `Failed to build U-Boot detector (config error): ${msg}`;
    }
    const promptDetector = new PromptDetector();

    // 1. 被动：缓冲区未消费内容的尾部即设备最近输出
    let kind: UbootEnvKind | null = classifyUbootEnv(
      detector,
      promptDetector,
      shell.read(0)
    );
    let source = "buffer";
    // 2. 主动：发空回车重绘提示符（可能回答挂起的交互提示，见工具描述警告）
    if (!kind) {
      shell.write("", 0);
      source = "probe";
      for (let i = 0; i < 3 && !kind; i++) {
        await new Promise((r) => setTimeout(r, 500));
        kind = classifyUbootEnv(detector, promptDetector, shell.read(0));
      }
    }

    // 结论性结果同步标记；booting/autoboot 过渡态与 unknown 不动标记
    let markChanged = false;
    if (kind === "uboot") {
      markUbootSession(args.session_id);
      markChanged = !wasMarked;
    } else if (kind === "system" || kind === "login") {
      clearUbootSession(args.session_id);
      markChanged = wasMarked;
    }

    const lines: string[] = [
      `Environment: ${kind ?? "unknown"} (via ${source})`,
    ];
    if (!kind) {
      lines.push(
        "(no conclusive evidence within probe window — shell may be busy running a command)"
      );
    }
    const nowMarked = isUbootSession(args.session_id);
    lines.push(
      markChanged
        ? `U-Boot mark: ${nowMarked ? "set" : "clear"} (was ${wasMarked ? "set" : "clear"}, synced from detection)`
        : `U-Boot mark: ${nowMarked ? "set" : "clear"} (unchanged)`
    );
    logger.info(
      `[serial_uboot_state] detected=${kind ?? "unknown"} via=${source} mark=${nowMarked ? "set" : "clear"}`
    );
    return lines.join("\n");
  });
}

/** 注册 session（复用已有或新建），返回统一的 MCP 响应 */
function registerSession(
  shell: SerialShell,
  port: string,
  existingId: string | undefined,
  deviceName: string,
  detail: string
) {
  // 若已通过 portToSession 注册（如提前在 shell.login 中注册），直接复用
  const registeredId = existingId ?? portToSession.get(port);
  if (registeredId && serialStore.get(registeredId)) {
    logger.info(
      `[serial_shell_login] session reused: ${registeredId} port=${port}`
    );
    return `Session ${registeredId} on ${port} (existing, ${detail})`;
  }
  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = serialStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  serialStore.create(shell, {
    type: "serial",
    deviceName,
    connectionInfo: `${port} @ ${shell.getPort()}`,
    logPath,
  });
  portToSession.set(port, sessionId);
  logger.info(`[serial_shell_login] session opened: ${sessionId} port=${port}`);
  return `Session ${sessionId} opened on ${port} ${detail}`;
}
