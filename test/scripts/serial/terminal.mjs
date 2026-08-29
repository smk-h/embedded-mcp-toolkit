/**
 * =====================================================
 * 串口交互式终端（类似 MobaXterm / minicom）
 *
 *   打开串口后持续交互：命令行输入发送到串口，
 *   串口回传的数据实时显示在终端。
 *
 *   用法：
 *     node test/scripts/serial/terminal.mjs                      # 默认 COM3 @ 115200
 *     node test/scripts/serial/terminal.mjs COM5 921600          # 指定串口 + 波特率
 *     node test/scripts/serial/terminal.mjs COM5 921600 --line   # 指定串口 + 波特率 + 行模式
 *     node test/scripts/serial/terminal.mjs tcp://127.0.0.1:4444 # QEMU 虚拟板卡（npm run qemu）
 *
 *   TCP 虚拟板卡（tcp://host:port）：
 *     - 连接 QEMU `-serial tcp:...` 的监听端口（或其他串口服务器），
 *       交互体验与物理串口一致
 *     - 波特率参数被忽略（TCP 无物理层）
 *     - 同一端点同一时刻仅允许一个客户端（与真实串口独占一致）
 *
 *   裸转发模式（默认，TTY 下自动启用，行为对齐 MobaXterm）：
 *     - 键盘输入逐字节原样转发：Backspace / Ctrl+C / 回车都交给设备端行编辑处理，
 *       串口回传原样打印（保留 \r），所见即设备真实状态
 *     - 输入 `exit` 回车退出（退出前补发 Ctrl+U 清除设备端残留的半行输入）
 *
 *   行模式（--line）：
 *     - 本地 readline 编辑整行，回车后整行发送（自动追加换行符）
 *     - 按 Ctrl+C 直接把中断字节(0x03) 转发到串口，便于打断设备当前输出（类似 MobaXterm）
 *     - 输入 `exit` 退出
 *
 *   非 TTY 环境：禁用交互，仅监听打印串口回传数据（管道输入 `exit` 关闭）
 * ======================================================
 */

import { Socket } from "net";

import { SerialPort } from "serialport";
import { createInterface } from "readline";
import { isatty } from "tty";
import { fileURLToPath } from "url";

import { parseTcpEndpoint } from "../../../out/sdk/transports/serial.js";

/** @brief 回车/换行/退格等控制字节 */
const CR = 0x0d;
const LF = 0x0a;
const BS = 0x08;
const DEL = 0x7f;
const ETX = 0x03; // Ctrl+C
const VKILL = 0x15; // Ctrl+U 清行

/** @brief TCP 连接建立超时（毫秒），防止黑洞地址挂死 */
const TCP_CONNECT_TIMEOUT_MS = 5000;

/** @brief 命令行参数（剔除 --line 选项后） */
const args = process.argv.slice(2).filter((a) => a !== "--line");

/** @brief 默认串口路径（支持 tcp://host:port 形式的虚拟板卡端点） */
const PORT = args[0] ?? "COM3";

/** @brief 默认波特率（TCP 端点忽略） */
const BAUD_RATE = Number(args[1] ?? 115200);

/** @brief 是否为 TCP 虚拟板卡端点 */
const IS_TCP = PORT.startsWith("tcp://");

/** @brief 退出命令 */
const EXIT_CMD = "exit";

/** @brief 行模式下发送到串口的行结束符 */
const LINE_ENDING = "\n";

/** @brief 行模式开关（--line）；TTY 下默认走 MobaXterm 式裸转发 */
const LINE_MODE = process.argv.includes("--line");

/** @brief 交互式终端是否可用（仅在 TTY 下启用交互） */
const INTERACTIVE = isatty(0) && isatty(1);

/** @brief 裸转发模式：stdin 逐字节透传、串口回传原样打印（对齐 MobaXterm） */
const RAW_MODE = INTERACTIVE && !LINE_MODE;

