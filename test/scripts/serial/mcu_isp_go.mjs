/**
 * STM32 ISP Go 救砖脚本: 对处于 ISP 模式的芯片执行 AN3155 Go 命令,
 * 让其跳转 0x08000000 启动应用。
 *
 *   用法: node test/scripts/serial/mcu_isp_go.mjs [端口]   (默认 COM4)
 *
 * 本板实测(2026-10-31, ATK 战舰 V3 类一键下载电路):
 *   - 芯片处于 ISP 时, 0x7F/Get/Go 均可能只回 NACK(0x1F)或无响应;
 *   - 最合理解释: 打开端口瞬间的线序竞态毛刺把 bootloader 的自动波特率
 *     锁偏, 之后所有命令字节都被当作垃圾拒绝;
 *   - 因此本脚本按多种握手顺序轮询尝试(对状态干净的板子有效),
 *     若仍失败请改用 mcu_reset_app.mjs(复位时序, 本板实测 100% 可靠)。
 *
 *   轮询顺序: 轮次1: 0x7F 同步 -> Go; 轮次2: 直接 Go(适配已在命令等待态
 *   的芯片); 轮次3: 再同步 -> 再 Go。任一轮 Go 获 ACK 即发目标地址, 然后
 *   长听 6s 观察应用输出。
 *
 *   家族工具: mcu_serial_term.mjs(终端/诊断) mcu_isp_enter.mjs(主动进 ISP)
 */
import { SerialPort } from "serialport";

const PORT_PATH = process.argv[2] || "COM4";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => (buf.length ? buf.toString("hex").toUpperCase() : "无");

const port = new SerialPort({
  path: PORT_PATH,
  baudRate: 115200,
  rtscts: false,
  xon: false,
  xoff: false,
  autoOpen: false,
});
await new Promise((resolve, reject) => {
  port.open((err) => (err ? reject(err) : resolve()));
});
await new Promise((resolve, reject) => {
  port.set({ dtr: false, rts: false }, (err) => (err ? reject(err) : resolve()));
});
console.log(`端口已打开, DTR/RTS 已置 off`);

let rxBuffer = Buffer.alloc(0);
let rxSink = null;
port.on("data", (d) => {
  if (rxSink) {
    rxBuffer = Buffer.concat([rxBuffer, d]);
  }
});

/** 发送字节并监听窗口期内的响应 */
async function sendAndListen(bytes, label, ms) {
  console.log(`  [${label}] 发送: ${Buffer.from(bytes).toString("hex").toUpperCase()}`);
  rxBuffer = Buffer.alloc(0);
  rxSink = true;
  await new Promise((resolve, reject) => {
    port.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
  });
  await sleep(ms);
  rxSink = false;
  console.log(`  [${label}] 响应: ${hex(rxBuffer)}`);
  return rxBuffer;
}

let exitCode = 0;
try {
  await sleep(300); // 空听一段, 观察是否有自发输出
  console.log(`  [空听] ${hex(rxBuffer) || "无"}`);

  const rounds = [
    { name: "轮次1: 同步后 Go", sync: true },
    { name: "轮次2: 直接 Go", sync: false },
    { name: "轮次3: 再同步后 Go", sync: true },
  ];
  let ackGo = null;
  for (const round of rounds) {
    console.log(round.name);
    if (round.sync) {
      await sendAndListen([0x7f], "探测", 800);
    }
    ackGo = await sendAndListen([0x21, 0xde], "Go命令", 800);
    if (ackGo.includes(0x79)) {
      break;
    }
  }

  if (!ackGo || !ackGo.includes(0x79)) {
    console.log(`Go 命令始终未获 ACK(0x79), 停止。`);
    exitCode = 1;
  } else {
    const ackAddr = await sendAndListen([0x08, 0x00, 0x00, 0x00, 0x08], "地址", 800);
    console.log(`地址 ACK: ${ackAddr.includes(0x79) ? "成功, 芯片应已跳转应用" : "失败(仍尝试监听)"}`);

    console.log(`长听 6s 观察应用输出 ...`);
    let total = 0;
    rxSink = false;
    port.on("data", (d) => {
      total += d.length;
      process.stdout.write(d.toString("utf8").replace(/\r/g, ""));
    });
    await sleep(6000);
    console.log(total > 0 ? `\n=== 共收到 ${total} 字节, 应用已恢复 ===` : `\n=== 未收到应用输出 ===`);
    if (total === 0) exitCode = 1;
  }
} catch (err) {
  console.error(`[错误] ${err.message}`);
  exitCode = 1;
} finally {
  await new Promise((resolve) => port.close(() => resolve()));
}
process.exit(exitCode);
