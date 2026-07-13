/**
 * PowerShell 工具函数与交互式 Shell 管理器
 *
 * 提供两层能力：
 *   1. 一次性脚本执行：encodePsCommand / execPowerShell（非交互式，执行后进程退出）
 *   2. 交互式 Shell：PowerShellShell 类（持久化进程，支持 open/write/read/close）
 *
 * 交互式 Shell 通过 child_process.spawn 启动持久化的 PowerShell 进程，
 * 实现与 SerialShell / SSHShell 相同的缓冲区管理接口，
 * 可复用于 PshHandler 的解锁流程和 interactiveLoop。
 */
import {
  execSync,
  spawn,
  type ChildProcess,
  type ExecSyncOptionsWithStringEncoding,
} from "child_process";

import { BaseShell } from "./base-shell.js";
import { logger } from "../shared/logger.js";

// ── 一次性执行工具 ──────────────────────────────────────────

/** PowerShell 执行超时（毫秒） */
export const POWERSHELL_TIMEOUT = 15000;

/** execSync 的通用选项 */
export const PS_EXEC_OPTIONS: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: POWERSHELL_TIMEOUT,
  stdio: ["pipe", "pipe", "ignore"],
};

/**
 * 将 PowerShell 脚本编码为 Base64（UTF-16LE）
 *
 * PowerShell -EncodedCommand 要求脚本为 UTF-16LE 编码的 Base64 字符串，
 * 此函数封装了编码逻辑。
 */
export function encodePsCommand(script: string): string {
  const buf = Buffer.from(script, "utf16le");
  return buf.toString("base64");
}

/**
 * 执行一段 PowerShell 脚本并返回 stdout 的原始输出
 *
 * @param psScript  PowerShell 脚本内容
 * @param timeoutMs 可选的自定义超时（默认使用 POWERSHELL_TIMEOUT）
 * @returns stdout 字符串，错误时返回空字符串并记录日志
 */
export function execPowerShell(psScript: string, timeoutMs?: number): string {
  try {
    const encoded = encodePsCommand(psScript);
    const options: ExecSyncOptionsWithStringEncoding = timeoutMs
      ? { ...PS_EXEC_OPTIONS, timeout: timeoutMs }
      : PS_EXEC_OPTIONS;
    return execSync(
      `powershell -NoProfile -OutputFormat Text -EncodedCommand ${encoded}`,
      options
    ) as string;
  } catch (err) {
    logger.error("[powershell] execution failed:", err);
    return "";
  }
}

// ── 交互式 PowerShell Shell ─────────────────────────────────

/**
 * @brief 交互式 PowerShell Shell 配置
 *
 * @param workingDir 工作目录（默认当前进程的工作目录）
 * @param noProfile  跳过加载用户配置文件（默认 true）
 */
export interface PowerShellShellConfig {
  workingDir?: string;
  noProfile?: boolean;
}

/**
 * @brief 交互式 PowerShell Shell 管理器
 *
 * 通过 child_process.spawn 启动持久化的 PowerShell 进程，
 * 提供 open / write / read / close 四个核心方法，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 *
 * 与 SerialShell / SSHShell 保持相同的接口模式，
 * 实现 transport/loop.ts 中的 InteractiveShell 接口。
 */
export class PowerShellShell extends BaseShell {
  #process: ChildProcess | null = null;
  #config: PowerShellShellConfig;

  /** @brief ADB/PowerShell 通道的 banner 采集等待时长 */
  protected bannerWaitMs = 800;

  /**
   * @brief 构造函数
   * @param config PowerShell Shell 配置
   */
  constructor(config: PowerShellShellConfig = {}) {
    super();
    this.#config = config;
  }

  /** @brief 获取当前工作目录 */
  getWorkingDir(): string {
    return this.#config.workingDir ?? process.cwd();
  }

  /**
   * @brief 启动交互式 PowerShell 进程，注册数据监听
   *
   * 模板方法 acquire：spawn 启动持久化 PowerShell 进程，
   * 注册 stdout/stderr/close/error 监听。
   * 不负责 banner 采集（由基类 open 统一处理）。
   */
  protected async acquire(): Promise<void> {
    const args: string[] = [];
    if (this.#config.noProfile !== false) {
      args.push("-NoProfile");
    }
    args.push("-NoLogo", "-NoExit");

    const proc = spawn("powershell", args, {
      cwd: this.#config.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#process = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    proc.on("close", () => {
      this.#process = null;
    });
    proc.on("error", () => {
      this.#process = null;
    });
  }

  /**
   * @brief 向 PowerShell 进程发送原始字节
   *
   * payload 已含换行处理，此处只校验进程是否存活并发送。
   *
   * @param payload 已拼接换行的完整发送内容
   * @throws 进程未启动或已退出时抛出 "PowerShell shell not open. Call open() first."
   */
  protected rawWrite(payload: string): void {
    if (!this.#process || this.#process.exitCode !== null) {
      throw new Error("PowerShell shell not open. Call open() first.");
    }
    this.#process.stdin!.write(payload);
  }

  /**
   * @brief 关闭 PowerShell 进程
   *
   * 发送 exit 命令并终止进程。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
    if (this.#process) {
      const proc = this.#process;
      this.#process = null;
      try {
        proc.stdin?.write("exit\n");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }, 3000);
          proc.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
