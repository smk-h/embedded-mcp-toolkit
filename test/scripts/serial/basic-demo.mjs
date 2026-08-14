/**
 * =====================================================
 * 串口基础演示（debug 命令 + 密钥交互）
 *
 *   打开串口后依次执行：
 *     1. 发送 `debug` 命令并收集 3 秒输出
 *     2. 从命令行读取解锁密钥并发送
 *     3. 再次收集 3 秒输出后关闭串口
 *
 *   用法：
 *     node test/scripts/serial/basic-demo.mjs              # 默认 COM3 @ 115200
 *
 *   说明：脚本内部硬编码了串口路径与波特率，如需修改
 *   请直接编辑文件顶部的 SERIAL_PORT / BAUD_RATE 常量。
 * ======================================================
 */

import { SerialPort } from "serialport";
import { createInterface } from "readline";

/** @brief 串口路径（演示用，按实际设备修改） */
const SERIAL_PORT = "COM3";

/** @brief 波特率 */
const BAUD_RATE = 115200;

async function main() {
  // 1. 打开串口：autoOpen=false 以便显式等待 open 回调成功后再往下走
  const port = new SerialPort({
    path: SERIAL_PORT,
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  console.log(`Serial opened: ${SERIAL_PORT} @ ${BAUD_RATE}`);

  // 累积串口回显，便于在命令执行后统一打印
  let output = "";
  port.on("data", (data) => {
    output += data.toString();
  });

  // 2. 发送 debug 命令
  port.write("debug\n"); // 某些设备只认 \r\n 作为命令结束标志，但经过测试，这里 \n 就可以了

  // 等待 3 秒收集输出
  await new Promise((r) => setTimeout(r, 3000));

  console.log("=== Output ===");
  console.log(output);

  // 3. 从命令行读取密钥
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise((resolve) => {
    rl.question("Enter key: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });

  // 4. 发送密钥
  output = "";
  port.write(key + "\n");

  // 等待 3 秒收集输出
  await new Promise((r) => setTimeout(r, 3000));

  console.log("=== Result ===");
  console.log(output);

  // 5. 关闭串口
  await new Promise((resolve) => {
    port.close((err) => {
      if (err) console.error("Close error:", err.message);
      resolve();
    });
  });
  console.log("Serial closed");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
