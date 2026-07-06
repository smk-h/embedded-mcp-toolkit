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

import { OutputBuffer } from "./output-buffer.js";
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
export class PowerShellShell {
  #process: ChildProcess | null = null;
  #output = new OutputBuffer();
  #config: PowerShellShellConfig;

  /**
   * @brief 构造函数
   * @param config PowerShell Shell 配置
   */
  constructor(config: PowerShellShellConfig = {}) {
    this.#config = config;
  }

  /** @brief 获取当前工作目录 */
  getWorkingDir(): string {
    return this.#config.workingDir ?? process.cwd();
  }

  /**
   * @brief 启动交互式 PowerShell 进程
   *
   * 通过 spawn 启动持久化的 PowerShell 进程，
   * 注册 stdout/stderr 数据监听。
   * 此时不收集输出数据，需调用 write() 后才开始收集。
   *
   * @return shell 启动时的初始输出（banner / prompt）
   */
  async open(): Promise<string> {
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
      this.#output.append(data.toString());
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.#output.append(data.toString());
    });
    proc.on("close", () => {
      this.#process = null;
    });
    proc.on("error", () => {
      this.#process = null;
    });

    // 收集 banner 后停止
    this.#output.startCollecting();
    await new Promise((r) => setTimeout(r, 800));
    return this.#output.read(1);
  }

  /**
   * @brief 向 PowerShell 进程发送数据
   *
   * @param data              要发送的数据
   * @param clear             清空标志(默认1)：1=清空后收集，0=追加收集
   * @param appendLineEnding  是否追加换行符(默认true)：false 时发送原始数据(如 \x03 即 Ctrl+C)
   */
  write(
    data: string,
    clear: number = 1,
    appendLineEnding: boolean = true
  ): void {
    if (!this.#process || this.#process.exitCode !== null) {
      throw new Error("PowerShell shell not open. Call open() first.");
    }
    this.#output.prepareWrite(clear);
    this.#process.stdin!.write(appendLineEnding ? `${data}\n` : data);
  }

  /**
   * @brief 读取缓冲区中的输出数据
   *
   * 返回缓冲区内容，并根据 clear 参数决定是否清空缓冲区。
   *
   * @param clear 清空标志，控制读取后缓冲区状态：
   *              - 1（默认）：读取后清空缓冲区，下次 read() 返回新数据
   *              - 0：读取后保留缓冲区内容，下次 read() 仍可获取相同数据
   * @return 缓冲区中的文本内容
   */
  read(clear: number = 1): string {
    return this.#output.read(clear);
  }

  /**
   * @brief 关闭 PowerShell 进程
   *
   * 发送 exit 命令并终止进程，释放所有资源。
   */
  async close(): Promise<void> {
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
    this.#output.reset();
  }
}
