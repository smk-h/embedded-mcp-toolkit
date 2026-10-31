/**
 * 软件复位脚本: 用 DTR/RTS 时序复位 MCU, 以 BOOT0=0 从 Flash 干净启动应用。
 * 可用于把误入 ISP 模式的芯片拉回应用(实测有效), 也可用于普通的应用重启。
 *
 *   用法: node test/scripts/serial/mcu_reset_app.mjs [端口]   (默认 COM4)
 *
 * 时序:
 *   1. 打开端口(驱动会瞬间断言 DTR+RTS) -> 立刻置 DTR=off 保持 RTS=on
 *      (BOOT0=0, RESET 持续按住, 芯片稳定处于复位)
 *   2. 等待 200ms
 *   3. 置 RTS=off -> RESET 释放, BOOT0 为低, 芯片从 Flash 启动应用
 *   4. 监听 8 秒观察应用输出
 *
 * 家族工具: mcu_serial_term.mjs(终端/诊断) mcu_isp_enter.mjs(主动进 ISP)
 *           mcu_isp_go.mjs(ISP Go 命令跳应用)
 */
import { SerialPort } from "serialport";

const PORT_PATH = process.argv[2] || "COM4";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

try {
  // 1. 按住 RESET(RETS=on), 放低 BOOT0(DTR=off)
  await set({ dtr: false, rts: true });
  await sleep(50);
  await set({ dtr: false }); // 确保 BOOT0 稳定为低
  console.log("[1] RESET 已按住, BOOT0 已放低, 等待 200ms ...");
  await sleep(200);

  // 2. 释放 RESET, 芯片以 BOOT0=0 从 Flash 启动
  await set({ rts: false });
  console.log("[2] RESET 已释放, 应用启动中, 监听 8s ...");

  // 3. 监听应用输出
  let total = 0;
  port.on("data", (d) => {
    total += d.length;
    process.stdout.write(d.toString("utf8").replace(/\r/g, ""));
  });
  await sleep(8000);
  console.log(total > 0 ? `\n=== 共收到 ${total} 字节, 应用已恢复 ===` : `\n=== 未收到应用输出 ===`);
  process.exit(total > 0 ? 0 : 1);
} catch (err) {
  console.error(`[错误] ${err.message}`);
  await new Promise((resolve) => port.close(() => resolve()));
  process.exit(1);
}
