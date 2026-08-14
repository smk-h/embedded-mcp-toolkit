import { SerialPort } from "serialport";

const SERIAL_PORT = "COM3";
const BAUD_RATE = 115200;

/**
 * 持续监听串口数据，检测到 U-Boot 自动引导提示时自动发送换行进入 uboot 命令行
 */
async function main() {
  // 1. 打开串口
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

  // 2. 发送 reboot 命令重启设备
  console.log('Sending "reboot" to restart device...');
  port.write("reboot\n");

  // 3. 持续监听串口数据，检测 "Hit any key to stop autoboot:"
  console.log("Waiting for U-Boot autoboot prompt...");
  let output = "";
  let hitDetected = false;

  const AUTBOOT_PATTERN = /Hit any key to stop autoboot/i;

  port.on("data", (data) => {
    const chunk = data.toString();
    output += chunk;
    process.stdout.write(chunk); // 实时打印串口输出

    // 检测到 autoboot 提示时发送换行
    if (!hitDetected && AUTBOOT_PATTERN.test(output)) {
      hitDetected = true;
      console.log("\n>>> Detected autoboot prompt, sending newline to enter U-Boot...");
      port.write("\n"); // 发送换行进入 uboot
      output = ""; // 重置缓冲区，继续监听后续输出
    }

    // 检测到 uboot 提示符 =>（可选，用于确认已进入 uboot）
    if (hitDetected && /=>\s*$/.test(output)) {
      console.log("\n>>> Entered U-Boot command line.");
      hitDetected = false; // 重置以便后续再次检测（如果触发了 reset 等）
    }
  });

  // 4. 保持脚本运行，直到用户按 Ctrl+C 退出
  console.log("Press Ctrl+C to exit.\n");

  // 优雅退出处理
  const cleanup = () => {
    console.log("\nClosing serial port...");
    port.close((err) => {
      if (err) console.error("Close error:", err.message);
      else console.log("Serial closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
