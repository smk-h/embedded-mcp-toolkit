/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : file-logger.ts
 * Author     : sumu
 * Date       : 2026/06/05
 * Version    : x.x.x
 * Description: 原始数据文件日志记录器 FileLogger
 * ======================================================
 */

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
  dateDirName,
  fileTimestampMs,
  logTimestamp,
} from "../utils/timestamp.js";
import { sanitizeLine } from "../utils/terminal-sanitizer.js";
import { logger } from "./logger.js";
import { formatPartSuffix, LogRotator } from "./log-rotation.js";

/**
 * @brief 原始数据文件日志记录器
 *
 * 将接收到的原始数据按行写入日志文件，每行附时间戳。
 * 行缓冲区确保跨 chunk 到达的数据合并为完整行后再输出，
 * 同一行只有一个时间戳（该行实际到达完成的时刻）。
 *
 * 落盘位置：{SAVE2FILE_PATH}/{deviceName}/{YYYY-MM-DD}/{YYYY-MM-DD_HHMMSSsss}-{sessionId}.log
 * （设备名缺失时去掉一层 deviceName），按天分目录便于历史会话归档；
 * 文件名时间优先（与业务日志同前缀），单个文件被拷走后仍能看出属于哪一天。
 *
 * 单文件超过 LOG_MAX_SIZE_MB（默认 10MB）时自动滚动到下一分段：
 * 首段沿用原文件名，之后依次是 _001、_002…（见 log-rotation.ts），
 * 长会话不会再产出上百兆的单个日志文件。
 *
 * 供 SerialShell、SSHShell、AdbShell 等复用。
 */
export class FileLogger {
  /** 日志文件写入流，enable 时创建，disable 时关闭；滚动时换到新分段 */
  #logStream: WriteStream | null = null;
  /** 行缓冲区：缓存不完整行，遇换行符时整行输出 */
  #logLineBuf = "";
  /** 分段记账器：记录当前分段路径与已写字节数，enable 时创建 */
  #rotator: LogRotator | null = null;

  /**
   * @brief 启用文件日志
   *
   * 创建日志目录（如不存在），打开文件写入流。
   * 若文件为新文件或空文件，先写入统一头部。
   *
   * @param logPath 日志文件完整路径（首段路径）
   */
  enable(logPath: string): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const existing = existsSync(logPath) ? statSync(logPath).size : 0;
    const isNew = existing === 0;
    this.#logStream = createWriteStream(logPath, { flags: "a" });
    // 分段器读取当前 LOG_MAX_SIZE_MB；续写既有文件时对齐已写字节数，
    // 保证滚动阈值按真实文件大小判断，而不是从 0 重新计
    this.#rotator = new LogRotator(logPath);
    this.#rotator.resetTo(existing);
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      this.#logStream.write("\uFEFF");
      const header = `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`;
      this.#logStream.write(header);
      this.#rotator.account(3 + Buffer.byteLength(header, "utf8"));
    }
  }

  /**
   * @brief 根据环境变量 SAVE2FILE_PATH 自动启用日志
   *
   * 若 SAVE2FILE_PATH 值为 "none" 或空则跳过；否则按以下规则创建日志文件：
   *   - deviceName 可用：{SAVE2FILE_PATH}/{deviceName}/{YYYY-MM-DD}/{YYYY-MM-DD_HHMMSSsss}-{sessionId}.log
   *   - deviceName 缺失：{SAVE2FILE_PATH}/{YYYY-MM-DD}/{YYYY-MM-DD_HHMMSSsss}-{sessionId}.log（降级到根目录）
   *
   * 按天分目录 + 文件名带日期解决"进程重启后 session 编号从 1 重新开始"导致的
   * 同名混淆：目录负责归拢与按天清理，文件名负责拷贝出去后仍可辨识日期；
   * 毫秒后缀保证同一秒内多次建会话也不撞名。
   * 设备/日期子目录由 enable() 内部 mkdirSync 递归创建，无需此处额外建目录。
   *
   * @param sessionId 会话 ID（如 serial_1，本身已含通道前缀）
   * @param deviceName 设备名（如 board-lubancat）；可选，缺失时降级写入根目录
   * @returns 首段日志文件完整路径（写满后自动滚动到 _001、_002…）；文件日志未启用时返回 undefined
   */
  enableFromEnv(sessionId: string, deviceName?: string): string | undefined {
    const savePath = process.env.SAVE2FILE_PATH;
    if (!savePath || savePath === "none") return undefined;
    const absDir = resolve(savePath);
    const day = dateDirName();
    // 时间优先：与业务日志/local 日志同前缀，混排时天然成时间线；
    // sessionId 已是 "通道_序号" 形态，不再重复拼通道类型
    const fileName = `${fileTimestampMs()}-${sessionId}.log`;
    // deviceName 真值检查：空串/undefined 均视为缺失，降级到根目录，保证日志不丢
    const logPath = deviceName
      ? resolve(absDir, deviceName, day, fileName)
      : resolve(absDir, day, fileName);
    this.enable(logPath);
    logger.info(`[file-logger] file logging enabled: ${logPath}`);
    return logPath;
  }

  /**
   * @brief 当前正在写入的分段日志路径
   *
   * 未启用（或已 disable）时返回 null；滚动后返回新分段路径。
   */
  get currentPath(): string | null {
    return this.#rotator && this.#logStream ? this.#rotator.currentPath : null;
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
        // 尾行同样要清洗：缓冲区可能残留带裸 ESC 的不完整行（如 \x1b[?2004h…）
        this.#writeLine(
          `${logTimestamp()} ${sanitizeLine(this.#logLineBuf)}\n`
        );
        this.#logLineBuf = "";
      }
      this.#logStream.end();
      this.#logStream = null;
    }
    this.#rotator = null;
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
      this.#writeLine(`${logTimestamp()} ${sanitizeLine(line)}\n`);
    }
  }

  /**
   * @brief 写入一整行（含换行符），必要时先滚动分段
   *
   * 单行是分段的最小单位：超限时先切到下一段再整行写入，
   * 不会把一行内容拆到两个文件里。
   *
   * @param line 已带时间戳前缀与换行符的日志行
   */
  #writeLine(line: string): void {
    const stream = this.#logStream;
    if (!stream || !this.#rotator) return;
    const len = Buffer.byteLength(line, "utf8");
    if (this.#rotator.shouldRotate(len)) {
      this.#rotate();
    }
    const target = this.#logStream;
    if (!target) return;
    target.write(line);
    this.#rotator?.account(len);
  }

  /**
   * @brief 滚动到下一分段
   *
   * 关闭当前写入流，打开 _001/_002… 新分段，并写入续接头部
   * （标注分段序号与时间，便于多文件按时间线拼接阅读）。
   */
  #rotate(): void {
    if (!this.#rotator) return;
    const nextPath = this.#rotator.rotate();
    this.#logStream?.end();
    this.#logStream = createWriteStream(nextPath, { flags: "a" });

    const f = beijingFields();
    const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
    const header = `\uFEFF=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log (part ${formatPartSuffix(
      this.#rotator.part
    )}, continued) ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`;
    this.#logStream.write(header);
    // BOM 已内嵌在 header 首字符，byteLength 已含其 3 字节，无需额外相加
    this.#rotator.account(Buffer.byteLength(header, "utf8"));
  }
}
