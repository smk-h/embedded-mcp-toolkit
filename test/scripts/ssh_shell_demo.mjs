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

  // 1. 连接
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    client.connect(config);
  });
  console.log("Connected");

  // 2. 打开交互式 shell
  const stream = await new Promise((resolve, reject) => {
    client.shell((err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });

  let output = "";
  stream.on("data", (data) => {
    output += data.toString();
  });

  // 3. 发送 debug 命令
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
