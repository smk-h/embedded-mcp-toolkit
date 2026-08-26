/**
 * =====================================================
 * SSH 交互式终端（类似 MobaXterm / ssh 命令）
 *
 *   通过 ssh2 建立 PTY 会话后持续交互：键盘输入逐字节转发到远端，
 *   远端回传数据实时显示在终端。
 *
 *   用法：
 *     node test/scripts/ssh/terminal.mjs                          # 默认连接信息
 *     node test/scripts/ssh/terminal.mjs 192.168.16.105           # 指定主机
 *     node test/scripts/ssh/terminal.mjs 192.168.16.105 22 root root   # 主机 端口 用户 密码
 *
 *   连接信息优先级：命令行参数 > 环境变量（BOARD_HOST / BOARD_PORT /
 *   BOARD_USERNAME / BOARD_PASSWORD）> 内置默认值。
 *
 *   裸转发模式（TTY 下自动启用，行为对齐 MobaXterm / 原生 ssh）：
 *     - 键盘输入逐字节原样透传：Backspace / Ctrl+C / 回车都交给远端
 *       PTY 行编辑处理，回传原样打印，所见即设备真实状态
 *     - 输入 `exit` 回车退出（本地断开，远端 PTY 由 sshd 自动回收，
 *       无串口那样的半行残留问题）
 *
 *   非 TTY 环境：禁用交互，仅监听打印远端回传数据（管道输入 `exit` 关闭）
 *
 *   说明：裸转发的字节识别逻辑复用 ../serial/terminal.mjs 导出的纯函数，
 *   两类终端的退出判定行为保持一致。
 * ======================================================
 */

import { Client } from "ssh2";
import { createInterface } from "readline";
import { isatty } from "tty";
import { fileURLToPath } from "url";

import { startRawForward } from "../serial/terminal.mjs";

/** @brief 连接超时（毫秒） */
const CONNECT_TIMEOUT_MS = 10_000;

/** @brief 命令行参数 */
const args = process.argv.slice(2);

/** @brief 目标主机（参数 > 环境变量 > 默认值） */
const HOST = args[0] ?? process.env.BOARD_HOST ?? "192.168.16.105";

/** @brief 目标端口 */
const PORT = Number(args[1] ?? process.env.BOARD_PORT ?? 22);

/** @brief 登录用户名 */
const USERNAME = args[2] ?? process.env.BOARD_USERNAME ?? "root";

/** @brief 登录密码 */
const PASSWORD = args[3] ?? process.env.BOARD_PASSWORD ?? "root";

/** @brief 退出命令 */
const EXIT_CMD = "exit";

/** @brief 交互式终端是否可用（仅在 TTY 下启用交互） */
const INTERACTIVE = isatty(0) && isatty(1);

/** @brief 退出流程是否已启动（防止主动退出与流 close 事件重复处理） */
let closing = false;

/** @brief 当前 ssh2 客户端与 shell 流（shutdown 用） */
let client = null;
let stream = null;

/** @brief 恢复终端状态（退出后不能把用户的 shell 留在 raw 模式） */
function restoreTty() {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
}

/** @brief 退出流程：恢复终端并断开 SSH 连接（远端 PTY 由 sshd 自动回收） */
function shutdown(reason) {
  if (closing) return;
  closing = true;
  console.log(`\n[ssh] 正在关闭...${reason ? `（${reason}）` : ""}`);
  restoreTty();
  try {
    stream?.close();
    client?.end();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

/**
 * @brief 建立 SSH 连接并请求 PTY shell
 *
 * 密码认证失败时自动降级 keyboard-interactive（部分 sshd 禁用
 * password 认证只留 KBD 交互）。
 *
 * @return {Promise<stream>} 就绪的 shell 流（可 write / 监听 data）
 */
function openShell() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(
      () => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS}ms）：${HOST}:${PORT}`)),
      CONNECT_TIMEOUT_MS
    );

    conn
      .on("ready", () => {
        clearTimeout(timer);
        conn.shell(
          {
            term: process.env.TERM || "xterm-256color",
            cols: process.stdout.columns ?? 80,
            rows: process.stdout.rows ?? 24,
          },
          (err, s) => {
            if (err) {
              clearTimeout(timer);
              conn.end();
              return reject(err);
            }
            stream = s;
            resolve(s);
          }
        );
      })
      .on("keyboard-interactive", (_name, _instr, _lang, _prompts, finish) => {
        finish([PASSWORD]);
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: HOST,
        port: PORT,
        username: USERNAME,
        password: PASSWORD,
        tryKeyboard: true,
        readyTimeout: CONNECT_TIMEOUT_MS,
      });

    client = conn;
  });
}

/** @brief 裸转发模式（MobaXterm 式）：stdin raw，逐字节透传，回传原样打印 */
function runRawMode(shellStream) {
  console.log(
    `[ssh] 裸转发模式已就绪：输入逐字节透传（Backspace/Ctrl+C/回车由远端 PTY 处理）；输入 \`${EXIT_CMD}\` 回车退出`
  );
  process.stdin.setRawMode(true);
  startRawForward(shellStream, process.stdin, () => shutdown(EXIT_CMD));
}

/** @brief 非 TTY 监听：管道输入按行转发，输入 exit 关闭 */
function runPipeMode(shellStream) {
  console.warn(`[ssh] 非 TTY 环境，禁用交互，仅打印远端回传数据；管道输入 \`${EXIT_CMD}\` 关闭`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === EXIT_CMD) {
      rl.close();
      return;
    }
    shellStream.write(line + "\n");
  });
  rl.on("close", () => shutdown(EXIT_CMD));
}

async function main() {
  console.log(`[ssh] connecting ${USERNAME}@${HOST}:${PORT} ...`);

  // 1. 建立连接与 PTY shell
  const shellStream = await openShell();
  console.log(`[ssh] connected: ${USERNAME}@${HOST}:${PORT}`);

  // 2. 远端回传实时打印（PTY 场景原样输出）
  shellStream.on("data", (data) => process.stdout.write(data));
  shellStream.stderr.on("data", (data) => process.stderr.write(data));

  // 3. 终端尺寸变化时同步远端 PTY（窗口大小一致才能正确渲染全屏程序）
  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      stream?.setWindow(process.stdout.rows ?? 24, process.stdout.columns ?? 80, 0, 0);
    });
  }

  // 4. 错误/意外关闭处理（主动退出走 shutdown，不进这里）
  shellStream.on("error", (err) => {
    console.error(`\n[ssh] 流错误: ${err.message}`);
  });
  shellStream.on("close", () => {
    if (closing) {
      console.log(`[ssh] 会话已关闭`);
      return;
    }
    console.error(`\n[ssh] 远端已关闭会话`);
    restoreTty();
    process.exit(1);
  });

  // 5. 启动输入通道
  if (INTERACTIVE) {
    runRawMode(shellStream);
  } else {
    runPipeMode(shellStream);
  }
}

// 直接运行时启动终端；被 import 时不自动执行（便于复用/单测）
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? process.argv[1].toLowerCase() === self.toLowerCase()
    : process.argv[1] === self;
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[ssh] 错误: ${err.message}`);
    restoreTty();
    process.exit(1);
  });
}
