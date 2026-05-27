// 终端输出辅助 — 清洗控制字符，防止终端显示错乱

/**
 * 清洗串口/SSH 输出中的控制字符，防止终端显示错乱
 *
 * 嵌入式串口终端通常使用 CR+LF（\r\n）换行，且可能包含 ANSI 转义序列。
 * 直接 console.log 这些原始数据会导致：
 *   - \r 将光标移回行首，覆盖已有输出
 *   - ANSI 转义序列移动光标，造成文本出现在错误位置
 *
 * 清洗策略：
 *   1. \r\n → \n（Windows 风格 CRLF 归一化为 LF）
 *   2. 孤立的 \r（无 \n 跟随）→ \n（视为换行）
 *   3. 移除 ANSI CSI 序列（\x1b[...m, \x1b[...A/B/C/D 等）
 *   4. 移除其他控制字符（保留 \n 和 \t）
 *
 * @param raw 原始输出字符串
 * @return 清洗后的安全字符串，可安全打印到终端
 */
export function sanitize(raw: string): string {
  return (
    raw
      // 先归一化 CRLF → LF
      .replace(/\r\n/g, "\n")
      // 孤立的 CR 替换为 LF
      .replace(/\r/g, "\n")
      // 移除 ANSI CSI 序列：ESC[ + 参数 + 字母
      // 匹配 \x1b[...m (SGR), \x1b[...A/B/C/D/H/J/K 等光标控制
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // eslint-disable-line no-control-regex
      // 移除其他 ANSI 序列（如 ESC]...BEL 等）
      .replace(/\x1b\][^\x07]*\x07/g, "") // eslint-disable-line no-control-regex
      .replace(/\x1b[^[][0-9;]*[A-Za-z]/g, "") // eslint-disable-line no-control-regex
      // 移除除 \n \t 之外的控制字符（ASCII 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // eslint-disable-line no-control-regex
  );
}
