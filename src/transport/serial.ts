import { SerialPort } from "serialport";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "fs";
import { dirname } from "path";
import { MAX_BUFFER_SIZE } from "../infra/constants.js";
import { logTimestamp } from "../utils/timestamp.js";
import { interactiveLoop } from "./loop.js";
import { sanitize } from "../utils/terminal-sanitizer.js";
import { PshState, PshStateMachine } from "./psh.js";
import { KeyProvider } from "../utils/key-provider.js";
import { getKeyProviderConfig } from "../infra/config.js";
import {
  UserLoginStatus,
  UserLoginResult,
  UserLoginHandler,
  UserLoginStateMachine,
  UserLoginStepDelays,
} from "./user-login.js";

/**
 * @brief 串口 Shell 连接配置
 *
 * @param port     串口设备路径（如 COM3、/dev/ttyUSB0）
 * @param baudRate 波特率（默认 115200）
 * @param dataBits 数据位（5/6/7/8，默认 8）
 * @param stopBits 停止位（1/1.5/2，默认 1）
 * @param parity   校验位（none/even/odd，默认 none）
 */
export interface SerialShellConfig {
  port: string;
  baudRate?: number;
  dataBits?: 8 | 5 | 6 | 7;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd";
  /** 命令追加的换行符（\n, \r\n），默认 \n */
  lineEnding?: string;
  /** 串口登录用户名（用于 userLoginDemoSerial 等需要串口认证的场景） */
  loginUsername?: string;
  /** 串口登录密码（用于 userLoginDemoSerial 等需要串口认证的场景） */
  loginPassword?: string;
}

/**
 * @brief 串口交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过串口与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */

export class SerialShell {
  #serialPort: SerialPort | null = null;
  #buffer = "";

  // 输出收集开关：由 open/write 控制，为 true 时接收到的数据才会写入 #buffer
  #collecting = false;
  // 缓冲区溢出策略：false=丢弃新数据(保留旧)，true=覆盖最早数据(保留新)
  #overflow = false;
  // 串口连接配置（端口号、波特率、数据位等）
  #config: SerialShellConfig;
  // 数据日志文件写入流（通过 enableFileLogging 激活）
  #logStream: WriteStream | null = null;
  // 日志行缓冲区：串口数据按物理时序分 chunk 到达，一行可能被拆成多次 "data" 事件。
  // 缓冲不完整行，遇换行符时整行输出，保证同一行只有一个时间戳（该行实际到达完成的时刻）。
  #logLineBuf = "";

  /**
   * @brief 构造函数
   * @param config 串口连接配置
   */
  constructor(config: SerialShellConfig) {
    this.#config = config;
  }

  /** @brief 获取当前串口设备路径 */
  getPort(): string {
    return this.#config.port;
  }

