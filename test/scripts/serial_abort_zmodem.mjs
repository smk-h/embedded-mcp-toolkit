/**
 * =====================================================
 * 串口 ZMODEM 中止工具
 *
 *   当设备端 rz/sz 卡在 ZMODEM 收发态无法退出时（Ctrl+C 无效，
 *   因为 rz 把 0x03 当数据吞掉），运行本脚本向串口发送 ZMODEM
 *   标准中止序列 CAN(0x18)×5 + BS(0x08)×5，让 lrzsz 干净退出。
 *
 *   前提：COM 口未被占用（若有 MCP 串口会话，需先 serial_close 释放）。
 *
 *   用法：
 *     node test/scripts/serial_abort_zmodem.mjs           # 默认 COM3
 *     node test/scripts/serial_abort_zmodem.mjs COM5      # 指定串口
 *     node test/scripts/serial_abort_zmodem.mjs COM5 921600  # 指定波特率
 * ======================================================
 */

import { SerialPort } from "serialport";

/** @brief 默认串口路径 */
const PORT = process.argv[2] ?? "COM3";

/** @brief 默认波特率 */
const BAUD_RATE = Number(process.argv[3] ?? 115200);

/** @brief ZMODEM 标准中止序列：CAN(0x18)×5 + BS(0x08)×5 */
const ABORT_SEQUENCE = Buffer.from([
  0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08,
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[abort] opening ${PORT} @ ${BAUD_RATE} ...`);
  const port = new SerialPort({
    path: PORT,
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  console.log("[abort] opened, sending CAN×5 + BS×5 ...");

  // 收集回显，确认设备退出
  port.on("data", (buf) => {
    const ascii = buf
      .toString("latin1")
      .replace(/[\x00-\x1f\x7f-\xff]/g, ".");
    console.log(`[recv] ${ascii}`);
  });

  port.write(ABORT_SEQUENCE);
  await sleep(600);

  // 发回车触发提示符回显，确认 shell 已恢复
  port.write("\r");
  await sleep(800);

  port.close();
  console.log("[abort] done");
}

main().catch((err) => {
  console.error("[abort] failed:", err.message);
  process.exit(1);
});
