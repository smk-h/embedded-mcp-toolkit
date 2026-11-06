/**
 * =====================================================
 * 模拟串口设备（TCP 假设备，无需真实板卡）
 *
 *   在本地监听一个 TCP 端口，扮演"插着串口线的 Linux 板卡"：
 *   回显键入字符、打印提示符、响应常用命令，并按 exec-runner
 *   的 marker 约定回写退出码。toolkit 侧通过设备配置的
 *   serial.port = "tcp://127.0.0.1:4444" 以 TCP 客户端接入，
 *   会话判定、提示符检测、日志落盘与真实串口完全一致。
 *
 *   两种启动形态：
 *     node test/scripts/serial/fake-device.mjs                # 已登录 shell，提示符 ~ #
 *     node test/scripts/serial/fake-device.mjs --login         # getty 登录流程（root/root）
 *
 *   可测能力：
 *     - serial_open / serial_close：连接、banner、同端点防重
 *     - serial_shell_login：无 PSH 判定（默认）/ 账号密码登录（--login）
 *     - serial_exec：marker 检测 + 退出码、提示符兜底、echo 剥离
 *     - serial_read / serial_write / serial_send_ctrl
 *     - 常驻命令：top 持续刷屏，直到 Ctrl+C（验证采样超时）
 *     - 复位：reboot 打印内核启动日志（验证启动早退/日志留存）
 *
 *   参数：
 *     --port <n>     监听端口，默认 4444
 *     --host <ip>    监听地址，默认 127.0.0.1
 *     --login        以 login: 提示符启动，模拟 getty 账号登录
 *     --prompt <s>   自定义 shell 提示符，默认 "~ # "
 * ======================================================
 */

import net from "node:net";

// ── 参数解析 ────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { port: 4444, host: "127.0.0.1", login: false, prompt: "~ # " };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--host") opts.host = argv[++i];
    else if (arg === "--login") opts.login = true;
    else if (arg === "--prompt") opts.prompt = argv[++i];
    else if (/^\d+$/.test(arg)) opts.port = Number(arg);
  }
  return opts;
}

const OPT = parseArgs(process.argv.slice(2));

const BANNER = "Welcome to Alpine Linux 3.20 (fake serial device)";

/** 用户名/密码（与 .embedded/configs/devices/fake-serial.yaml 保持一致） */
const CREDENTIAL = { username: "root", password: "root" };

/** 内置命令表：key 为完整命令行 */
const BUILTINS = {
  "uname -a": "Linux fake-board 6.6.0-fake #1 SMP PREEMPT aarch64 GNU/Linux",
  "uname -r": "6.6.0-fake",
  ls: "bin  dev  etc  home  proc  root  sys  tmp  usr",
  "ls /": "bin  dev  etc  home  proc  root  sys  tmp  usr",
  pwd: "/root",
  whoami: "root",
  id: "uid=0(root) gid=0(root)",
  date: new Date().toString(),
  uptime: " 09:57:49 up 1 day,  2:03,  load average: 0.00, 0.01, 0.05",
  free: "              total        used        free\nMem:         524288      102400      421888",
  ps: "  PID USER       VSZ STAT COMMAND\n    1 root      1580 S    /sbin/init\n   42 root      2412 S    -sh",
  "cat /proc/cpuinfo":
    "processor\t: 0\nBogoMIPS\t: 125.00\nFeatures\t: fp asimd evtstrm\nCPU implementer\t: 0x41\nCPU architecture: 8",
  "cat /proc/meminfo": "MemTotal:         524288 kB\nMemFree:          421888 kB",
  "ip addr": "1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo",
};

/** reboot 时打印的"内核启动"日志（用于验证启动早退与原始日志留存） */
const BOOT_LOG = [
  "[   12.345678] reboot: Restarting system",
  "[    0.000000] Booting Linux on physical CPU 0x0",
  "[    0.000000] Linux version 6.6.0-fake (fake@build) #1 SMP aarch64",
  "[    0.512000] Run /sbin/init as init process",
];

// ── 命令执行 ────────────────────────────────────────────────

/**
 * @brief 执行一条命令并返回待回显文本
 *
 * @param {string} cmd   命令原文（已剥掉 exec marker 包装）
 * @param {object} conn  连接上下文（含 top 定时器等）
 * @returns {Promise<string>} 输出文本（换行用 \n，发送时统一转 \r\n）
 */