  /**
   * @brief 启用串口数据写入日志文件
   *
   * 将串口接收到的所有原始数据实时写入指定日志文件，
   * 与内存缓冲区 #buffer 并行工作，互不影响。
   *
   * @param logPath 日志文件完整路径（目录会自动创建）
   */
  enableFileLogging(logPath: string): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.#logStream = createWriteStream(logPath, { flags: "a" });
  }

  /**
   * @brief 关闭数据日志文件流
   */
  disableFileLogging(): void {
    if (this.#logStream) {
      // 将缓冲区中剩余的不完整行写入
      if (this.#logLineBuf) {
        this.#logStream.write(`${logTimestamp()} ${this.#logLineBuf}\n`);
        this.#logLineBuf = "";
      }
      this.#logStream.end();
      this.#logStream = null;
    }
  }

  /**
   * @brief 向缓冲区追加数据（内部方法）
   *
   * 根据 #collecting 和 #overflow 状态决定数据写入行为：
   * - #collecting=false：未开启收集，丢弃数据
   * - #collecting=true, #overflow=false（clear=1 模式）：
   *   缓冲区满时丢弃新数据，保留已有内容
   * - #collecting=true, #overflow=true（clear=0 模式）：
   *   缓冲区满时覆盖最早的数据，保留最新内容
   *
   * @param data 待追加的文本数据
   */
  #appendBuffer(data: string): void {
    if (!this.#collecting) return;
    this.#buffer += data;
    if (this.#buffer.length > MAX_BUFFER_SIZE) {
      if (this.#overflow) {
        // 覆盖模式：保留最新的 MAX_BUFFER_SIZE 字节
        this.#buffer = this.#buffer.slice(-MAX_BUFFER_SIZE);
      } else {
        // 丢弃模式：截断到 MAX_BUFFER_SIZE，丢弃溢出部分
        this.#buffer = this.#buffer.substring(0, MAX_BUFFER_SIZE);
      }
    }
  }

  /**
   * @brief 打开串口连接并启动交互式 shell
   *
   * 打开串口设备，注册数据监听。
   * 此时不收集输出数据，需调用 write() 后才开始收集。
   * https://serialport.io/docs/guide-usage
   * @return 串口启动时的初始输出（banner / prompt）
   */
  async open(): Promise<string> {
    const serialPort = new SerialPort({
      path: this.#config.port,
      baudRate: this.#config.baudRate ?? 115200,
      dataBits: (this.#config.dataBits ?? 8) as 8 | 5 | 6 | 7,
      stopBits: (this.#config.stopBits ?? 1) as 1 | 1.5 | 2,
      parity: (this.#config.parity ?? "none") as "none" | "even" | "odd",
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      serialPort.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this.#serialPort = serialPort;
    this.#collecting = false;

    // 监听串口数据接收事件：将收到的二进制数据转为字符串后追加到内部缓冲区
    serialPort.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#appendBuffer(text);
      // 若启用了文件日志，按行写入（缓冲不完整行，遇换行符时输出带时间戳的完整行）
      if (this.#logStream) {
        this.#logLineBuf += text;
        const lines = this.#logLineBuf.split("\n");
        this.#logLineBuf = lines.pop() ?? "";
        for (const line of lines) {
          this.#logStream.write(`${logTimestamp()} ${line.replace(/\r/g, "")}\n`);
        }
      }
    });
    // 关闭事件：串口被物理断开或系统关闭时触发，清空句柄防止野指针
    serialPort.on("close", () => {
      this.#serialPort = null;
    });
    // 错误事件：串口通信出错时触发，清空句柄
    serialPort.on("error", () => {
      this.#serialPort = null;
    });

    // 打开后短暂收集 banner 输出（如登录提示、shell 提示符），然后停止收集
    this.#collecting = true;
    await new Promise((r) => setTimeout(r, 500));
    const banner = this.#buffer;
    this.#buffer = "";
    this.#collecting = false;
    this.#overflow = false;
    return banner;
  }

  /**
   * @brief 向串口 shell 发送命令
   *
   * 发送命令到串口执行，同时控制缓冲区的清空与溢出行为。
   *
   * @param cmd   要执行的命令字符串
   * @param clear 清空标志，控制缓冲区行为：
   *              - 1（默认）：清空缓冲区后开始收集，写满时丢弃新数据
   *              - 0：不清空缓冲区，继续追加写入，写满时覆盖最早的数据
   */
  write(cmd: string, clear: number = 1): void {
    if (!this.#serialPort || !this.#serialPort.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    if (clear) {
      this.#buffer = "";
      this.#overflow = false;
    } else {
      this.#overflow = true;
    }
    this.#collecting = true;
    this.#serialPort.write(`${cmd}${this.#config.lineEnding ?? "\n"}`);
  }

  /**
   * @brief 发送原始数据到串口（不追加换行符）
   *
   * 用于发送控制字符等场景，如 "\x15"（Ctrl+u）、"\x03"（Ctrl+C）等。
   *
   * @param data  要发送的原始字符串
   * @param clear 清空标志（同 write），默认 1
   */
  sendRaw(data: string, clear: number = 1): void {
    if (!this.#serialPort || !this.#serialPort.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    if (clear) {
      this.#buffer = "";
      this.#overflow = false;
    } else {
      this.#overflow = true;
    }
    this.#collecting = true;
    this.#serialPort.write(data);
  }

  /**
   * @brief 读取缓冲区中的输出数据
   *
   * 返回缓冲区内容，并根据 clear 参数决定是否清空缓冲区。
   *
   * @param clear 清空标志，控制读取后缓冲区状态：
   *              - 1（默认）：读取后清空缓冲区，下次 read() 返回新数据
   *              - 0：读取后保留缓冲区内容，下次 read() 仍可获取相同数据
   * @return 缓冲区中的文本内容
   */
  read(clear: number = 1): string {
    const data = this.#buffer;
    if (clear) {
      this.#buffer = "";
      this.#overflow = false;
      this.#collecting = false;
    }
    return data;
  }

  /**
   * @brief 关闭串口连接
   *
   * 释放所有资源，清空缓冲区，关闭日志文件流。
   */
  async close(): Promise<void> {
    this.disableFileLogging();
    if (this.#serialPort) {
      const port = this.#serialPort;
      this.#serialPort = null;
      await new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          try {
            port.destroy();
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        port.close((err) => {
          clearTimeout(timeout);
          if (err) console.error("Serial close error:", err.message);
          resolve();
        });
      });
    }
    this.#buffer = "";
    this.#collecting = false;
    this.#overflow = false;
  }
}

/**
 * @brief 交互式串口 Shell 命令行入口
 *
 * 打开串口连接，从标准输入循环读取命令并发送，
 * 读取输出并显示，按 Ctrl+C 时断开连接并退出。
 *
 * @param config 串口连接配置
 */
export async function interactiveSerialShell(
  config: SerialShellConfig
): Promise<void> {
  const shell = new SerialShell(config);

  const banner = await shell.open();
  if (banner) process.stdout.write(banner);
  console.log(
    "\n--- Serial shell ready. Send commands with write(), read() to get output. ---\n"
  );

  await interactiveLoop(shell, "serial");
}

/**
 * @brief 用户串口登录演示
 *
 * 自动探测串口终端是否需要登录，并在需要时完成用户名/密码认证。
 *
 * 流程：
 *   1. 打开串口，读取 banner，失败则返回错误
 *   2. 检查 banner 是否含有 "login:" —— 有则直接进入步骤5发送用户名
 *   3. 无 "login:" 则发送 echo __SH_STATUS_PROBE__ 探测
 *      - 收到 __SH_STATUS_PROBE__：不需要登录，提示英文信息并结束
 *      - 收到 Password:：进入步骤4
 *   4. 当前因探测命令进入 Password: 状态，写入一次 echo 命令
 *      - 含 incorrect：表示下一次可正常输入用户名，进入步骤5
 *      - 否则：返回状态异常
 *   5. 发送配置文件中的用户名，等待输出
 *      - 含 Password:：进入步骤6输入密码
 *      - 不含：返回登录异常
 *   6. 输入密码，检测是否含 incorrect
 *      - 含：密钥错误，返回提示重试
 *      - 不含：再发 echo __SH_STATUS_PROBE__ 验证，若收到则登录成功
 *
 * @param config 串口连接配置（需包含 loginUsername / loginPassword）
 */
export async function userLoginDemoSerial(
  config: SerialShellConfig,
  stepDelays?: UserLoginStepDelays
): Promise<UserLoginResult> {
  console.log("[userLoginDemoSerial] === Starting user login demo ===\n");

  const shell = new SerialShell(config);

  // ===== 步骤 1：打开串口连接，读取启动信息（banner） =====
  console.log(
    `[Step 1] Opening ${config.port} @ ${config.baudRate ?? 115200} ...`
  );
  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[Step 1] Open serial failed:", errorMsg);
    await shell.close().catch(() => { });
    return {
      success: false,
      status: UserLoginStatus.ERROR,
      output: "",
      error: errorMsg,
    };
  }
  console.log("[Step 1] --- Serial Banner ---\n%s\n---", sanitize(banner));

  // ===== 步骤 2~4：状态机驱动探测与状态分析 =====
  const sm = new UserLoginStateMachine();
  let action = sm.start(banner);

  while (!action.done) {
    // action.send!   : ! 是 TS 非空断言 —— done=false 时 send 一定有值，消除编译报错
    // write(..., 1)  : 1 是 clear 参数 —— 写之前清空读缓冲区，确保只读到本次命令的响应
    shell.write(action.send!, 1);
    await new Promise((resolve) => setTimeout(resolve, action.waitMs));
    const output = shell.read(1);
    console.log("[SM] probe output =\n%s", sanitize(output));
    action = sm.feed(output);
  }

  console.log("[SM] terminal state = %s", action.state);

  // ===== 根据状态机终态决定后续动作 =====
  switch (action.state) {
    case UserLoginStatus.NO_LOGIN_REQUIRED:
      console.log("No login required! Entering interactive shell.\n");
      await interactiveLoop(shell, "serial");
      return {
        success: true,
        status: UserLoginStatus.NO_LOGIN_REQUIRED,
        output: "",
      };

    case UserLoginStatus.WAITING_USERNAME: {
      const handler = new UserLoginHandler({
        username: config.loginUsername ?? "",
        password: config.loginPassword ?? "",
      });
      const result = await handler.login(shell, undefined, stepDelays);
      if (result.success) {
        console.log("Login succeeded! Entering interactive shell.\n");
        await interactiveLoop(shell, "serial");
      } else {
        await shell.close();
      }
      return result;
    }

    default: {
      let error = "无法识别终端状态";
      if (action.state === UserLoginStatus.ERROR) {
        error = "状态机检测异常";
      }
      await shell.close();
      return {
        success: false,
        status: action.state,
        output: "",
        error,
      };
    }
  }
}

