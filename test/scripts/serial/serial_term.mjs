/**
 * =====================================================
 * 串口收发与 DTR/RTS 线序诊断工具
 *
 *   背景：
 *     XCOM 这类裸串口工具不会主动改变 DTR/RTS，而 PuTTY / MobaXterm
 *     打开端口时会把 DTR、RTS 置为有效。部分开发板（如 ATK 战舰 V3）
 *     的“一键下载”电路用 CH340 的 DTR、RTS 经三极管去控制 MCU 的
 *     RESET 与 BOOT0，一旦被置位，MCU 可能被按在复位或进入 ROM ISP
 *     模式，表现为“接收端什么都收不到，也发不出去”。
 *     本工具允许显式指定 DTR/RTS 的最终电平，并用 --diagnose 自动遍历
 *     四种组合，实测出哪种线序下板子能正常说话。
 *
 *   用法：
 *     node test/scripts/serial/serial_term.mjs --list
 *     node test/scripts/serial/serial_term.mjs -p COM4
 *     node test/scripts/serial/serial_term.mjs -p COM4 --dtr off --rts off # STM32这个可正常建立连接
 *     node test/scripts/serial/serial_term.mjs -p COM4 --diagnose
 *     node test/scripts/serial/serial_term.mjs -p COM4 --dtr off --rts off -s go -w 2
 *     node test/scripts/serial/serial_term.mjs -p COM4 -H -t -l recv.bin
 *
 *   运行后按 Ctrl+C 可优雅退出并关闭串口。
 * ======================================================
 */

import { createWriteStream } from "fs";
import { createInterface } from "readline";
import { SerialPort } from "serialport";

// ---------------------------------------------------------------- 默认与映射表
const DEFAULT_BAUD = 115200;
const DIAGNOSE_DWELL_MS = 1500; // 诊断时每种线序的监听时长
const DIAGNOSE_SETTLE_MS = 200; // 切换线序后的电平稳定时间

const EOL_TABLE = {
  none: "",
  lf: "\n",
  cr: "\r",
  crlf: "\r\n",
};

const PARITY_TABLE = {
  N: "none",
  E: "even",
  O: "odd",
  M: "mark",
  S: "space",
};

const STOP_TABLE = {
  1: 1,
  1.5: 1.5,
  2: 2,
};

const OPTION_SPEC = {
  "--list": { key: "list", type: "bool" },
  "-h": { key: "help", type: "bool" },
  "--help": { key: "help", type: "bool" },
  "-p": { key: "port", type: "string" },
  "--port": { key: "port", type: "string" },
  "-b": { key: "baud", type: "number" },
  "--baud": { key: "baud", type: "number" },
  "--data-bits": { key: "dataBits", type: "choice", values: ["5", "6", "7", "8"] },
  "--stop-bits": { key: "stopBits", type: "choice", values: ["1", "1.5", "2"] },
  "--parity": { key: "parity", type: "choice", values: ["N", "E", "O", "M", "S"] },
  "--flow": { key: "flow", type: "choice", values: ["none", "rtscts", "xonxoff"] },
  "--dtr": { key: "dtr", type: "choice", values: ["on", "off", "keep"] },
  "--rts": { key: "rts", type: "choice", values: ["on", "off", "keep"] },
  "--diagnose": { key: "diagnose", type: "bool" },
  "-s": { key: "send", type: "string" },
  "--send": { key: "send", type: "string" },
  "-w": { key: "wait", type: "number" },
  "--wait": { key: "wait", type: "number" },
  "--eol": { key: "eol", type: "choice", values: ["none", "lf", "cr", "crlf"] },
  "-H": { key: "hex", type: "bool" },
  "--hex": { key: "hex", type: "bool" },
  "-t": { key: "timestamp", type: "bool" },
  "--timestamp": { key: "timestamp", type: "bool" },
  "-l": { key: "log", type: "string" },
  "--log": { key: "log", type: "string" },
  "--watch": { key: "watch", type: "bool" },
};

const DEFAULTS = {
  list: false,
  help: false,
  port: null,
  baud: DEFAULT_BAUD,
  dataBits: "8",
  stopBits: "1",
  parity: "N",
  flow: "none",
  dtr: "keep",
  rts: "keep",
  diagnose: false,
  send: null,
  wait: 1.0,
  eol: "crlf",
  hex: false,
  timestamp: false,
  log: null,
  watch: false,
};

