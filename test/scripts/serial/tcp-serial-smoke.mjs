/**
 * =====================================================
 * TCP 串口通道冒烟验证（QEMU 虚拟板卡）
 *
 * 验证 SerialShell 的 tcp://host:port 通道：
 *   1. parseTcpEndpoint 端点解析（IPv4 / 主机名 / IPv6 / 非法格式）
 *   2. serial_open → 会话建立 + 同端点防重
 *   3. serial_exec → echo 命令执行与提示符检测返回
 *   4. serial_close → 会话关闭
 *
 * 用法：
 *   node test/scripts/serial/tcp-serial-smoke.mjs                # 仅离线解析检查
 *   node test/scripts/serial/tcp-serial-smoke.mjs tcp://127.0.0.1:4444
 *                                                                # 含在线 QEMU 验证（需先 npm run build）
 *
 * QEMU 参考启动命令（先启动，等应急 shell 出现后再跑本脚本）：
 *   npm run qemu          # 即 scripts/start-qemu-virt.ps1，串口监听 tcp://127.0.0.1:4444
 * 或手动：
 *   qemu-system-aarch64 -M virt -cpu cortex-a57 -m 512M -display none \
 *     -kernel vmlinuz-virt -initrd initramfs-virt \
 *     -append "console=ttyAMA0" \
 *     -serial tcp:127.0.0.1:4444,server,nowait \
 *     -monitor telnet:127.0.0.1:5555,server,nowait
 * ======================================================
 */

import {
  serialCloseHandler,
  serialExecHandler,
  serialOpenHandler,
} from "../../../out/sdk/tools/serial/shell.js";
import { parseTcpEndpoint } from "../../../out/sdk/transports/serial.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 离线：端点解析 ──────────────────────────────
console.log("[offline] parseTcpEndpoint 解析检查");

const GOOD_CASES = [
  ["tcp://127.0.0.1:4444", { host: "127.0.0.1", tcpPort: 4444 }],
  ["tcp://localhost:1234", { host: "localhost", tcpPort: 1234 }],
  ["tcp://192.168.1.9:8888", { host: "192.168.1.9", tcpPort: 8888 }],
  ["tcp://[::1]:5555", { host: "::1", tcpPort: 5555 }],
];
let failed = 0;
for (const [input, expect] of GOOD_CASES) {
  const r = parseTcpEndpoint(input);
  const ok = r.host === expect.host && r.tcpPort === expect.tcpPort;
  console.log(`  [${ok ? "✓" : "✗"}] ${input} → ${JSON.stringify(r)}`);
  if (!ok) failed++;
}

const BAD_CASES = ["tcp://:4444", "tcp://127.0.0.1", "tcp://host:abc", "COM3"];
for (const bad of BAD_CASES) {
  let threw = false;
  try {
    parseTcpEndpoint(bad);
  } catch {
    threw = true;
  }
  console.log(`  [${threw ? "✓" : "✗"}] 非法端点 ${bad} → ${threw ? "抛错" : "未抛错(异常)"}`);
  if (!threw) failed++;
}

if (failed > 0) {
  console.log(`[✗] 解析检查未通过（${failed} 项）`);
  process.exit(1);
}
console.log("[✓] 解析检查全部通过\n");

const endpoint = process.argv[2];
if (!endpoint) {
  console.log("未传入端点参数，跳过在线验证（传入形如 tcp://127.0.0.1:4444 的参数启用）");
  process.exit(0);
}

// ── 在线：QEMU 会话全流程 ─────────────────────────
console.log(`[online] 连接 ${endpoint} ...`);
const openMsg = await serialOpenHandler({ port: endpoint });
console.log(openMsg);
const openMatch = openMsg.match(/^Session (serial_\d+) opened/);
if (!openMatch) {
  console.log("[✗] serial_open 失败");
  process.exit(1);
}
const sessionId = openMatch[1];

// 防重：同端点二次 open 应被拦截
await sleep(200);
const dupMsg = await serialOpenHandler({ port: endpoint });
const dupOk = dupMsg.includes("already open");
console.log(`  [${dupOk ? "✓" : "✗"}] 同端点防重: ${dupMsg.split("\n")[0]}`);

// exec：echo 命令（提示符检测返回，不应触发兜底超时）
console.log("[online] exec: echo hello-tcp-serial");
const out = await serialExecHandler({
  session_id: sessionId,
  command: "echo hello-tcp-serial",
  timeoutMs: 10000,
});
console.log(out);
const echoOk = out.includes("hello-tcp-serial") && !out.includes("兜底超时");
console.log(`  [${echoOk ? "✓" : "✗"}] echo 输出回读（提示符检测返回）`);

// 关闭
const closeMsg = await serialCloseHandler({ session_id: sessionId });
console.log(`  [${closeMsg.includes("closed") ? "✓" : "✗"}] ${closeMsg}`);

const allOk = dupOk && echoOk && closeMsg.includes("closed");
console.log(allOk ? "\n[✓] TCP 串口通道在线验证全部通过" : "\n[✗] 存在未通过项");
process.exit(allOk ? 0 : 1);
