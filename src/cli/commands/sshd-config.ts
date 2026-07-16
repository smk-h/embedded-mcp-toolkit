/**
 * @file src/cli/commands/sshd-config.ts
 * @brief embedded-mcp-toolkit sshd-config 命令
 *
 * 交互式引导完成"Windows 端 SSH 免密登录环境"搭建，用于让远端 Linux 编译服务器
 * 通过公钥免密登录 Windows 本地（MCP 服务所在机器）。
 *
 * 菜单功能：
 * [1] 一键完成全流程（安装→密钥→配置→模板）
 * [2] 安装 Windows OpenSSH Server（在线 / MSI 双途径）
 * [3] 登录 Linux 编译服务器，生成密钥对，SFTP 拉取公钥到本地
 * [4] 配置 Windows sshd（写 authorized_keys、改 sshd_config、禁用 administrators 分组）
 * [5] 检查 sshd 配置状态（只读诊断）
 *
 * SSH 操作基于 ssh2 库在本文件内独立实现（sshConnect / sshExec / sshDownload /
 * sshDisconnect），不复用 src/transports/ssh.ts 的 SSHShell（后者绑定 MCP 会话注册、
 * PSH 解锁等业务机制，不适合一次性运维命令）。
 */

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  createWriteStream,
  unlinkSync,
} from "fs";
import { resolve, join, dirname } from "path";
import { homedir, userInfo, networkInterfaces } from "os";
import { createInterface } from "readline";
import { get as httpsGet } from "https";

import { Client, type ConnectConfig } from "ssh2";
import {
  select,
  isCancel,
  log,
  box,
  text,
  password,
  confirm,
} from "@clack/prompts";

// ============================================================
// 类型与常量
// ============================================================

/**
 * @brief sshd-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 *          本期无命令行选项，保留接口与与 init/split 一致；后续扩展时改为
 *          具名 interface 即可。
 */
export type SshdConfigOptions = Record<string, never>;

/**
 * @brief Linux 编译服务器连接信息（仅内存，不落盘）
 * @details 第 [3] 步交互式收集，用于 SSH 登录 Linux 生成密钥对。
 *          password 仅存在于进程内存，不写入日志或磁盘。
 */
interface LinuxServerInfo {
  host: string;
  port: number; // SSH 端口，默认 22
  username: string;
  password: string; // 仅内存，不落盘
}

/**
 * @brief 外部命令执行结果
 * @details 统一封装 PowerShell / msiexec 等外部命令的退出码与输出。
 */
interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * @brief OpenSSH 安装方式检测结果
 * @param method    安装方式枚举
 * @param methodLabel 给用户展示的中文标签
 * @param exePath   sshd.exe 的实际路径（已安装时），未找到为 null
 * @param detail    附加说明（如检测到但服务未注册等）
 */
interface OpenSshInstallInfo {
  method: OpenSshInstallMethod;
  methodLabel: string;
  exePath: string | null;
  detail: string;
}

/**
 * @brief OpenSSH 安装方式枚举
 * @details 通过三信号（Capability State / 服务 ImagePath / exe 路径探测）综合判定。
 */
type OpenSshInstallMethod = "msi" | "capability" | "unknown";

/** @brief Capability 安装方式下 sshd.exe 的标准路径（由 Windows 组件管理） */
const CAPABILITY_SSHD_EXE = "C:\\Windows\\System32\\OpenSSH\\sshd.exe";
/** @brief MSI 安装方式下 sshd.exe 的标准路径（由 MSI 安装器释放） */
const MSI_SSHD_EXE = "C:\\Program Files\\OpenSSH\\sshd.exe";

/** @brief 菜单选项：一键完成全流程（安装→密钥→配置→模板） */
const MENU_ONE_CLICK = "1";
/** @brief 菜单选项：安装 Windows SSH 服务 */
const MENU_INSTALL_SSH = "2";
/** @brief 菜单选项：编译服务器生成密钥对 */
const MENU_GENERATE_KEY = "3";
/** @brief 菜单选项：配置 Windows 中 sshd 服务 */
const MENU_CONFIG_SSHD = "4";
/** @brief 菜单选项：检查 sshd 配置状态（只读诊断） */
const MENU_CHECK_STATUS = "5";
/** @brief 菜单选项：卸载 Windows SSH 服务 */
const MENU_UNINSTALL_SSH = "6";
/** @brief 菜单选项：查看 Windows 连接信息（用户名/IP） */
const MENU_SHOW_INFO = "7";
/** @brief 菜单选项：生成 Linux 端 MCP 配置模板 */
const MENU_GEN_TEMPLATE = "8";
/** @brief 菜单选项：退出 */
const MENU_EXIT = "0";

/**
 * @brief 主菜单可选 value 联合类型
 * @details 复用 MENU_* 常量，供 clack select 泛型约束，确保 switch 分支穷举。
 */
type MenuChoice =
  | typeof MENU_ONE_CLICK
  | typeof MENU_INSTALL_SSH
  | typeof MENU_GENERATE_KEY
  | typeof MENU_CONFIG_SSHD
  | typeof MENU_CHECK_STATUS
  | typeof MENU_UNINSTALL_SSH
  | typeof MENU_SHOW_INFO
  | typeof MENU_GEN_TEMPLATE
  | typeof MENU_EXIT;

/** @brief OpenSSH Server 的 Windows Capability 名称（在线安装用） */
const OPENSSH_CAPABILITY_NAME = "OpenSSH.Server~~~~0.0.1.0";

/** @brief OpenSSH MSI 离线安装包下载地址（GitHub releases） */
const OPENSSH_MSI_URL =
  "https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi";

/** @brief sshd_config 文件路径（Windows OpenSSH 安装后的标准位置） */
const SSHD_CONFIG_PATH = "C:\\ProgramData\\ssh\\sshd_config";

/** @brief 公钥在本地的落地路径（相对 cwd），专用密钥名避免覆盖用户通用密钥 */
const LOCAL_PUBKEY_REL = ".embedded/ssh/id_mcp_server.pub";

/** @brief MSI 安装包在本地的缓存路径（相对 cwd），step1 下载、step5 卸载复用 */
const LOCAL_MSI_REL = ".embedded/ssh/OpenSSH-Win64.msi";

/** @brief Linux 端 .mcp.json 模板输出路径（相对 cwd），自动填充 IP/用户名/路径 */
const REMOTE_MCP_TEMPLATE_REL = ".embedded/ssh/mcp-remote-template.json";

/** @brief sshd.exe 候选路径（按优先级：MSI 安装目录 → Windows 自带目录） */
const SSHD_EXE_CANDIDATES = [MSI_SSHD_EXE, CAPABILITY_SSHD_EXE];

/** @brief 公钥行匹配正则（ssh-rsa / ssh-ed25519 / ecdsa- / sk- 开头） */
const PUBKEY_LINE_RE = /^\s*(ssh-rsa|ssh-ed25519|ecdsa-|sk-)/;

// ============================================================
// 平台与管理员权限
// ============================================================

/**
 * @brief 判断当前是否在 Windows 平台
 * @returns Windows 平台返回 true
 */
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * @brief 检测当前进程是否具备管理员权限
 * @details 优先用 `net session`（退出码 0 = 管理员），失败时回退到 PowerShell
 *          的 WindowsPrincipal.IsInRole 检测。两者皆失败返回 false。
 * @returns 具备管理员权限返回 true
 */
function isAdmin(): boolean {
  // 方式 1：net session 仅管理员可成功执行
  try {
    execFileSync("net", ["session"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    // 非管理员或 net 不可用，继续尝试 PowerShell
  }

  // 方式 2：PowerShell WindowsPrincipal 检测
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 10000 }
    );
    return out.trim() === "True";
  } catch {
    return false;
  }
}

/**
 * @brief 自动 UAC 提权重启当前命令
 * @details 用 PowerShell `Start-Process -Verb RunAs` 启动一个新的管理员权限进程
 *          来重新执行 sshd-config 子命令（弹 UAC 确认），本进程随即退出。
 *          - UAC 确认（用户点"是"）：新管理员窗口启动，本进程 exit(0)
 *          - UAC 拒绝或提权失败：提示需要管理员权限并 exit(1)
 *
 *          Windows 无纯原生原地提权（Linux sudo 式）；此方案零依赖、对所有
 *          Windows 可用，代价是开新窗口。本命令为交互式菜单，新窗口从头开始可接受。
 *
 * @throws 不会抛出——内部捕获所有异常，失败时直接 process.exit(1)
 */
function relaunchAsAdmin(): void {
  console.log("[run] 当前非管理员权限，正在请求提权（将弹出 UAC 确认窗口）...");

  // process.execPath = node.exe 全路径；process.argv[1] = cli.js 路径
  const nodeExe = process.execPath;
  const cliScript = process.argv[1];
  // Start-Process 的 -ArgumentList 用空格分隔，路径含空格需加引号
  const argsList = `"${cliScript}" sshd-config`;

  try {
    // Start-Process -Verb RunAs 触发 UAC；用户点"是"后返回，点"否"抛异常
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${nodeExe}' -ArgumentList '${argsList}' -Verb RunAs`,
      ],
      { stdio: "ignore", timeout: 60000 }
    );
    // 提权进程已启动（新窗口），本进程让位退出
    console.log("[info] 已启动管理员权限窗口，请在弹出的新窗口中继续操作");
    process.exit(0);
  } catch {
    // 用户拒绝 UAC 或其他失败
    console.error("[err] 需要管理员权限才能运行(UAC 被拒绝或提权失败)");
    console.error('     请以管理员身份手动运行，或在 UAC 弹窗中点击"是"');
    process.exit(1);
  }
}

