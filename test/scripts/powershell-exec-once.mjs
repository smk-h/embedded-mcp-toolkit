#!/usr/bin/env node
/**
 * =====================================================
 * power_shell_exec 一次性执行验证（仅 win32 可跑）
 *
 * 验证一次性执行模式的五个核心契约：
 *   1. 正常命令：输出完整 + [exit code: 0] 标注
 *   2. 失败命令：exit code 1（throw 路径）
 *   3. 超时终止：Start-Sleep 60s + timeoutMs=3000 → 进程树被杀，
 *      带 [超时终止] 标注且耗时 ~3s（命令真的停了，不再等满 60s）
 *   4. 中文往返：中文输出无 U+FFFD 乱码（UTF-8 强制编码路径）
 *   5. 落盘日志：LOG_SAVE=1 时命令与结果写入
 *      {LOG_DIR}/local/<timestamp>.log（与业务日志同目录体系、同生命周期）
 *
 * 运行：node test/scripts/powershell-exec-once.mjs（先 npm run build；
 * 在 Windows 机器上执行，Linux 上自动 SKIP）
 * ======================================================
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { powerShellExecHandler } from "../../out/sdk/tools/win/powershell.js";

if (process.platform !== "win32") {
  console.log("SKIP  power_shell_exec tests (requires win32)");
  process.exit(0);
}

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

// ── 1. 正常命令 + exit code ──
{
  const r = await powerShellExecHandler({ command: "Write-Output 'hello once'" });
  check("ok path: output complete", r.includes("hello once"), `got "${r}"`);
  check("ok path: exit code 0 annotated", r.includes("[exit code: 0]"), `got "${r}"`);
}

// ── 2. 失败命令 exit code 1 ──
{
  const r = await powerShellExecHandler({ command: "throw 'boom'" });
  check("fail path: exit code 1 annotated", r.includes("[exit code: 1]"), `got "${r}"`);
  check("fail path: error message visible", r.includes("boom"), `got "${r}"`);
}

// ── 3. 超时终止（进程树强杀） ──
{
  const t0 = Date.now();
  const r = await powerShellExecHandler({
    command: "Start-Sleep -Seconds 60",
    timeoutMs: 3000,
  });
  const elapsed = Date.now() - t0;
  check("timeout path: killed around timeoutMs", elapsed >= 2900 && elapsed < 15000, `elapsed=${elapsed}ms`);
  check("timeout path: termination annotated", r.includes("超时终止"), `got "${r}"`);
}

// ── 4. 中文往返（UTF-8 编码） ──
{
  const r = await powerShellExecHandler({ command: "Write-Output '中文输出测试'" });
  check("utf8 path: no U+FFFD replacement", !r.includes("\uFFFD"), `got "${r}"`);
  check("utf8 path: Chinese intact", r.includes("中文输出测试"), `got "${r}"`);
}

// ── 5. 落盘日志（LOG_SAVE 启用时命令与结果写入 {LOG_DIR}/local/<timestamp>.log） ──
{
  const saveDir = mkdtempSync(join(tmpdir(), "ps-exec-log-"));
  process.env.LOG_SAVE = "1";
  process.env.LOG_DIR = saveDir;
  try {
    const r = await powerShellExecHandler({ command: "Write-Output 'logged line'" });
    const localDir = join(saveDir, "local");
    const files = readdirSync(localDir);
    check(
      "log path: local/<timestamp>.log created",
      files.some((f) => /^\d{4}-\d{2}-\d{2}_\d{6}\.log$/.test(f)),
      `files=${files.join(",")}`
    );
    const logFile = files.find((f) => f.endsWith(".log"));
    const log = logFile ? readFileSync(join(localDir, logFile), "utf8") : "";
    check("log content: header line", log.includes("PowerShell exec log"), log.slice(0, 200));
    check("log content: command recorded", log.includes("$ Write-Output 'logged line'"), log.slice(0, 200));
    check("log content: result recorded", log.includes("logged line"), log.slice(0, 200));
    check("log content: call block closed", log.includes("└─ end #"), log.slice(0, 200));
  } finally {
    delete process.env.LOG_SAVE;
    delete process.env.LOG_DIR;
    rmSync(saveDir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll power_shell_exec checks passed.");
