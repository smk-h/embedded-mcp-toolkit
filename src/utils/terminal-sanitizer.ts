// 终端输出辅助 — 清洗控制字符，防止终端显示错乱

/**
 * @brief 控制字符 → 可见文本标记映射表
 *
 * 串口/U-Boot 输出可能包含 NULL(0x00)、ESC(0x1B)、BS(0x08) 等控制字符。
 * 直接写入日志会导致 VSCode 将其识别为二进制文件而无法打开。
 * 此表将控制字符替换为可读的 ASCII 标记（如 [NUL]、[ESC]），
 * 既保留原始信息，又确保日志文件为纯文本。
 */
const CONTROL_CHARS: Record<number, string> = {
  0x00: "[NUL]",
  0x01: "[SOH]",
  0x02: "[STX]",
  0x03: "[ETX]",
  0x04: "[EOT]",
  0x05: "[ENQ]",
  0x06: "[ACK]",
  0x07: "[BEL]",
  0x08: "[BS]",
  0x0B: "[VT]",
  0x0C: "[FF]",
  0x0E: "[SO]",
  0x0F: "[SI]",
  0x10: "[DLE]",
  0x11: "[DC1]",
  0x12: "[DC2]",
  0x13: "[DC3]",
  0x14: "[DC4]",
  0x15: "[NAK]",
  0x16: "[SYN]",
  0x17: "[ETB]",
  0x18: "[CAN]",
  0x19: "[EM]",
  0x1A: "[SUB]",
  0x1B: "[ESC]",
  0x1C: "[FS]",
  0x1D: "[GS]",
  0x1E: "[RS]",
  0x1F: "[US]",
  0x7F: "[DEL]",
};

/** @brief 匹配所有非打印控制字符（保留 \t 0x09、\n 0x0A） */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * @brief 清洗串口/SSH 输出中的控制字符，防止终端显示错乱
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

/**
 * @brief 清理日志行中的控制字符
 *
 * 移除回车符 \r，并将所有非打印控制字符替换为可见标记。
 * 保留制表符 \t 和换行符 \n。
 * 供 FileLogger 和 Logger 共用。
 *
 * @param line 原始日志行（可能含控制字符）
 * @returns    纯文本的日志行，控制字符已转为可见标记
 */
export function sanitizeLine(line: string): string {
  // 移除所有回车符。串口输出常以 \r\n 结尾，\n 已作行分隔符处理，\r 是冗余的终端控制字符
  const stripped = line.replace(/\r/g, "");

  // CONTROL_RE 匹配 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F（不含 \t 0x09、\n 0x0A）
  // 对每个匹配到的控制字符，取其 charCode 查映射表 CONTROL_CHARS
  // 找到则替换为 "[ESC]" 等可见标记，找不到则丢弃（?? 确保空字符串不被误判为 falsy）
  return stripped.replace(CONTROL_RE, (ch) => CONTROL_CHARS[ch.charCodeAt(0)] ?? "");
}
