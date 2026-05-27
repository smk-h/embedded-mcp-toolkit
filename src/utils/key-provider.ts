import {
  watchFile,
  unwatchFile,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

/**
 * @brief
 */
export type KeyProviderMode = "file" | "terminal";

/**
 * @brief KeyProvider 配置
 */
export interface KeyProviderConfig {
  mode: KeyProviderMode; // 密钥提供方式
  challengeFilePath?: string; // 挑战信息写入路径
  keyFilePath?: string; // 轮询密钥的文件路径
  pollInterval?: number; // 轮询间隔（毫秒），默认 500
  timeout?: number; // 超时（毫秒），默认 120000（2 分钟）
  prompt?: string; // 提示文本
}

/**
 * @brief 密钥提供器 — 封装从文件或终端获取解锁密钥的逻辑
 *
 * 支持两种模式：
 * - **file**：将挑战信息写入 challengeFilePath，轮询 keyFilePath 等待外部工具写入密钥，
 *   读取后自动清空密钥文件。适用于 MCP 服务器等无交互终端的场景。
 * - **terminal**：在终端显示挑战信息并提示用户输入密钥。适用于 CLI 交互场景。
 */
export class KeyProvider {
  readonly #config: Required<KeyProviderConfig>;

  /**
   * @brief 构造函数
   * @param config 配置项
   */
  constructor(config: KeyProviderConfig) {
    this.#config = {
      mode: config.mode,
      challengeFilePath: config.challengeFilePath ?? "challenge.txt",
      keyFilePath: config.keyFilePath ?? "password_input.txt",
      pollInterval: config.pollInterval ?? 500,
      timeout: config.timeout ?? 120_000,
      prompt: config.prompt ?? "Enter unlock key: ",
    };
  }

  /**
   * @brief 获取密钥 — 根据配置的模式从文件或终端读取
   * @param output 设备输出的挑战信息（QR 码、Challenge Code 等）
   * @return 用户/外部工具提供的解锁密钥
   */
  async getKey(output: string): Promise<string> {
    if (this.#config.mode === "file") {
      return this.#fromFile(output);
    }
    return this.#fromTerminal(output);
  }

  /**
   * @brief 文件 IPC 模式：写入挑战信息，轮询密钥文件
   * @param output 设备输出的挑战信息
   * @return 用户/外部工具提供的解锁密钥
   */
  async #fromFile(output: string): Promise<string> {
    const { challengeFilePath, keyFilePath, pollInterval, timeout } =
      this.#config;

    // 写入挑战信息
    writeFileSync(challengeFilePath, output, "utf-8");
    console.log(
      "Challenge written to %s, waiting for key in %s ...",
      challengeFilePath,
      keyFilePath
    );

    // 清空可能残留的旧密钥
    if (existsSync(keyFilePath)) {
      writeFileSync(keyFilePath, "", "utf-8");
    }

    // 轮询密钥文件
    return new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let settled = false;

      const finish = (result: string | Error) => {
        if (settled) return;
        settled = true;
        unwatchFile(keyFilePath);
        // 清空挑战文件
        writeFileSync(challengeFilePath, "", "utf-8");
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      // 用 fs.watchFile 轮询，比 setInterval 更高效
      watchFile(keyFilePath, { interval: pollInterval }, () => {
        if (settled) return;
        try {
          const content = readFileSync(keyFilePath, "utf-8").trim();
          if (content) {
            // 读取后清空密钥文件和挑战文件
            writeFileSync(keyFilePath, "", "utf-8");
            writeFileSync(challengeFilePath, "", "utf-8");
            finish(content);
          }
        } catch {
          // 文件可能正在写入，忽略读取错误
        }
      });

      // 超时处理
      const checkTimeout = setInterval(() => {
        if (settled) {
          clearInterval(checkTimeout);
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(checkTimeout);
          finish(
            new Error(
              `KeyProvider timed out after ${timeout}ms waiting for ${keyFilePath}`
            )
          );
        }
      }, pollInterval);
    });
  }

  /**
   * @brief 终端交互模式：显示挑战信息，提示用户输入
   * @param output 设备输出的挑战信息
   * @return 用户输入的解锁密钥
   */
  async #fromTerminal(output: string): Promise<string> {
    console.log(
      "\n--- Challenge output from device ---\n%s\n----------------------------------\n",
      output
    );

    return new Promise<string>((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(this.#config.prompt, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}
