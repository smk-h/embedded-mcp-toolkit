/**
 * =====================================================
 * serial_term.mjs 裸转发模式单元测试
 *
 *   覆盖：
 *     - nextDevLine 行状态推算（exit 识别 / 退格 / 清行 / 脏行标记）
 *     - startRawForward 透传行为（逐字节转发 / CRLF 折叠 / exit 回车截获）
 *
 *   用法：
 *     node test/scripts/serial-term-raw-test.mjs
 * ======================================================
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { nextDevLine, startRawForward } from "./serial_term.mjs";

const CR = 0x0d;
const LF = 0x0a;
const BS = 0x08;
const DEL = 0x7f;
const ETX = 0x03;
const VKILL = 0x15;
const TAB = 0x09;
const ESC = 0x1b;

/** @brief 模拟打字：字符串按字符、数字按字节喂给 nextDevLine */
function typeBytes(...parts) {
  let line = "";
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) line = nextDevLine(line, ch.charCodeAt(0));
    } else {
      line = nextDevLine(line, part);
    }
  }
  return line;
}

// ---------- nextDevLine：行状态推算 ----------
{
  // 正常输入 "exit" 可被识别
  assert.equal(typeBytes("exit"), "exit");

  // 退格（DEL / BS 两种键盘编码）删一个字符
  assert.equal(typeBytes("exite", DEL), "exit");
  assert.equal(typeBytes("exite", BS), "exit");

  // Ctrl+C / Ctrl+U 清行
  assert.equal(typeBytes("exi", ETX), "");
  assert.equal(typeBytes("partial line", ETX), "");
  assert.equal(typeBytes("exit", VKILL), "");

  // Tab / 方向键转义序列 / UTF-8 多字节 → 脏行，不会误判为 exit
  assert.notEqual(typeBytes("exi", TAB, "t"), "exit");
  assert.notEqual(typeBytes("exi", ESC, 0x5b, 0x43, "t"), "exit"); // 方向键右
  assert.notEqual(typeBytes("exi", 0xe9, 0x80, 0x80, "t"), "exit"); // UTF-8 多字节

  // 普通命令不受影响
  assert.equal(typeBytes("ls -l"), "ls -l");

  console.log("[ok] nextDevLine 行状态推算");
}

// ---------- startRawForward：透传行为 ----------
/**
 * @brief 构造假串口 + 假输入（同步 EventEmitter，写入即触发 data 事件）
 */
function harness() {
  const port = {
    writes: [],
    write(buf) {
      this.writes.push(Buffer.from(buf));
    },
  };
  const input = new EventEmitter();
  input.write = (buf) => input.emit("data", buf);
  let exited = 0;
  startRawForward(port, input, () => exited++);
  return { input, exited: () => exited, sent: () => Buffer.concat(port.writes).toString("latin1") };
}

/** @brief 字符串/字节数组转 Buffer */
const buf = (...parts) =>
  Buffer.from(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : [p])),
  );

{
  // 键盘输入逐字节原样透传（含退格、Ctrl+C 控制字节）
  const h = harness();
  h.input.write(buf("ech", DEL, DEL, DEL, ETX, "ls", CR));
  assert.equal(h.sent(), "ech\x7f\x7f\x7f\x03ls\r");
  assert.equal(h.exited(), 0);
  console.log("[ok] 逐字节透传（退格/Ctrl+C 原样转发）");
}

{
  // 打字敲错用退格修正后输入 exit，回车触发本地退出，且回车字节不透传
  const h = harness();
  h.input.write(buf("exiz", DEL, "t"));
  h.input.write(buf(CR));
  assert.equal(h.exited(), 1);
  assert.equal(h.sent(), "exiz\x7ft"); // exit 四个字符已逐字透传，仅回车被截获
  console.log("[ok] 退格修正后输入 exit 触发本地退出");
}

{
  // CRLF（粘贴场景）只透传 CR，避免多提交一个空行
  const h = harness();
  h.input.write(buf("ls", CR, LF));
  assert.equal(h.sent(), "ls\r");
  console.log("[ok] CRLF 折叠为 CR");
}

{
  // 行内包含 exit 子串（如 exit 0）不触发退出
  const h = harness();
  h.input.write(buf("exit 0", CR));
  assert.equal(h.exited(), 0);
  assert.equal(h.sent(), "exit 0\r");
  console.log("[ok] 非独立 exit 行不误判");
}

{
  // Ctrl+C 清行后再输入 exit，仍可正常识别（清行后残留的退格也不影响）
  const h = harness();
  h.input.write(buf("wront", ETX, DEL, "exit", CR));
  assert.equal(h.exited(), 1);
  console.log("[ok] Ctrl+C 清行后 exit 识别不受残留影响");
}

{
  // LF（0x0a）作回车的终端也能触发退出；独立 LF 原样透传
  const h = harness();
  h.input.write(buf("exit", LF));
  assert.equal(h.exited(), 1);

  const h2 = harness();
  h2.input.write(buf(LF)); // 非 CRLF 一部分的独立 LF
  assert.equal(h2.sent(), "\n");
  assert.equal(h2.exited(), 0);
  console.log("[ok] LF 回车识别与独立 LF 透传");
}

console.log("\n全部通过 ✔");
