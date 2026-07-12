import { stat, unlink } from "node:fs/promises";

import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
  type Stats,
} from "ssh2";

import { interactiveLoop } from "./loop.js";
import { OutputBuffer } from "./output-buffer.js";
import { sanitize } from "../utils/terminal-sanitizer.js";
import { PshState, PshStateMachine } from "../services/psh.js";
import { KeyProvider } from "../services/key-provider.js";
import { getKeyProviderConfig } from "../shared/config.js";
import { FileLogger } from "../shared/file-logger.js";

/**
 * @brief SSH Shell 连接配置
 *
 * @param host       目标主机地址
 * @param port       SSH 端口，默认 22
 * @param username   登录用户名
 * @param password   密码认证（与 privateKey 二选一）
 * @param privateKey 密钥认证（与 password 二选一）
 * @param passphrase 密钥解密口令（privateKey 加密时需要）
 * @param deviceName 设备别名（可选，用于会话注册和列表展示）
 */
export interface SSHShellConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  deviceName?: string;
}

/**
 * @brief 文件传输结果摘要
 *
 * 由 SSHShell 的 uploadFile / downloadFile 返回，
 * 工具层据此格式化为 MCP 文本响应。
 */
export interface TransferResult {
  direction: "upload" | "download"; // 传输方向：upload 本地→远端，download 远端→本地
  localPath: string; // 本地文件路径
  remotePath: string; // 远端文件路径
  bytes: number; // 传输字节数（源文件大小）
  durationMs: number; // 耗时（毫秒）
  success: boolean; // 是否成功
  error?: string; // 失败时的错误信息（成功时为 undefined）
}

/**
 * @brief SSH 交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过 SSH 协议与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */
export class SSHShell {
  #client: Client | null = null;
  #stream: ClientChannel | null = null;
  #sftp: SFTPWrapper | null = null; // 懒加载的 SFTP 子系统，首次文件传输时才建立
  #output = new OutputBuffer();
  #config: SSHShellConfig;

  /** @brief 文件日志记录器，用于将 shell 输出写入本地文件 */
  readonly fileLogger = new FileLogger();

  /**
   * @brief 构造函数
   * @param config SSH 连接配置
   */
  constructor(config: SSHShellConfig) {
    this.#config = config;
  }

  /** @brief 获取 SSH 目标主机地址 */
  getHost(): string {
    return this.#config.host;
  }

  /** @brief 获取 SSH 端口号，未配置时返回默认值 22 */
  getPort(): number {
    return this.#config.port ?? 22;
  }

  /** @brief 获取 SSH 登录用户名 */
  getUsername(): string {
    return this.#config.username;
  }

  /** @brief 获取设备别名，未配置时返回 "(unknown)" */
  getDeviceName(): string {
    return this.#config.deviceName ?? "(unknown)";
  }