// ---------------------------------------------------------------- 通用小工具
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 清空串口收发缓冲；兼容 flush 的回调式与 Promise 式两种签名 */
function flushPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const ret = port.flush(finish);
      if (ret && typeof ret.then === "function") {
        ret.then(finish, finish);
      }
    } catch {
      finish();
    }
    setTimeout(finish, 500);
  });
}

/** 把一段字节格式化成带偏移与 ASCII 栏的十六进制行 */
function hexLines(data, width = 16) {
  const lines = [];
  for (let off = 0; off < data.length; off += width) {
    const chunk = data.subarray(off, off + width);
    const hexs = Array.from(chunk, (b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ")
      .padEnd(width * 3 - 1, " ");
    const text = Array.from(chunk, (b) =>
      b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".",
    ).join("");
    lines.push(`${off.toString(16).toUpperCase().padStart(4, "0")}  ${hexs}  |${text}|`);
  }
  return lines;
}

/** 给诊断结果做一段可读的预览：基本可打印就按文本，否则按十六进制 */
function preview(data, limit = 48) {
  if (data.length === 0) {
    return "无数据";
  }
  const head = data.subarray(0, limit);
  const printable = Array.from(head).filter(
    (b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d,
  ).length;
  let text;
  if (printable >= head.length * 0.9) {
    text = head.toString("ascii").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  } else {
    text = Array.from(head, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  }
  const suffix = data.length > limit ? " ..." : "";
  return `${data.length} 字节: ${text}${suffix}`;
}

/** 解析命令行参数；支持 `--key value` 与 `--key=value` 两种写法 */
function parseArgv(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    let inlineValue = null;

    if (token.startsWith("--") && token.includes("=")) {
      const idx = token.indexOf("=");
      inlineValue = token.slice(idx + 1);
      token = token.slice(0, idx);
    }

    const spec = OPTION_SPEC[token];
    if (!spec) {
      throw new Error(`未知参数: ${token}`);
    }
    if (spec.type === "bool") {
      if (inlineValue !== null) {
        throw new Error(`${token} 不接受取值`);
      }
      opts[spec.key] = true;
      continue;
    }

    const value = inlineValue !== null ? inlineValue : argv[i + 1];
    if (value === undefined) {
      throw new Error(`${token} 缺少取值`);
    }
    if (inlineValue === null) {
      i += 1;
    }

    if (spec.type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`${token} 需要一个数字, 收到: ${value}`);
      }
      opts[spec.key] = num;
    } else if (spec.type === "choice") {
      if (!spec.values.includes(value)) {
        throw new Error(`${token} 只接受 ${spec.values.join(" / ")}, 收到: ${value}`);
      }
      opts[spec.key] = value;
    } else {
      opts[spec.key] = value;
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 显示输出
class Output {
  constructor(hexMode, timestamp, logPath) {
    this.hexMode = hexMode;
    this.timestamp = timestamp;
    this.buf = "";
    this.log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  }

  stamp() {
    if (!this.timestamp) {
      return "";
    }
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `[${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${ms}] `;
  }

  feed(data) {
    if (this.log) {
      this.log.write(data);
    }
    if (this.hexMode) {
      for (const line of hexLines(data)) {
        process.stdout.write(this.stamp() + line + "\n");
      }
    } else {
      this.buf += data.toString("utf8");
      let idx = this.buf.indexOf("\n");
      while (idx !== -1) {
        const line = this.buf.slice(0, idx).replace(/\r$/, "");
        this.buf = this.buf.slice(idx + 1);
        process.stdout.write(this.stamp() + line + "\n");
        idx = this.buf.indexOf("\n");
      }
    }
  }

  /** 把没有换行结尾的残留缓冲显示出来 */
  flush() {
    if (this.buf) {
      process.stdout.write(this.stamp() + this.buf + "\n");
      this.buf = "";
    }
  }

  close() {
    this.flush();
    if (this.log) {
      this.log.end();
      this.log = null;
    }
  }
}

// ---------------------------------------------------------------- 串口操作
/** 按 on/off/keep 设置 DTR、RTS；keep 表示保持驱动默认状态不动 */
function setLines(port, dtr, rts) {
  return new Promise((resolve, reject) => {
    const options = {};
    if (dtr !== "keep") {
      options.dtr = dtr === "on";
    }
    if (rts !== "keep") {
      options.rts = rts === "on";
    }
    if (Object.keys(options).length === 0) {
      resolve();
      return;
    }
    port.set(options, (err) => (err ? reject(err) : resolve()));
  });
}

/** 从系统串口列表里找出设备的友好描述 */
async function describePort(device) {
  try {
    const ports = await SerialPort.list();
    const hit = ports.find((p) => p.path.toUpperCase() === device.toUpperCase());
    if (!hit) {
      return "";
    }
    return hit.friendlyName || hit.manufacturer || "";
  } catch {
    return "";
  }
}

async function listSerialPorts() {
  const ports = await SerialPort.list();
  ports.sort((a, b) => a.path.localeCompare(b.path));
  if (ports.length === 0) {
    console.log("未发现任何串口");
    return 1;
  }
  console.log(`发现 ${ports.length} 个串口:`);
  for (const info of ports) {
    const desc = info.friendlyName || info.manufacturer || "";
    console.log(`  ${info.path.padEnd(8, " ")} ${desc}`);
    const detail = [info.vendorId, info.productId].filter(Boolean).join(":");
    if (detail) {
      console.log(`  ${"".padEnd(8, " ")} VID:PID=${detail}`);
    }
  }
  return 0;
}

async function openPort(opts) {
  const port = new SerialPort({
    path: opts.port,
    baudRate: opts.baud,
    dataBits: Number(opts.dataBits),
    stopBits: STOP_TABLE[opts.stopBits],
    parity: PARITY_TABLE[opts.parity],
    rtscts: opts.flow === "rtscts",
    xon: opts.flow === "xonxoff",
    xoff: opts.flow === "xonxoff",
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  await setLines(port, opts.dtr, opts.rts);

  const desc = await describePort(opts.port);
  console.log(`端口      : ${opts.port}${desc ? `  (${desc})` : ""}`);
  console.log(
    `参数      : ${opts.baud} ${opts.dataBits}${opts.parity}${opts.stopBits}, ` +
    `流控 ${opts.flow}`,
  );
  console.log(`DTR/RTS   : ${opts.dtr} / ${opts.rts}`);
  return port;
}

// ---------------------------------------------------------------- 运行模式
/** 遍历 DTR/RTS 的四种组合，报告每种能收到多少字节 */
async function runDiagnose(port) {
  const combos = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];
  console.log(`开始遍历 DTR/RTS 组合, 每种监听 ${(DIAGNOSE_DWELL_MS / 1000).toFixed(1)} 秒 ...`);
  console.log();

  let best = null;
  let chunks = [];
  const collect = (data) => chunks.push(data);
  port.on("data", collect);

  try {
    for (const [dtr, rts] of combos) {
      await setLines(port, dtr ? "on" : "off", rts ? "on" : "off");
      await flushPort(port);
      await sleep(DIAGNOSE_SETTLE_MS);
      chunks = [];
      await sleep(DIAGNOSE_DWELL_MS);

      const buf = Buffer.concat(chunks);
      const label = `DTR=${dtr ? "on " : "off"} RTS=${rts ? "on " : "off"}`;
      console.log(`  ${label}  ->  ${preview(buf)}`);
      if (buf.length > 0 && (best === null || buf.length > best.size)) {
        best = { dtr, rts, size: buf.length };
      }
    }
  } finally {
    port.off("data", collect);
  }

  console.log();
  if (best === null) {
    console.log("四种组合都没有收到任何数据:");
    console.log("  * 确认波特率、TX/RX 接线与板子是否已上电、已跑起程序");
    console.log("  * 确认没有其它程序(如 XCOM)占用同一个 COM 口");
    return 1;
  }

  console.log(`推荐线序: --dtr ${best.dtr ? "on" : "off"} --rts ${best.rts ? "on" : "off"}`);
  console.log("若推荐值正是 off/off, 就说明另外三种会把板子拉进复位/ISP, 这也解释了");
  console.log("MobaXterm 收不到数据的原因。");
  return 0;
}

/** 发送一条命令，收集指定时长内的响应后退出 */
async function runOneShot(port, output, text, waitS, eol) {
  port.on("data", (data) => output.feed(data));
  await new Promise((resolve, reject) => {
    port.write(Buffer.from(text + eol, "utf8"), (err) => (err ? reject(err) : resolve()));
  });
  console.log(`[发送] ${text}`);

  const deadline = Date.now() + waitS * 1000;
  while (Date.now() < deadline) {
    await sleep(20);
  }
  output.flush();
  return 0;
}

/** 交互式终端（interactive=true）或纯监听（interactive=false） */
function runStream(port, output, interactive, eol) {
  port.on("data", (data) => output.feed(data));

  if (!interactive) {
    console.log("只读模式(不回显键盘), Ctrl+C 退出。");
    console.log();
    return;
  }

  console.log("已连接, 输入内容后回车发送; Ctrl+C 退出。");
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const text = line.replace(/\r?\n$/, "");
    port.write(Buffer.from(text + eol, "utf8"));
    if (text) {
      console.log(`[发送] ${text}`);
    }
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

// ---------------------------------------------------------------- 入口
function printHelp() {
  console.log(`串口收发与 DTR/RTS 线序诊断工具

用法: node test/scripts/serial/serial_term.mjs [选项]

选项:
  --list                列出可用串口后退出
  -p, --port PORT       串口设备名, 如 COM4 或 /dev/ttyUSB0
  -b, --baud BAUD       波特率(默认 ${DEFAULT_BAUD})
  --data-bits {5,6,7,8} 数据位(默认 8)
  --stop-bits {1,1.5,2} 停止位(默认 1)
  --parity {N,E,O,M,S}  校验位(默认 N)
  --flow {none,rtscts,xonxoff}
                        流控(默认 none)
  --dtr {on,off,keep}   打开端口后 DTR 的最终电平; keep 表示不改变(默认)
  --rts {on,off,keep}   打开端口后 RTS 的最终电平; keep 表示不改变(默认)
  --diagnose            遍历 DTR/RTS 四种组合, 找出能收到数据的线序
  -s, --send TEXT       发送一条命令, 收集响应后退出(配合 -w)
  -w, --wait SEC        一条命令发送后收集响应的秒数(默认 1.0)
  --eol {none,lf,cr,crlf}
                        发送时附加的换行符(默认 crlf)
  -H, --hex             十六进制显示接收数据
  -t, --timestamp       每行加时间戳
  -l, --log FILE        把收到的原始字节追加写入文件
  --watch               只监听不读键盘(适合纯记录)
  -h, --help            显示本帮助

示例:
  node test/scripts/serial/serial_term.mjs --list
  node test/scripts/serial/serial_term.mjs -p COM4 --dtr off --rts off
  node test/scripts/serial/serial_term.mjs -p COM4 --diagnose
  node test/scripts/serial/serial_term.mjs -p COM4 --dtr off --rts off -s go -w 2`);
}

async function main() {
  let opts;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`[错误] ${err.message}`);
    console.error("        用 -h/--help 查看用法。");
    return 2;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.list) {
    return listSerialPorts();
  }
  if (!opts.port) {
    console.error("[错误] 需要 -p/--port 指定串口, 或使用 --list 查看可用串口");
    return 2;
  }
  if (opts.diagnose && opts.send !== null) {
    console.error("[错误] --diagnose 与 -s/--send 不能同时使用");
    return 2;
  }

  const output = new Output(opts.hex, opts.timestamp, opts.log);
  const eol = EOL_TABLE[opts.eol];

  let port;
  try {
    port = await openPort(opts);
  } catch (err) {
    console.error(`[错误] 打开 ${opts.port} 失败: ${err.message}`);
    console.error("        该口可能被其它程序(如 XCOM)占用, 或已被拔掉。");
    output.close();
    return 1;
  }

  let exitCode = 0;
  let done = false;
  const shutdown = async (code) => {
    if (done) {
      return code;
    }
    done = true;
    exitCode = code;
    try {
      await new Promise((resolve) => port.close(() => resolve()));
    } catch {
      // 端口可能已异常断开, 忽略
    }
    output.close();
    process.exit(code);
  };

  process.on("SIGINT", () => {
    process.stdout.write("\n");
    shutdown(exitCode);
  });
  port.on("error", (err) => {
    console.error(`\n[错误] 串口异常: ${err.message}`);
    shutdown(1);
  });

  try {
    if (opts.diagnose) {
      return await shutdown(await runDiagnose(port));
    }
    if (opts.send !== null) {
      return await shutdown(await runOneShot(port, output, opts.send, opts.wait, eol));
    }
    runStream(port, output, !opts.watch, eol);
    return undefined; // 交互模式由 SIGINT / stdin 结束驱动退出
  } catch (err) {
    console.error(`[错误] ${err.message}`);
    return await shutdown(1);
  }
}

main()
  .then((code) => {
    if (code !== undefined) {
      process.exitCode = code;
    }
  })
  .catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
