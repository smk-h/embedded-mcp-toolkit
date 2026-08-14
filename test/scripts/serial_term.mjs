/**
 * =====================================================
 * 串口交互式终端（类似 MobaXterm / minicom）
 *
 *   打开串口后持续交互：命令行输入的内容发送到串口，
 *   串口回传的数据实时显示在终端。
 *
 *   用法：
 *     node test/scripts/serial_term.mjs                    # 默认 COM3 @ 115200
 *     node test/scripts/serial_term.mjs COM5               # 指定串口
 *     node test/scripts/serial_term.mjs COM5 921600        # 指定串口 + 波特率
 *
 *   交互方式：
 *     - 直接在终端输入一行内容并回车，即发送到串口（自动追加换行符）
 *     - 输入 `exit` 或按 Ctrl+C 退出
 *     - 串口收到的数据以 [RX] 前缀实时打印，方便区分回显
 * ======================================================
 */

import { SerialPort } from "serialport";
import { createInterface } from "readline";
import { isatty } from "tty";

/** @brief 默认串口路径 */
const PORT = process.argv[2] ?? "COM3";

/** @brief 默认波特率 */
const BAUD_RATE = Number(process.argv[3] ?? 115200);

/** @brief 退出命令 */
const EXIT_CMD = "exit";

/** @brief 发送到串口的行结束符 */
const LINE_ENDING = "\n";

/** @brief 交互式终端是否可用（仅在 TTY 下启用 readline 交互） */
const INTERACTIVE = isatty(0) && isatty(1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[serial] opening ${PORT} @ ${BAUD_RATE} ...`);

  // 1. 打开串口
  const port = new SerialPort({
    path: PORT,
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  console.log(`[serial] opened: ${PORT} @ ${BAUD_RATE}`);
  if (!INTERACTIVE) {
    console.warn(`[serial] 非 TTY 环境，禁用 readline 交互，仅打印串口回传数据`);
  } else {
    console.log(`[serial] 交互模式已就绪，输入一行回车发送到串口，输入 \`${EXIT_CMD}\` 或按 Ctrl+C 退出`);
  }

  // 2. 接收串口数据，实时打印（带 [RX] 前缀便于区分回显）
  port.on("data", (data) => {
    const text = data.toString("utf8");
    if (text.includes("\r")) {
      // 去除 \r 防止 Windows 换行干扰显示
      process.stdout.write(text.replace(/\r/g, ""));
    } else {
      process.stdout.write(text);
    }
  });

  // 3. 错误/关闭处理
  port.on("error", (err) => {
    console.error(`\n[serial] 串口错误: ${err.message}`);
  });
  port.on("close", () => {
    console.log(`\n[serial] 串口已关闭`);
  });

  // 4. 命令行交互：把用户输入逐行发送到串口
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === EXIT_CMD) {
      rl.close();
      return;
    }
    if (line.trim()) {
      port.write(line + LINE_ENDING);
      // console.log(`\n[TX] ${line}`); // 如需回显发送内容可放开此注释
    }
  });

  // 退出流程
  const shutdown = async () => {
    console.log(`\n[serial] 正在关闭...`);
    rl.close();
    await new Promise((resolve) => {
      port.close((err) => {
        if (err) console.error(`[serial] 关闭错误: ${err.message}`);
        resolve();
      });
    });
    process.exit(0);
  };

  rl.on("close", shutdown);
  process.on("SIGINT", shutdown); // Ctrl+C
}

main().catch((err) => {
  console.error(`[serial] 错误: ${err.message}`);
  process.exit(1);
});
