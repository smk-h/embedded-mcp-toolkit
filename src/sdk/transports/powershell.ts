/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : powershell.ts
 * Author     : sumu
 * Date       : 2026/05/27
 * Version    : x.x.x
 * Description: PowerShell 工具函数（一次性脚本执行）
 *
 * 提供一次性脚本执行能力：encodePsCommand / execPowerShell
 * （非交互式，执行后进程退出），供 win 域工具与 CLI 复用。
 *
 * 编码说明：powershell.exe 在 stdio 重定向（管道）下的输出编码
 * 跟随控制台代码页（简体中文 Windows 为 936/GBK），并非 UTF-8，
 * execPowerShell 按检测到的代码页解码输出。
 *
 * 历史说明：曾提供 PowerShellShell 交互式会话类（持久化进程 +
 * open/write/read/close），因管道 stdin 无法发送 Ctrl+C（常驻命令
 * 停不下来只能杀会话）等死结已退役，会话工具由
 * tools/win/powershell.ts 的一次性 power_shell_exec 取代。
 * ======================================================
 */
import {
  execSync,
  type ExecSyncOptionsWithBufferEncoding,
} from "child_process";
import { TextDecoder } from "util";

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

