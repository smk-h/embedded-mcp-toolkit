/**
 * STM32 主动进入 ISP 模式脚本: 用 DTR/RTS 时序模拟"一键下载"的进 ISP 操作。
 * 进 ISP 后芯片运行 ROM 引导程序, 可供 ISP 烧录工具(FlyMcu/STM32CubeProgrammer
 * 串口模式等)使用, 也可用于验证进 ISP 时序与探测协议。
 *
 *   用法: node test/scripts/serial/mcu_isp_enter.mjs [端口]   (默认 COM4)
 *
 * 本板(ATK 战舰 V3 类一键下载电路)实测拟合的电路行为:
 *   RESET 按住 ≈ RTS 有效 且 DTR 无效; BOOT0 随 DTR 翻转且带 RC 滞后。
 *   打开端口时驱动断言两线的先后是竞态, 若 RTS 先起、DTR 后起, 复位释放沿
 *   时刻 BOOT0 尚未落下, 芯片即误入 ISP —— 这正是"一打开串口就砖"的根源。
 *
 * 时序一(主, 确定性复现上述竞态):
 *   1. RTS=on 按住复位(DTR 保持 off), 等 100ms
 *   2. DTR=on -> 产生复位释放沿, BOOT0 尚未落下 -> 进 ISP
 *   3. 等 300ms 后发 0x7F 探测验证
 * 时序二(备, 双线保持后同时释放):
 *   1. DTR=on, RTS=on 保持 200ms
 *   2. 两线同时释放 -> 复位释放沿上 BOOT0 靠 RC 滞后保持高 -> 进 ISP
 *
 * 本板实测: 时序一曾一次成功(0x79), 也曾一次把应用复位重启——BOOT0 的
 * RC 滞后是竞态, 同一时序结果非确定。脚本每一步都用 0x7F 探测验证实际
 * 结果, 不预设成功。
 *
 * 退出 ISP: 用 mcu_reset_app.mjs(复位时序) 或 mcu_isp_go.mjs(Go 命令跳应用)。
 * 家族工具: mcu_serial_term.mjs(终端/诊断) mcu_isp_go.mjs(ISP Go 命令跳应用)
 */
import { SerialPort } from "serialport";

const PORT_PATH = process.argv[2] || "COM4";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => (buf.length ? buf.toString("hex").toUpperCase() : "无");
const set = (opts) =>
  new Promise((resolve, reject) => {
    port.set(opts, (err) => (err ? reject(err) : resolve()));
  });

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
// 先显式归位到 off/off, 摆脱驱动打开瞬间的断言态
await set({ dtr: false, rts: false });
await sleep(200);

/** 发 0x7F 并收集 1s 内的响应 */
async function probe() {
  port.write(Buffer.from([0x7f]));
  let buf = Buffer.alloc(0);
  const ondata = (d) => {
    buf = Buffer.concat([buf, d]);
  };
  port.on("data", ondata);
  await sleep(1000);
  port.off("data", ondata);
  return buf;
}

let exitCode = 1;
try {
  // ---- 时序一: RTS 先按住复位, DTR 后起制造释放沿
  await set({ rts: true });
  console.log("[时序一] RTS=on 按住复位(DTR=off), 等 100ms ...");
  await sleep(100);
  await set({ dtr: true });
  console.log("[时序一] DTR=on 产生复位释放沿(BOOT0 尚高), 等 300ms ...");
  await sleep(300);
  let ack = await probe();
  console.log(`[时序一] 0x7F 探测响应: ${hex(ack)}`);
  if (ack.includes(0x79)) {
    console.log(`=== 收到 ACK(0x79), 芯片已进入 ISP(同步等待态) ===`);
    exitCode = 0;
  } else if (ack.includes(0x1f)) {
    console.log(`=== 收到 NACK(0x1F), 芯片本就在 ISP 命令态 ===`);
    exitCode = 0;
  } else {
    // ---- 时序二: 双线保持后同时释放(意外进 ISP 的原始时序)
    console.log(`[时序二] 时序一未进 ISP, 改用双线保持后同时释放 ...`);
    await set({ dtr: true, rts: true });
    await sleep(200);
    await set({ dtr: false, rts: false });
    console.log("[时序二] 两线已同时释放, 等 300ms ...");
    await sleep(300);
    ack = await probe();
    console.log(`[时序二] 0x7F 探测响应: ${hex(ack)}`);
    if (ack.includes(0x79)) {
      console.log(`=== 收到 ACK(0x79), 芯片已进入 ISP(同步等待态) ===`);
      exitCode = 0;
    } else if (ack.includes(0x1f)) {
      console.log(`=== 收到 NACK(0x1F), 芯片本就在 ISP 命令态 ===`);
      exitCode = 0;
    } else {
      console.log(`=== 两种时序都未进入 ISP; 若需烧录请用 BOOT0 跳线 + 复位按键 ===`);
    }
  }
} catch (err) {
  console.error(`[错误] ${err.message}`);
} finally {
  await new Promise((resolve) => port.close(() => resolve()));
}
process.exit(exitCode);
