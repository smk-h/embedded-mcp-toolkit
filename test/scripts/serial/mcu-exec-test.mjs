/**
 * @brief runMcuExec 离线验证（无需真实设备）
 *
 * 验证单片机裸固件执行器的完成判定与安全约束：
 *   1. pattern 路径：responsePattern 命中即返回（且早于静默窗口）
 *   2. quiet 路径：心跳干扰下（心跳周期 > quietMs）响应后静默判定完成
 *   3. timeout 路径：到点兜底返回，全程不发 Ctrl+C（裸发送契约）
 *   4. 空响应：发送后一直无数据，quietMs 到期即返回空输出，不苦等 timeout
 *   5. 前置冲刷：发送前的残留心跳进 flushed，不污染本次 output
 *   6. quietMs 大于心跳周期时静默永不满足 → 走 timeout（文档约束的反向证明）
 *   7. 裸发送契约：命令原样下发，无 marker 包装、无 shell 语法追加
 *
 * 运行：node test/scripts/serial/mcu-exec-test.mjs（先 npm run build）
 */

import { runMcuExec } from "../../../out/sdk/exec/mcu-exec-runner.js";

/**
 * mock shell：write() 后按 afterMs 时间表向缓冲投放数据，模拟
 * "无回显固件 + 周期心跳 + 命令响应"的输出流。
 */
