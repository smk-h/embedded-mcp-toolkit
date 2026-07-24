import { SerialPort } from "serialport";

import { interactiveLoop } from "./loop.js";
import { BaseShell } from "./base-shell.js";
import { sanitize } from "../utils/terminal-sanitizer.js";
import { PshState, PshStateMachine } from "../services/psh.js";
import { KeyProvider } from "../services/key-provider.js";
import { getKeyProviderConfig } from "../shared/config.js";
import {
  UserLoginStatus,
  UserLoginResult,
  UserLoginHandler,
  UserLoginStateMachine,
  UserLoginStepDelays,
} from "../services/user-login.js";

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
  /** 设备别名（可选，用于会话注册和列表展示） */
  deviceName?: string;
}

/**
 * @brief 串口交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过串口与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */

export class SerialShell extends BaseShell {
  #serialPort: SerialPort | null = null;
  #config: SerialShellConfig;
  /** @brief 二进制旁路接收回调，默认 null（未启用时 data 监听仅走文本态路径） */
  #rawReceiver: ((b: Buffer) => void) | null = null;

  /** @brief SSH/Serial 通道的 banner 采集等待时长 */
  protected bannerWaitMs = 500;

  /**
   * @brief 写入时的换行符
   *
   * 覆盖基类默认值 "\n"，使用 config.lineEnding（默认仍为 "\n"）。
   */
  protected get lineEnding(): string {
    return this.#config.lineEnding ?? "\n";
  }

  /**
   * @brief 构造函数
   * @param config 串口连接配置
   */
  constructor(config: SerialShellConfig) {
    super();
    this.#config = config;
  }

  /** @brief 获取当前串口设备路径 */
  getPort(): string {
    return this.#config.port;
  }

  /** @brief 获取设备别名，未配置时返回 "(unknown)" */
  getDeviceName(): string {
    return this.#config.deviceName ?? "(unknown)";
  }

  /**
   * @brief 向串口发送原始数据（不追加换行、不碰文本态缓冲）
   *
   * 既是基类模板方法 write() 的发送子步骤（payload 为已拼换行的 string），
   * 也供 ZMODEM 等二进制协议直接写字节（payload 为 Buffer）。
   * serialport.write 本就接受 string | Buffer，两种形态共用一条出口。
   *
   * 注：相对基类的 protected 抽象方法，此处提为 public，
   * 让 services/zmodem 层能直接发送 ZMODEM 帧，无需另造 public 别名。
   *
   * @param payload 已拼换行的文本，或原始字节 Buffer
   * @throws 串口未打开时抛出 "Serial not open. Call open() first."
   */
  rawWrite(payload: string | Buffer): void {
    if (!this.#serialPort || !this.#serialPort.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    this.#serialPort.write(payload);
  }

  /**
   * @brief 挂载 / 卸载原始字节接收回调
   *
   * 挂载后（cb 非空），串口 data 事件改为"双写"：
   *   - 原始 Buffer 喂给 cb（ZMODEM 协议层消费）
   *   - 仍按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
   * 卸载（cb=null 或调用返回的卸载函数）后恢复纯文本态。
   *
   * @param cb 字节接收回调；传 null 卸载
   * @returns 卸载函数，调用后移除回调
   */
  attachRawReceiver(cb: ((b: Buffer) => void) | null): () => void {
    this.#rawReceiver = cb;
    return () => {
      if (this.#rawReceiver === cb) this.#rawReceiver = null;
    };
  }

  /**
   * @brief 打开串口连接，注册数据监听
   *
   * 模板方法 acquire：打开串口设备，注册 data/close/error 监听。
   * 不负责 banner 采集（由基类 open 统一处理）。
   * https://serialport.io/docs/guide-usage
   */
  protected async acquire(): Promise<void> {
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
    // 监听串口数据接收事件：双写策略
    //   - #rawReceiver 非空时，原始 Buffer 喂给二进制旁路（ZMODEM 等协议消费）
    //   - 始终按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
    // #rawReceiver 默认 null，此时与改动前逐字一致（只走 appendData 路径）
    serialPort.on("data", (data: Buffer) => {
      if (this.#rawReceiver) this.#rawReceiver(data);
      this.appendData(data.toString());
    });
    // 关闭事件：串口被物理断开或系统关闭时触发，清空句柄防止野指针
    serialPort.on("close", () => {
      this.#serialPort = null;
    });
    // 错误事件：串口通信出错时触发，清空句柄
    serialPort.on("error", () => {
      this.#serialPort = null;
    });
  }

  /**
   * @brief 发送原始数据到串口（不追加换行符）
   *
   * 调用继承的 write(data, clear, false)，等价于不追加换行。
   * 用于发送控制字符等场景，如 "\x15"（Ctrl+u）、"\x03"（Ctrl+C）等。
   *
   * @param data  要发送的原始字符串
   * @param clear 清空标志（同 write），默认 1
   */
  sendRaw(data: string, clear: number = 1): void {
    this.write(data, clear, false);
  }

  /**
   * @brief 关闭串口连接
   *
   * 含 2s 超时 + destroy 兜底，防止串口关闭卡住。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
    // 释放时清理二进制旁路回调，防止野指针（ZMODEM 会话结束后回调不应再触发）
    this.#rawReceiver = null;
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
    await shell.close().catch(() => {});
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
        console.log(
          "[Step 4] Challenge      : %s\n",
          action.detectResult.challengeCode ?? "(none)"
        );
      }

      const keyProvider = new KeyProvider(getKeyProviderConfig("serial"));

      const result = await handler.unlock(shell, "", 1500, (output: string) =>
        keyProvider.getKey(output)
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
        console.log("[Step 4] Unlock succeeded! Entering interactive shell.\n");
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
      console.log(
        "[Step 4] Shell is already unlocked, entering interactive shell.\n"
      );
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
