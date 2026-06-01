import { SerialPort } from "serialport";
import { MAX_BUFFER_SIZE } from "../infra/constants.js";
import { interactiveLoop } from "./loop.js";
import { sanitize } from "../utils/terminal-sanitizer.js";
import { PshHandler, PshState } from "./psh.js";
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

  #collecting = false; // 是否开启输出收集，open/write 控制
  #overflow = false; // 缓冲区满时是否覆盖最早数据（clear=0 时为 true，允许覆盖）
  #config: SerialShellConfig; // 串口连接配置

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
   *
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

    serialPort.on("data", (data: Buffer) => {
      this.#appendBuffer(data.toString());
    });
    serialPort.on("close", () => {
      this.#serialPort = null;
    });
    serialPort.on("error", () => {
      this.#serialPort = null;
    });

    // 收集 banner 后停止
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
   * 释放所有资源，清空缓冲区。
   */
  async close(): Promise<void> {
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
    // 状态机要求发探测命令
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
 * 流程：
 *   1. 打开串口连接，读取 banner
 *   2. 自动匹配 PSH profile（psh / psh_busybox）
 *   3. 探测当前 PSH 状态
 *   4. 如状态为 LOCKED，发送 debug 命令，
 *      将 QR 码 + Base64 Challenge 写入 challenge.txt
 *   5. 轮询 password_input.txt 等待外部工具写入密钥
 *   6. 发送密钥完成解锁，输出结果
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
  shell.write("exit", 1); // 会清空之前的内容

  // ===== 步骤 2：自动识别 PSH profile =====
  // 串口设备可能已运行很久，banner 只有内核日志，没有 PSH 特征
  // 用 echo 命令探测：PSH 锁定状态下会返回 "Not Supported" 之类的错误
  let handler = PshHandler.matchFromOutput(banner);
  let detectOutput = banner;

  if (!handler) {
    console.log(
      "[Step 2] No PSH profile matched from banner, probing with echo..."
    );
    shell.write("echo __PSH_PROBE__", 1);
    await new Promise((r) => setTimeout(r, 1500));
    const probeOutput = shell.read(1);
    console.log("[Step 2] probeOutput =", sanitize(probeOutput));
    detectOutput = banner + "\n" + probeOutput;
    handler = PshHandler.matchFromOutput(detectOutput);
  }

  if (!handler) {
    console.log(
      "[Step 2] No PSH profile matched — shell may already be unlocked or not a PSH device."
    );
    await shell.close();
    return;
  }
  console.log(
    "[Step 2] Matched profile: %s (%s)\n",
    handler.profile.name,
    handler.profile.description
  );

  // ===== 步骤 3：探测 PSH 当前状态 =====
  let detect = handler.detect(detectOutput);
  console.log("[Step 3] Detected state : %s", detect.state);
  console.log("[Step 3] Is PSH         : %s", detect.isPsh);
  console.log(
    "[Step 3] Challenge      : %s\n",
    detect.challengeCode ?? "(none)"
  );

  if (detect.state === PshState.UNKNOWN) {
    console.log("[Step 3] State is UNKNOWN, sending probe command...");
    detect = await handler.probeState(shell);
    console.log("[Step 3] After probe    : %s", detect.state);
  }

  // ===== 步骤 4：根据状态执行对应操作 =====
  if (detect.state === PshState.LOCKED) {
    console.log("[Step 4] === Starting unlock sequence ===\n");

    const keyProvider = new KeyProvider(getKeyProviderConfig("serial"));

    const result = await handler.unlock(
      shell,
      "", // key 参数用不到（走 onKeyRequest 回调）
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
        "[Step 4] Unlock succeeded! Entering interactive shell. Type commands and press Enter. Press Ctrl+C to exit.\n"
      );
      await interactiveLoop(shell, "serial");
    } else if (result.attemptsLeft && result.attemptsLeft > 0) {
      console.log(
        "[Step 4] Hint: wrong password, %d attempt(s) remaining. Re-run to try again.",
        result.attemptsLeft
      );
    }
  } else if (detect.state === PshState.READY) {
    console.log("[Step 4] Shell is already unlocked, no action needed.");
  } else if (detect.state === PshState.ERROR) {
    console.log(
      "[Step 4] Shell is in ERROR state (previous unlock may have failed)."
    );
  } else if (detect.state === PshState.UNLOCKING) {
    console.log(
      "[Step 4] Shell is in UNLOCKING state — a password prompt was left dangling."
    );
  }

  // ===== 步骤 5：解锁后验证（已在步骤 4 内完成解锁后验证） =====
  console.log("[Step 5] Post-unlock verification done");

  // ===== 步骤 6：关闭串口，演示结束 =====
  console.log("[Step 6] === Demo complete ===");
  await shell.close();
}
