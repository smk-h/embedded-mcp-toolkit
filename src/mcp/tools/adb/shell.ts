/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : shell.ts
 * Author     : opencode
 * Date       : 2026/05/31
 * Version    : 1.0.0
 * Description: ADB Shell 交互式 MCP 工具
 *
 *   提供对 Android 设备的持久化 ADB Shell 会话管理，
 *   支持 open / close / write / read / list / exec 六个操作。
 *
 *   与 PowerShellShell / SerialShell / SSHShell 保持相同的接口模式，
 *   区别在于 ADB Shell 连接的是持久化 adb shell 子进程。
 * ======================================================
 */
import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import {
  getPromptPattern,
  getExecTimeoutConfig,
  resolveAdbSerial,
  resolveDeviceName,
} from "../../../shared/config.js";
import { AdbShell, type AdbShellConfig } from "../../../transports/adb.js";
import { adbStore } from "./sessions.js";
import {
  CONTROL_CHAR_MAP,
  type ControlChar,
  PromptDetector,
} from "../../shared/prompt-detector.js";
import { sendControlChar } from "../../shared/send-ctrl.js";
import { runExec } from "../../shared/exec-runner.js";
import { resolveAdbDeviceName } from "./device-resolver.js";

// ── adb_shell_open ──────────────────────────────────────────

/**
 * @brief adb_shell_open 工具配置
 *
 * 打开一个持久化 ADB Shell 会话，返回初始 banner 输出。
 *
 * @param device  目标设备别名（推荐传入，如 "board-lubancat"）。传入即直接使用 config
 *                中该设备绑定的 serialNo，不触发探测、日志目录更准确；不传时才由
 *                adb 自动发现唯一连接的设备
 */
export const adbShellOpenConfig = {
  description:
    "Open an interactive ADB shell session to an Android device. Returns the initial banner output.",
  inputSchema: fromJsonSchema<{
    device?: string;
  }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description:
          'Target device alias, e.g. "board-lubancat". ' +
          "PREFER passing the alias when you know the target device: " +
          "it reads the serialNo bound in config and connects directly without device probing, " +
          "and the log directory follows the alias. " +
          "Passing a raw serial number is also accepted — " +
          "it is auto-resolved back to the alias when bound. " +
          "Omit only when no specific device is intended; " +
          "the program then auto-discovers the single connected device " +
          "(errors out if 0 or >1 devices). " +
          "There is NO need to call adb_device_list first.",
      },
    },
  }),
};

/**
 * @brief adb_shell_open 处理函数
 *
 * 流程：
 *   1. 根据参数构建 AdbShellConfig 配置
 *   2. 创建 AdbShell 实例并启动 adb shell 进程
 *   3. 读取 banner 输出
 *   4. 将 shell 存入会话表，返回 session_id
 *
 * @param args  工具参数，包含可选的 device
 * @returns MCP 响应，包含 session_id 和 banner 内容
 */
