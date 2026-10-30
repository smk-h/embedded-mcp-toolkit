/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : logger.ts
 * Author     : sumu
 * Date       : 2026/05/26
 * Version    : x.x.x
 * Description: 日志模块
 *
 * 通过 MCP 环境变量 LOG_SAVE / LOG_DIR 控制日志文件写入。
 * - LOG_SAVE 为真值时启用文件保存
 * - LOG_DIR 指定日志目录，默认 "./log"
 * - 日志文件名格式: YYYY-MM-DD_HHMMSS.log（北京时间）
 * - 单文件超过 LOG_MAX_SIZE_MB（默认 10MB）自动滚动到 _001、_002… 分段
 *   （长驻进程不再产出上百兆的单个业务日志文件，见 log-rotation.ts）
 *
 * 导出单例 logger 对象，通过 logger.info / error / warn 写入日志。
 * ======================================================
 */

import { mkdirSync, appendFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import {
  beijingFields,
  fileTimestamp,
  logTimestamp,
} from "../utils/timestamp.js";
import { sanitizeLine } from "../utils/terminal-sanitizer.js";
import { formatPartSuffix, LogRotator } from "./log-rotation.js";

/**
 * @brief 日志来源标识约定（手写于消息开头）
 *
 * - 工具名/模块名，小写蛇形：[serial_exec] [config] [zmodem]
 * - 动态实例用冒号连接：[PshSM:${transport}] [ssh_build:${session_id}]
 * - 会话日志(FileLogger)记录设备原始字节，不加来源前缀
 */

/**
 * @brief 日志记录器
 *
 * 提供 info / error / warn 三个方法，
 * 调用时同时写入日志文件和终端。
 * 日志文件在首次写入时延迟创建，避免依赖模块加载时的环境变量时序。
 */
class Logger {
  private logFile: string | null = null;
  private initialized = false;
  /** 分段记账器：记录当前分段路径与已写字节数，ensureInit 时创建 */
  private rotator: LogRotator | null = null;

  /** 延迟初始化（首次写入时触发，确保 LOG_SAVE / LOG_DIR 已设置） */
  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;

    const save = process.env.LOG_SAVE;
    if (save !== "1" && save !== "true") return;

    const dir = process.env.LOG_DIR ?? "./log";
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.logFile = join(dir, `${fileTimestamp()}.log`);

    // 续写既有同名文件时对齐已写字节数，滚动阈值按真实文件大小判断
    const existing = existsSync(this.logFile) ? statSync(this.logFile).size : 0;
    this.rotator = new LogRotator(this.logFile);
    this.rotator.resetTo(existing);

    // 新文件或空文件时写入统一头部
    if (existing === 0) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      const header = `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`;
      appendFileSync(this.logFile, header);
      this.rotator.account(Buffer.byteLength(header, "utf8"));
    }
  }

  /**
   * @brief 追加文本到当前分段，超过上限时先滚动到下一段
   *
   * @param text 已格式化的日志文本（可多行）
   */
  private appendText(text: string): void {
    if (!this.logFile) return;
    try {
      const buf = Buffer.from(sanitizeLine(text), "utf8");
      if (this.rotator?.shouldRotate(buf.length)) {
        this.rotate();
      }
      if (!this.logFile) return;
      appendFileSync(this.logFile, buf);
      this.rotator?.account(buf.length);
    } catch {
      /* 静默失败，不影响主流程 */
    }
  }

  /**
   * @brief 滚动到下一分段（_001、_002…），并写入续接头部
   */
  private rotate(): void {
    if (!this.rotator) return;
    this.logFile = this.rotator.rotate();
    const f = beijingFields();
    const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
    const header = `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log (part ${formatPartSuffix(
      this.rotator.part
    )}, continued) ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`;
    appendFileSync(this.logFile, header);
    this.rotator.account(Buffer.byteLength(header, "utf8"));
  }

  /**
   * 安全写入 stderr：管道已断（MCP 客户端掉线）时写操作会抛 EPIPE，
   * 进而再次触发 uncaughtException，形成日志死循环。这里静默吞掉。
   */
  private safeStderr(msg: string): void {
    try {
      process.stderr.write(msg);
    } catch {
      /* stderr 管道断开，忽略 */
    }
  }

  /** 写入一行到日志文件（超限自动滚动到下一分段） */
  private write(level: string, message: string): void {
    this.ensureInit();
    if (!this.logFile) return;
    this.appendText(`${logTimestamp()} [${level}] ${message}\n`);
  }

  /** 序列化参数为字符串 */
  private format(args: unknown[]): string {
    return args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
  }

  /** 普通信息日志（终端输出到 stderr，避免污染 MCP stdio 协议通道） */
  info(...args: unknown[]): void {
    const msg = this.format(args);
    this.write("INFO", msg);
    this.safeStderr(`${msg}\n`);
  }

  /** 错误日志 */
  error(...args: unknown[]): void {
    const msg = this.format(args);
    this.write("ERROR", msg);
    this.safeStderr(`${msg}\n`);
  }

  /** 警告日志 */
  warn(...args: unknown[]): void {
    const msg = this.format(args);
    this.write("WARN", msg);
    this.safeStderr(`${msg}\n`);
  }

  /**
   * 写入带分隔符的内容块到日志文件和终端
   *
   * 格式:
   *   [YYYY-MM-DD HH:mm:ss] [LEVEL] [context] 描述::
   *   ----------------------------
   *       缩进 4 空格的内容行
   *   ----------------------------
   *
   * @param level       日志级别 (INFO, WARN, ERROR)
   * @param context     上下文标识 (如 "psh", "ssh_build:ssh_1")
   * @param description 块描述/标签
   * @param content     块内容
   * @param maxLines    最大保留行数，正数=截断省略中间行，-1=全部显示（默认 -1）
   */
  block(
    level: string,
    context: string,
    description: string,
    content: string,
    maxLines = -1
  ): void {
    this.ensureInit();
    if (!content) return;

    let display = content;
    if (maxLines > 0) {
      const lines = content.split(/\r?\n/);
      if (lines.length > maxLines) {
        const half = Math.floor(maxLines / 2);
        const head = lines.slice(0, half).join("\n");
        const tail = lines.slice(-half).join("\n");
        display = `${head}\n...[${lines.length - maxLines} lines omitted]...\n${tail}`;
      }
    }

    const parts: string[] = [];
    const ctxTag = context ? `[${context}] ` : "";
    parts.push(`${logTimestamp()} [${level}] ${ctxTag}${description}:`);
    parts.push("----------------------------");
    for (const line of display.split("\n")) {
      parts.push(`    ${line}`);
    }
    parts.push("----------------------------");

    if (this.logFile) {
      this.appendText(parts.join("\n") + "\n");
    }

    const indented = display
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    this.safeStderr(
      `${description}:\n----------------------------\n${indented}\n----------------------------\n`
    );
  }

  /** 是否启用了文件保存 */
  get isEnabled(): boolean {
    return this.logFile !== null;
  }

  /**
   * @brief 当前业务日志文件的绝对路径
   * @details 触发延迟初始化，保证返回路径就是实际正在写入的文件
   *          （文件名在首次写入时定格，一处生成、处处一致；
   *          写满一段后返回新的分段路径 _001/_002…）；
   *          LOG_SAVE 未启用时返回 null。
   */
  get filePath(): string | null {
    this.ensureInit();
    return this.logFile;
  }
}

/** 全局单例 logger */
export const logger = new Logger();
