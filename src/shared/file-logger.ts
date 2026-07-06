import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  type WriteStream,
} from "fs";
import { dirname, resolve } from "path";
import {
  beijingFields,
  fileTimestamp,
  logTimestamp,
} from "../utils/timestamp.js";
import { sanitizeLine } from "../utils/terminal-sanitizer.js";
import { logger } from "./logger.js";

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
      this.#logStream.write("\uFEFF");
      this.#logStream.write(
        `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`
      );
    }
  }

  /**
   * @brief 根据环境变量 SAVE2FILE_PATH 自动启用日志
   *
   * 若 SAVE2FILE_PATH 值为 "none" 或空则跳过；
   * 否则在 {SAVE2FILE_PATH}/{sessionId}_{YYYY-MM-DD_HH-mm-ss}.log 创建日志文件。
   *
   * @param sessionId 会话 ID（如 serial_1）
   */
  enableFromEnv(sessionId: string): void {
    const savePath = process.env.SAVE2FILE_PATH;
    if (!savePath || savePath === "none") return;
    const absDir = resolve(savePath);
    const logPath = resolve(absDir, `${sessionId}_${fileTimestamp()}.log`);
    this.enable(logPath);
    logger.info(`[file-logger] file logging enabled: ${logPath}`);
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