class FakeMcuShell {
  constructor(chunks = [], preBuffer = "") {
    // chunks: [{ afterMs, data }]，afterMs 相对 write() 时刻
    this.chunks = chunks;
    this.buffer = preBuffer;
    this.written = []; // 记录每次 write 的原始内容（断言裸发送契约）
    this.timers = [];
  }
  write(data, clear = 1) {
    this.written.push(data);
    if (clear) {
      this.buffer = ""; // 与真实 OutputBuffer.prepareWrite(1) 语义一致
    }
    for (const c of this.chunks) {
      const t = setTimeout(() => {
        this.buffer += c.data;
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

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

// ── 1. pattern 命中即返回，且早于静默窗口 ──
{
  const shell = new FakeMcuShell([
    { afterMs: 100, data: "APP: echo: wifi info\r\n[ESP8266] ip = 192.168.10.101\r\n" },
  ]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "wifi info",
    timeoutMs: 5000,
    quietMs: 1000, // 静默窗口故意很大，证明是 pattern 抢先完成
    responseRegex: /\[ESP8266\] ip =/,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("pattern path: completedBy=pattern", r.completedBy === "pattern", `got ${r.completedBy}`);
  check("pattern path: output contains ip", r.output.includes("192.168.10.101"), `got "${r.output}"`);
  check(
    "pattern path: returns well before quiet window",
    elapsed < 900,
    `elapsed=${elapsed}ms, quietMs=1000`
  );
  await shell.close();
}

// ── 2. quiet 路径：心跳干扰下（周期 > quietMs）响应后静默完成 ──
{
  // 心跳 900ms 周期，响应在 100ms；quietMs=300 → 响应后约 500-600ms 完成，
  // 赶在下一个心跳（900ms）之前
  const shell = new FakeMcuShell([
    { afterMs: 100, data: "APP: echo: ver\r\n" },
    { afterMs: 900, data: "flash-app count = 99\r\n" },
    { afterMs: 1800, data: "flash-app count = 100\r\n" },
  ]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "ver",
    timeoutMs: 5000,
    quietMs: 300,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("quiet path: completedBy=quiet", r.completedBy === "quiet", `got ${r.completedBy}`);
  check("quiet path: output contains response", r.output.includes("APP: echo: ver"), `got "${r.output}"`);
  check(
    "quiet path: completes before next heartbeat (period > quietMs works)",
    elapsed < 850,
    `elapsed=${elapsed}ms`
  );
  check("quiet path: first heartbeat not swallowed into output", !r.output.includes("count = 99"), `got "${r.output}"`);
  await shell.close();
}

// ── 3. timeout 路径：到点兜底，全程不发 Ctrl+C ──
// 夹具说明：timeout 只在"输出持续到达使静默永不满足、且 pattern 不命中"时
// 才可达（空输出设备会被 quiet 先行判完成，见第 4 组），故用心跳周期
// 200ms < quietMs 400ms 的持续心跳流喂满窗口。
{
  const shell = new FakeMcuShell([
    { afterMs: 200, data: "flash-app count = 1\r\n" },
    { afterMs: 400, data: "flash-app count = 2\r\n" },
    { afterMs: 600, data: "flash-app count = 3\r\n" },
    { afterMs: 800, data: "flash-app count = 4\r\n" },
    { afterMs: 1000, data: "flash-app count = 5\r\n" },
  ]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "reboot",
    timeoutMs: 800,
    quietMs: 400,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("timeout path: completedBy=timeout", r.completedBy === "timeout", `got ${r.completedBy}`);
  check(
    "timeout path: no ctrl+c written (0x03 never sent)",
    shell.written.every((w) => !w.includes("\x03")),
    `written=${JSON.stringify(shell.written)}`
  );
  check("timeout path: only one raw write (the command itself)", shell.written.length === 1, `got ${shell.written.length}`);
  check(
    "timeout path: returns no earlier than timeoutMs",
    elapsed >= 800 && elapsed < 3000,
    `elapsed=${elapsed}ms`
  );
  await shell.close();
}

// ── 4. 空响应：发送后一直无数据，quietMs 到期即返回空输出 ──
{
  const shell = new FakeMcuShell([]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "silent-cmd",
    timeoutMs: 5000,
    quietMs: 300,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("empty path: completedBy=quiet", r.completedBy === "quiet", `got ${r.completedBy}`);
  check("empty path: output empty", r.output === "", `got "${r.output}"`);
  check(
    "empty path: completes at ~quietMs, not at timeoutMs",
    elapsed < 2000,
    `elapsed=${elapsed}ms (timeoutMs=5000)`
  );
  await shell.close();
}

// ── 5. 前置冲刷：发送前的残留心跳进 flushed，不污染本次 output ──
{
  const shell = new FakeMcuShell(
    [{ afterMs: 100, data: "APP: echo: ping\r\n" }],
    "flash-app count = 41\r\nflash-app count = 42\r\n" // 写入前已积累的心跳
  );
  const r = await runMcuExec({
    shell,
    command: "ping",
    timeoutMs: 5000,
    quietMs: 300,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  check("flush path: stale heartbeats captured in flushed", r.flushed.includes("count = 41"), `flushed="${r.flushed}"`);
  check("flush path: output free of stale data", !r.output.includes("count = 41"), `output="${r.output}"`);
  check("flush path: output has the response", r.output.includes("APP: echo: ping"), `output="${r.output}"`);
  await shell.close();
}

// ── 6. quietMs 大于心跳周期：静默永不满足 → timeout（文档约束的反向证明） ──
{
  // 心跳 300ms 周期 < quietMs 500ms → 每次心跳都重置静默计时 → 只能靠 timeout 兜底
  const shell = new FakeMcuShell([
    { afterMs: 300, data: "flash-app count = 1\r\n" },
    { afterMs: 600, data: "flash-app count = 2\r\n" },
    { afterMs: 900, data: "flash-app count = 3\r\n" },
    { afterMs: 1200, data: "flash-app count = 4\r\n" },
  ]);
  const r = await runMcuExec({
    shell,
    command: "demo",
    timeoutMs: 1000,
    quietMs: 500,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  check(
    "heartbeat-vs-quiet: quiet never satisfied when quietMs > heartbeat period",
    r.completedBy === "timeout",
    `got ${r.completedBy}`
  );
  check(
    "heartbeat-vs-quiet: heartbeats preserved in output",
    r.output.includes("count = 2"),
    `output="${r.output}"`
  );
  await shell.close();
}

// ── 7. 裸发送契约：命令原样下发，无 marker/无 shell 语法追加 ──
{
  const shell = new FakeMcuShell([{ afterMs: 100, data: "ok\r\n" }]);
  await runMcuExec({
    shell,
    command: "wifi info",
    timeoutMs: 5000,
    quietMs: 300,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  check(
    "raw contract: exactly the command, no marker/echo suffix",
    shell.written.length === 1 && shell.written[0] === "wifi info",
    `written=${JSON.stringify(shell.written)}`
  );
  await shell.close();
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll mcu-exec checks passed.");