// ============================================================
// 交互输入
// ============================================================

/**
 * @brief 同步询问用户输入（明文）
 * @details 基于 readline 的单次问答，问完即关闭 rl。与 init.ts 的 prompt 一致。
 * @param questionText 提示文本
 * @returns 用户输入的字符串（已 trim）
 */
function prompt(questionText: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * @brief 清空终端屏幕
 * @details 使用 ANSI 转义序列 \x1Bc（全屏重置）清屏并将光标移到左上角。
 *          非 TTY 环境（管道/重定向）跳过，避免向非终端输出写入控制字符。
 */
function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  }
}

/**
 * @brief step 执行完毕后的暂停等待
 * @details 提示"按 Enter 回到菜单，按 q 退出"，阻塞等待用户按键：
 *          - Enter（空输入）→ 返回 false，调用方清屏并重新显示菜单
 *          - q / Q          → 返回 true，调用方退出主循环
 *          - 其它输入       → 继续等待，不响应（避免误触退出）
 * @returns 用户是否选择退出（q → true，Enter → false）
 */
async function pauseForMenu(): Promise<boolean> {
  while (true) {
    const input = await prompt("\n按 Enter 回到菜单，按 q 退出: ");
    if (input.toLowerCase() === "q") {
      return true;
    }
    if (input === "") {
      return false;
    }
    // 其它输入忽略，循环重新提示
  }
}

/**
 * @brief 安全地读取密码（不回显明文）
 * @details 通过 stdin raw mode 逐字符读取，终端显示 `*` 占位。
 *          非 TTY 环境（如管道输入）回退为 readline 直接读取，此时密码可见，
 *          属已知限制。支持 Backspace 删除、Ctrl+C 退出。
 * @param questionText 提示文本
 * @returns 用户输入的密码字符串
 */
async function askPassword(questionText: string): Promise<string> {
  process.stdout.write(questionText);

  // stdin 的类型断言：TTY 模式下拥有 setRawMode 方法
  type TtyStdin = NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode?(mode: boolean): void;
  };
  const stdin = process.stdin as TtyStdin;
  let password = "";
  let rawModeEnabled = false;

  // 尝试启用 raw mode（关闭回显）
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  stdin.resume();

  return new Promise<string>((resolve) => {
    /**
     * @brief 清理监听器并恢复终端状态
     */
    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.pause();
      if (rawModeEnabled && stdin.setRawMode) {
        stdin.setRawMode(false);
      }
    }

    /**
     * @brief 逐字符处理回调
     * @param ch 读到的字节
     */
    function onData(ch: Buffer): void {
      const char = ch.toString("utf8");

      // 回车（CR / LF）— 结束输入
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(password);
        return;
      }

      // Ctrl+C — 中止程序
      if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Backspace / Delete — 删除最后一个字符
      if (char === "\u007f" || char === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      // 普通字符 — 追加并显示占位符
      password += char;
      process.stdout.write("*");
    }

    stdin.on("data", onData);
  });
}

/**
 * @brief 解析紧凑格式的服务器地址
 * @details 支持 `user@host[:port]` 格式，例如：
 *          - `cnb-dso-xxx@cnb.space`
 *          - `root@1.2.3.4:2222`
 *          - `user@host.example.com`
 *          未带端口时默认 22。user、host 均不能为空。
 * @param input 用户输入的地址字符串
 * @returns 解析结果；格式非法返回 null
 */
function parseServerAddress(
  input: string
): { host: string; port: number; username: string } | null {
  const trimmed = input.trim();
  // 必须包含 @ 分隔用户名与主机
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const username = trimmed.slice(0, atIdx);
  const rest = trimmed.slice(atIdx + 1);
  if (!username || !rest) return null;

  // 可选 :port（取最后一个冒号，避免 IPv6 地址干扰；本场景主要为域名/IPv4）
  let host = rest;
  let port = 22;
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx > 0) {
    const portPart = rest.slice(colonIdx + 1);
    const parsedPort = parseInt(portPart, 10);
    // 端口必须是纯数字且在合法范围
    if (/^\d+$/.test(portPart) && parsedPort > 0 && parsedPort <= 65535) {
      host = rest.slice(0, colonIdx);
      port = parsedPort;
    }
  }

  if (!host) return null;
  return { host, port, username };
}

// ============================================================
// 命令执行封装
// ============================================================

// 将 execFile 转为 Promise 形式，便于 async/await 调用
const execFileAsync = promisify(execFile);

/**
 * @brief 执行外部命令并统一封装结果（runPowerShell / runCmd 的公共核心）
 * @details 捕获退出码与 stdout / stderr，异常统一转为 success:false 结果，
 *          不向调用方抛出。maxBuffer 默认 10MB，兼容大量输出的命令。
 * @param cmd       命令名（如 "powershell"、"msiexec"）
 * @param args      参数数组
 * @param timeoutMs 超时毫秒数，默认 300000（5 分钟）
 * @returns 封装的执行结果
 */
