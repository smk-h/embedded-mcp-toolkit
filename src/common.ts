/** @brief 输出缓冲区最大容量（字节） */
export const MAX_BUFFER_SIZE = 1024 * 1024; // 16KB

/**
 * @brief 清洗串口/SSH 输出中的控制字符，防止终端显示错乱
 *
 * 嵌入式串口终端通常使用 CR+LF（\r\n）换行，且可能包含 ANSI 转义序列。
 * 直接 console.log 这些原始数据会导致：
 *   - \r 将光标移回行首，覆盖已有输出
 *   - ANSI 转义序列移动光标，造成文本出现在错误位置
 *
 * 清洗策略：
 *   1. \r\n → \n（Windows 风格 CRLF 归一化为 LF）
 *   2. 孤立的 \r（无 \n 跟随）→ \n（视为换行）
 *   3. 移除 ANSI CSI 序列（\x1b[...m, \x1b[...A/B/C/D 等）
 *   4. 移除其他控制字符（保留 \n 和 \t）
 *
 * @param raw 原始输出字符串
 * @return 清洗后的安全字符串，可安全打印到终端
 */
export function sanitizeTerminalOutput(raw: string): string {
  return raw
    // 先归一化 CRLF → LF
    .replace(/\r\n/g, "\n")
    // 孤立的 CR 替换为 LF
    .replace(/\r/g, "\n")
    // 移除 ANSI CSI 序列：ESC[ + 参数 + 字母
    // 匹配 \x1b[...m (SGR), \x1b[...A/B/C/D/H/J/K 等光标控制
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // 移除其他 ANSI 序列（如 ESC]...BEL 等）
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[^[][0-9;]*[A-Za-z]/g, "")
    // 移除除 \n \t 之外的控制字符（ASCII 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * @brief 交互式 Shell 的读写接口
 *
 * 抽象出 write / read / close 方法，
 * 供 interactiveLoop 统一调用。
 */
export interface InteractiveShell {
  write(cmd: string, clear?: number): void;
  read(clear?: number): string;
  close(): Promise<void>;
}

/**
 * @brief 交互式终端循环
 *
 * 从标准输入循环读取命令并发送，读取输出并显示，
 * 按 Ctrl+C 时断开连接并退出。
 *
 * @param shell  实现 InteractiveShell 接口的 shell 实例
 * @param prefix 命令提示符前缀（如 "ssh"、"serial"）
 */
export async function interactiveLoop(shell: InteractiveShell, prefix: string): Promise<void> {
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
