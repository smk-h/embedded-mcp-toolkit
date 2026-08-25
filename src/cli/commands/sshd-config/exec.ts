/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exec.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: 命令执行封装
 *
 * 执行外部命令并统一封装结果：execToResult（公共核心）、runPowerShell、runCmd。
 * ======================================================
 */

import { execFile } from "child_process";
import { promisify } from "util";

import { type CommandResult } from "./types.js";

// ============================================================
// 命令执行封装
// ============================================================

// 将 execFile 转为 Promise 形式，便于 async/await 调用
const execFileAsync = promisify(execFile);

/**
 * @brief 执行外部命令并统一封装结果（runPowerShell / runCmd 的公共核心）
 * @details 捕获退出码与 stdout / stderr，异常统一转为 success:false 结果，
 *          不向调用方抛出。maxBuffer 默认 10MB，兼容大量输出的命令。
 * @param cmd       命令名（如 "powershell"、"msiexec"）
 * @param args      参数数组
 * @param timeoutMs 超时毫秒数，默认 300000（5 分钟）
 * @returns 封装的执行结果
 */
export async function execToResult(
  cmd: string,
  args: string[],
  timeoutMs = 300000
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      success: false,
      exitCode: e.code ?? -1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/**
 * @brief 执行 PowerShell 命令
 * @details 前置设置 [Console]::OutputEncoding 为 UTF-8，确保 PowerShell 输出经管道
 *          回传 Node 时不乱码。**不使用 chcp 65001**——chcp 会修改共享控制台的代码页，
 *          导致 conhost 清屏重绘（表现为首次调用时菜单/提示被"刷掉"），而
 *          [Console]::OutputEncoding 只影响子进程自身的输出编码，不触碰控制台。
 * @param script    PowerShell 脚本字符串
 * @param timeoutMs 超时毫秒数，默认 300000（5 分钟）
 * @returns 封装的执行结果
 */
export async function runPowerShell(
  script: string,
  timeoutMs = 300000
): Promise<CommandResult> {
  return execToResult(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`,
    ],
    timeoutMs
  );
}

/**
 * @brief 执行通用外部命令
 * @details 用于 msiexec、sshd.exe install 等非 PowerShell 命令。
 * @param cmd       命令名（如 "msiexec"）
 * @param args      参数数组
 * @param timeoutMs 超时毫秒数，默认 300000
 * @returns 封装的执行结果
 */
export async function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 300000
): Promise<CommandResult> {
  return execToResult(cmd, args, timeoutMs);
}
