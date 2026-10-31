#!/usr/bin/env node
/**
 * =====================================================
 * runMcuExec 离线验证（无需真实设备）
 *
 * 完成语义（两出口，先到者）：
 *   - pattern：responsePattern 在累积输出中命中 → 提前返回
 *   - timeout：未配 pattern（或 pattern 未命中）→ 等满 timeoutMs 返回
 *     单片机长命令执行期间往往零输出，"安静"不代表执行结束，
 *     等满预估时长才是预期行为；全程不发 Ctrl+C
 *
 * 覆盖：
 *   1. pattern 命中即返回（早于 timeoutMs）
 *   2. 无 pattern + 空输出 → 等满 timeoutMs，全程不发 Ctrl+C
 *   3. 无 pattern + 快速应答后安静 → 仍等满 timeoutMs（核心语义:
 *      响应结束不提前返回, 防长命令被截断）
 *   4. 无 pattern + 持续心跳流 → 等满 timeoutMs, 心跳收进输出
 *   5. 前置冲刷: 发送前残留进 flushed, 不污染本次 output
 *   6. 裸发送契约: 命令原样下发, 无 marker/无 shell 语法追加
 *
 * 运行：node test/scripts/serial/mcu-exec-test.mjs（先 npm run build）
 * ======================================================
 */
import { runMcuExec } from "../../../out/sdk/exec/mcu-exec-runner.js";

/**
 * mock shell：write() 后按 afterMs 时间表向缓冲投放数据，模拟
 * "无回显固件 + 命令响应"的输出流。
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
  console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : " | " + detail}`);
  if (!cond) failed++;
}

// ── 1. pattern 命中即返回（早于 timeoutMs）──
{
  const shell = new FakeMcuShell([
    { afterMs: 100, data: "APP: echo: wifi info\r\n[ESP8266] ip = 192.168.10.101\r\n" },
  ]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "wifi info",
    timeoutMs: 5000,
    responseRegex: /\[ESP8266\] ip =/,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("pattern path: completedBy=pattern", r.completedBy === "pattern", `got ${r.completedBy}`);
  check("pattern path: output contains ip", r.output.includes("192.168.10.101"), `got "${r.output}"`);
  check(
    "pattern path: returns well before timeoutMs",
    elapsed < 1500,
    `elapsed=${elapsed}ms, timeoutMs=5000`
  );
  await shell.close();
}

// ── 2. 无 pattern + 空输出 → 等满 timeoutMs，全程不发 Ctrl+C ──
{
  const shell = new FakeMcuShell([]); // 永远无输出
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "reboot",
    timeoutMs: 800,
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
    "timeout path: waits the full timeoutMs (empty output too)",
    elapsed >= 800 && elapsed < 3000,
    `elapsed=${elapsed}ms`
  );
  await shell.close();
}

// ── 3. 无 pattern + 快速应答后安静 → 仍等满 timeoutMs（核心语义）──
// 长命令执行期间零输出, "安静"不代表执行结束; 响应完不提前返回, 防截断。
{
  const shell = new FakeMcuShell([
    { afterMs: 100, data: "APP: echo: build\r\n" },
    { afterMs: 200, data: "build: started, please wait...\r\n" },
    // 之后再无输出 —— 命令可能仍在跑
  ]);
  const t0 = Date.now();
  const r = await runMcuExec({
    shell,
    command: "build",
    timeoutMs: 1500,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  const elapsed = Date.now() - t0;
  check("no-quiet path: completedBy=timeout", r.completedBy === "timeout", `got ${r.completedBy}`);
  check(
    "no-quiet path: does NOT return early after response goes quiet",
    elapsed >= 1500 && elapsed < 4000,
    `elapsed=${elapsed}ms (timeoutMs=1500)`
  );
  check("no-quiet path: response collected in output", r.output.includes("build: started"), `got "${r.output}"`);
  await shell.close();
}

// ── 4. 无 pattern + 持续心跳流 → 等满 timeoutMs, 心跳收进输出 ──
{
  const shell = new FakeMcuShell([
    { afterMs: 200, data: "flash-app count = 1\r\n" },
    { afterMs: 400, data: "flash-app count = 2\r\n" },
    { afterMs: 600, data: "flash-app count = 3\r\n" },
    { afterMs: 800, data: "flash-app count = 4\r\n" },
    { afterMs: 1000, data: "flash-app count = 5\r\n" },
  ]);
  const r = await runMcuExec({
    shell,
    command: "demo",
    timeoutMs: 1000,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  check("heartbeat path: completedBy=timeout", r.completedBy === "timeout", `got ${r.completedBy}`);
  check(
    "heartbeat path: heartbeats preserved in output",
    r.output.includes("count = 3"),
    `output="${r.output}"`
  );
  await shell.close();
}

// ── 5. 前置冲刷: 发送前的残留进 flushed, 不污染本次 output ──
{
  const shell = new FakeMcuShell(
    [{ afterMs: 100, data: "APP: echo: ping\r\n" }],
    "debug line left over\r\n" // 写入前已积累的残留
  );
  const r = await runMcuExec({
    shell,
    command: "ping",
    timeoutMs: 2000,
    responseRegex: null,
    logPrefix: "[mcu-test]",
  });
  check("flush path: stale data captured in flushed", r.flushed.includes("debug line"), `flushed="${r.flushed}"`);
  check("flush path: output free of stale data", !r.output.includes("debug line"), `output="${r.output}"`);
  check("flush path: output has the response", r.output.includes("APP: echo: ping"), `output="${r.output}"`);
  await shell.close();
}

// ── 6. 裸发送契约: 命令原样下发, 无 marker/无 shell 语法追加 ──
{
  const shell = new FakeMcuShell([{ afterMs: 100, data: "ok\r\n" }]);
  await runMcuExec({
    shell,
    command: "wifi info",
    timeoutMs: 2000,
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

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} assertion(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
