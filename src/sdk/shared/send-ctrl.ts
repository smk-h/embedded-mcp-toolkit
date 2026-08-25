/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : send-ctrl.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : 1.0.0
 * Description: 发送控制字符的统一动作
 *
 *   三个通道（adb/ssh/serial）的 send_ctrl 工具复用本函数，
 *   以「不追加换行」的方式发送控制字符，保证语义正确。
 *
 *   设计要点：
 *     - appendLineEnding=false：控制字符（如 \x03）后不可追加 \n，
 *       否则破坏其语义（如 \x03\n 在部分 shell 下会被当作两段输入）
 *     - 发送后 drain()：丢弃控制字符在 PTY 下的回显（如 ^C），
 *       避免污染下一次 read
 *     - settleMs 等待：给信号传递与远端响应留时间
 * ======================================================
 */

import type { InteractiveShell } from "../../transports/interactive-shell.js";

import { CONTROL_CHAR_MAP, type ControlChar } from "./prompt-detector.js";

/** @brief 控制字符信号生效的默认等待时长（毫秒） */
const DEFAULT_SETTLE_MS = 200;

/**
 * @brief 发送控制字符的统一流程
 *
 * 流程：
 *   1. 查 CONTROL_CHAR_MAP 得到字节字符串（如 "c" → "\x03"）
 *   2. 以 appendLineEnding=false 调用 shell.write，保证不追加换行
 *   3. drain() 丢弃缓冲区（控制字符回显 + 历史残留）
 *   4. 等待 settleMs 让信号生效
 *
 * @param shell    - 目标 shell 实例（任意通道）
 * @param key      - 控制字符类型（c/u/d/z）
 * @param settleMs - 信号生效等待时长（默认 200ms）
 * @returns 实际发送的字节字符串
 */
export async function sendControlChar(
  shell: InteractiveShell,
  key: ControlChar,
  settleMs: number = DEFAULT_SETTLE_MS
): Promise<string> {
  const byte: string = CONTROL_CHAR_MAP[key];

  // 第三参 false 是关键：不追加换行，确保控制字符语义正确
  shell.write(byte, 1, false);

  // 丢弃控制字符在 PTY 下的回显（如 ^C）以及发送前可能累积的残留，
  // 避免污染后续 read
  shell.drain();

  // 给 SIGINT 传递 + 远端响应留时间
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  return byte;
}