async function execToResult(
  cmd: string,
  args: string[],
  timeoutMs = 300000
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      success: false,
      exitCode: e.code ?? -1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/**
 * @brief 执行 PowerShell 命令
 * @details 前置设置 [Console]::OutputEncoding 为 UTF-8，确保 PowerShell 输出经管道
 *          回传 Node 时不乱码。**不使用 chcp 65001**——chcp 会修改共享控制台的代码页，
 *          导致 conhost 清屏重绘（表现为首次调用时菜单/提示被"刷掉"），而
 *          [Console]::OutputEncoding 只影响子进程自身的输出编码，不触碰控制台。
 * @param script    PowerShell 脚本字符串
 * @param timeoutMs 超时毫秒数，默认 300000（5 分钟）
 * @returns 封装的执行结果
 */
async function runPowerShell(
  script: string,
  timeoutMs = 300000
): Promise<CommandResult> {
  return execToResult(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`,
    ],
    timeoutMs
  );
}

/**
 * @brief 执行通用外部命令
 * @details 用于 msiexec、sshd.exe install 等非 PowerShell 命令。
 * @param cmd       命令名（如 "msiexec"）
 * @param args      参数数组
 * @param timeoutMs 超时毫秒数，默认 300000
 * @returns 封装的执行结果
 */
async function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 300000
): Promise<CommandResult> {
  return execToResult(cmd, args, timeoutMs);
}

// ============================================================
// SSH 最小封装（基于 ssh2，不复用 SSHShell）
// ============================================================

/**
 * @brief 建立到 Linux 的 SSH 连接
 * @details 基于 ssh2 Client 直接连接，不经过 SSHShell。
 * @param info Linux 服务器连接信息
 * @returns 已连接的 ssh2 Client 实例
 * @throws 连接失败时抛出
 */
function sshConnect(info: LinuxServerInfo): Promise<Client> {
  const client = new Client();
  return new Promise<Client>((resolve, reject) => {
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.connect({
      host: info.host,
      port: info.port,
      username: info.username,
      password: info.password,
      readyTimeout: 10000,
    } as ConnectConfig);
  });
}

/**
 * @brief 在已建立的 SSH 连接上执行一条命令
 * @details 收集 stdout 与 stderr，命令结束后返回完整 stdout（trim 尾部空白）。
 * @param client  已连接的 ssh2 Client
 * @param command 要执行的 shell 命令
 * @returns 命令的 stdout 输出（已 trim）
 * @throws 执行失败时抛出
 */
function sshExec(client: Client, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      // stderr 仅作调试参考，不阻断流程，此处显式消费避免 unhandled 事件告警
      stream.stderr.on("data", () => {
        /* 忽略远端 stderr */
      });
      stream.on("close", () => {
        resolve(stdout.trim());
      });
    });
  });
}

/**
 * @brief 从远端 SFTP 下载文件到本地
 * @details 基于 ssh2 的 sftp 子系统，使用 fastGet 流式下载。
 * @param client    已连接的 ssh2 Client
 * @param remotePath 远端文件绝对路径（SFTP 不识别 ~，需先展开）
 * @param localPath  本地目标文件路径
 * @throws SFTP 不可用或下载失败时抛出
 */
function sshDownload(
  client: Client,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

/**
 * @brief 关闭 SSH 连接
 * @param client ssh2 Client 实例
 */
function sshDisconnect(client: Client): void {
  try {
    client.end();
  } catch {
    // 忽略关闭时的异常
  }
}

// ============================================================
// HTTP 下载（MSI 离线安装包）
// ============================================================

/**
 * @brief 下载文件到本地（支持 HTTPS 重定向）
 * @details GitHub releases 会 301/302 重定向到 CDN，需手动跟随。
 *          下载失败时清理半成品文件。
 * @param url      下载地址
 * @param destPath 本地目标路径
 * @throws 网络错误或 HTTP 非 2xx 时抛出
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = createWriteStream(destPath);

    const req = httpsGet(url, (response) => {
      // 处理重定向（301 / 302）
      if (
        (response.statusCode === 301 || response.statusCode === 302) &&
        response.headers.location
      ) {
        file.close();
        const redirectUrl = response.headers.location;
        downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        try {
          unlinkSync(destPath);
        } catch {
          // 忽略清理失败
        }
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });

    req.on("error", (err) => {
      file.close();
      try {
        unlinkSync(destPath);
      } catch {
        // 忽略清理失败
      }
      reject(err);
    });
  });
}

// ============================================================
// sshd 服务辅助
// ============================================================

/**
 * @brief 检查 sshd 服务是否已注册
 * @details 通过 Get-Service 查询 sshd 服务是否存在（Select-Object -ExpandProperty Name
 *          仅输出 "sshd" 或空）。统一 step1 / step3 / ensureSshdService 三处服务检查逻辑。
 * @returns 已注册返回 true
 */
async function isSshdServiceRegistered(): Promise<boolean> {
  const result = await runPowerShell(
    "Get-Service sshd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"
  );
  return result.success && result.stdout === "sshd";
}

/**
 * @brief 查找系统中存在的 sshd.exe 路径
 * @details 按候选路径列表逐个探测（MSI 目录优先，Windows 自带目录次之）。
 * @returns 找到的 sshd.exe 绝对路径；未找到返回 null
 */
function findSshdExe(): string | null {
  for (const candidate of SSHD_EXE_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * @brief 检测 OpenSSH 的安装方式（MSI / Capability / 未知）
 * @details 综合三个信号交叉判定，任一单一信号都不足以区分 MSI 与 Capability。
 *          执行顺序按"快→慢"排列，能尽早判定就尽早返回，避免慢命令卡死：
 *
 *   信号 C（最快，同步）：findSshdExe() 文件探测
 *     方法：existsSync 探测 MSI_SSHD_EXE / CAPABILITY_SSHD_EXE 两个候选路径
 *
 *   信号 B（快，~100ms）：sshd 服务的 ImagePath
 *     命令：(Get-CimInstance Win32_Service -Filter "Name='sshd'").ImagePath
 *     - 含 "Program Files\OpenSSH" → MSI（MSI 安装器把文件释放到此目录）
 *     - 含 "System32\OpenSSH"      → Capability（Windows 组件目录）
 *     这是最可靠的区分信号：服务实际加载的 exe 路径不会撒谎。
 *
 *   判定优先级（实际执行顺序）：
 *     1. 先取信号 C（瞬时），再取信号 B（快）。
 *     2. 信号 B 命中 → 立即返回（最可靠 + 快）。
 *     3. 信号 B 未命中（服务未注册）→ 用信号 C 兜底判定。
 *     4. 信号 C 也无法判定 → 才调用慢速的信号 A。
 *
 *   信号 A（慢，可能数十秒）：Get-WindowsCapability 的 State
 *     命令：Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
 *           | Select-Object -ExpandProperty State
 *     - "Installed"  → 由 Windows 组件（Capability）安装，但部分 MSI 安装后也可能
 *       被 Capability 探测到（因 OpenSSH 文件落到了系统目录），故仅作"强提示"。
 *     - "NotPresent" → 肯定不是 Capability 方式装的。
 *     给独立 30 秒超时（runPowerShell 默认 5 分钟会卡死）。仅在 B、C 都无法判定
 *     时才调用，绝大多数场景不会执行到这里。
 *
 * @returns 安装方式信息（method / methodLabel / exePath / detail）
 */
async function detectOpenSshInstallMethod(): Promise<OpenSshInstallInfo> {
  log.message("    正在检测安装方式...");
  // 信号 C：文件探测（同步，先拿到 exe 路径供后续填充）
  const exePath = findSshdExe();

  // 信号 B：读 sshd 服务的 ImagePath（服务实际加载的 exe 路径）
  //   Get-CimInstance 比 WMI 更现代；ImagePath 形如：
  //     "C:\Program Files\OpenSSH\sshd.exe" serves...（含 arguments）
  let svcImagePath: string | null = null;
  const svcRegistered = await isSshdServiceRegistered();
  if (svcRegistered) {
    const imgResult = await runPowerShell(
      "(Get-CimInstance Win32_Service -Filter \"Name='sshd'\").ImagePath"
    );
    if (imgResult.success && imgResult.stdout) {
      svcImagePath = imgResult.stdout;
    }
  }

  // —— 信号 B 优先：服务 ImagePath 是最可靠来源，且 Get-CimInstance 很快 ——
  if (svcImagePath) {
    // 取 ImagePath 中的 exe 路径（去掉首尾引号与尾部参数）
    const pathLower = svcImagePath.toLowerCase();
    if (pathLower.includes("program files\\openssh")) {
      return {
        method: "msi",
        methodLabel: "MSI",
        exePath,
        detail: svcRegistered
          ? "服务 ImagePath 指向 Program Files\\OpenSSH"
          : "exe 位于 Program Files\\OpenSSH（服务未注册）",
      };
    }
    if (pathLower.includes("system32\\openssh")) {
      return {
        method: "capability",
        methodLabel: "Capability",
        exePath,
        detail: svcRegistered
          ? "服务 ImagePath 指向 System32\\OpenSSH"
          : "exe 位于 System32\\OpenSSH（服务未注册）",
      };
    }
  }

  // —— 信号 C 兜底：仅靠文件路径（服务未注册时 B 不可用，跳过慢速的 A） ——
  if (exePath === MSI_SSHD_EXE) {
    return {
      method: "msi",
      methodLabel: "MSI",
      exePath,
      detail: "仅在 MSI 标准目录发现 sshd.exe",
    };
  }
  if (exePath === CAPABILITY_SSHD_EXE) {
    return {
      method: "capability",
      methodLabel: "Capability",
      exePath,
      detail: "仅在系统目录发现 sshd.exe",
    };
  }

  // —— 信号 A：Capability State（慢，仅在 B、C 都无法判定时才调用） ——
  //   Get-WindowsCapability -Online 要扫描 CBS 组件存储，某些机器上需要数十秒。
  //   给独立较短超时（30 秒），避免默认的 5 分钟卡死。
  log.message("    进一步查询 Capability 状态（可能需要数秒）...");
  let capabilityInstalled = false;
  const capResult = await runPowerShell(
    `Get-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME} | Select-Object -ExpandProperty State`,
    30000
  );
  if (capResult.success && capResult.stdout.includes("Installed")) {
    capabilityInstalled = true;
  }

  // Capability Installed 且 exe 不在 MSI 目录 → 判为 Capability
  if (capabilityInstalled && !existsSync(MSI_SSHD_EXE)) {
    return {
      method: "capability",
      methodLabel: "Capability",
      exePath,
      detail: "Get-WindowsCapability 报告 Installed",
    };
  }

  // 未安装 / 信号矛盾
  return {
    method: "unknown",
    methodLabel: "未知",
    exePath: null,
    detail:
      !svcRegistered && !exePath
        ? "未检测到 OpenSSH 安装"
        : "安装来源无法确定（信号矛盾）",
  };
}

/**
 * @brief 确保 sshd 服务已注册
 * @details MSI 静默安装有时只释放文件不注册服务（当系统中已存在 OpenSSH 文件时尤其常见）。
 *          本函数先检查 `sshd` 服务是否存在，不存在则用 `sshd.exe install` 注册。
 * @returns true=服务已就绪（已注册或注册成功）；false=注册失败
 */
async function ensureSshdService(): Promise<boolean> {
  // 先检查服务是否已注册
  if (await isSshdServiceRegistered()) {
    return true;
  }

  // 服务未注册，用 sshd.exe install 注册
  const sshdExe = findSshdExe();
  if (!sshdExe) {
    console.error("[err] 未找到 sshd.exe，无法注册服务");
    console.error(`     已尝试: ${SSHD_EXE_CANDIDATES.join(", ")}`);
    return false;
  }

  console.log(`[run] 注册 sshd 服务 (${sshdExe} install)...`);
  const installResult = await runCmd(sshdExe, ["install"]);
  if (!installResult.success) {
    console.error(
      `[err] 注册 sshd 服务失败: ${installResult.stderr || "未知错误"}`
    );
    return false;
  }
  console.log("[info] sshd 服务已注册");
  return true;
}

// ============================================================
// sshd_config 辅助
// ============================================================

/**
 * @brief 在 sshd_config 行数组中查找匹配且未被注释的指令行
 * @details 统一 step3（回显最终配置）与 step4（检查配置）的指令行查找逻辑。
 *          注释行（以 # 开头）不视为有效指令。
 * @param lines   sshd_config 的行数组
 * @param pattern 指令匹配正则（匹配 trimmed 后的整行）
 * @returns 匹配到的行；未匹配返回 undefined
 */
function findActiveConfigLine(
  lines: string[],
  pattern: RegExp
): string | undefined {
  return lines.find((l) => pattern.test(l.trim()) && !l.trim().startsWith("#"));
}

/**
 * @brief 修改 sshd_config 文本内容
 * @details 对 sshd_config 逐行处理：
 *          1. 确保 PubkeyAuthentication yes
 *          2. 确保 AuthorizedKeysFile .ssh/authorized_keys
 *          3. 注释掉 Match Group administrators 整段（含 Match 行及其下所有指令）
 *          缺失的指令在文件末尾追加。
 * @param content 原始 sshd_config 文本
 * @returns 修改后的文本
 */
function modifySshdConfig(content: string): string {
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  let inMatchAdmin = false;
  let foundPubkey = false;
  let foundAuthKeys = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 已在 Match Group administrators 块内
    if (inMatchAdmin) {
      // 遇到新的 Match 指令 → 退出 admin 块（该行本身不注释，正常处理）
      if (/^Match\s+/i.test(trimmed) && !trimmed.startsWith("#")) {
        inMatchAdmin = false;
        // 不 continue，让该行走下面的正常处理
      } else {
        // 仍在 admin 块内，注释掉非空非注释行
        if (trimmed && !trimmed.startsWith("#")) {
          result.push("# " + line);
        } else {
          result.push(line);
        }
        continue;
      }
    }

    // 检测进入 Match Group administrators 块
    if (/^Match\s+Group\s+administrators/i.test(trimmed)) {
      inMatchAdmin = true;
      // 注释掉 Match 行本身
      result.push("# " + line);
      continue;
    }

    // 处理 PubkeyAuthentication
    if (
      /^\s*PubkeyAuthentication\s+/i.test(trimmed) &&
      !trimmed.startsWith("#")
    ) {
      result.push("PubkeyAuthentication yes");
      foundPubkey = true;
      continue;
    }

    // 处理 AuthorizedKeysFile
    if (
      /^\s*AuthorizedKeysFile\s+/i.test(trimmed) &&
      !trimmed.startsWith("#")
    ) {
      result.push("AuthorizedKeysFile .ssh/authorized_keys");
      foundAuthKeys = true;
      continue;
    }

    result.push(line);
  }

  // 追加缺失的指令
  if (!foundPubkey) {
    result.push("PubkeyAuthentication yes");
  }
  if (!foundAuthKeys) {
    result.push("AuthorizedKeysFile .ssh/authorized_keys");
  }

  return result.join("\n");
}

// ============================================================
// 主菜单
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择（clack select）
 * @details 基于 @clack/prompts 的 select 交互组件，方向键选择、Enter 确认。
 *          Ctrl+C 取消时返回 null，由调用方决定退出逻辑。
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "Windows SSH 免密登录配置",
    options: [
      {
        value: MENU_ONE_CLICK,
        label: `[${MENU_ONE_CLICK}] 一键完成全流程（安装→密钥→配置→模板）`,
      },
      {
        value: MENU_INSTALL_SSH,
        label: `[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`,
      },
      {
        value: MENU_GENERATE_KEY,
        label: `[${MENU_GENERATE_KEY}] 编译服务器生成密钥对`,
      },
      {
        value: MENU_CONFIG_SSHD,
        label: `[${MENU_CONFIG_SSHD}] 配置 Windows 中 sshd 服务`,
      },
      {
        value: MENU_CHECK_STATUS,
        label: `[${MENU_CHECK_STATUS}] 检查 sshd 配置状态（只读诊断）`,
      },
      {
        value: MENU_UNINSTALL_SSH,
        label: `[${MENU_UNINSTALL_SSH}] 卸载 Windows SSH 服务`,
      },
      {
        value: MENU_SHOW_INFO,
        label: `[${MENU_SHOW_INFO}] 查看本机连接信息（用户名/IP）`,
      },
      {
        value: MENU_GEN_TEMPLATE,
        label: `[${MENU_GEN_TEMPLATE}] 生成 Linux 端 MCP 配置模板`,
      },
      { value: MENU_EXIT, label: `[${MENU_EXIT}] 退出` },
    ],
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

// ============================================================
// step1: 安装 Windows SSH 服务
// ============================================================

/**
 * @brief 安装 Windows OpenSSH Server
 * @details 先检测是否已安装（Get-Service sshd / Get-WindowsCapability），
 *          已安装则跳过。未安装时让用户选择安装方式（默认 MSI）：
 *          - MSI 分支（默认）：本地已存在 MSI 包则跳过下载，否则从 GitHub
 *            下载后调用 msiexec 静默安装。
 *          - 在线分支：调用 Add-WindowsCapability 安装（依赖 Windows Update，
 *            国内网络易卡，故不作为默认）。
 *          安装后启动 sshd 并设为开机自启。每步失败均打印中文提示并 return，
 *          不抛异常。
 */
async function doInstallSsh(): Promise<boolean> {
  log.info("开始安装 Windows SSH ...");

  // 检测 sshd 服务是否已存在
  if (await isSshdServiceRegistered()) {
    log.message("    OpenSSH Server 已安装，跳过");
    return true;
  }

  // 检测 Windows Capability 状态
  const checkCap = await runPowerShell(
    `Get-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME} | Select-Object -ExpandProperty State`
  );
  if (checkCap.success && checkCap.stdout.includes("Installed")) {
    log.message("    OpenSSH Server 已安装(Capability)，跳过");
    return true;
  }

  // 让用户选择安装方式（默认 MSI）
  // clack select：方向键选择、Enter 确认；value 复用原 "1"/"2" 分支判断
  const methodChoiceRaw = await select<string>({
    message: "选择安装方式",
    options: [
      {
        value: "1",
        label: "MSI 离线安装",
        hint: "默认，下载一次可重复使用",
      },
      {
        value: "2",
        label: "在线安装(Add-WindowsCapability)",
        hint: "依赖 Windows Update",
      },
    ],
    initialValue: "1",
  });
  // Ctrl+C 取消：直接返回主菜单
  if (isCancel(methodChoiceRaw)) {
    log.message("    已取消安装方式选择");
    return false;
  }
  const methodChoice = methodChoiceRaw;

  // MSI 缓存路径（与 step2 拉取的公钥同目录，使用模块常量便于 step5 卸载复用）
  const msiPath = resolve(process.cwd(), LOCAL_MSI_REL);
  const msiDir = dirname(msiPath);

  if (methodChoice === "2") {
    // ===== 在线安装分支 =====
    log.message("    在线安装 (Add-WindowsCapability)...");
    log.message("    依赖 Windows Update, 网络不佳时可能长时间卡住");
    const installOnline = await runPowerShell(
      `Add-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME}`
    );
    if (!installOnline.success) {
      log.error(`    在线安装失败: ${installOnline.stderr || "未知错误"}`);
      log.message("     可重新运行本项改选 MSI 离线安装");
      return false;
    }
    log.message("在线安装成功");
  } else {
    // ===== MSI 离线安装分支（默认）=====
    // 确保下载目录存在
    if (!existsSync(msiDir)) {
      mkdirSync(msiDir, { recursive: true });
    }

    try {
      // 本地已存在 MSI 包则跳过下载
      if (existsSync(msiPath)) {
        log.message(`    已存在 MSI 安装包，跳过下载: ${msiPath}`);
      } else {
        log.message(`    下载 MSI 安装包: ${OPENSSH_MSI_URL}`);
        await downloadFile(OPENSSH_MSI_URL, msiPath);
        log.message(`    下载完成: ${msiPath}`);
      }

      log.message("    执行 MSI 静默安装...");
      const installMsi = await runCmd("msiexec", [
        "/i",
        msiPath,
        "/quiet",
        "/norestart",
      ]);
      if (!installMsi.success) {
        log.message(`    MSI 安装失败: ${installMsi.stderr || "未知错误"}`);
        return false;
      }
      log.message("    MSI 安装成功");
    } catch (err) {
      log.message(
        `    MSI 下载/安装失败: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  log.info("启动 sshd 服务 ...");
  // 确保 sshd 服务已注册（MSI 静默安装有时不注册服务，需用 sshd.exe install 补注册）
  const serviceReady = await ensureSshdService();
  if (!serviceReady) {
    log.warn("请手动注册 sshd 服务：<sshd.exe 路径> install");
    return false;
  }

  // 启动 sshd 服务
  log.message("    正在启动 sshd 服务...");
  const startResult = await runPowerShell("Start-Service sshd");
  if (!startResult.success) {
    log.message(`    启动 sshd 失败: ${startResult.stderr || "未知错误"}`);
    return false;
  }
  log.message("    sshd 服务已启动");

  // 设为开机自启
  log.info("设置 sshd 开机自启 ...");
  const autoResult = await runPowerShell(
    "Set-Service -Name sshd -StartupType Automatic"
  );
  if (!autoResult.success) {
    log.message(`    设置自启失败: ${autoResult.stderr || "未知错误"}`);
    return false;
  }
  log.message("    sshd 已设为开机自启");
  log.success("Windows SSH 服务安装完成");
  return true;
}

