/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcu-exec-runner.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: 单片机裸固件 exec 的编排逻辑（serial_mcu_exec 专用）
 *
 *   面向无 shell、无回显、无提示符的单片机固件（如 STM32 应用 + 心跳打印），
 *   与 exec-runner.ts（adb/ssh/serial 三通道共享）刻意分离：
 *     - 不做 marker 包装：单片机固件不解析 shell 语法，拼 `; echo MARKER`
 *       会被当作命令数据原样发给固件
 *     - 不做 PTY 回显剥离：无回显设备的首行输出就是真实响应
 *     - 不做常驻分类/不发 Ctrl+C：对单片机发 0x03 可能误触发固件动作，
 *       超时一律只收集不中断
 *
 *   完成判定三选一（先到者）：
 *     - pattern：responsePattern 在累积输出中任意位置命中（固件有确定性
 *       应答结尾时推荐配置，快且准）
 *     - quiet  ：距最后一字节静默 ≥ quietMs（通用路径；心跳落在窗口内会
 *       重置计时，故 quietMs 必须小于心跳周期，响应才能在下一个心跳前
 *       被判完成）
 *     - timeout：timeoutMs 兜底（异常语义，仅安全阀）
 * ======================================================
 */

import type { InteractiveShell } from "../transports/interactive-shell.js";
import { logger } from "../shared/logger.js";

/** @brief 轮询间隔（毫秒），与 exec-runner 保持同一节奏 */
const POLL_INTERVAL_MS = 200;

/** @brief 未传 timeoutMs 时的默认兜底时长（毫秒） */
const DEFAULT_MCU_TIMEOUT_MS = 10000;

/**
 * @brief 单片机 exec 的完成路径
 *   - pattern：responsePattern 命中（确定性）
 *   - quiet  ：静默窗口期满（通用路径）
 *   - timeout：兜底超时（异常语义，未发中断）
 */
export type McuCompletedBy = "pattern" | "quiet" | "timeout";

/**
 * @brief 单片机 exec 的输入参数
 *
 * 由 serial_mcu_exec handler 构造（设备经 getMcuConfig 守卫后才有资格走到这里）。
 */
export interface McuExecInput {
  /** 目标串口 shell 实例 */
  readonly shell: InteractiveShell;
  /** 要执行的命令字符串（裸命令，执行器不做任何包装） */
  readonly command: string;
  /** 缓冲区清空标志（透传给 shell.write，默认 1） */
  readonly clear?: number;
  /** 最大执行时长（毫秒）；未传时用 DEFAULT_MCU_TIMEOUT_MS 兜底 */
  readonly timeoutMs?: number;
  /** 静默判定窗口（毫秒），须小于固件心跳周期 */
  readonly quietMs: number;
  /** 响应完成正则（已由 getMcuConfig 编译校验）；null 时仅用静默判定 */
  readonly responseRegex: RegExp | null;
  /** 日志前缀，如 "[serial_mcu_exec]" */
  readonly logPrefix: string;
}

/**
 * @brief 单片机 exec 的输出结果
 *
 * 无 exitCode/interrupted/timeoutKind 概念：单片机固件没有退出码，
 * 超时也永不发中断，timeout 语义统一由 completedBy 承载。
 */
export interface McuExecResult {
  /** 累积的全部输出文本（含心跳行，由调用方/AI 自行辨识） */
  readonly output: string;
  /**
   * 前置冲刷丢弃的缓冲区残留（发送命令前 drain 的内容）。
   * 心跳是周期性输出，两次 exec 之间可能积累心跳行，前置冲刷保证
   * output 只含本次命令之后的输出；冲刷内容仅供诊断，不展示给用户。
   */
  readonly flushed: string;
  /** 完成路径（pattern/quiet/timeout） */
  readonly completedBy: McuCompletedBy;
  /** 实际执行时长（毫秒），用于格式化标注 */
  readonly elapsedMs: number;
}

/**
 * @brief sleep 毫秒的轻量封装
 * @param ms - 等待毫秒数
 * @returns 到期后 resolve
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @brief 执行单片机裸固件命令
 *
 * 流程：
 *   1. 前置冲刷：drain() 丢弃发送前缓冲区残留（两次命令之间的心跳行）
 *   2. 裸发送：shell.write(command, clear)，不拼 marker、不追加 shell 语法
 *   3. 轮询（最长 timeoutMs）：每轮 drain 累积输出，按先到者判定完成：
 *      - responsePattern 命中 → completedBy="pattern"
 *      - 距最后一字节静默 ≥ quietMs → completedBy="quiet"
 *        （含空响应：发送后一直无数据，quietMs 到期即返回空输出，
 *        不苦等 timeoutMs）
 *      - 超过 timeoutMs → completedBy="timeout"（不发 Ctrl+C）
 *
 * @param input - 输入参数（shell/命令/判定参数）
 * @returns 执行结果（输出 + 完成路径 + 时长）
 */
export async function runMcuExec(input: McuExecInput): Promise<McuExecResult> {
  const effectiveTimeout = input.timeoutMs ?? DEFAULT_MCU_TIMEOUT_MS;

  // ── 1. 前置冲刷：丢弃发送前缓冲区可能累积的心跳残留 ──
  const flushed: string = input.shell.drain();
  if (flushed) {
    logger.info(
      `${input.logPrefix} flushed ${flushed.length} bytes before mcu exec`
    );
  }

  // ── 2. 裸发送：不拼 marker、不剥回显，命令原样下发 ──
  input.shell.write(input.command, input.clear ?? 1);

  // ── 3. 轮询：pattern 命中 / 静默期满 / 兜底超时，先到者判完成 ──
  const startTime = Date.now();
  const deadline = startTime + effectiveTimeout;
  let accumulated = "";
  let lastByteAt = startTime; // 静默计时起点 = 发送时刻（空响应也能按时完成）

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const now = Date.now();
    const chunk = input.shell.drain();
    if (chunk) {
      accumulated += chunk;
      lastByteAt = now;
    }

    if (input.responseRegex && input.responseRegex.test(accumulated)) {
      logger.info(
        `${input.logPrefix} completed by pattern after ${now - startTime}ms`
      );
      return {
        output: accumulated,
        flushed,
        completedBy: "pattern",
        elapsedMs: now - startTime,
      };
    }
    if (now - lastByteAt >= input.quietMs) {
      logger.info(
        `${input.logPrefix} completed by quiet(${input.quietMs}ms) after ${
          now - startTime
        }ms`
      );
      return {
        output: accumulated,
        flushed,
        completedBy: "quiet",
        elapsedMs: now - startTime,
      };
    }
    if (now >= deadline) {
      logger.info(
        `${input.logPrefix} timeout after ${now - startTime}ms (no interrupt sent)`
      );
      return {
        output: accumulated,
        flushed,
        completedBy: "timeout",
        elapsedMs: now - startTime,
      };
    }
  }
}