/**
 * @brief PSH 探测 + 解锁演示（串口方式）
 *
 * 使用 PshStateMachine 状态机替代 if-else 嵌套判断:
 *   1. 打开串口，读取 banner
 *   2. 状态机 start(banner) → 自动匹配 profile
 *   3. 未匹配到则发探测 → feed(channel, output) → 再次匹配
 *   4. 匹配成功后自动 detect 状态 → UNKNOWN 时自动 probeState
 *   5. 状态明确后根据终态决定解锁或直接进入交互
 *
 * 环境变量：
 *   SERIAL_PORT, SERIAL_BAUDRATE
 *   KEY_PROVIDER (file|terminal), CHALLENGE_FILE, KEY_FILE
 *
 * @param config 串口连接配置（可选，未提供时从环境变量读取默认值）
 */
export async function pshDemoSerial(config: SerialShellConfig): Promise<void> {
  // ===== 步骤 1：打开串口连接，读取启动信息（banner） =====
  console.log("[Step 1] === PSH Unlock Demo (Serial) ===\n");

  console.log(
    `[Step 1] Opening ${config.port} @ ${config.baudRate ?? 115200} ...`
  );
  const shell = new SerialShell(config);
  const banner = await shell.open();
  console.log("[Step 1] --- Serial Banner ---\n%s\n---", sanitize(banner));

  // ===== 步骤 2~3：状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("serial");
  let action = sm.start(banner);

  while (!action.done) {
    shell.write(action.send!, 1);
    await new Promise((r) => setTimeout(r, action.waitMs));
    const output = shell.read(1);
    console.log("[SM] probe output =", sanitize(output));
    action = await sm.feed(shell, output);
  }

  console.log("[SM] terminal state = %s", action.state);

  // ===== 步骤 4~5：根据状态机终态决定后续动作 =====
  const handler = action.handler;

  switch (action.state) {
    case PshState.LOCKED: {
      if (!handler) {
        console.log("[Step 4] LOCKED but no handler — abort.");
        break;
      }
      console.log(
        "[Step 4] Matched profile: %s (%s)\n",
        handler.profile.name,
        handler.profile.description
      );

      if (action.detectResult) {
        console.log("[Step 4] Challenge      : %s\n",
          action.detectResult.challengeCode ?? "(none)");
      }

      const keyProvider = new KeyProvider(getKeyProviderConfig("serial"));

      const result = await handler.unlock(
        shell,
        "",
        1500,
        (output: string) => keyProvider.getKey(output)
      );

      console.log("[Step 4] Unlock result:");
      console.log("            success      : %s", result.success);
      console.log("            state        : %s", result.state);
      console.log(
        "            challenge    : %s",
        result.challengeCode ?? "(none)"
      );
      console.log(
        "            attemptsLeft : %s",
        result.attemptsLeft ?? "(none)"
      );
      console.log("            error        : %s", result.error ?? "(none)");

      if (result.success) {
        console.log(
          "[Step 4] Unlock succeeded! Entering interactive shell.\n"
        );
        await interactiveLoop(shell, "serial");
      } else if (result.attemptsLeft && result.attemptsLeft > 0) {
        console.log(
          "[Step 4] Hint: wrong password, %d attempt(s) remaining.",
          result.attemptsLeft
        );
      }
      break;
    }

    case PshState.READY:
      console.log("[Step 4] Shell is already unlocked, entering interactive shell.\n");
      await interactiveLoop(shell, "serial");
      break;

    case PshState.UNLOCKING:
      console.log(
        "[Step 4] Shell is in UNLOCKING state — a password prompt was left dangling."
      );
      break;

    case PshState.ERROR:
      console.log(
        "[Step 4] Shell is in ERROR state (previous unlock may have failed)."
      );
      break;

    default:
      if (handler) {
        console.log(
          "[Step 4] Matched profile '%s' but state is %s — no unlock performed.",
          handler.profile.name,
          action.state
        );
      } else {
        console.log(
          "[Step 4] No PSH profile matched — shell may already be unlocked."
        );
      }
      break;
  }

  // ===== 关闭串口 =====
  console.log("[Step 5] === Demo complete ===");
  await shell.close();
}