export async function adbShellOpenHandler(args: { device?: string }) {
  // 1) 确定目标设备名称
  //    优先使用用户传入的 args.device（手动指定设备），
  //    未传入则调用 resolveDeviceName() 从环境变量/配置中解析默认设备名
  const deviceName = args.device ?? resolveDeviceName();

  // 2) 根据设备名称解析 ADB 序列号（serialNo）
  //    从 config.yaml 中查找 devices.<deviceName>.adb.serialNo 配置项，
  //    若该设备未在配置文件中显式指定序列号，则返回 null
  const serialNo = resolveAdbSerial(deviceName);

  // 3) 记录序列号的来源（用于日志追踪）
  //    resolveAdbSerial() 的返回值可以有效区分传入的是设备名还是序列号：
  //      - 若 deviceName 命中 config.yaml 中的设备键 → 返回配置的序列号（与 deviceName 不同）
  //      - 若 deviceName 未命中（即本身是原始序列号）→ 原样返回（与 deviceName 相同）
  //    据此判断：
  //      - serialNo !== deviceName → 用户传的是设备别名，序列号从 config 查得
  //      - serialNo === deviceName → 用户传的是原始序列号（如多设备场景下 AI 让用户选择后传入，用户需要保证其正确性和合法性）
  //      - 无 args.device 且 serialNo 有值 → 默认设备，序列号来自 config
  //      - 无 args.device 且 serialNo 为 null → 无配置序列号，由 adb devices 自动发现
  let serialSource: string;
  if (args.device) {
    if (serialNo !== deviceName) {
      serialSource = `user argument → config.yaml devices.${deviceName}.adb.serialNo`;
    } else {
      serialSource = `user argument (raw serial)`;
    }
  } else if (serialNo) {
    serialSource = `config.yaml devices.${deviceName}.adb.serialNo`;
  } else {
    serialSource = `adb devices auto-discovery`;
  }
  logger.info(
    `[adb_shell_open] device=${deviceName} serialNo=${serialNo ?? "(auto)"} source=${serialSource}`
  );

  const config: AdbShellConfig = {
    serialNo,
    deviceName,
  };

  const shell = new AdbShell(config);
  let banner: string;
  try {
    // 调用 open()：1) 自动发现设备 → 2) spawn adb shell 子进程 → 3) 收集 banner
    // 若自动发现失败（无设备/多设备），抛出异常由下方 catch 捕获，shell 实例不会进入会话表
    banner = await shell.open();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[adb_shell_open] open failed: ${errMsg}`);
    return {
      content: [text(`ADB shell open failed: ${errMsg}`)],
    };
  }

  // open() 成功后才将 shell 存入会话表，后续操作通过 session_id 复用该进程
  // 连接成功后用真实 serialNo 按三级降级策略算出 finalDeviceName，
  // 让日志目录与会话表 deviceName 字段反映真实连接的设备，而非连接前的静态猜测值
  // （deviceName 变量保留原值，用于 serialSource 日志逻辑不改动）
  const realSerialNo = shell.getSerialNo();
  const finalDeviceName = resolveAdbDeviceName(
    args.device,
    realSerialNo,
    deviceName
  );
  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = adbStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, finalDeviceName);
  adbStore.create(shell, {
    type: "adb",
    deviceName: finalDeviceName,
    connectionInfo: realSerialNo,
    logPath,
  });
  logger.info(`[adb_shell_open] session opened: ${sessionId}`);

  return {
    content: [
      text(
        `Session ${sessionId} opened. Device: ${shell.getSerialNo()}\n${banner || "(no banner)"}`
      ),
    ],
  };
}

// ── adb_shell_close ─────────────────────────────────────────

/**
 * @brief adb_shell_close 工具配置
 *
 * 关闭指定的 ADB Shell 会话并终止 adb shell 进程。
 *
 * @param session_id  由 adb_shell_open 返回的会话 ID
 */
export const adbShellCloseConfig = {
  description: "Close an ADB shell session and terminate the adb process.",
  inputSchema: fromJsonSchema<{ session_id: string }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by adb_shell_open",
      },
    },
    required: ["session_id"],
  }),
};

/**
 * @brief adb_shell_close 处理函数
 *
 * 流程：
 *   1. 从会话表中查找指定 session_id
 *   2. 调用 shell.close() 发送 exit 命令并终止进程
 *   3. 从会话表中移除该条目
 *
 * @param args  工具参数，包含 session_id
 * @returns MCP 响应，确认会话已关闭
 */
export async function adbShellCloseHandler(args: { session_id: string }) {
  logger.info(`[adb_shell_close] session_id=${args.session_id}`);
  const result = adbStore.getOrNotFound(args.session_id);
  if (!result.ok) {
    return result.response;
  }

  await adbStore.withLock(args.session_id, async () => {
    await result.shell.close();
  });
  adbStore.remove(args.session_id);

  return { content: [text(`Session ${args.session_id} closed.`)] };
}

// ── adb_shell_write ─────────────────────────────────────────

/**
 * @brief adb_shell_write 工具配置
 *
 * 向指定的 ADB Shell 会话发送命令。
 *
 * @param session_id  由 adb_shell_open 返回的会话 ID
 * @param command     要发送的命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const adbShellWriteConfig = {
  description: "Send a command to an ADB shell session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    clear?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by adb_shell_open",
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
 * @brief adb_shell_write 处理函数
 *
 * 向 ADB shell 进程发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 adb_shell_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @returns MCP 响应，确认命令已发送
 */
export async function adbShellWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  const clearVal = args.clear ?? 1;
  logger.info(
    `[adb_shell_write] session_id=${args.session_id} command=${args.command} clear=${clearVal}`
  );
  const result = adbStore.getOrNotFound(args.session_id);
  if (!result.ok) {
    return result.response;
  }

  return adbStore.withLock(args.session_id, async () => {
    result.shell.write(args.command, clearVal);
    return { content: [text(`Command sent: ${args.command}`)] };
  });
}

// ── adb_shell_read ──────────────────────────────────────────

/**
 * @brief adb_shell_read 工具配置
 *
 * 读取指定 ADB Shell 会话的输出数据。
 *
 * @param session_id  由 adb_shell_open 返回的会话 ID
 * @param clear       缓冲区清空标志（1=读取后清空，0=保留缓冲区，默认 1）
 */
export const adbShellReadConfig = {
  description: "Read output from an ADB shell session.",
  inputSchema: fromJsonSchema<{ session_id: string; clear?: number }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by adb_shell_open",
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
 * @brief adb_shell_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @returns MCP 响应，包含读取到的输出内容
 */
export async function adbShellReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  const clearVal = args.clear ?? 1;
  logger.info(
    `[adb_shell_read] session_id=${args.session_id} clear=${clearVal}`
  );
  const result = adbStore.getOrNotFound(args.session_id);
  if (!result.ok) {
    return result.response;
  }

  return adbStore.withLock(args.session_id, async () => {
    const output = result.shell.read(clearVal);
    return { content: [text(output || "(no output)")] };
  });
}

// ── adb_shell_exec ──────────────────────────────────────────

/**
 * @brief adb_shell_exec 工具配置
 *
 * 向 ADB Shell 会话发送命令并等待输出，合并 write + delay + read 为一次调用。
 * 检测到 shell 提示符立即返回；超过 maxDuration 未返回则自动发 Ctrl+C 熔断。
 *
 * @param session_id   由 adb_shell_open 返回的会话 ID
 * @param command      要执行的命令字符串
 * @param delay        最小轮询持续时长（毫秒，默认 1000），兼容旧语义
 * @param clear        缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 * @param maxDuration  执行时长覆盖（毫秒）。默认按命令类型分流：常驻命令(ping/logcat/top)10000ms 采样超时(发Ctrl+C)，普通命令 300000ms 兜底超时(不发Ctrl+C)。超时动作仍按常驻性判定
 */
export const adbShellExecConfig = {
  description:
    "Send a command to an ADB shell session and wait for the output. Combines write + delay + read in one call.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    delay?: number;
    clear?: number;
    maxDuration?: number;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by adb_shell_open",
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
  }),
};

/**
 * @brief adb_shell_exec 处理函数
 *
 * 通过 runExec 统一编排完成命令发送、轮询、提示符检测、超时熔断。
 * 常驻命令（logcat/top/ping）超时自动采样（发 Ctrl+C，返回采样超时标注）；
 * 普通命令靠提示符检测返回，仅提示符未匹配时走兜底超时（不发 Ctrl+C，返回兜底超时标注）。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear、maxDuration
 * @returns MCP 响应，包含命令执行后的输出内容（超时时按类型追加采样/兜底超时标注）
 */
export async function adbShellExecHandler(args: {
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
    `[adb_shell_exec] session_id=${args.session_id} command=${args.command} delay=${delayVal} clear=${clearVal} maxDuration=${maxDurationVal ?? "(default)"}`
  );
  const result = adbStore.getOrNotFound(args.session_id);
  if (!result.ok) {
    return result.response;
  }

  const shell = result.shell;
  const deviceName = resolveDeviceName();

  // 提示符检测器：设备配置覆盖优先，无配置用默认正则
  const promptDetector = new PromptDetector(getPromptPattern(deviceName));

  // exec 超时配置：常驻命令扩展名单 + 采样/兜底时长，设备级三通道共享
  const execTimeoutConfig = getExecTimeoutConfig(deviceName);

  // sendCtrl 闭包：只写字节，runExec 内部已自行 sleep 等待
  const sendCtrl = (key: ControlChar): void => {
    shell.write(CONTROL_CHAR_MAP[key], 1, false);
  };

  return adbStore.withLock(args.session_id, async () => {
    const execResult = await runExec({
      shell,
      command: args.command,
      delay: delayVal,
      clear: clearVal,
      maxDuration: maxDurationVal,
      promptDetector,
      sendCtrl,
      logPrefix: "[adb_shell_exec]",
      execTimeoutConfig,
    });

    // 三态格式化：正常完成原样返回；采样超时（常驻）与兜底超时（普通）追加不同标注
    let output = execResult.output;
    if (execResult.timeoutKind === "sampling") {
      output =
        (output ? output + "\n" : "") +
        `[采样超时: 已收集 ${execResult.elapsedMs}ms 输出，已发送 Ctrl+C 终止常驻命令]`;
    } else if (execResult.timeoutKind === "fallback") {
      output =
        (output ? output + "\n" : "") +
        `[兜底超时: 已收集 ${execResult.elapsedMs}ms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`;
    }

    return { content: [text(output || "(no output)")] };
  });
}

// ── adb_shell_send_ctrl ─────────────────────────────────────

/**
 * @brief 控制字符可读名称映射（用于返回信息展示）
 *
 * key 为 ControlChar，value 为人类可读名称（如 "Ctrl+C"）。
 */
const CTRL_LABEL: Readonly<Record<ControlChar, string>> = {
  c: "Ctrl+C",
  u: "Ctrl+U",
  d: "Ctrl+D",
  z: "Ctrl+Z",
};

/**
 * @brief adb_shell_send_ctrl 工具配置
 *
 * 向 ADB Shell 会话发送控制字符（不追加换行），用于终止/控制前台命令。
 *
 * @param session_id  由 adb_shell_open 返回的会话 ID
 * @param key         控制字符类型：c(Ctrl+C)/u(Ctrl+U)/d(Ctrl+D)/z(Ctrl+Z)
 */
export const adbShellSendCtrlConfig = {
  description:
    "Send a control character (Ctrl+C/U/D/Z) to an ADB shell session without appending a newline.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    key: ControlChar;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by adb_shell_open",
      },
      key: {
        type: "string",
        enum: ["c", "u", "d", "z"],
        description:
          "Control character: c=Ctrl+C(SIGINT), u=Ctrl+U(clear line), d=Ctrl+D(EOF), z=Ctrl+Z(suspend)",
      },
    },
    required: ["session_id", "key"],
  }),
};

/**
 * @brief adb_shell_send_ctrl 处理函数
 *
 * 复用共享 sendControlChar，以不追加换行的方式发送控制字符，
 * 保证语义正确。发送后自动 drain 丢弃回显并短暂等待信号生效。
 *
 * @param args  工具参数，包含 session_id 和 key
 * @returns MCP 响应，确认控制字符已发送
 */
export async function adbShellSendCtrlHandler(args: {
  session_id: string;
  key: ControlChar;
}) {
  logger.info(
    `[adb_shell_send_ctrl] session_id=${args.session_id} key=${args.key}`
  );
  const result = adbStore.getOrNotFound(args.session_id);
  if (!result.ok) {
    return result.response;
  }

  return adbStore.withLock(args.session_id, async () => {
    const byte = await sendControlChar(result.shell, args.key);
    const label = CTRL_LABEL[args.key];
    return {
      content: [text(`${label} sent (${byte})`)],
    };
  });
}
