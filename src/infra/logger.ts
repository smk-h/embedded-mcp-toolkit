/**
 * @brief 日志模块
 *
 * 通过 MCP 环境变量 LOG_SAVE / LOG_DIR 控制日志文件写入。
 * - LOG_SAVE 为真值时启用文件保存
 * - LOG_DIR 指定日志目录，默认 "./log"
 * - 日志文件名格式: YYYY-MM-DD_HH-mm-ss.log（北京时间）
 *
 * 导出单例 logger 对象，通过 logger.info / error / warn 写入日志。
 */

import { mkdirSync, appendFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { beijingFields, fileTimestamp, logTimestamp } from "../utils/timestamp.js";

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

    // 新文件或空文件时写入统一头部
    const isNew = !existsSync(this.logFile) || statSync(this.logFile).size === 0;
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      appendFileSync(this.logFile, `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`);
    }
  }

  /** 写入一行到日志文件 */
  private write(level: string, message: string): void {
    this.ensureInit();
    if (!this.logFile) return;
    try {
      const line = `${logTimestamp()} [${level}] ${message}\n`;
      // 移除非法控制字符，确保能安全编码为 UTF-8
      const safe = line.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      appendFileSync(this.logFile, Buffer.from(safe, "utf8"));
    } catch {
      /* 静默失败，不影响主流程 */
    }
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
    process.stderr.write(`${msg}\n`);
  }

  /** 错误日志 */
  error(...args: unknown[]): void {
    const msg = this.format(args);
    this.write("ERROR", msg);
    console.error(...args);
  }

  /** 警告日志 */
  warn(...args: unknown[]): void {
    const msg = this.format(args);
    this.write("WARN", msg);
    console.warn(...args);
  }

  /** 是否启用了文件保存 */
  get isEnabled(): boolean {
    return this.logFile !== null;
  }
}

/** 全局单例 logger */
export const logger = new Logger();
