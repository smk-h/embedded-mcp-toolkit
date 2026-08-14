import { SerialPort } from "serialport";
import { createInterface } from "readline";

const SERIAL_PORT = "COM3";
const BAUD_RATE = 115200;

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
