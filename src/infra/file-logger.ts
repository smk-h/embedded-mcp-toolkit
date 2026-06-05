import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "fs";
import { dirname } from "path";
import { beijingFields, logTimestamp } from "../utils/timestamp.js";

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
 * @brief 清理日志行中的控制字符
 *
 * 移除回车符 \r，并将所有非打印控制字符替换为可见标记。
 * 保留制表符 \t 和换行符 \n（后者已在 write() 中处理）。
 *
 * @param line 原始日志行（可能含控制字符）
 * @returns    纯文本的日志行，控制字符已转为可见标记
 */
function sanitizeLine(line: string): string {
  // 移除所有回车符。串口输出常以 \r\n 结尾，\n 在 write() 中已作行分隔符处理，\r 是冗余的终端控制字符
  const stripped = line.replace(/\r/g, "");

  // CONTROL_RE 匹配 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F（不含 \t 0x09、\n 0x0A）
  // 对每个匹配到的控制字符，取其 charCode 查映射表 CONTROL_CHARS
  // 找到则替换为 "[ESC]" 等可见标记，找不到则丢弃（?? 确保空字符串不被误判为 falsy）
  return stripped.replace(CONTROL_RE, (ch) => CONTROL_CHARS[ch.charCodeAt(0)] ?? "");
}

/**
 * @brief 原始数据文件日志记录器
 *
 * 将接收到的原始数据按行写入日志文件，每行附时间戳。
 * 行缓冲区确保跨 chunk 到达的数据合并为完整行后再输出，
 * 同一行只有一个时间戳（该行实际到达完成的时刻）。
 *
 * 供 SerialShell、SSHShell、AdbShell、PowerShellShell 等复用。
 */
export class FileLogger {
  /** 日志文件写入流，enable 时创建，disable 时关闭 */
  #logStream: WriteStream | null = null;
  /** 行缓冲区：缓存不完整行，遇换行符时整行输出 */
  #logLineBuf = "";

  /**
   * @brief 启用文件日志
   *
   * 创建日志目录（如不存在），打开文件写入流。
   * 若文件为新文件或空文件，先写入统一头部。
   *
   * @param logPath 日志文件完整路径
   */
  enable(logPath: string): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const isNew = !existsSync(logPath) || statSync(logPath).size === 0;
    this.#logStream = createWriteStream(logPath, { flags: "a" });
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      this.#logStream.write(`=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`);
    }
  }

  /**
   * @brief 关闭文件日志
   *
   * 将行缓冲区中剩余的不完整行写入文件，然后关闭写流。
   * 未启用时调用无副作用。
   */
  disable(): void {
    if (this.#logStream) {
      if (this.#logLineBuf) {
        this.#logStream.write(`${logTimestamp()} ${this.#logLineBuf}\n`);
        this.#logLineBuf = "";
      }
      this.#logStream.end();
      this.#logStream = null;
    }
  }

  /**
   * @brief 写入原始数据文本
   *
   * 将接收到的 chunk 按换行符分割，完整行附时间戳写入文件，
   * 不完整行暂存到行缓冲区等待下一个 chunk 拼接。
   * 未启用时无副作用。
   *
   * @param text 接收到的原始数据文本
   */
  write(text: string): void {
    if (!this.#logStream) return;
    this.#logLineBuf += text;
    const lines = this.#logLineBuf.split("\n");
    this.#logLineBuf = lines.pop() ?? "";
    for (const line of lines) {
      this.#logStream.write(`${logTimestamp()} ${sanitizeLine(line)}\n`);
    }
  }
}
