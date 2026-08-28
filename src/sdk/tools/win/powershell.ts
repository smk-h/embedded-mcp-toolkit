/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : powershell.ts
 * Author     : sumu
 * Date       : 2026/05/28
 * Version    : x.x.x
 * Description: PowerShell SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 * 提供对本地 Windows PowerShell 的一次性执行能力（exec）：
 *   每次调用 spawn 独立 powershell.exe 进程跑完即退，不依赖会话。
 *   无会话状态、可并发、超时强杀整棵进程树——交互式会话模式下
 *   「管道 stdin 发不了 Ctrl+C、命令停不下来只能杀会话」的死结
 *   在此路径上根本不存在。命令与完整结果按调用块落盘（LOG_SAVE 启用，
 *   目录 {LOG_DIR}/local、生命周期与业务日志一致），每行带与业务日志
 *   同款 `[YYYY-MM-DD HH:mm:ss]` 时间戳前缀，供客户端事后翻查。
 *   编码：chcp 检测控制台代码页，命令前缀强制 OutputEncoding 为代码页
 *   对应编码（GBK 系统下 936→GBK），Node 端按同代码页解码，内置 cmdlet
 *   与外部原生 exe（ipconfig 等）输出统一，中文无乱码（延续 commit b66466d）。
 * ======================================================
 */
import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { spawn, execSync, type ChildProcess } from "child_process";
import {
  beijingFields,
  fileTimestamp,
  logTimestamp,
} from "../../utils/timestamp.js";
import { sanitizeLine } from "../../utils/terminal-sanitizer.js";

// ── 控制台代码页检测与编码转换 ──────────────────────────────

/**
 * 缓存的活动代码页（chcp 结果），进程生命周期内视为不变。
 *
 * 延续退役会话工具（commit b66466d）的代码页方案：管道重定向下
 * powershell.exe 内置 cmdlet 默认输出 UTF-8，外部原生 exe（ipconfig
 * 等）按 CRT 代码页（简体中文 Windows 为 936/GBK）直接写管道，两种
 * 编码混在同一输出流。修复手段是检测一次代码页：命令前缀强制
 * [Console]::OutputEncoding 为代码页对应编码，Node 端按同代码页解码，
 * 内置与外部输出编码统一，中文全部正确。
 */
let cachedCodePage: number | null = null;

/** 常见控制台代码页 → WHATWG 编码标签映射（TextDecoder 通用） */
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
 * 结果缓存于模块级变量，避免每次执行重复起进程。
 * chcp.com 输出的标签文字随系统语言本地化，但代码页数字
 * 始终是输出中最后一段连续数字，与语言无关。
 *
 * @returns 代码页编号；检测失败时回退 65001（UTF-8）并记录告警
 */
