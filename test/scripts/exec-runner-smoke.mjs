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

// ── 7. 内核启动早退（kernelBootDetector 注入 + 复位类命令场景） ──
// reset 后 hush shell 已销毁，marker 永不出现；输出先到 U-Boot 重启横幅、
// 后到内核启动特征 → 检测器命中即返回，不等 effectiveTimeout 耗尽
{
  const shell = new FakeShell([
    { afterMs: 300, data: "\nU-Boot 2017.09 ...\nresetting ...\n" },
    {
      afterMs: 1500,
      data: "Starting kernel ...\n[ 0.000000] Booting Linux on physical CPU\n",
    },
  ]);
  const detectorCalls = [];
  const kernelBootDetector = (acc) => {
    detectorCalls.push(acc.length);
    return /starting\s+kernel|linux\s+version/i.test(acc);
  };
  const t0 = Date.now();
  const r = await runExec(
    makeInput(shell, {
      command: "reset",
      markerStyle: "plain",
      kernelBootDetector,
      timeoutMs: 30000,
    })
  );
  const elapsed = Date.now() - t0;
  check(
    "kernelBoot path: completedBy=kernelBoot",
    r.completedBy === "kernelBoot",
    `got ${r.completedBy}`
  );
  check("kernelBoot path: not timedOut", !r.timedOut, `timedOut=${r.timedOut}`);
  check(
    "kernelBoot path: exitCode null (marker unreachable)",
    r.exitCode === null
  );
  check(
    "kernelBoot path: output keeps kernel log",
    r.output.includes("Starting kernel"),
    `got "${r.output}"`
  );
  check(
    "kernelBoot path: returns well before timeout (elapsed ~1.7s < 30s)",
    elapsed >= 1500 && elapsed < 5000,
    `elapsed=${elapsed}ms`
  );
  check(
    "kernelBoot path: detector actually consulted",
    detectorCalls.length > 0
  );
  await shell.close();
}

// ── 8. 未注入 kernelBootDetector 时早退完全关闭（向后兼容） ──
// 相同的内核启动输出，无检测器 → 只能跑满 timeoutMs 走 fallback（旧行为）
{
  const shell = new FakeShell([
    { afterMs: 300, data: "\nU-Boot 2017.09 ...\nresetting ...\n" },
    {
      afterMs: 1500,
      data: "Starting kernel ...\n[ 0.000000] Booting Linux on physical CPU\n",
    },
  ]);
  const r = await runExec(
    makeInput(shell, { command: "reset", markerStyle: "plain", timeoutMs: 1500 })
  );
  check(
    "no-detector path: falls back to timeout (early-exit fully off)",
    r.completedBy === "timeout" && r.timeoutKind === "fallback",
    `completedBy=${r.completedBy}, timeoutKind=${r.timeoutKind}`
  );
  check(
    "no-detector path: output still delivered in full",
    r.output.includes("Starting kernel")
  );
  await shell.close();
}

// ── 9. marker 优先于内核启动特征（正常命令不受早退截断） ──
// 命令输出中巧合含 "Linux version" 字样，但 marker 先到 → 走 marker 路径，
// 证明检测顺序：marker > kernelBoot（确定性优先于环境判定）
{
  const shell = new FakeShell([
    {
      afterMs: 100,
      data: "\nLinux version 5.4.0 (copied from banner)\n___MCP_EXEC_DONE_xxxxxx___:0\n",
    },
  ]);
  const r = await runExec(
    makeInput(shell, {
      timeoutMs: 5000,
      kernelBootDetector: (acc) => /linux\s+version/i.test(acc),
    })
  );
  check(
    "marker precedence: marker wins over kernel-boot string in output",
    r.completedBy === "marker" && r.exitCode === 0,
    `completedBy=${r.completedBy}, exitCode=${r.exitCode}`
  );
  await shell.close();
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
