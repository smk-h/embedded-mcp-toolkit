/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : powershell.ts
 * Author     : sumu
 * Date       : 2026/05/27
 * Version    : x.x.x
 * Description: PowerShell 工具函数与交互式 Shell 管理器
 *
 * 提供两层能力：
 *   1. 一次性脚本执行：encodePsCommand / execPowerShell（非交互式，执行后进程退出）
 *   2. 交互式 Shell：PowerShellShell 类（持久化进程，支持 open/write/read/close）
 *
 * 交互式 Shell 通过 child_process.spawn 启动持久化的 PowerShell 进程，
 * 实现与 SerialShell / SSHShell 相同的缓冲区管理接口，
 * 可复用于 PshHandler 的解锁流程。
 *
 * 编码说明：powershell.exe 在 stdio 重定向（管道）下的输入输出编码
 * 跟随控制台代码页（简体中文 Windows 为 936/GBK），并非 UTF-8。
 * 因此会话打开时检测一次代码页，之后 stdout/stderr 按该代码页流式解码、
 * stdin 按该代码页编码，保证 AI 收到与会话日志写入的均为正确文本。
 * ======================================================
 */
import {
  execSync,
  spawn,
  type ChildProcess,
  type ExecSyncOptionsWithBufferEncoding,
} from "child_process";
import iconv from "iconv-lite";
import { TextDecoder } from "util";

import { BaseShell } from "./base-shell.js";
import { logger } from "../shared/logger.js";

// ── 控制台代码页检测与编码转换 ──────────────────────────────

/** 缓存的活动代码页（chcp 结果），进程生命周期内视为不变 */
let cachedCodePage: number | null = null;

/** 常见控制台代码页 → WHATWG 编码标签映射（TextDecoder / iconv 通用） */
const CODEPAGE_LABELS: Record<number, string> = {
  936: "gbk",
  950: "big5",
  949: "euc-kr",
  932: "shift-jis",
  866: "ibm866",
  20866: "koi8-r",
  21866: "koi8-r",
  65001: "utf-8",
};

/**
 * @brief 检测当前控制台活动代码页（等价 chcp）
 *
 * 结果缓存于模块级变量，避免每次会话/执行重复起进程。
 * chcp.com 输出的标签文字随系统语言本地化，但代码页数字
 * 始终是输出中最后一段连续数字，与语言无关。
 *
 * @returns 代码页编号；检测失败时回退 65001（UTF-8）并记录告警
 */
export function detectConsoleCodePage(): number {
  if (cachedCodePage === null) {
    cachedCodePage = 65001;
    try {
      const out = execSync("chcp.com", {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).toString("latin1");
      const runs = out.match(/\d+/g);
      if (runs?.length) {
        cachedCodePage = Number(runs[runs.length - 1]);
      }
    } catch (err) {
      logger.warn("[powershell] chcp detect failed, fallback 65001:", err);
    }
  }
  return cachedCodePage;
}

/**
 * @brief 代码页编号转编码标签
 *
 * @param cp 代码页编号（如 936）
 * @returns 编码标签（如 "gbk"）；未知代码页回退 "utf-8" 并记录告警
 */
export function codepageToLabel(cp: number): string {
  if (CODEPAGE_LABELS[cp]) return CODEPAGE_LABELS[cp];
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  logger.warn(`[powershell] unknown codepage ${cp}, fallback utf-8`);
  return "utf-8";
}

// ── 一次性执行工具 ──────────────────────────────────────────

/** PowerShell 执行超时（毫秒） */
export const POWERSHELL_TIMEOUT = 15000;

/** execSync 的通用选项（按 Buffer 返回，由调用方按代码页解码） */
export const PS_EXEC_OPTIONS: ExecSyncOptionsWithBufferEncoding = {
  encoding: "buffer",
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
 * 执行一段 PowerShell 脚本并返回 stdout 文本
 *
 * 输入经 UTF-16LE Base64（-EncodedCommand）传递，不受代码页影响；
 * 输出字节按当前控制台代码页解码，避免中文系统（GBK）下乱码。
 *
 * @param psScript  PowerShell 脚本内容
 * @param timeoutMs 可选的自定义超时（默认使用 POWERSHELL_TIMEOUT）
 * @returns stdout 字符串，错误时返回空字符串并记录日志
 */
export function execPowerShell(psScript: string, timeoutMs?: number): string {
  try {
    const encoded = encodePsCommand(psScript);
    const options: ExecSyncOptionsWithBufferEncoding = timeoutMs
      ? { ...PS_EXEC_OPTIONS, timeout: timeoutMs }
      : PS_EXEC_OPTIONS;
    const out = execSync(
      `powershell -NoProfile -OutputFormat Text -EncodedCommand ${encoded}`,
      options
    ) as Buffer;
    return new TextDecoder(codepageToLabel(detectConsoleCodePage())).decode(
      out
    );
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
 * @param codePage   覆盖自动检测的控制台代码页（默认 detectConsoleCodePage）
 */
export interface PowerShellShellConfig {
  workingDir?: string;
  noProfile?: boolean;
  codePage?: number;
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

  /** stdout 流式解码器（stream 模式保留跨 chunk 的不完整多字节序列） */
  #stdoutDecoder: TextDecoder | null = null;
  /** stderr 流式解码器（与 stdout 独立，避免两路不完整序列互相污染） */
  #stderrDecoder: TextDecoder | null = null;
  /** stdin 编码标签，与 PowerShell 侧 [Console]::InputEncoding 对应 */
  #stdinLabel = "utf-8";

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
   *
   * spawn 前先按控制台代码页创建解码器：管道下 powershell.exe 的
   * 输出编码跟随代码页（中文系统为 GBK），需按相同代码页解码，
   * 否则中文全部变为乱码；{stream: true} 保证多字节字符跨 chunk
   * 到达时不被切断。
   */
  protected async acquire(): Promise<void> {
    const label = codepageToLabel(
      this.#config.codePage ?? detectConsoleCodePage()
    );
    this.#stdoutDecoder = new TextDecoder(label);
    this.#stderrDecoder = new TextDecoder(label);
    this.#stdinLabel = label;

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
      this.appendData(this.#stdoutDecoder!.decode(data, { stream: true }));
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.appendData(this.#stderrDecoder!.decode(data, { stream: true }));
    });
    proc.on("close", () => {
      this.#process = null;
      // 进程退出时冲刷流式解码器中残留的不完整多字节序列
      this.appendData(
        this.#stdoutDecoder!.decode() + this.#stderrDecoder!.decode()
      );
    });
    proc.on("error", () => {
      this.#process = null;
    });
  }

  /**
   * @brief 向 PowerShell 进程发送原始字节
   *
   * payload 已含换行处理，此处只校验进程是否存活并发送。
   * 发送前按会话代码页编码：PowerShell 以 [Console]::InputEncoding
   * （即控制台代码页）读取管道输入，直接发 UTF-8 会导致命令中的
   * 中文被错误解码，回显与执行结果均乱码。
   *
   * @param payload 已拼接换行的完整发送内容
   * @throws 进程未启动或已退出时抛出 "PowerShell shell not open. Call open() first."
   */
  protected rawWrite(payload: string): void {
    if (!this.#process || this.#process.exitCode !== null) {
      throw new Error("PowerShell shell not open. Call open() first.");
    }
    const buf =
      this.#stdinLabel === "utf-8"
        ? Buffer.from(payload, "utf8")
        : iconv.encode(payload, this.#stdinLabel);
    this.#process.stdin!.write(buf);
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