function detectConsoleCodePage(): number {
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
      logger.warn(
        `[power_shell_exec] chcp detect failed, fallback 65001: ${err instanceof Error ? err.message : String(err)}`
      );
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
function codepageToLabel(cp: number): string {
  if (CODEPAGE_LABELS[cp]) return CODEPAGE_LABELS[cp];
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  logger.warn(`[power_shell_exec] unknown codepage ${cp}, fallback utf-8`);
  return "utf-8";
}

// ── power_shell_exec ────────────────────────────────────────

/**
 * @brief 一次性执行的超时时长（毫秒），对齐 exec-runner 的兜底超时语义
 */
const PS_EXEC_DEFAULT_TIMEOUT_MS = 300000;

/**
 * @brief 一次性执行的输出累积上限（字符），防止失控命令耗尽内存
 *
 * 对齐 CLI 层 runPowerShell 的 maxBuffer（10MB）量级，取 1M 字符——
 * 对 LLM 上下文已远超合理读取量，仅作内存安全阀。超限即杀进程并标注。
 */
const PS_EXEC_MAX_OUTPUT_CHARS = 1024 * 1024;

/**
 * @brief exec 调用序号（进程生命周期内自增）
 *
 * 落盘日志的调用块编号，方便客户端按第几次调用定位。
 */
let psExecSeq = 0;

/**
 * @brief exec 落盘日志文件路径（懒初始化，进程生命周期内定格）
 *
 * 生命周期与业务日志（logger.ts）完全一致：
 *   - 启用条件：LOG_SAVE 为 "1"/"true"（同口径）
 *   - 目录：{LOG_DIR ?? "./log"}/local（LOG_DIR 配 ./.embedded/log 时
 *     即 .embedded/log/local，与退役前的 PowerShell 会话日志同目录）
 *   - 文件名：{fileTimestamp()}.log（如 2026-08-28_074731.log）
 *   - 首次调用时懒创建（避免依赖模块加载时的环境变量时序），
 *     之后 MCP 进程存活期间一直追加同一文件，不滚动
 *
 * null 表示未启用或尚未初始化成功。
 */
let execLogFile: string | null = null;

/**
 * @brief 懒初始化 exec 落盘日志文件
 *
 * 对齐 logger.ts ensureInit 的模式：新文件写入统一头部（与业务日志
 * 同款头）。初始化成功（文件定格）后短路返回；未启用（LOG_SAVE 未
 * 置位）不定格——env 读取零成本，每次调用重查，保证进程内动态启用
 * 也能生效；初始化失败（目录不可写等）仅告警、下次重试，不影响
 * exec 主流程。
 */
function ensureExecLogFile(): void {
  if (execLogFile) return;

  const save = process.env.LOG_SAVE;
  if (save !== "1" && save !== "true") return;

  try {
    const dir = join(process.env.LOG_DIR ?? "./log", "local");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    execLogFile = join(dir, `${fileTimestamp()}.log`);

    const isNew = !existsSync(execLogFile) || statSync(execLogFile).size === 0;
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      appendFileSync(
        execLogFile,
        `=~=~=~=~=~=~=~=~=~=~=~= PowerShell exec log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`,
        "utf8"
      );
    }
    logger.info(`[power_shell_exec] file logging enabled: ${execLogFile}`);
  } catch (err) {
    logger.warn(
      `[power_shell_exec] failed to init exec log file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * @brief 将一次 exec 调用（命令 + 完整结果）追加落盘
 *
 * 会话工具退役后 FileLogger（挂 shell 实例、open 时启用）失去挂靠点，
 * exec 改为自带落盘：每次调用写一个完整事务块，结构对齐业务日志的
 * ┌─/└─ 调用边界风格；每一行统一带 `[YYYY-MM-DD HH:mm:ss]` 时间戳前缀
 * （与业务日志同款 logTimestamp），便于跨文件按时间对齐翻查。
 * appendFileSync 即时落盘（远程管理场景调用频率低，无性能顾虑），
 * 无需管理流生命周期；输出逐行 sanitize 清洗 ANSI 转义，防污染日志文件。
 *
 * 落盘失败不阻断工具返回（日志是辅助能力），仅记录业务日志告警。
 *
 * @param command     本次执行的命令原文
 * @param resultText  返回给调用方的完整结果文本（含 exit code / 超时标注）
 * @param elapsedMs   实际耗时
 */
function appendExecLog(
  command: string,
  resultText: string,
  elapsedMs: number
): void {
  ensureExecLogFile();
  if (!execLogFile) return;

  const seq = ++psExecSeq;
  try {
    const ts = logTimestamp();
    const head =
      `${ts} ┌─ power_shell_exec #${seq} ────────────────\n` +
      `${ts} $ ${command}\n`;
    const body = resultText
      .split("\n")
      .map((line) => sanitizeLine(line))
      .map((line) => (line ? `${ts} ${line}` : ""))
      .join("\n");
    const tail =
      `\n${ts} (${elapsedMs}ms)\n` +
      `${ts} └─ end #${seq} ────────────────────────────────\n`;
    appendFileSync(execLogFile, head + body + tail, "utf8");
  } catch (err) {
    logger.warn(
      `[power_shell_exec] failed to append exec log: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * @brief 强制终止进程树（powershell.exe 及其启动的全部子进程）
 *
 * Node 的 proc.kill() 在 Windows 上只杀目标进程本体，命令内部启动的
 * 子进程（如 ping -t）会成为孤儿继续跑——超时停不干净。taskkill /T
 * 按进程树递归终止，/F 强制（不等待子进程自行响应），是 Windows 上
 * 「超时 = 命令真停」的唯一可靠手段。非 win32 直接 kill 兜底。
 *
 * taskkill 为异步 spawn：终止请求发出后 close 事件随后到达，由调用方
 * 的 close 监听收尾，此处不等待。
 *
 * @param proc 要终止的 PowerShell 进程
 */
function killProcessTree(proc: ChildProcess): void {
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    proc.kill();
  }
}

/**
 * @brief power_shell_exec 工具配置
 *
 * 独立进程一次性执行 PowerShell 命令（不依赖会话，每次全新进程）。
 * 超时强制终止整棵进程树——命令真正停止，不存在旧会话模式
 * 「停不下来只能杀会话」的死结。
 *
 * @param command     要执行的 PowerShell 命令字符串
 * @param timeoutMs   执行时长上限（毫秒，默认 300000）
 * @param workingDir  进程工作目录（可选，默认 MCP server 进程的 cwd）
 */
export const powerShellExecConfig: SdkToolConfig = {
  description:
    "Run a PowerShell command ONCE on the local Windows machine — each call spawns a fresh process, " +
    "no session required. " +
    "Output is decoded with the console codepage detected via chcp (GBK on zh-CN Windows) — " +
    "both built-in cmdlets and native exes (ipconfig etc.) come out with correct Chinese, " +
    "no mojibake. Exit code is appended on completion. On timeout the whole process tree " +
    "is force-terminated — a stuck or resident command (ping -t) REALLY stops. " +
    "State (cd / variables / imported modules) does NOT persist between calls — " +
    "compose it into the command itself (e.g. 'cd C:\\work; npm test'). " +
    "When LOG_SAVE is enabled, every call (command + full result) is appended to " +
    "{LOG_DIR}/local/<timestamp>.log — same lifecycle as the business log " +
    "(one file per MCP process, created on first call), every line prefixed with " +
    "the same [YYYY-MM-DD HH:mm:ss] timestamp as the business log — for offline review.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The PowerShell command to execute",
      },
      timeoutMs: {
        type: "number",
        description:
          "Execution cap in ms (default: 300000 = 5min). The process tree is force-killed on timeout, " +
          "so a genuinely stuck or resident command (ping -t, endless loop) WILL be stopped. " +
          "Suggested ranges: instant cmdlets (Get-Location/echo/ipconfig) 5000-10000 " +
          "(PowerShell startup itself takes ~1s); medium tasks (package install, service ops) " +
          "30000-120000; long builds up to 600000.",
      },
      workingDir: {
        type: "string",
        description:
          "Working directory for the process (default: the MCP server's current working directory)",
      },
    },
    required: ["command"],
  },
};

/**
 * @brief power_shell_exec 处理函数
 *
 * 一次性执行流程（编码策略延续退役会话工具 commit b66466d）：
 *   1. spawn powershell -NoProfile -NonInteractive -Command
 *      命令前缀强制 [Console]::OutputEncoding=GetEncoding(检测到的代码页)
 *      —— 管道下内置 cmdlet 默认输出 UTF-8、外部原生 exe（ipconfig 等
 *      按 CRT 代码页写 GBK）输出 GBK，混流无法单一解码；统一为代码页
 *      编码后内置与外部输出一致。不可强制 UTF-8（外部 GBK 字节被误读
 *      成 U+FFFD），也不可不强制（内置 cmdlet 变 UTF-8 乱码）
 *   2. stdout/stderr 按同一代码页流式解码累积（stream 模式防多字节
 *      字符跨 chunk 切断）
 *   3. 进程退出收尾：返回输出 + exit code
 *   4. 超时 / 输出超限：killProcessTree 强制终止，返回已收集输出 + 标注
 *
 * 输入侧：Windows spawn 走宽字符 API 传参，命令中的中文不经过代码页，
 * 无需 -EncodedCommand 转码。
 *
 * @param args  工具参数，包含 command 和可选的 timeoutMs、workingDir
 * @return MCP 响应，包含命令输出与 exit code（超时/截断时追加标注）
 */
export async function powerShellExecHandler(args: {
  command: string;
  timeoutMs?: number;
  workingDir?: string;
}): Promise<string> {
  const timeoutMs = args.timeoutMs ?? PS_EXEC_DEFAULT_TIMEOUT_MS;
  logger.info(
    `[power_shell_exec] command=${args.command} timeoutMs=${timeoutMs} workingDir=${args.workingDir ?? "(cwd)"}`
  );

  if (process.platform !== "win32") {
    return "This tool only works on Windows.";
  }

  return new Promise<string>((resolve) => {
    const startedAt = Date.now();
    // 编码策略（延续退役会话工具 commit b66466d 的代码页方案）：
    // powershell.exe 在管道重定向下内置 cmdlet 默认按 UTF-8 输出，
    // 而外部原生 exe（ipconfig 等）按 CRT 代码页（中文系统 936/GBK）
    // 直接写管道——两种编码混在同一输出流，单一解码器无法兼顾。
    // 修复：命令前缀强制 [Console]::OutputEncoding 为检测到的代码页
    // 对应编码（936→GBK），使内置 cmdlet 与外部 exe 输出统一为代码页
    // 编码，Node 端按同代码页解码，全部正确。注意不可强制 UTF-8——
    // 那会让外部 exe 的 GBK 字节被 PowerShell 误读成 U+FFFD 乱码。
    // 输入侧：Windows spawn 走宽字符 API 传参，命令中的中文不经过代码页。
    const cp = detectConsoleCodePage();
    const proc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(${cp}); ${args.command}`,
      ],
      {
        cwd: args.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const label = codepageToLabel(cp);
    const stdoutDecoder = new TextDecoder(label);
    const stderrDecoder = new TextDecoder(label);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const appendChunk = (
      target: "stdout" | "stderr",
      chunk: Buffer
    ): void => {
      const current = target === "stdout" ? stdout : stderr;
      if (current.length >= PS_EXEC_MAX_OUTPUT_CHARS) {
        return; // 已超限，丢弃后续数据（进程在 kill 路径上）
      }
      const decoded =
        target === "stdout"
          ? stdoutDecoder.decode(chunk, { stream: true })
          : stderrDecoder.decode(chunk, { stream: true });
      if (target === "stdout") {
        stdout += decoded;
      } else {
        stderr += decoded;
      }
      if (stdout.length + stderr.length >= PS_EXEC_MAX_OUTPUT_CHARS) {
        truncated = true;
        logger.warn(
          `[power_shell_exec] output exceeds ${PS_EXEC_MAX_OUTPUT_CHARS} chars, killing process tree`
        );
        killProcessTree(proc);
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
    proc.stderr.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(
        `[power_shell_exec] timeout after ${timeoutMs}ms, killing process tree`
      );
      killProcessTree(proc);
    }, timeoutMs);

    // spawn 本身失败（如 powershell 不在 PATH）：error 事件，无 close 码
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const elapsedMs = Date.now() - startedAt;
      const text = `Failed to start PowerShell: ${err.message}`;
      appendExecLog(args.command, text, elapsedMs);
      resolve(text);
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const elapsedMs = Date.now() - startedAt;
      // 冲刷流式解码器中滞留的尾部多字节序列
      stdout += stdoutDecoder.decode();
      stderr += stderrDecoder.decode();
      logger.info(
        `[power_shell_exec] exited code=${code ?? "(killed)"} elapsed=${elapsedMs}ms` +
          `${timedOut ? " (timeout)" : ""}${truncated ? " (truncated)" : ""}`
      );

      const parts: string[] = [];
      const out = stdout.trim();
      const err = stderr.trim();
      if (out) parts.push(out);
      if (err) parts.push(`[stderr]\n${err}`);
      if (timedOut) {
        parts.push(
          `[超时终止: ${elapsedMs}ms，进程树已强制终止，命令已停止，输出可能不完整]`
        );
      } else if (truncated) {
        parts.push(
          `[输出截断: 超过 ${PS_EXEC_MAX_OUTPUT_CHARS} 字符上限，进程已终止，输出可能不完整]`
        );
      } else if (code !== null) {
        parts.push(`[exit code: ${code}]`);
      } else {
        parts.push(`[进程异常退出: 无退出码]`);
      }
      const resultText = parts.length > 0 ? parts.join("\n") : "(no output)";
      appendExecLog(args.command, resultText, elapsedMs);
      resolve(resultText);
    });
  });
}
