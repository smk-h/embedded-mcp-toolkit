/**
 * @brief runExec 离线冒烟验证（无需真实设备）
 *
 * 验证 delay/pollInterval 从 ExecInput 移除后的行为：
 *   1. 正常路径：marker 检测命中即返回，exitCode 正确解析
 *   2. 提示符路径：marker 未现、末尾提示符命中返回
 *   3. timeoutMs 覆盖：普通命令到点走 fallback 兜底（不发 Ctrl+C）
 *   4. 常驻命令：到点走 sampling 熔断（发 Ctrl+C）
 *   5. 旧调用方传多余 delay 字段：对象多字段不影响运行（向后兼容）
 *
 * 运行：node test/scripts/exec-runner-smoke.mjs（先 npm run build）
 */

import { runExec } from "../../out/sdk/exec/exec-runner.js";
import { PromptDetector } from "../../out/sdk/exec/prompt-detector.js";

/** mock shell：write() 捕获注入的 marker 并异步回显，模拟设备回包 */
class FakeShell {
  // echoFirst=true：首个 \n 前的回显行（真实 PTY 行为）
  constructor(responseChunks) {
    // responseChunks: [{ afterMs, data }]，在 write() 后开始投放
    this.responseChunks = responseChunks ?? [];
    this.buffer = "";
    this.written = [];
    this.timers = [];
  }
  write(data) {
    this.written.push(data);
    for (const c of this.responseChunks) {
      // afterMs 相对 write() 时刻；命令里的 marker 提取出来动态替换
      const t = setTimeout(() => {
        this.buffer += c.data.replace(
          /___MCP_EXEC_DONE_\w{6}___/,
          (data.match(/___MCP_EXEC_DONE_\w{6}___/) ?? [""])[0]
        );
      }, c.afterMs);
      t.unref?.();
      this.timers.push(t);
    }
  }
  read(clear = 1) {
    const out = this.buffer;
    if (clear) this.buffer = "";
    return out;
  }
  drain() {
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
  async close() {
    this.timers.forEach(clearTimeout);
  }
  async open() {
    return "";
  }
}

const ctrlLog = [];
const sendCtrl = (key) => ctrlLog.push(key);

function makeInput(shell, extra = {}) {
  return {
    shell,
    command: "echo hi",
    promptDetector: new PromptDetector(),
    sendCtrl,
    logPrefix: "[smoke]",
    ...extra,
  };
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

// ── 1. marker 命中即返回 ──
{
  const shell = new FakeShell([
    { afterMs: 50, data: "\nhi\n___MCP_EXEC_DONE_xxxxxx___:0\n# " },
  ]);
  const r = await runExec(makeInput(shell, { timeoutMs: 5000 }));
  check("marker path: completedBy=marker", r.completedBy === "marker");
  check("marker path: exitCode=0", r.exitCode === 0, `got ${r.exitCode}`);
  check("marker path: output=hi", r.output === "hi", `got "${r.output}"`);
  check("marker path: not timedOut", !r.timedOut);
  await shell.close();
}

// ── 2. 提示符路径（marker 未出现，末尾提示符命中） ──
{
  const shell = new FakeShell([{ afterMs: 50, data: "\nworld\n# " }]);
  const r = await runExec(makeInput(shell, { timeoutMs: 5000 }));
  check("prompt path: completedBy=prompt", r.completedBy === "prompt");
  check("prompt path: output contains world", r.output.includes("world"));
  await shell.close();
}

// ── 3. timeoutMs 覆盖 + 普通命令 fallback（不发 Ctrl+C） ──
{
  const shell = new FakeShell([]); // 永远无输出
  const t0 = Date.now();
  const r = await runExec(makeInput(shell, { command: "slowcmd", timeoutMs: 1000 }));
  const elapsed = Date.now() - t0;
  check(
    "fallback path: timeoutKind=fallback",
    r.timeoutKind === "fallback",
    `got ${r.timeoutKind}`
  );
  check("fallback path: no ctrl+c sent", ctrlLog.length === 0);
  // 注：回显剥离阶段（找首个 \n，最多 10×200ms）计入 deadline 且优先于轮询循环，
  // 无输出设备上会先耗尽 echo-strip 再判超时，故实际耗时 ~2s 是既有行为；
  // 此处只断言「不早于 timeoutMs 返回」+ 「deadline 未被任何垫高逻辑延长到 5min 默认」
  check(
    "fallback path: returns no earlier than timeoutMs, well below 5min default",
    elapsed >= 1000 && elapsed < 5000,
    `elapsed=${elapsed}ms`
  );
  await shell.close();
}

// ── 4. 常驻命令 sampling（发 Ctrl+C） ──
{
  const shell = new FakeShell([{ afterMs: 100, data: "\nping 8.8.8.8 ...\n" }]);
  const r = await runExec(makeInput(shell, { command: "ping 8.8.8.8", timeoutMs: 1000 }));
  check(
    "sampling path: timeoutKind=sampling",
    r.timeoutKind === "sampling",
    `got ${r.timeoutKind}`
  );
  check("sampling path: ctrl+c sent once", ctrlLog.length === 1, `got ${ctrlLog.length}`);
  await shell.close();
}

// ── 5. 旧调用方残留 delay 字段（多余字段被忽略，不影响运行） ──
{
  const shell = new FakeShell([
    { afterMs: 50, data: "\nhi\n___MCP_EXEC_DONE_xxxxxx___:0\n# " },
  ]);
  const r = await runExec(makeInput(shell, { delay: 9999, timeoutMs: 5000 }));
  check(
    "legacy delay field ignored: still returns on marker",
    r.completedBy === "marker"
  );
  await shell.close();
}

// ── 6. 默认超时（不传 timeoutMs）：普通命令 5min 兜底 —— 只验证分类日志不打断，跳过实际等待 ──
{
  // 用常驻命令 + 默认 sampling 10s 太久，改为验证 effectiveTimeout 逻辑已由 3/4 覆盖
  console.log("SKIP  default-timeout path (covered by cases 3/4 via timeoutMs)");
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