  /**
   * @brief 打开 SSH 连接并启动交互式 shell
   *
   * 建立 SSH 连接，分配 PTY 伪终端，启动远端登录 shell。
   * 此时不收集输出数据，需调用 write() 后才开始收集。
   *
   * @return shell 启动时的初始输出（banner / prompt）
   */
  async open(): Promise<string> {
    const client = new Client(); // 创建 ssh2 Client

    await new Promise<void>((resolve, reject) => {
      client.on("ready", () => resolve());
      client.on("error", reject);
      // 用配置发起 TCP + SSH 握手连接
      client.connect({
        host: this.#config.host,
        port: this.#config.port ?? 22,
        username: this.#config.username,
        password: this.#config.password,
        privateKey: this.#config.privateKey,
        passphrase: this.#config.passphrase,
        readyTimeout: 10000,
      } as ConnectConfig);
    });

    this.#client = client;
    // 连接成功后分配 PTY 伪终端（xterm, 80x24），启动远端 shell
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: "xterm", cols: 80, rows: 24 }, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
    // 监听 stream 的 data/stderr 事件，收集输出到内部缓冲区
    stream.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#output.append(text);
      this.fileLogger.write(text);
    });
    stream.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#output.append(text);
      this.fileLogger.write(text);
    });
    stream.on("close", () => {
      this.#stream = null;
    });

    this.#stream = stream;

    // 收集 banner 后停止
    this.#output.startCollecting();
    await new Promise((r) => setTimeout(r, 500)); // 等待 500ms 收集 banner（登录提示、motd 等），然后停止收集
    return this.#output.read(1);
  }

  /**
   * @brief 向 SSH shell 发送数据
   *
   * 发送数据到远端 shell 执行。SSH 已分配 PTY 伪终端，\x03 会被远端
   * 终端驱动自动转换为 SIGINT，因此通过本方法直接写入即可中断命令。
   *
   * @param data              要发送的数据
   * @param clear             清空标志(默认1)：1=清空后收集，0=追加收集
   * @param appendLineEnding  是否追加换行符(默认true)：false 时发送原始数据(如 \x03 即 Ctrl+C)
   */
  write(
    data: string,
    clear: number = 1,
    appendLineEnding: boolean = true
  ): void {
    if (!this.#stream) throw new Error("Shell not open. Call open() first.");
    this.#output.prepareWrite(clear);
    this.#stream.write(appendLineEnding ? `${data}\n` : data);
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
    return this.#output.read(clear);
  }

  /**
   * @brief 排空缓冲区但不停止数据收集
   *
   * 返回当前缓冲区内容并清空，保持输出收集状态。
   * 用于长时间命令执行期间持续接收输出数据。
   * 与 read(1) 不同的是，read(1) 在读取后会停止数据收集，
   * 而 drain() 不清除收集状态。
   *
   * @return 缓冲区中的文本内容
   */
  drain(): string {
    return this.#output.drain();
  }

  /**
   * @brief 懒加载 SFTP 子系统会话
   *
   * 若 SFTP 会话已建立则直接复用；否则在当前 SSH 连接上发起 SFTP 子系统。
   * ssh2 协议允许同一 Client 连接同时承载 shell 通道与 sftp 子系统，
   * 二者互不干扰，因此 SFTP 与 shell 操作可在同一会话上交替进行。
   *
   * @return SFTPWrapper 实例
   * @throws 连接未打开或远端不支持 SFTP 时抛出
   */
  async #ensureSftp(): Promise<SFTPWrapper> {
    if (this.#sftp) {
      return this.#sftp;
    }
    if (!this.#client) {
      throw new Error("SSH connection not open.");
    }
    this.#sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      this.#client!.sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        resolve(sftp);
      });
    });
    return this.#sftp;
  }

  /**
   * @brief 上传本地文件到远端（SFTP）
   *
   * 通过 ssh2 的 fastPut 流式并行上传，不在内存中缓冲整个文件，
   * 适用于大文件（上百 MB）。传输字节数取自本地源文件 stat 大小。
   * 异常被捕获并封装为 success:false 的结果返回，不向调用方抛出。
   *
   * @param localPath  本地源文件路径
   * @param remotePath 远端目标文件路径
   * @return 传输结果摘要
   */
  async uploadFile(
    localPath: string,
    remotePath: string
  ): Promise<TransferResult> {
    const start = Date.now();

    // 先取本地源文件大小（用于摘要），失败则直接返回失败结果
    let bytes: number;
    try {
      const st = await stat(localPath);
      bytes = st.size;
    } catch (err) {
      return {
        direction: "upload",
        localPath,
        remotePath,
        bytes: 0,
        durationMs: Date.now() - start,
        success: false,
        error: `Cannot stat local file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const sftp = await this.#ensureSftp();
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => {
          if (err) {
            return reject(err);
          }
          resolve();
        });
      });
      return {
        direction: "upload",
        localPath,
        remotePath,
        bytes,
        durationMs: Date.now() - start,
        success: true,
      };
    } catch (err) {
      return {
        direction: "upload",
        localPath,
        remotePath,
        bytes: 0,
        durationMs: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @brief 下载远端文件到本地（SFTP）
   *
   * 通过 ssh2 的 fastGet 流式并行下载，不在内存中缓冲整个文件，
   * 适用于大文件（上百 MB）。传输字节数取自远端源文件 sftp.stat 大小。
   * 异常被捕获并封装为 success:false 的结果返回，不向调用方抛出；
   * 失败时清理可能产生的半成品本地文件。
   *
   * @param remotePath 远端源文件路径
   * @param localPath  本地目标文件路径
   * @return 传输结果摘要
   */
  async downloadFile(
    remotePath: string,
    localPath: string
  ): Promise<TransferResult> {
    const start = Date.now();

    try {
      const sftp = await this.#ensureSftp();

      // 先取远端源文件大小（用于摘要 + 源不存在时提前失败）
      const st = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) {
            return reject(err);
          }
          resolve(stats);
        });
      });
      const bytes = st.size;

      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            return reject(err);
          }
          resolve();
        });
      });
      return {
        direction: "download",
        localPath,
        remotePath,
        bytes,
        durationMs: Date.now() - start,
        success: true,
      };
    } catch (err) {
      // 失败时清理半成品本地文件（忽略清理本身的错误）
      try {
        await unlink(localPath);
      } catch {
        // 目标文件可能未创建，忽略
      }
      return {
        direction: "download",
        localPath,
        remotePath,
        bytes: 0,
        durationMs: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @brief 关闭 shell 会话和 SSH 连接
   *
   * 释放所有资源，清空缓冲区。释放顺序：SFTP 子系统 → shell 通道 → SSH 连接 → 缓冲区。
   */
  async close(): Promise<void> {
    this.fileLogger.disable();
    // 先释放 SFTP 子系统（若已建立）
    if (this.#sftp) {
      this.#sftp.end();
      this.#sftp = null;
    }
    if (this.#stream) {
      this.#stream.close();
      this.#stream = null;
    }
    if (this.#client) {
      this.#client.end();
      this.#client = null;
    }
    this.#output.reset();
  }
}

/**
 * @brief 交互式 SSH Shell 命令行入口
 *
 * 打开 SSH 连接，从标准输入循环读取命令并发送，
 * 读取输出并显示，按 Ctrl+C 时断开连接并退出。
 *
 * @param config SSH 连接配置
 */
export async function interactiveShell(config: SSHShellConfig): Promise<void> {
  const shell = new SSHShell(config);

  const banner = await shell.open();
  if (banner) process.stdout.write(banner);
  console.log(
    "\n--- SSH shell ready. Send commands with write(), read() to get output. ---\n"
  );

  await interactiveLoop(shell, "ssh");
}

/**
 * @brief PSH 探测 + 解锁演示（SSH 方式）
 *
 * 使用 PshStateMachine 状态机替代 if-else 嵌套判断，统一驱动 profile
 * 匹配、状态检测与解锁流程：
 *   1. 连接 SSH，读取 banner
 *   2. 状态机 start(banner) → 自动匹配 profile
 *   3. 未匹配到则发探测 → feed(channel, output) → 再次匹配
 *   4. 匹配成功后自动 detect 状态 → UNKNOWN 时自动 probeState
 *   5. 状态明确后根据终态决定解锁或直接进入交互
 *
 * 环境变量：
 *   BOARD_HOST, BOARD_PORT, BOARD_USERNAME, BOARD_PASSWORD
 *   KEY_PROVIDER (file|terminal), CHALLENGE_FILE, KEY_FILE
 *
 * @param config SSH 连接配置
 */
export async function pshDemoSsh(config: SSHShellConfig): Promise<void> {
  // ===== 步骤 1：连接 SSH，读取启动信息（banner） =====
  console.log("[Step 1] === PSH Unlock Demo (SSH) ===\n");

  console.log(`[Step 1] Connecting to ${config.host}:${config.port ?? 22} ...`);
  const shell = new SSHShell(config);
  const banner = await shell.open();
  console.log("[Step 1] --- SSH Banner ---\n%s\n---", sanitize(banner));

  // ===== 步骤 2~3：状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("ssh");
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

      const keyProvider = new KeyProvider(getKeyProviderConfig("ssh"));

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
        await interactiveLoop(shell, "ssh");
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
      await interactiveLoop(shell, "ssh");
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

  // ===== 关闭 SSH 连接 =====
  console.log("[Step 5] === Demo complete ===");
  await shell.close();
}
