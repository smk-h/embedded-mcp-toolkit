import type { InteractiveShell } from "./interactive-shell.js";

/**
 * @brief 交互式终端循环
 *
 * 从标准输入循环读取命令并发送，读取输出并显示，
 * 按 Ctrl+C 时断开连接并退出。
 *
 * @param shell  实现 InteractiveShell 接口的 shell 实例
 * @param prefix 命令提示符前缀（如 "ssh"、"serial"）
 */
export async function interactiveLoop(
  shell: InteractiveShell,
  prefix: string
): Promise<void> {
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${prefix}> `,
  });

  const cleanup = async () => {
    rl.close();
    await shell.close();
    console.log("\nDisconnected.");
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  rl.prompt();

  for await (const line of rl) {
    // readline 的 line 事件已自动去掉末尾换行符（\n / \r\n），
    // trim() 进一步去掉首尾空白，得到纯净的命令字符串
    const cmd = line.trim();
    if (!cmd) {
      rl.prompt();
      continue;
    }

    shell.write(cmd, 1);
    await new Promise((r) => setTimeout(r, 1000));
    const output = shell.read(1);
    if (output) process.stdout.write(output + "\n");
    rl.prompt();
  }

  await cleanup();
}