// ============================================================
// step2: 编译服务器生成密钥对
// ============================================================

/**
 * @brief 在 Linux 编译服务器上生成 SSH 密钥对并拉取公钥
 * @details 交互式收集 Linux 服务器连接信息（不落盘），SSH 登录后：
 *          1. 检测远端 sshd 是否运行（未运行则提示安装命令并退出）
 *          2. 以登录用户身份执行 ssh-keygen 生成密钥（已存在则询问覆盖）
 *          3. 通过 SFTP 把公钥拉取到本地 .embedded/ssh/id_mcp_server.pub
 *          SSH 操作基于 ssh2 在本文件内独立实现，不复用 SSHShell。
 */
async function doGenerateKey(): Promise<boolean> {
  log.info("开始在编译服务器生成密钥对 ...");

  // 交互式收集连接信息（不落盘）
  // 紧凑格式 user@host[:port]，一次输入完成
  const addressRaw = await text({
    message: "编译服务器地址",
    placeholder: "user@host[:port],host 可为 IP 或主机别名，如 sumu@1.1.1.1:22",
  });
  if (isCancel(addressRaw)) {
    log.message("    已取消");
    return false;
  }
  const addressInput = addressRaw.trim();
  if (!addressInput) {
    log.message("    已取消");
    return false;
  }

  const parsed = parseServerAddress(addressInput);
  if (!parsed) {
    log.message(
      "    地址格式错误，应为 user@host[:port]（如 root@1.2.3.4 或 root@1.2.3.4:2222）"
    );
    return false;
  }

  const pwdRaw = await password({
    message: "登录密码",
  });
  if (isCancel(pwdRaw)) {
    log.message("    已取消");
    return false;
  }

  const info: LinuxServerInfo = { ...parsed, password: pwdRaw };

  // SSH 连接
  let client: Client;
  try {
    log.info(`连接 ${info.username}@${info.host}:${info.port} ...`);
    client = await sshConnect(info);
    log.message("    SSH 连接成功");
  } catch (err) {
    log.message(
      `    无法连接编译服务器: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }

  try {
    // 信息采集：获取当前登录用户、主机 IP、家目录，仅展示供用户核对连接目标
    const remoteUser = await sshExec(client, "whoami");
    const remoteIp = await sshExec(
      client,
      "hostname -I 2>/dev/null | awk '{print $1}' || hostname"
    );
    const remoteHome = await sshExec(client, "eval echo ~$USER");
    log.info("连接目标信息");
    log.message(`    当前用户: ${remoteUser || "(unknown)"}`);
    log.message(`    主机 IP: ${remoteIp || "(unknown)"}`);
    log.message(`    家目录: ${remoteHome || "(unknown)"}`);

    // 检测远端 sshd 是否运行
    const sshdCheck = await sshExec(
      client,
      "systemctl status sshd 2>/dev/null || service ssh status 2>/dev/null || echo NO_SSHD"
    );
    if (sshdCheck.includes("NO_SSHD")) {
      log.message("    远端 sshd 未运行");
      log.message("    请在编译服务器上安装并启动 sshd: ");
      log.message(
        "        Debian/Ubuntu: sudo apt install openssh-server && sudo systemctl start sshd"
      );
      log.message(
        "        RHEL/CentOS:   sudo dnf install openssh-server && sudo systemctl start sshd"
      );
      return false;
    }
    log.message("    远端 sshd 运行正常");

    // 检测密钥是否已存在（专用密钥名 id_mcp_server，避免覆盖用户通用密钥）
    // 注意：必须精确匹配 "EXISTS"，不能用 includes——"NOT_EXISTS" 也包含子串 "EXISTS"
    const keyCheck = await sshExec(
      client,
      "test -f ~/.ssh/id_mcp_server && echo EXISTS || echo NOT_EXISTS"
    );
    if (keyCheck === "EXISTS") {
      const overwrite = await confirm({
        message: "MCP 专用密钥已存在，是否覆盖?",
        active: "覆盖",
        inactive: "保留",
        initialValue: false,
      });
      if (isCancel(overwrite) || !overwrite) {
        log.message("    已取消，保留原密钥");
        return false;
      }
      // 先删除旧密钥文件，避免 ssh-keygen 触发交互式 "Overwrite (y/n)?" 确认
      // sshExec 基于 exec 通道，无法向远端 stdin 写入回应，ssh-keygen 会死等输入导致卡死
      log.message("    删除旧密钥文件 ...");
      await sshExec(
        client,
        "rm -f ~/.ssh/id_mcp_server ~/.ssh/id_mcp_server.pub"
      );
    }

    // 生成密钥对（专用密钥名 id_mcp_server）
    log.info("生成 MCP 专用 RSA 密钥对 (id_mcp_server) ...");
    await sshExec(
      client,
      'ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_mcp_server'
    );
    log.message("    密钥对生成成功");

    // 列出 ~/.ssh 目录所有文件，供用户确认密钥已正确生成
    const sshListing = await sshExec(client, "ls -la ~/.ssh 2>/dev/null");
    log.info("~/.ssh 目录内容");
    for (const line of sshListing.split("\n")) {
      if (line.trim()) {
        log.message(`    ${line}`);
      }
    }

    // 展开 ~ 为绝对路径（SFTP 不识别 ~）
    const pubPathRaw = await sshExec(client, "echo ~/.ssh/id_mcp_server.pub");
    const pubPathRemote = pubPathRaw.replace(/\s+/g, "");

    // 确保本地目录存在
    const localPubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
    const localDir = dirname(localPubPath);
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }

    // SFTP 下载公钥
    log.info("拉取公钥到本地 ...");
    await sshDownload(client, pubPathRemote, localPubPath);
    log.message(`    公钥已保存: ${localPubPath}`);
    log.success("密钥对生成完成");
    return true;
  } catch (err) {
    log.message(`    操作失败: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    sshDisconnect(client);
  }
}

// ============================================================
// step3: 配置 Windows sshd
// ============================================================

/**
 * @brief 配置 Windows sshd 服务
 * @details 1. 把 .embedded/ssh/id_mcp_server.pub 追加到 ~/.ssh/authorized_keys（去重）
 *          2. 备份 C:\ProgramData\ssh\sshd_config → .bak（已存在不覆盖）
 *          3. 修改 sshd_config：开启公钥认证、指定 AuthorizedKeysFile、禁用
 *             Match Group administrators 分组规则
 *          4. 重启 sshd 使配置生效（先检查服务是否注册；未注册则跳过重启不回滚，仅提示）
 *          5. 回显最终关键配置项供用户核对
 */
async function doConfigSshd(): Promise<boolean> {
  log.info("开始配置 Windows sshd 服务 ...");

  // 1. 读取本地公钥
  log.info("检查 本地 id_mcp_server(linux) 是否已经存在 ...");
  const pubKeyPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  if (!existsSync(pubKeyPath)) {
    log.message(`    未找到公钥文件: ${pubKeyPath}`);
    log.message(`    请先执行 [${MENU_GENERATE_KEY}] 编译服务器生成密钥对`);
    return false;
  } else {
    log.message(`    已找到公钥文件: ${pubKeyPath}`);
  }
  const pubKey = readFileSync(pubKeyPath, "utf8").trim();

  // 2. 写入 authorized_keys（去重）
  log.info("写入 authorized_keys ...");
  const sshDir = resolve(homedir(), ".ssh");
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true });
    log.message(`    创建目录: ${sshDir}`);
  }
  const akPath = join(sshDir, "authorized_keys");
  const existingContent = existsSync(akPath)
    ? readFileSync(akPath, "utf8")
    : "";
  const existingLines = existingContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

  if (existingLines.includes(pubKey)) {
    log.message("    公钥已存在于 authorized_keys, 跳过");
  } else {
    // 确保末尾有换行再追加
    const prefix =
      existingContent === "" || existingContent.endsWith("\n")
        ? existingContent
        : existingContent + "\n";
    writeFileSync(akPath, prefix + pubKey + "\n", "utf8");
    log.message(`    公钥已写入: ${akPath}`);
  }
  log.info("配置 sshd_config ...");
  // 3. 检查 sshd_config 是否存在
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message(`    未找到 sshd_config: ${SSHD_CONFIG_PATH}`);
    log.message(`    请先执行 [${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`);
    return false;
  }

  // 4. 备份 sshd_config（已存在 .bak 不覆盖，保留首次备份）
  const bakPath = SSHD_CONFIG_PATH + ".bak";
  if (!existsSync(bakPath)) {
    copyFileSync(SSHD_CONFIG_PATH, bakPath);
    log.message(`    已备份: ${bakPath}`);
  } else {
    log.message(`    备份已存在，保留首次备份: ${bakPath}`);
  }

  // 5. 修改 sshd_config
  const originalConfig = readFileSync(SSHD_CONFIG_PATH, "utf8");
  const modifiedConfig = modifySshdConfig(originalConfig);
  writeFileSync(SSHD_CONFIG_PATH, modifiedConfig, "utf8");
  log.message(
    "    sshd_config 已修改(PubkeyAuthentication yes / AuthorizedKeysFile / 禁用 administrators 分组)"
  );

  // 6. 重启 sshd 使配置生效
  //    先检查 sshd 服务是否已注册：未注册时（如 sshd 以非服务方式运行）跳过重启，
  //    不回滚配置（配置本身已正确），仅提示用户手动重启或执行 [2] 安装服务。
  log.info("检查 sshd 服务是否已注册 ...");
  const svcRegistered = await isSshdServiceRegistered();

  if (!svcRegistered) {
    log.message("    sshd 服务未注册（可能以非服务方式运行），跳过自动重启");
    log.message("    配置已写入，请手动重启 sshd 使其生效：");
    log.message(
      `      若 sshd 以服务方式运行：先执行 [${MENU_INSTALL_SSH}] 安装服务`
    );
    log.message("      若 sshd 以进程方式运行：手动结束 sshd 进程后重新启动");
  } else {
    log.message("    sshd 服务已注册");
    log.info("重启 sshd 服务 ...");
    const restartResult = await runPowerShell("Restart-Service sshd -Force");
    if (!restartResult.success) {
      log.message(`    重启 sshd 失败: ${restartResult.stderr || "未知错误"}`);
      log.message("    正在回滚 sshd_config ...");
      try {
        writeFileSync(SSHD_CONFIG_PATH, originalConfig, "utf8");
        log.message("    sshd_config 已回滚");
      } catch (err) {
        log.message(
          `    回滚失败: ${err instanceof Error ? err.message : err}`
        );
      }
      return false;
    }
    log.message("    sshd 服务已重启");
  }

  // 7. 回显最终关键配置项
  log.info("最终关键配置");
  const finalConfig = readFileSync(SSHD_CONFIG_PATH, "utf8");
  const finalLines = finalConfig.split(/\r?\n/);

  const pubKeyLine = findActiveConfigLine(
    finalLines,
    /^\s*PubkeyAuthentication\s+/i
  );
  log.message(`    PubkeyAuthentication: ${pubKeyLine ?? "(未设置)"}`);

  const authKeysLine = findActiveConfigLine(
    finalLines,
    /^\s*AuthorizedKeysFile\s+/i
  );
  log.message(`    AuthorizedKeysFile:   ${authKeysLine ?? "(未设置)"}`);

  const matchAdminLine = finalLines.find((l) =>
    /^#\s*Match\s+Group\s+administrators/i.test(l)
  );
  log.message(
    `    Match Group admin:     ${matchAdminLine ? "已注释（禁用分组）" : "(未找到原始规则)"}`
  );

  log.success("Windows sshd 配置完成");
  return true;
}

