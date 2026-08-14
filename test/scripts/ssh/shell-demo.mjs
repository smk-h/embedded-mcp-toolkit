/**
 * =====================================================
 * SSH 交互式 shell 基础演示（debug 命令 + 密钥交互）
 *
 *   通过 SSH 打开交互式 shell，依次执行：
 *     1. 发送 `debug` 命令并收集 3 秒输出
 *     2. 从命令行读取解锁密钥并发送
 *     3. 再次收集 3 秒输出后关闭连接
 *
 *   用法：
 *     node test/scripts/ssh/shell-demo.mjs
 *
 *   说明：连接信息（host / port / username / password）
 *   硬编码在文件顶部的 config 中，请按实际设备修改。
 * ======================================================
 */

import { Client } from "ssh2";
import { createInterface } from "readline";

const config = {
  host: "192.168.16.105",
  port: 22,
  username: "root",
  password: "root",
};

async function main() {
  const client = new Client();

  // 1. 连接：等 ready 事件触发即认为连接成功
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    client.connect(config);
  });
  console.log("Connected");

  // 2. 打开交互式 shell：与 exec() 不同，shell 在同一会话内持续复用
  const stream = await new Promise((resolve, reject) => {
    client.shell((err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });

  // 累积 shell 回显，便于在命令执行后统一打印
  let output = "";
  stream.on("data", (data) => {
    output += data.toString();
  });

  // 3. 发送 debug 命令（某些设备只认 \r\n 作为命令结束标志）
  stream.write("debug\n");

  // 等待 3 秒收集输出
  await new Promise((r) => setTimeout(r, 3000));

  console.log("=== Output ===");
  console.log(output);

  // 4. 从命令行读取密钥
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise((resolve) => {
    rl.question("Enter key: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });

  // 5. 发送密钥
  output = "";
  stream.write(key + "\n");

  // 等待 3 秒收集输出
  await new Promise((r) => setTimeout(r, 3000));

  console.log("=== Result ===");
  console.log(output);

  // 6. 关闭
  stream.close();
  client.end();
  console.log("Disconnected");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