/** @brief 退出流程是否已启动（防止主动退出与串口 close 事件重复处理） */
let closing = false;

/**
 * @brief 根据透传到设备的字节，推算设备侧的当前输入行
 *
 * 裸转发模式下键盘输入原样透传，退出命令 `exit` 只能在本地识别：
 * 用该函数维护"设备视角的当前行"，回车时若恰为 exit 则本地退出。
 * 推算只求不漏判/不误判 exit，Tab/方向键/UTF-8 等字节一律标记脏行。
 *
 * @param line  当前推算行
 * @param byte  即将透传的字节
 * @return 推算出的新行
 */
export function nextDevLine(line, byte) {
  if (byte === BS || byte === DEL) return line.slice(0, -1); // 退格：设备删一个字符
  if (byte === ETX || byte === VKILL) return ""; // Ctrl+C / Ctrl+U：设备清行
  if (byte >= 0x20 && byte <= 0x7e) return line + String.fromCharCode(byte); // ASCII 可打印
  return line + "\u0000"; // 其余字节（Tab/方向键/UTF-8 等）：标记脏行，保证不会误判为 exit
}

/**
 * @brief 裸转发核心：把输入字节流原样透传到串口，并在本地识别 exit 回车
 *
 * CRLF（多见于粘贴）只转发 CR，避免 CR 提交后再被 LF 提交一个空行。
 *
 * @param port          串口对象（只需 write 方法，便于单测注入假串口）
 * @param input         输入流（默认 process.stdin，便于单测注入假输入）
 * @param onExitRequest 命中 exit 回车时的本地退出回调（该回车字节不透传）
 * @return input 的 data 监听器（便于单测解绑）
 */
export function startRawForward(port, input, onExitRequest) {
  let devLine = "";
  let prevByte = 0;

  const listener = (chunk) => {
    const out = Buffer.alloc(chunk.length);
    let len = 0;
    for (const byte of chunk) {
      if (byte === LF && prevByte === CR) {
        prevByte = byte;
        continue; // CR 后紧跟的 LF 不透传（CR 已提交，再发 LF 会多提交一个空行）
      }
      if ((byte === CR || byte === LF) && devLine === EXIT_CMD) {
        port.write(out.subarray(0, len)); // 先把 exit 之前的字节发完
        onExitRequest();
        return;
      }
      out[len++] = byte;
      prevByte = byte;
      devLine = byte === CR || byte === LF ? "" : nextDevLine(devLine, byte);
    }
    port.write(out.subarray(0, len));
  };

  input.on("data", listener);
  return listener;
}

/**
 * @brief 打开 TCP 串口通道（QEMU `-serial tcp:...` 等虚拟板卡）
 *
 * 返回与 SerialPort 同构的读写面（write / on / close / drain），
 * 让主流程不感知通道差异。close 采用 end + destroy：串口服务端（QEMU）
 * 收到 FIN 不会回 FIN（串口无挂断语义），仅 end 会停在本端 FIN_WAIT_2。
 *
 * @param endpoint tcp://host:port 端点字符串
 */
function openTcp(endpoint) {
  return new Promise((resolve, reject) => {
    const { host, tcpPort } = parseTcpEndpoint(endpoint);
    const socket = new Socket();
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`TCP 连接超时: ${host}:${tcpPort}（${TCP_CONNECT_TIMEOUT_MS}ms）`));
    }, TCP_CONNECT_TIMEOUT_MS);
    const onError = (err) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    socket.once("error", onError);
    socket.connect({ host, port: tcpPort }, () => {
      cleanup();
      resolve({
        write: (data, cb) => socket.write(data, cb),
        drain: (cb) => cb?.(),
        on: (event, cb) => socket.on(event, cb),
        close: (cb) =>
          socket.end(() => {
            socket.destroy();
            cb?.();
          }),
      });
    });
  });
}

/** @brief 恢复终端状态（退出后不能把用户的 shell 留在 raw 模式） */
function restoreTty() {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
}