// ============================================================
// step4: 检查 sshd 配置状态（只读诊断）
// ============================================================

/**
 * @brief 检查 sshd 配置状态（纯只读诊断）
 * @details 不修改任何文件或服务，逐项检查并汇总展示当前"Linux→Windows 免密登录"
 *          所需的配置是否就绪：
 *          (a) sshd 服务状态：是否安装、Running、启动类型
 *          (b) sshd_config 关键项：PubkeyAuthentication / AuthorizedKeysFile / Match Group administrators
 *          (c) authorized_keys 状态：是否存在、含多少条公钥
 *          (d) 本地公钥状态：.embedded/ssh/id_mcp_server.pub 是否存在
 *          末尾给出汇总结论，列出异常项与建议执行的菜单项。
 */
async function doCheckStatus(): Promise<void> {
  log.info("检查 sshd 配置状态（只读诊断）");

  const issues: string[] = [];

  // (a) sshd 服务状态
  log.info("sshd 服务状态");
  const svcResult = await runPowerShell(
    "$s = Get-Service sshd -ErrorAction SilentlyContinue; if ($s) { '{0}|{1}' -f $s.Status, $s.StartType } else { 'NOT_INSTALLED' }"
  );
  if (!svcResult.success || svcResult.stdout === "NOT_INSTALLED") {
    log.message("    sshd 服务未安装");
    issues.push(`[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`);
  } else {
    const parts = svcResult.stdout.split("|");
    const status = parts[0]?.trim() ?? "Unknown";
    const startType = parts[1]?.trim() ?? "Unknown";
    const isRunning = status === "Running";
    const isAuto = startType === "Automatic";
    log.message(`    状态: ${status}`);
    log.message(`    启动类型: ${startType}`);
    if (!isRunning) {
      issues.push(`启动 sshd 服务（或重新执行 [${MENU_INSTALL_SSH}]）`);
    }
    if (!isAuto) {
      issues.push(`将 sshd 设为开机自启（或重新执行 [${MENU_INSTALL_SSH}]）`);
    }
  }

  // (a.2) 安装方式（MSI / Capability / 未知）
  const installInfo = await detectOpenSshInstallMethod();
  log.message(
    `    安装方式: ${installInfo.methodLabel}(${installInfo.detail})`
  );

  // (b) sshd_config 关键项
  log.info("sshd_config 关键项");
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message(`    未找到 sshd_config: ${SSHD_CONFIG_PATH}`);
    issues.push(
      `[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务(生成 sshd_config)`
    );
  } else {
    const configContent = readFileSync(SSHD_CONFIG_PATH, "utf8");
    const configLines = configContent.split(/\r?\n/);

    // PubkeyAuthentication
    const pubKeyLine = findActiveConfigLine(
      configLines,
      /^\s*PubkeyAuthentication\s+/i
    );
    const pubKeyOk = pubKeyLine && /yes/i.test(pubKeyLine.trim());
    log.message(
      `    PubkeyAuthentication: ${pubKeyLine?.trim() ?? "(未设置，需为 yes)"}`
    );
    if (!pubKeyOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (PubkeyAuthentication yes)`);

    // AuthorizedKeysFile
    const authKeysLine = findActiveConfigLine(
      configLines,
      /^\s*AuthorizedKeysFile\s+/i
    );
    const authKeysOk =
      authKeysLine && authKeysLine.includes(".ssh/authorized_keys");
    log.message(
      `    AuthorizedKeysFile: ${authKeysLine?.trim() ?? "(未设置)"}`
    );
    if (!authKeysOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (AuthorizedKeysFile)`);

    // Match Group administrators（非注释行存在 = 仍激活）
    const matchAdminLine = findActiveConfigLine(
      configLines,
      /^\s*Match\s+Group\s+administrators/i
    );
    const matchAdminOk = !matchAdminLine;
    log.message(
      `    Match Group administrators: ${matchAdminOk ? "已禁用" : "仍激活（" + matchAdminLine.trim() + "）"}`
    );
    if (!matchAdminOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (禁用 administrators 分组)`);
  }

  // (c) authorized_keys 状态
  log.info("authorized_keys 状态");
  const akPath = join(homedir(), ".ssh", "authorized_keys");
  if (!existsSync(akPath)) {
    log.message(`    不存在: ${akPath}`);
    log.message("    公钥条数: 0");
    issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (写入 authorized_keys)`);
  } else {
    const akContent = readFileSync(akPath, "utf8");
    const keyCount = akContent
      .split(/\r?\n/)
      .filter((l) => PUBKEY_LINE_RE.test(l)).length;
    const hasKeys = keyCount > 0;
    log.message(`    路径: ${akPath}`);
    log.message(`    公钥条数: ${keyCount}`);
    if (!hasKeys)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (authorized_keys 为空)`);
  }

  // (d) 本地公钥状态
  log.info("本地公钥状态");
  const localPubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  const pubExists = existsSync(localPubPath);
  log.message(`    ${pubExists ? "存在" : "不存在"}: ${localPubPath}`);
  if (!pubExists) issues.push(`[${MENU_GENERATE_KEY}] 编译服务器生成密钥对`);

  // 汇总结论
  if (issues.length === 0) {
    log.success("配置就绪，可尝试从 Linux 免密登录");
  } else {
    log.message(`    存在 ${issues.length} 项异常，建议依次执行：`);
    // 去重（同一菜单项可能被多次建议）
    const unique = Array.from(new Set(issues));
    for (const item of unique) {
      log.message(`    ${item}`);
    }
  }
}

// ============================================================
// step5 辅助：卸载流程专用工具函数
// ============================================================

/**
 * @brief 打开"程序和功能"并等待用户手动卸载后按回车继续
 * @details 封装 step5 中三处相同的"开 appwiz.cpl + 等待回车"逻辑。
 *          手动卸载是异步过程，程序无法感知结束时机，故用 prompt 阻塞等待。
 *
 *          实现说明：.cpl 不能直接 spawn（报 EFTYPE），也不能用 control.exe
 *          （它启动控制面板后固定返回退出码 1，execFile 会误判为失败）。
 *          用 `cmd /c start "" "appwiz.cpl"` 是 Windows 打开文件/程序的标准方式：
 *          start 自身立即返回退出码 0，控制面板窗口正常弹出。
 * @returns 打开失败时返回 false（已打印错误提示）
 */
async function openAppwizAndAwait(): Promise<boolean> {
  log.message('    正在打开"程序和功能"，请在窗口中找到 OpenSSH 手动卸载...');
  const openResult = await runCmd("cmd", ["/c", "start", "", "appwiz.cpl"]);
  if (!openResult.success) {
    log.message(`    打开"程序和功能"失败: ${openResult.stderr || "未知错误"}`);
    log.message('    可手动运行 appwiz.cpl 或通过"设置 > 应用"卸载');
    return false;
  }
  log.message('    已打开"程序和功能"，请在窗口中卸载 OpenSSH');
  log.message("    卸载完成后按回车继续...");
  await prompt("  ");
  return true;
}

/**
 * @brief 从 authorized_keys 移除 MCP 专用公钥
 * @details 读取 .embedded/ssh/id_mcp_server.pub 的公钥内容，在 ~/.ssh/authorized_keys
 *          中按整行精确匹配删除对应行。保留其它公钥不受影响。公钥文件不存在或
 *          authorized_keys 不存在时静默跳过（非错误，可能未执行过 step2/step3）。
 */
async function removeMcpPubKeyFromAuthorizedKeys(): Promise<void> {
  const pubKeyPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  if (!existsSync(pubKeyPath)) {
    log.message("    未找到本地公钥文件，跳过 authorized_keys 清理");
    return;
  }
  const pubKey = readFileSync(pubKeyPath, "utf8").trim();
  if (!pubKey) {
    log.message("    本地公钥文件为空，跳过 authorized_keys 清理");
    return;
  }

  const akPath = join(homedir(), ".ssh", "authorized_keys");
  if (!existsSync(akPath)) {
    log.message("    authorized_keys 不存在，无需清理");
    return;
  }

  const akContent = readFileSync(akPath, "utf8");
  const lines = akContent.split(/\r?\n/);
  // 精确匹配：整行 trim 后等于公钥的行视为需删除
  const before = lines.length;
  const filtered = lines.filter((l) => l.trim() !== pubKey);
  const removed = before - filtered.length;

  if (removed === 0) {
    log.message("    authorized_keys 中未找到 MCP 公钥，无需清理");
    return;
  }

  // 重写文件（过滤掉空行尾部的多余换行）
  const newContent = filtered.filter((l) => l.trim() !== "").join("\n");
  if (newContent) {
    writeFileSync(akPath, newContent + "\n", "utf8");
  } else {
    // 所有公钥都被移除，文件变空——保留空文件而非删除（避免权限丢失）
    writeFileSync(akPath, "", "utf8");
  }
  log.message(`    已从 authorized_keys 移除 MCP 公钥（${removed} 条）`);
}

/**
 * @brief 从 .bak 备份恢复 sshd_config
 * @details step3 修改 sshd_config 前备份为 .bak（首次备份不覆盖）。卸载时若 .bak
 *          存在，则用它覆盖回 sshd_config，恢复 step3 修改前的原始配置。恢复后
 *          删除 .bak（已完成使命）。sshd_config 不存在或 .bak 不存在时静默跳过。
 */
function restoreSshdConfigFromBackup(): void {
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message("    sshd_config 不存在，跳过恢复");
    return;
  }
  const bakPath = SSHD_CONFIG_PATH + ".bak";
  if (!existsSync(bakPath)) {
    log.message("    未找到 sshd_config.bak 备份，跳过恢复");
    return;
  }
  try {
    copyFileSync(bakPath, SSHD_CONFIG_PATH);
    unlinkSync(bakPath);
    log.message("    sshd_config 已从备份恢复（.bak 已删除）");
  } catch (err) {
    log.message(
      `    [err] 恢复 sshd_config 失败: ${err instanceof Error ? err.message : err}`
    );
    log.message("    [info] 可手动执行: copy /Y sshd_config.bak sshd_config");
  }
}

// ============================================================
// step5: 卸载 Windows SSH 服务
// ============================================================

/**
 * @brief 卸载 Windows OpenSSH Server
 * @details 先用 detectOpenSshInstallMethod 判定安装方式，再按来源选卸载策略：
 *          - msi        → 优先 msiexec /x 静默卸载（需本地有 MSI 包），否则 appwiz.cpl
 *          - capability → Remove-WindowsCapability（系统组件卸载）
 *          - unknown    → 直接打开 appwiz.cpl 让用户手动卸载
 *
 *          卸载流程顺序（先停服务再卸载，避免运行中的 sshd 占用文件）：
 *          0. 停止 sshd 服务（Stop-Service sshd -Force）
 *          1. 按安装方式卸载 OpenSSH（msiexec / Remove-WindowsCapability / appwiz.cpl）
 *          2. 删除 sshd 服务残留（卸载有时不删服务，sc.exe delete 补删）
 *          3. 从 authorized_keys 移除 MCP 专用公钥（按 .embedded/ssh/id_mcp_server.pub
 *             内容精确匹配删除对应行，保留其它公钥）
 *          4. 从 .bak 备份恢复 sshd_config（step3 修改前的原始配置）
 *
 *          不自动删除 C:\ProgramData\ssh 与 C:\Program Files\OpenSSH 目录：
 *          前者可能含用户自定义配置，避免误删；仅在末尾提示可手动删除。
 */
async function doUninstallSsh(): Promise<void> {
  log.info("卸载 Windows SSH 服务");

  // 检测安装方式（同时确认是否已安装）
  log.info("检测安装方式 ...");
  const info = await detectOpenSshInstallMethod();
  if (info.method === "unknown" && info.exePath === null) {
    log.message("    未检测到 OpenSSH 安装，无需卸载");
    return;
  }
  log.message(`    检测到安装方式: ${info.methodLabel}(${info.detail})`);

  // ===== 步骤 0：先停止 sshd 服务（后续卸载/删文件时避免被运行中进程占用） =====
  if (await isSshdServiceRegistered()) {
    log.info("停止 sshd 服务 ...");
    const stopResult = await runPowerShell(
      "Stop-Service sshd -Force -ErrorAction SilentlyContinue"
    );
    if (stopResult.success) {
      log.message("    sshd 服务已停止");
    } else {
      // 停止失败不阻断后续流程（服务可能已是停止状态或权限受限）
      log.message("    停止 sshd 服务失败（可能已停止），继续后续步骤");
    }
  } else {
    log.message("    sshd 服务未注册，跳过停止");
  }

  // ===== 步骤 1：按安装方式卸载 OpenSSH =====
  if (info.method === "capability") {
    // ===== Capability 方式：用系统组件卸载 =====
    log.info("通过 Remove-WindowsCapability 卸载...");
    const capResult = await runPowerShell(
      `Remove-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME}`
    );
    if (!capResult.success) {
      log.message(`    Capability 卸载失败: ${capResult.stderr || "未知错误"}`);
      log.message('    请打开"程序和功能"手动卸载');
      await openAppwizAndAwait();
    } else {
      log.message("    Capability 卸载成功");
    }
  } else if (info.method === "msi") {
    // ===== MSI 方式：优先 msiexec /x 静默卸载，否则 appwiz.cpl =====

    const msiPath = resolve(process.cwd(), LOCAL_MSI_REL);
    if (existsSync(msiPath)) {
      log.info(`使用 MSI 包卸载: ${msiPath}`);
      const uninstallResult = await runCmd("msiexec", [
        "/x",
        msiPath,
        "/quiet",
        "/norestart",
      ]);
      if (uninstallResult.success) {
        log.message("    MSI 卸载成功");
      } else {
        log.message(
          `     MSI 卸载失败: ${uninstallResult.stderr || "未知错误"}`
        );
        log.message(`    请改用下方打开的"程序和功能"手动卸载`);
        await openAppwizAndAwait();
      }
    } else {
      // 本地没有 MSI 包，只能走图形界面
      log.message(`    未找到本地 MSI 包（${msiPath}），无法静默卸载`);
      await openAppwizAndAwait();
    }
  } else {
    // ===== unknown：无法确定来源，交给用户手动卸载 =====
    log.message("    无法确定安装来源，需手动卸载");
    await openAppwizAndAwait();
  }

  // ===== 步骤 2：删除 sshd 服务残留（卸载有时不删服务，sc.exe delete 补删） =====
  if (await isSshdServiceRegistered()) {
    log.info("sshd 服务仍存在，正在删除服务...");
    const delResult = await runCmd("sc.exe", ["delete", "sshd"]);
    if (delResult.success) {
      log.message("    sshd 服务已删除");
    } else {
      // sc.exe 的错误信息输出到 stdout 而非 stderr（且为 GBK 编码可能乱码），
      // 优先取 stderr，其次 stdout，最后兜底 exitCode
      const errMsg =
        delResult.stderr || delResult.stdout || `退出码 ${delResult.exitCode}`;
      log.message(`    删除 sshd 服务失败: ${errMsg}`);
      log.message("    可手动执行: sc.exe delete sshd");
    }
  } else {
    log.message("    sshd 服务已不存在");
  }

  // ===== 步骤 3：从 authorized_keys 移除 MCP 专用公钥（对应 step3 的写入） =====
  log.info("从 authorized_keys 移除 MCP 专用公钥 ...");
  await removeMcpPubKeyFromAuthorizedKeys();

  // ===== 步骤 4：从 .bak 备份恢复 sshd_config（对应 step3 的修改） =====
  log.info("从 .bak 备份恢复 sshd_config ...");
  restoreSshdConfigFromBackup();

  log.success("    Windows SSH 服务卸载完成");
  log.message(
    "    配置目录 C:\\ProgramData\\ssh 未自动清理（可能含自定义配置）"
  );
  log.message("    如需彻底清除，请手动删除该目录");
}

// ============================================================
// step6: 查看本机连接信息
// ============================================================

/**
 * @brief 单个可用 IPv4 地址及其所属网卡
 * @param ip    IPv4 地址
 * @param iface 网卡名（os.networkInterfaces() 的 key）
 */
interface IpEntry {
  ip: string;
  iface: string;
}

/**
 * @brief 本机连接信息采集结果
 * @param sshUser  ssh 登录用户名（已剥离 DOMAIN\ 前缀）
 * @param ipList   可用 IPv4 地址列表（已过滤回环 / 链路本地 / 虚拟网卡），每项含网卡名
 */
interface ConnectionInfo {
  sshUser: string;
  ipList: IpEntry[];
}

/**
 * @brief 采集本机连接信息（用户名 + 可用 IPv4 地址）
 * @details 统一 doShowConnectionInfo 与 doGenerateTemplate 的信息采集逻辑：
 *          (a) 当前 Windows 登录用户名（os.userInfo().username），剥离 DOMAIN\ 前缀
 *          (b) 本机所有 IPv4 地址，过滤回环（127.x）、链路本地（169.254）、虚拟网卡
 * @returns 连接信息对象
 */
function collectConnectionInfo(): ConnectionInfo {
  // (a) 当前登录用户名（剥离 DOMAIN\ 前缀，ssh 只取反斜杠后的部分）
  const rawUser = userInfo().username;
  const sshUser = rawUser.includes("\\")
    ? rawUser.slice(rawUser.indexOf("\\") + 1)
    : rawUser;

  // (b) 枚举所有 IPv4 地址（排除回环 127.x、链路本地 169.254、虚拟网卡）
  const interfaces = networkInterfaces();
  const ipList: IpEntry[] = [];
  for (const [ifName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    // 跳过常见虚拟网卡（VirtualBox / VMware / Hyper-V / WSL），减少干扰
    if (/virtual|vmware|hyper-v|vethernet|wsl|docker/i.test(ifName)) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        // 跳过 169.254 链路本地地址（未正确获取 DHCP 时出现）
        if (addr.address.startsWith("169.254")) continue;
        ipList.push({ ip: addr.address, iface: ifName });
      }
    }
  }

  return { sshUser, ipList };
}

/**
 * @brief 查看本机 Windows 的连接信息（用户名 / IP），供 Linux 端 ssh 连接参考
 * @details 纯只读，不修改任何状态。展示：
 *          (a) 当前 Windows 登录用户名（os.userInfo().username）
 *          (b) 本机所有 IPv4 地址（os.networkInterfaces()），过滤回环与虚拟网卡
 *          (c) 拼接一条可直接在 Linux 端执行的示例 ssh 命令（含 -i 指定专用密钥）
 *          多网卡环境下列出所有候选 IP，由用户根据网络拓扑自行判断选哪个。
 */
async function doShowConnectionInfo(): Promise<void> {
  log.info("查看本机连接信息");

  const { sshUser, ipList } = collectConnectionInfo();

  // (a) 用户名
  log.info("Windows 用户名");
  log.message(`当前登录用户名: ${sshUser}(用于 Linux 端 ssh 登录)`);

  // (b) IPv4 地址列表
  log.info("本机 IPv4 地址");
  if (ipList.length === 0) {
    log.message("    未检测到可用的 IPv4 地址");
  } else {
    for (const entry of ipList) {
      log.message(`    ${entry.ip}(${entry.iface})`);
    }
  }

  // (c) 为每个 IP 拼接一条 Linux 端可直接执行的 ssh 命令（末尾标注网卡名）
  log.info("Linux 端连接本机命令(免密登录)示例");
  const keyPath = "~/.ssh/id_mcp_server";
  if (ipList.length === 0) {
    log.message(`    ssh -i ${keyPath} ${sshUser}@<Windows_IP>`);
  } else {
    for (const entry of ipList) {
      log.message(
        `    ssh -i ${keyPath} ${sshUser}@${entry.ip}(${entry.iface})`
      );
    }
  }
  log.success("以上信息可直接在 Linux 端使用，确保已生成专用密钥并配置 sshd");
  log.message(
    "    首次连接会提示主机密钥确认(Are you sure you want to continue connecting?)，输入 yes 即可，之后不再询问"
  );
  log.message(
    `    确保已依次执行 [${MENU_INSTALL_SSH}] 安装 → [${MENU_GENERATE_KEY}] 生成密钥 → [${MENU_CONFIG_SSHD}] 配置 sshd, 连接才能免密成功`
  );
}

// ============================================================
// step7: 生成 Linux 端 MCP 配置模板
// ============================================================

/**
 * @brief 生成 Linux 端 Claude Code 的 .mcp.json 配置模板
 * @details 自动采集本机用户名与 IPv4 地址，结合专用密钥名（id_mcp_server）与
 *          remote-start-mcp.bat 脚本路径，生成一份 Linux 端可直接使用的
 *          .mcp.json 模板，写入 .embedded/ssh/mcp-remote-template.json。
 *
 *          生成后打印模板路径与内容摘要，提示用户复制到 Linux 端项目根目录
 *          并按需修改 IP / 脚本路径。多网卡时取首个 IP 作为示例，同时在模板
 *          注释中列出其它候选 IP。
 */
async function doGenerateTemplate(): Promise<boolean> {
  log.info("开始生成 Linux 端 MCP 配置模板");

  const { sshUser, ipList } = collectConnectionInfo();

  if (ipList.length === 0) {
    log.message("    未检测到可用的 IPv4 地址，无法生成模板");
    log.message("    请确认网络连接正常后重试");
    return false;
  }

  // 取首个 IP 作为模板默认值，其余 IP 在提示中列出
  const primaryIp = ipList[0].ip;
  const keyPath = "~/.ssh/id_mcp_server";

  // Windows 上 remote-start-mcp.bat 的绝对路径（模板中用户需确认与修改）
  // 统一用正斜杠：JSON 无需转义反斜杠，视觉清爽，且 Windows 的 node / ssh
  // 完全支持正斜杠路径（node 内部 path 与 spawn 均做归一化）
  const batPath = join(resolve(process.cwd()), "remote-start-mcp.bat").replace(
    /\\/g,
    "/"
  );

  // 构造 .mcp.json 模板内容
  // prettier-ignore
  const template = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    mcpServers: {
      "embedded-board": {
        command: "ssh",
        args: [
          "-i",
          keyPath,
          `${sshUser}@${primaryIp}`,
          batPath,
        ],
      },
    },
  };
  // 序列化（2 空格缩进，与项目 .mcp.json 风格一致）
  const content = JSON.stringify(template, null, 2) + "\n";

  // 写入 .embedded/ssh/mcp-remote-template.json
  const templatePath = resolve(process.cwd(), REMOTE_MCP_TEMPLATE_REL);
  const templateDir = dirname(templatePath);
  if (!existsSync(templateDir)) {
    mkdirSync(templateDir, { recursive: true });
  }
  writeFileSync(templatePath, content, "utf8");

  // 生成结果
  log.info("Windows 用户名和IP地址");
  log.message(`    Windows 用户名: ${sshUser}`);
  log.message(`    模板默认 IP:   ${primaryIp}`);
  if (ipList.length > 1) {
    log.message("    其它可用 IP:");
    for (const entry of ipList.slice(1)) {
      log.message(`      ${entry.ip}（${entry.iface}）`);
    }
  }
  log.success(`模板已生成: ${templatePath}`);

  // 使用步骤
  log.info("使用步骤");
  log.message(
    `    1. 将 ${templatePath} 复制到 Linux 项目根目录并重命名为 .mcp.json`
  );
  log.message("    2. 按需修改以下内容：");
  log.message(
    `       - ssh 连接的 IP（当前为 ${primaryIp}，若不通换用其它候选 IP）`
  );
  log.message(`       - remote-start-mcp.bat 的绝对路径（当前为 ${batPath}）`);
  log.message("    3. 在 Linux 端重启 Claude Code 使配置生效");
  log.message(
    "    注意: MCP 客户端首次连接 Windows 会触发主机密钥确认，需先在 Linux 端手动执行一次 ssh 连接并输入 yes 完成信任，之后客户端即可自动免密连接"
  );
  log.message(
    `    前置条件：已依次执行 [${MENU_INSTALL_SSH}] 安装 → [${MENU_GENERATE_KEY}] 生成密钥 → [${MENU_CONFIG_SSHD}] 配置 sshd`
  );
  log.message("    否则 ssh 连接会失败（密码提示 / 连接拒绝）");

  // 模板内容预览（box 包裹，标题作为独立节点）
  log.info("模板内容如下");
  box(content.replace(/\n$/, ""), "模板内容预览");
  return true;
}

// ============================================================
// step8: 一键完成全流程
// ============================================================

/**
 * @brief 一键完成全流程：安装 → 生成密钥 → 配置 sshd → 生成模板
 * @details 顺序调用四个 step 函数，任一步返回 false 即中止并提示。
 *          安装方式选择（MSI / 在线）仍会交互式询问。
 * @returns 整体是否全部成功完成
 */
async function doOneClickFlow(): Promise<boolean> {
  log.info("一键完成全流程 ...");

  if (!(await doInstallSsh())) {
    log.message("    安装步骤未完成，中止流程");
    return false;
  }
  if (!(await doGenerateKey())) {
    log.message("    生成密钥步骤未完成，中止流程");
    return false;
  }
  if (!(await doConfigSshd())) {
    log.message("    配置 sshd 步骤未完成，中止流程");
    return false;
  }
  if (!(await doGenerateTemplate())) {
    log.message("    生成模板步骤未完成，中止流程");
    return false;
  }

  log.success("全流程已完成，可从 Linux 免密登录 Windows");
  return true;
}

// ============================================================
// 主入口
// ============================================================

/**
 * @brief 打印命令 banner（标题分隔线）
 * @details 每次清屏后重新显示，作为菜单顶部固定的标题栏。
 */
function printBanner(): void {
  console.log("===================================");
  console.log("  embedded-mcp-toolkit sshd-config");
  console.log("===================================");
}

/**
 * @brief sshd-config 命令主入口
 * @details 执行流程：平台校验 → 管理员权限检查 → 交互式菜单循环。
 *          非管理员或非 Windows 平台直接退出，不进入菜单。
 * @param opts 命令选项（本期为空，预留扩展）
 */
export async function runSshdConfig(opts: SshdConfigOptions): Promise<void> {
  // 显式标记预留参数本期不使用，后续扩展时移除此行
  void opts;
  // 平台校验
  if (!isWindows()) {
    console.error("[err] 本命令仅支持 Windows");
    return;
  }

  // 管理员权限检查：非管理员时自动 UAC 提权重启（本进程退出）
  if (!isAdmin()) {
    relaunchAsAdmin();
    return; // relaunchAsAdmin 内部会 exit，此行仅作类型安全兜底
  }

  // 交互式菜单循环（每轮清屏 + 打印 banner，clack select 渲染菜单）
  while (true) {
    clearScreen();
    printBanner();
    const choice = await mainMenu();

    // 用户在主菜单 Ctrl+C 取消，或选择退出
    if (choice === null || choice === MENU_EXIT) {
      console.log("[info] 再见");
      return;
    }

    switch (choice) {
      case MENU_ONE_CLICK:
        await doOneClickFlow();
        break;
      case MENU_INSTALL_SSH:
        await doInstallSsh();
        break;
      case MENU_GENERATE_KEY:
        await doGenerateKey();
        break;
      case MENU_CONFIG_SSHD:
        await doConfigSshd();
        break;
      case MENU_CHECK_STATUS:
        await doCheckStatus();
        break;
      case MENU_UNINSTALL_SSH:
        await doUninstallSsh();
        break;
      case MENU_SHOW_INFO:
        await doShowConnectionInfo();
        break;
      case MENU_GEN_TEMPLATE:
        await doGenerateTemplate();
        break;
      default:
        // clack select 只会返回已定义的 value，理论上不会进入 default；
        // 保留兜底分支以防后续扩展遗漏
        break;
    }

    // step 执行完毕：按 Enter 回到菜单（清屏），按 q 退出
    if (await pauseForMenu()) {
      console.log("[info] 再见");
      return;
    }
  }
}
