/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : prompt-detector.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : 1.0.0
 * Description: Shell 提示符检测器与控制字符映射
 *
 *   提供两类共享能力，供三个通道（adb/ssh/serial）的 exec 编排复用：
 *     1. ControlChar / CONTROL_CHAR_MAP
 *        —— 控制字符类型与字节映射（Ctrl+C/U/D/Z），供 send_ctrl 工具使用
 *     2. PromptDetector
 *        —— 判断累积输出是否已出现 shell 提示符（命令结束信号），
 *           支持默认正则 + 设备配置覆盖，用于 exec 的命令结束判定
 * ======================================================
 */

/**
 * @brief 支持的控制字符类型
 *
 * 对应终端常用控制字符：
 *   - c : Ctrl+C（\x03）→ SIGINT，中断当前命令
 *   - u : Ctrl+U（\x15）→ 清除当前输入行
 *   - d : Ctrl+D（\x04）→ EOF，结束输入
 *   - z : Ctrl+Z（\x1a）→ SIGTSTP，挂起当前命令
 */
export type ControlChar = "c" | "u" | "d" | "z";

/**
 * @brief 控制字符到字节字符串的映射
 *
 * send_ctrl 工具与 exec 熔断逻辑通过此映射查表得到待发送的字节，
 * 避免散落的字面量。值采用 Readonly 防止运行期被篡改。
 */
export const CONTROL_CHAR_MAP: Readonly<Record<ControlChar, string>> = {
  c: "\x03", // Ctrl+C → SIGINT
  u: "\x15", // Ctrl+U → 清行
  d: "\x04", // Ctrl+D → EOF
  z: "\x1a", // Ctrl+Z → 挂起
};

/**
 * @brief shell 提示符检测器
 *
 * 判断一段累积输出是否已出现 shell 提示符（命令结束信号）。
 * 支持默认提示符集与设备配置覆盖：
 *   - 未传 customPattern：使用 DEFAULT_PATTERN，覆盖 Android / Linux / U-Boot 常见 prompt
 *   - 传 customPattern：按设备配置的正则识别（应对自定义 PS1）
 *
 * 仅检测「输出末尾」是否以提示符结尾，避免命令输出中间偶然出现的 # / $ 被误判。
 */
export class PromptDetector {
  /**
   * @brief 默认提示符正则
   *
   * 锚定输出末尾（$），匹配以下结尾的提示符：
   *   - Android :  / $  、  :/ $  、  :/ #
   *   - Linux   :  $  、  #  、  >
   *   - U-Boot  :  =>  、  U-Boot>
   *
   * 不追求覆盖所有自定义 PS1，未命中时由 exec 的 maxDuration 熔断兜底
   * （见 spec.md「不做的事」第 5 条）。
   */
  static readonly DEFAULT_PATTERN =
    /(?:[^\r\n]*[:/]?\s*[/~]\s*[#$]\s*|[^\r\n]*[#>$]\s*|[^\r\n]*=>\s*)$/;

  /** @brief 实际使用的提示符正则（默认或配置覆盖） */
  private readonly pattern: RegExp;

  /**
   * @brief 构造提示符检测器
   * @param customPattern - 可选的自定义提示符正则字符串，来自设备配置 promptPattern
   */
  constructor(customPattern?: string) {
    // 配置覆盖优先；未配置时用默认正则
    this.pattern = customPattern
      ? new RegExp(customPattern)
      : PromptDetector.DEFAULT_PATTERN;
  }

  /**
   * @brief 检测累积输出是否以提示符结尾
   *
   * PTY 回显的命令行本身不以提示符结尾，只有命令执行完返回到交互态时
   * 才会出现提示符。因此检测「输出末尾」即可判定命令是否结束。
   *
   * @param accumulated - 当前累积的全部输出
   * @returns true 表示已检测到提示符，命令结束
   */
  detect(accumulated: string): boolean {
    return this.pattern.test(accumulated);
  }
}
