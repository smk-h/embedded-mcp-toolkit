/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcu.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: Serial 单片机裸固件模式 SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 *   serial_mcu_exec：面向无 shell/无回显/无提示符的单片机固件（如 STM32 应用
 *   + 心跳打印）。与 serial_exec（shell 语义：marker 包装/回显剥离/提示符
 *   检测）刻意分离为独立工具，并用双向守卫保证路由：
 *     - 本工具：设备未配置 serial.mcu 时拒绝（指路 serial_exec）
 *     - serial_exec：设备配置了 serial.mcu 时拒绝（指路本工具）
 *   一键登录对 MCU 设备同样由守卫拒绝（见 login.ts）。
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import { getMcuConfig } from "../../shared/config.js";
import { serialStore } from "./sessions.js";
import { runMcuExec } from "../../exec/mcu-exec-runner.js";

// ── serial_mcu_exec ─────────────────────────────────────────

/**
 * @brief serial_mcu_exec 工具配置
 *
 * 向单片机裸固件会话发送命令并等待响应。完成判定不依赖回显/提示符：
 * responsePattern 命中或静默窗口（quietMs）期满，超时永不发 Ctrl+C。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param command     要发送的命令字符串（裸命令，原样下发）
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 * @param timeoutMs   最大执行时长（毫秒，默认 10000）
 */
export const serialMcuExecConfig: SdkToolConfig = {
  description:
    "Send a raw command to an MCU (bare-firmware) serial session and wait for the response. " +
    "ONLY for devices with 'serial.mcu: { enabled: true }' in their device config — these devices have " +
    "NO shell echo and NO prompt; completion is decided by the configured responsePattern match or a quiet " +
    "window (quietMs), and NO interrupt (Ctrl+C) is ever sent on timeout. " +
    "The returned output may contain the firmware's periodic heartbeat lines — identify the actual response " +
    "within them. " +
    "IMPORTANT: Do NOT issue concurrent commands to the same session_id; always wait for this call to finish " +
    "before sending the next one. For regular Linux-shell serial sessions use serial_exec instead.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      command: {
        type: "string",
        description: "The raw command to send to the MCU firmware",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
      timeoutMs: {
        type: "number",
        description:
          "Execution cap in ms — MANDATORY on every call: estimate the expected response time and pass it; " +
          "typical MCU command responses 1000-3000ms; firmware reboot/reset up to 10000ms. " +
          "If omitted, defaults to 10000ms. On timeout NO interrupt is ever sent (0x03 could trigger " +
          "unintended firmware actions) — the completion kind is annotated in the returned output.",
      },
    },
    required: ["session_id", "command"],
  },
};

/**
 * @brief serial_mcu_exec 处理函数
 *
 * 流程：
 *   1. 反向守卫：设备未配置 serial.mcu 时拒绝（shell 语义与裸固件不兼容）
 *   2. 会话锁内调用 runMcuExec：前置冲刷 → 裸发送 → 轮询（pattern/quiet/timeout）
 *   3. 按 completedBy 追加中文标注（风格对齐 serial_exec 的超时标注）
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear、timeoutMs
 * @return MCP 响应，包含固件响应输出（含心跳行）与完成方式标注
 */
export async function serialMcuExecHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
  timeoutMs?: number;
}) {
  const clearVal = args.clear ?? 1;
  const timeoutMsVal = args.timeoutMs;
  logger.info(
    `[serial_mcu_exec] session_id=${args.session_id} command=${args.command} clear=${clearVal} timeoutMs=${timeoutMsVal ?? "(default)"}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  // 反向守卫：非 MCU 设备不得走 MCU 语义（裸发送/静默判定与 shell 会话不兼容，
  // 且易被误用于绕过 serial_exec 的 marker/提示符体系）
  const deviceName = shell.getDeviceName();
  let mcuConfig;
  try {
    mcuConfig = getMcuConfig(deviceName);
  } catch (err) {
    const msg = `设备 '${deviceName}' 的 serial.mcu 配置错误: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.warn(`[serial_mcu_exec] ${msg}`);
    return msg;
  }
  if (!mcuConfig) {
    const msg = `设备 '${deviceName}' 未启用单片机模式（serial 段无 mcu 配置）。请改用 serial_exec；如确为单片机设备，请在其设备配置的 serial 段下添加 mcu: { enabled: true }。`;
    logger.info(`[serial_mcu_exec] ${msg}`);
    return msg;
  }

  return serialStore.withLock(args.session_id, async () => {
    const result = await runMcuExec({
      shell,
      command: args.command,
      clear: clearVal,
      timeoutMs: timeoutMsVal,
      quietMs: mcuConfig.quietMs,
      responseRegex: mcuConfig.responseRegex,
      logPrefix: "[serial_mcu_exec]",
    });

    let output = result.output;
    if (result.completedBy === "pattern") {
      output =
        (output ? output + "\n" : "") +
        `[MCU: 响应模式命中, 耗时 ${result.elapsedMs}ms]`;
    } else if (result.completedBy === "quiet") {
      output =
        (output ? output + "\n" : "") +
        `[MCU: 静默 ${mcuConfig.quietMs}ms 判定完成, 耗时 ${result.elapsedMs}ms]`;
    } else {
      output =
        (output ? output + "\n" : "") +
        `[MCU兜底超时: 已收集 ${result.elapsedMs}ms 输出, 未发送中断（命令可能仍在运行）]`;
    }

    // 漏传 timeoutMs 的反向引导：工具描述已强制要求预估传参，仍未传时在结果
    // 末尾追加提示，促使调用方下次按命令预期耗时显式传参
    if (timeoutMsVal === undefined) {
      output =
        (output ? output + "\n" : "") +
        "[提示: 本次未传 timeoutMs，按默认 10000ms 兜底执行。请预估命令预期耗时并显式传参]";
    }

    return output || "(no output)";
  });
}