async function execCommand(cmd, conn) {
  const line = cmd.trim();
  if (!line) return "";

  // echo：剥离首尾引号，支持 echo "x"
  if (/^echo\s+/.test(line)) {
    return line.slice(5).replace(/^["']|["']$/g, "");
  }

  // 常驻命令：持续刷屏，直到客户端发 Ctrl+C（验证采样超时与强停）
  if (/^top\b/.test(line)) {
    if (conn.topTimer) return "top: already running";
    let tick = 0;
    conn.topTimer = setInterval(() => {
      tick++;
      conn.socket.write(
        `\r\nMem: 524288K used 102400K free 421888K   tick=${tick}`
      );
    }, 500);
    return "top - 09:57:49 up 1 day,  load average: 0.00, 0.01, 0.05";
  }

  // sleep N：真实等待，便于验证长命令不提前返回
  if (/^sleep\s+\d+/.test(line)) {
    const sec = Number(line.split(/\s+/)[1]);
    await new Promise((r) => setTimeout(r, sec * 1000));
    return "";
  }

  // reboot：先打复位行，再打内核启动日志（shell 视角等同于"设备重启中"）
  if (line === "reboot" || line === "reset") {
    return BOOT_LOG.join("\n");
  }

  if (line === "exit" || line === "logout") return "logout";

  return BUILTINS[line] ?? `sh: ${line}: not found`;
}

/**
 * @brief 从 exec-runner 注入的完整命令行中拆出业务命令与 marker
 *
 * 注入形态：subshell → `(cmd); echo "MARKER:$?"`；plain → `cmd; echo "MARKER:$?"`
 *
 * @param {string} raw 收到的整行
 * @returns {{marker: string|null, cmd: string}}
 */
function splitMarker(raw) {
  const marker = /___MCP_EXEC_DONE_[a-z0-9]+___/.exec(raw)?.[0] ?? null;
  if (!marker) return { marker: null, cmd: raw.trim() };

  let cmd = raw
    .replace(new RegExp(`;\\s*echo\\s+"?${marker}:\\$\\?"?\\s*$`), "")
    .trim();
  if (cmd.startsWith("(") && cmd.endsWith(")")) cmd = cmd.slice(1, -1);
  return { marker, cmd: cmd.trim() };
}

// ── 连接处理 ────────────────────────────────────────────────

/** 启动一条连接的状态机 */
function handleConnection(socket) {
  /** 当前输入行 */
  let line = "";
  /** 登录阶段：user → 等用户名；pass → 等密码；shell → 已登录 */
  let phase = OPT.login ? "user" : "shell";
  /** 连接上下文：top 等常驻命令的定时器、被扣住待回写的 marker */
  const conn = { socket, topTimer: null, pendingMarker: null };

  const write = (text) => socket.write(text.replace(/\n/g, "\r\n"));
  const prompt = () => {
    if (phase === "user") socket.write("fake-board login: ");
    else if (phase === "pass") socket.write("Password: ");
    else socket.write(OPT.prompt);
  };

  if (OPT.login) {
    socket.write("\r\nfake-board login: ");
  } else {
    write(`\r\n${BANNER}\r\n`);
    socket.write(OPT.prompt);
  }

  /** 中断常驻命令（Ctrl+C） */
  function interrupt() {
    if (conn.topTimer) {
      clearInterval(conn.topTimer);
      conn.topTimer = null;
    }
  }

  socket.on("data", async (chunk) => {
    for (const ch of chunk.toString()) {
      // 回车：执行当前行
      if (ch === "\n") {
        socket.write("\r\n");
        const raw = line;
        line = "";

        // 登录阶段：按顺序收用户名/密码，不做任何命令解析
        if (phase === "user") {
          if (raw.trim() === CREDENTIAL.username) {
            phase = "pass";
          } else {
            write("Login incorrect");
            phase = "user";
          }
          prompt();
          continue;
        }
        if (phase === "pass") {
          if (raw.trim() === CREDENTIAL.password) {
            phase = "shell";
            write(`\r\n${BANNER}\r\n`);
          } else {
            write("Login incorrect");
            phase = "user";
          }
          prompt();
          continue;
        }

        const { marker, cmd } = splitMarker(raw);
        const out = await execCommand(cmd, conn);
        if (out) write(`${out}\r\n`);
        if (conn.topTimer) {
          // 常驻命令仍在跑：先扣住 marker，等 Ctrl+C 后再回写退出码，
          // 否则 marker 会让 exec 误判"命令已结束"，采样超时逻辑测不到
          if (marker) conn.pendingMarker = marker;
          continue;
        }
        if (marker) write(`${marker}:0`); // 普通命令退出码恒为 0
        prompt();
        continue;
      }

      if (ch === "\r") continue;

      // Ctrl+C：中断常驻命令并回到提示符
      if (ch === "\x03") {
        const wasRunning = conn.topTimer !== null;
        interrupt();
        write("^C");
        if (wasRunning) {
          // SIGINT 语义的退出码；回写被扣住的 marker 让 exec 立即返回
          if (conn.pendingMarker) {
            write(`${conn.pendingMarker}:130`);
            conn.pendingMarker = null;
          }
          prompt();
        }
        continue;
      }

      // Ctrl+U：清行
      if (ch === "\x15") {
        line = "";
        continue;
      }

      // 退格
      if (ch === "\x7f" || ch === "\b") {
        if (line) {
          line = line.slice(0, -1);
          socket.write("\b \b");
        }
        continue;
      }

      // 普通字符：入行并回显（PTY 回显语义）
      line += ch;
      socket.write(ch);
    }
  });

  socket.on("close", interrupt);
  socket.on("error", () => {});
}

// ── 启动 ────────────────────────────────────────────────────

const server = net.createServer(handleConnection);

// 端口占用时给出可操作的提示，而不是抛原始异常栈（常见于忘记关上一个假设备）
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[fake-serial] 端口 ${OPT.port} 已被占用：先关掉上一个假设备，或换端口 --port <n>`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(OPT.port, OPT.host, () => {
  console.error(
    `[fake-serial] listening on tcp://${OPT.host}:${OPT.port}` +
      ` (${OPT.login ? "getty login: root/root" : `prompt "${OPT.prompt}"`})`
  );
  console.error(
    `[fake-serial] toolkit 侧: serial_open({ port: "tcp://${OPT.host}:${OPT.port}" })`
  );
});
