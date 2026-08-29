/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : shell.ts
 * Author     : sumu
 * Date       : 2026/05/26
 * Version    : x.x.x
 * Description: Serial 会话基础 SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 *   覆盖串口交互式 Shell 的基础生命周期与数据收发：
 *   open / close / write / read / exec / send_ctrl。
 *   一键登录见 login.ts，U-Boot 编排见 uboot.ts，ZMODEM 见 transfer.ts。
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import {
  getExecTimeoutConfig,
  getPromptPattern,
  getSerialConfig,
  getUbootConfig,
  resolveDeviceName,
} from "../../shared/config.js";
import {
  SerialShell,
  type SerialShellConfig,
} from "../../transports/serial.js";
import {
  serialStore,
  portToSession,
  isUbootSession,
  clearUbootSession,
} from "./sessions.js";
import {
  CONTROL_CHAR_MAP,
  type ControlChar,
  PromptDetector,
  UbootDetector,
  createUbootPromptDetector,
} from "../../exec/prompt-detector.js";
import { sendControlChar } from "../../exec/send-ctrl.js";
import { runExec } from "../../exec/exec-runner.js";

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
          "Serial port path (e.g. COM3, /dev/ttyUSB0) or TCP serial endpoint " +
          "(tcp://host:port, e.g. QEMU with '-serial tcp:...'). Overrides device config if provided.",
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

  // 检查该端口（COM 口或 TCP 端点）是否已有活跃会话
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
    connectionInfo: shell.getConnectionInfo(),
    logPath,
  });
  portToSession.set(config.port, sessionId);
  logger.info(`[serial_open] session opened: ${sessionId} port=${config.port}`);

  return `Session ${sessionId} opened on ${shell.getConnectionInfo()}.\n${banner || "(no banner)"}`;
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
    // U-Boot 标记会话：读到的内容含内核启动特征时同步清标记。
    // 覆盖手动 read 读到 reset/bootm 后内核日志的场景——证据若被
    // read 取走而未判定，下次 exec 前置冲刷已无可回收材料。
    if (output && isUbootSession(args.session_id)) {
      try {
        const ubootDetector = new UbootDetector(
          getUbootConfig(resolveDeviceName())
        );
        if (ubootDetector.matchKernelBoot(output)) {
          clearUbootSession(args.session_id);
          logger.info(
            `[serial_read] kernel boot detected, cleared U-Boot mark for session ${args.session_id}`
          );
        }
      } catch (err) {
        // uboot 配置含非法正则时不应阻断 read 主流程，跳过本次检查
        logger.warn(
          `[serial_read] uboot detector config error, skip kernel check: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return output || "(no output)";
  });
}

// ── serial_exec ──────────────────────────────────────────────

/**
 * @brief serial_exec 工具配置
 *
 * 向串口会话发送命令并等待输出，合并 write + read 为一次调用，完成检测自动进行。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param command     要执行的命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const serialExecConfig: SdkToolConfig = {
  description:
    "Send a command to a serial shell session and wait for the output. Combines write + read in one call, " +
    "with automatic completion detection (marker/prompt). " +
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
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
      timeoutMs: {
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
 * @param args  工具参数，包含 session_id、command 和可选的 clear、timeoutMs
 * @return MCP 响应，包含命令执行后的输出内容（超时时按类型追加采样/兜底超时标注）
 */
export async function serialExecHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
  timeoutMs?: number;
}) {
  const clearVal = args.clear ?? 1;
  const timeoutMsVal = args.timeoutMs;
  logger.info(
    `[serial_exec] session_id=${args.session_id} command=${args.command} clear=${clearVal} timeoutMs=${timeoutMsVal ?? "(default)"}`
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

    // U-Boot 态的 2级回落检测收窄为 U-Boot 提示符集（默认 =>/U-Boot> ∪
    // 用户配置），而非通用默认正则：U-Boot 下 TFTP/升级类命令用连续 #
    // 刷进度条，通用正则"行尾 #"分支会把进度帧误判为 Linux root 提示符
    // 提前返回（实测 alg 升级 42s 的命令 406ms 即被截胡）。U-Boot 会话
    // plain 包装必有 marker，真结束由 1级 marker 确定性判定；boot/bootm
    // 离开 U-Boot 后 plain marker 在 Linux sh 下照常展开，环境切换由
    // 内核启动特征驱动下方自校正，无需通用提示符参与。
    // 配置含非法正则时退回通用默认检测器，不阻断 exec 主流程。
    let promptDetector: PromptDetector;
    if (wasUboot) {
      try {
        promptDetector = createUbootPromptDetector(getUbootConfig(deviceName));
      } catch (err) {
        logger.warn(
          `[serial_exec] uboot prompt config error, fallback to default detector: ${err instanceof Error ? err.message : String(err)}`
        );
        promptDetector = new PromptDetector();
      }
    } else {
      promptDetector = new PromptDetector(getPromptPattern(deviceName));
    }

    const execResult = await runExec({
      shell,
      command: args.command,
      clear: clearVal,
      timeoutMs: timeoutMsVal,
      promptDetector,
      sendCtrl,
      logPrefix: "[serial_exec]",
      execTimeoutConfig,
      // U-Boot 态会话（serial_enter_uboot 标记）marker 用 plain 风格：
      // 去掉子 shell 括号（hush 无该语法），`; echo` 仍无条件执行，
      // 1级 marker 检测照常生效
      markerStyle: wasUboot ? "plain" : "subshell",
    });

    // U-Boot 态执行后自校正标记：证据出现内核启动特征（reset/boot/bootm
    // 或设备自行重启，任意完成路径均可命中）即判定已离开 U-Boot，清除
    // 会话标记，后续 serial_exec 恢复 subshell 包装。
    //
    // 证据范围 = 本次输出 + 前置冲刷残留：reset 后内核日志晚于 exec
    // 返回时会滞留 buffer，被下次 exec 前置冲刷带出——合并检查避免
    // 证据随冲刷丢弃导致标记永久残留（冲刷发生在本次 wasUboot 采样
    // 之后，只影响本次自校正，不影响本次包装风格；plain 包装在 Linux
    // 下同样可用，晚一拍无功能性破坏）。
    //
    // 刻意不用「提示符排除法」（completedBy=prompt 且尾部非 U-Boot 提示符）
    // 清标记：负向证据不可靠——# 进度帧等垃圾尾部同样能触发（2026-08-27
    // 事故即由此误清）。权威同步入口为 serial_uboot_state 的
    // detect/clear 动作。
    if (wasUboot) {
      let leftUboot = false;
      try {
        const ubootDetector = new UbootDetector(getUbootConfig(deviceName));
        leftUboot = ubootDetector.matchKernelBoot(
          execResult.flushed + execResult.output
        );
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
