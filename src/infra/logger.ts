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

import { mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

/** 当前北京时间各字段 */
function beijingFields() {
  const now = new Date();
  const bj = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  );
  return {
    y: bj.getFullYear(),
    m: String(bj.getMonth() + 1).padStart(2, "0"),
    d: String(bj.getDate()).padStart(2, "0"),
    hh: String(bj.getHours()).padStart(2, "0"),
    mm: String(bj.getMinutes()).padStart(2, "0"),
    ss: String(bj.getSeconds()).padStart(2, "0"),
  };
}

/**
 * @brief 日志文件名用时间戳（不含空格/冒号）
 *
 * 格式: YYYY-MM-DD_HH-mm-ss
 */
function fileTimestamp(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}-${f.mm}-${f.ss}`;
}

/**
 * @brief 日志行内时间戳
 *
 * 格式: [YYYY-MM-DD HH:mm:ss]
 */
function logTimestamp(): string {
  const f = beijingFields();
  return `[${f.y}-${f.m}-${f.d} ${f.hh}:${f.mm}:${f.ss}]`;
}

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
  }

  /** 写入一行到日志文件 */
  private write(level: string, message: string): void {
    this.ensureInit();
    if (!this.logFile) return;
    try {
      appendFileSync(
        this.logFile,
        `${logTimestamp()} [${level}] ${message}\n`,
        "utf8"
      );
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