/** @brief 退出流程：恢复终端、清除设备端残留行、关闭串口 */
async function shutdown(port) {
  if (closing) return;
  closing = true;
  console.log(`\n[serial] 正在关闭...`);
  restoreTty();
  if (RAW_MODE) {
    // exit 逐字透传时已到达设备，补发 Ctrl+U 清掉设备端残留的半行，下次连接干净
    await new Promise((resolve) => {
      port.write(Buffer.from([VKILL]), () => port.drain(() => resolve()));
    });
  }
  await new Promise((resolve) => port.close(() => resolve()));
  process.exit(0);
}

/** @brief 裸转发模式（MobaXterm 式）：stdin raw，逐字节透传，回传原样打印 */
function runRawMode(port) {
  console.log(`[serial] 裸转发模式已就绪：输入逐字节透传（Backspace/Ctrl+C/回车由设备处理）；输入 \`${EXIT_CMD}\` 回车退出`);
  process.stdin.setRawMode(true);
  startRawForward(port, process.stdin, () => void shutdown(port));
}

/** @brief 行模式（--line）与非 TTY 监听：本地 readline 整行编辑后发送 */
function runLineMode(port) {
  if (!INTERACTIVE) {
    console.warn(`[serial] 非 TTY 环境，禁用 readline 交互，仅打印串口回传数据`);
  } else {
    console.log(`[serial] 行模式已就绪，输入一行回车发送到串口；按 Ctrl+C 直接转发到串口；输入 \`${EXIT_CMD}\` 退出`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === EXIT_CMD) {
      rl.close();
      return;
    }
    if (line.trim()) {
      port.write(line + LINE_ENDING);
    }
  });

  // Ctrl+C: 直接转发中断字节(0x03) 到串口，而不是退出进程（类似 MobaXterm）
  rl.on("SIGINT", () => {
    const intByte = Buffer.from([ETX]);
    process.stdout.write("\n[TX] ^C\n");
    port.write(intByte);
  });

  rl.on("close", () => void shutdown(port));
}

async function main() {
  if (IS_TCP) {
    console.log(`[serial] opening TCP endpoint ${PORT} ...`);
  } else {
    console.log(`[serial] opening ${PORT} @ ${BAUD_RATE} ...`);
  }

  // 1. 打开串口（tcp:// 前缀走 TCP 虚拟板卡，否则走物理串口）
  let port;
  if (IS_TCP) {
    port = await openTcp(PORT);
  } else {
    port = new SerialPort({
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
  }
  console.log(IS_TCP ? `[serial] opened: ${PORT}（TCP 虚拟板卡）` : `[serial] opened: ${PORT} @ ${BAUD_RATE}`);

  // 2. 接收串口数据，实时打印（裸转发原样输出，其余模式去 \r 防止 Windows 换行干扰显示）
  port.on("data", (data) => {
    if (RAW_MODE) {
      process.stdout.write(data);
    } else {
      process.stdout.write(data.toString("utf8").replace(/\r/g, ""));
    }
  });

  // 3. 错误/意外关闭处理（主动退出走 shutdown，不进这里）
  port.on("error", (err) => {
    console.error(`\n[serial] 串口错误: ${err.message}`);
  });
  port.on("close", () => {
    if (closing) {
      console.log(`[serial] 串口已关闭`);
      return;
    }
    console.error(`\n[serial] 串口已意外关闭`);
    restoreTty();
    process.exit(1);
  });

  // 4. 启动输入通道
  if (RAW_MODE) {
    runRawMode(port);
  } else {
    runLineMode(port);
  }
}

// 直接运行时启动终端；被 import 时不自动执行（便于对纯函数做单测）
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? process.argv[1].toLowerCase() === self.toLowerCase()
    : process.argv[1] === self;
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[serial] 错误: ${err.message}`);
    process.exit(1);
  });
}
