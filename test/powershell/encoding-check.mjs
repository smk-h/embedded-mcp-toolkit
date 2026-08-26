#!/usr/bin/env node
/**
 * =====================================================
 * PowerShell 会话编码健康检查
 *
 * 验证 transports/powershell.ts 的代码页感知编解码：
 *   1. execPowerShell 一次性执行的中文输出
 *   2. 交互式会话中中文命令的回显与输出（stdin 编码方向）
 *   3. ipconfig 等原生工具输出（stdout 解码方向）
 *   4. FileLogger 会话日志文件内容
 *
 * 全部断言通过输出 ALL PASS 并退出码 0，否则列出失败项。
 * ======================================================
 */
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PowerShellShell,
  execPowerShell,
  detectConsoleCodePage,
  codepageToLabel,
} from "../../out/sdk/transports/powershell.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cp = detectConsoleCodePage();
console.log(`[check] console codepage: ${cp} -> ${codepageToLabel(cp)}`);

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  if (!cond) failed++;
};

// ── 1. 一次性执行 ─────────────────────────────────────────
const oneShot = execPowerShell("Write-Output '中文输出测试'");
assert(!oneShot.includes("\uFFFD"), "execPowerShell 输出无 U+FFFD");
assert(oneShot.includes("中文输出测试"), "execPowerShell 中文内容完整");

// ── 2. 交互式会话 + 文件日志 ──────────────────────────────
const shell = new PowerShellShell({});
await shell.open();

const logPath = join(tmpdir(), `ps-enc-check-${Date.now()}.log`);
shell.fileLogger.enable(logPath);

shell.write("ipconfig", 1);
await sleep(2500);
const ipconfig = shell.read(1);
assert(!ipconfig.includes("\uFFFD"), "会话 ipconfig 输出无 U+FFFD");
console.log(`[check] ipconfig 首两行: ${ipconfig.split(/\r?\n/).slice(0, 2).join(" / ").trim()}`);

shell.write('Write-Output "中文命令测试"', 1);
await sleep(1500);
const echo = shell.read(1);
assert(!echo.includes("\uFFFD"), "中文命令回显无 U+FFFD");
assert(echo.includes("中文命令测试"), "中文命令内容完整往返");

shell.fileLogger.disable();
await shell.close();

// ── 3. 日志文件（UTF-8 落盘） ─────────────────────────────
const log = readFileSync(logPath, "utf8");
assert(!log.includes("\uFFFD"), "日志文件无 U+FFFD");
assert(log.includes("中文命令测试"), "日志文件含正确中文");
rmSync(logPath, { force: true });

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
