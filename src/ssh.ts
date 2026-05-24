import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type ServerHostKeyAlgorithm } from "ssh2";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ShellStateManager, ShellState } from "./shell-state.js";

interface SSHConfig {
  host: string;
  port?: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string;
  hostKeyAlgorithms?: string[];
  challengeFile?: string | null;
  passwordFile?: string | null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface DirEntry {
  filename: string;
  longname: string;
  attrs: unknown;
}

/**
 * ssh2 库中 `Client` 提供两种执行远程命令的接口：
 *
 * | 接口      | 方法签名                            | 适用场景       | 是否支持交互输入 |
 * | --------- | ----------------------------------- | -------------- | ---------------- |
 * | `exec()`  | `client.exec(command, callback)`    | 单次非交互命令 | 否               |
 * | `shell()` | `client.shell([options], callback)` | 交互式会话/TTY | 是               |
 *
 * `exec()` 的工作方式：
 * - 向 SSH Server 发送 `SSH_MSG_CHANNEL_OPEN` 请求一个 session channel
 * - 在该 channel 上发送 exec 请求，Server fork 一个进程执行命令
 * - 命令的 stdin/stdout/stderr 通过 channel 透传
 * - 不支持伪终端分配，因此无法运行需要 TTY 的程序（如 vi、top、需要密码交互的脚本）
 *
 * `shell()` 的工作方式：
 * - 同样打开一个 session channel
 * - 但请求的是 shell 子系统，并可选分配 pseudo-TTY（PTY）
 * - Server 启动用户的登录 shell（如 /bin/sh）
 * - 获得一个交互式环境，可以连续发送多条命令，支持密码提示、光标控制等
 */
export class SSHManager {
  readonly #config: SSHConfig;
  #client: Client | null = null;
  #connecting: Promise<void> | null = null;
  #shellStream: ClientChannel | null = null;
  #shellBuffer: string = "";
  #shellState: ShellStateManager | null = null;

  constructor(config: SSHConfig) {
    this.#config = config;
  }

  setShellStateManager(sm: ShellStateManager | null): void {
    this.#shellState = sm;
  }

  async connect(): Promise<void> {
    // Prevent concurrent connection attempts
    if (this.#connecting) {
      return this.#connecting;
    }

    this.#connecting = this.#doConnect();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  async ensureConnected(): Promise<void> {
    if (!this.#client) {
      await this.connect();
    }
  }

  /**
   * 单次非交互命令。
   * 向 SSH Server 发送 exec 请求，Server fork 一个进程执行命令，
   * 命令的 stdin/stdout/stderr 通过 channel 透传。
   * 不支持伪终端分配，无法运行需要 TTY 的程序（如 vi、top、需要密码交互的脚本）。
   * 每次调用独立 fork，不保留 cd、环境变量等状态。
   */
  async exec(cmd: string): Promise<ExecResult> {
    await this.ensureConnected();
    const client = this.#client!; // safe: ensureConnected guarantees non-null
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(cmd, (err, stream: ClientChannel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", (code: number | null) => {
          resolve({ stdout, stderr, exitCode: code });
        });
      });
    });
  }

  /**
   * 打开交互式 shell 会话。
   * 请求 shell 子系统并分配 pseudo-TTY（PTY），
   * Server 启动用户的登录 shell（如 /bin/sh），
   * 获得一个交互式环境，可以连续发送多条命令，支持密码提示、光标控制等。
   * 返回初始 shell banner/prompt。
   */
  async openShell(options?: {
    term?: string;
    cols?: number;
    rows?: number;
  }): Promise<string> {
    await this.ensureConnected();
    const client = this.#client!;

    return new Promise<string>((resolve, reject) => {
      client.shell(
        {
          term: options?.term || "xterm",
          cols: options?.cols ?? 80,
          rows: options?.rows ?? 24,
        },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) return reject(err);

          this.#shellStream = stream;
          this.#shellBuffer = "";

          stream.on("data", (data: Buffer) => {
            this.#shellBuffer += data.toString();
          });

          stream.stderr.on("data", (data: Buffer) => {
            this.#shellBuffer += data.toString();
          });

          stream.on("close", () => {
            this.#shellStream = null;
          });

          setTimeout(() => resolve(this.#shellBuffer), 300);
        }
      );
    });
  }

  /**
   * 在已打开的交互式 shell 中发送一条命令并等待输出。
   * 命令在同一 shell 进程中执行，状态（cd 目录、环境变量等）保持。
   * 内部使用唯一标记 `echo` 命令来定位输出边界。
   * 若配置了 ShellStateManager 且检测到 shell 处于锁定状态，会自动尝试解锁后重试。
   */
  async shellSend(cmd: string, timeoutMs: number = 10000): Promise<string> {
    if (!this.#shellStream) {
      throw new Error("No shell session open. Call openShell() first.");
    }

    const marker = `__END_MARKER_${Date.now()}__`;
    const beforeLen = this.#shellBuffer.length;

    this.#shellStream.write(`${cmd}\necho "${marker}"\n`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const markerIdx = this.#shellBuffer.indexOf(marker, beforeLen);
      if (markerIdx !== -1) {
        let output = this.#shellBuffer.substring(beforeLen, markerIdx);
        const lines = output
          .split("\n")
          .filter((l) => !l.includes(marker) && l.trim() !== cmd);
        return lines.join("\n").trim();
      }

      if (this.#shellState?.hasUnlockSequence) {
        const recentBuf = this.#shellBuffer.substring(beforeLen);
        const state = this.#shellState.detectState(recentBuf);
        if (state === ShellState.LOCKED) {
          const result = await this._unlockShell();
          const parsed = JSON.parse(result);
          if (parsed.result === "awaiting_key") {
            throw new Error(`Shell is locked. ${parsed.message}`);
          }
          if (parsed.result === "error") {
            throw new Error(`Unlock failed: ${parsed.message}`);
          }
          this.#shellStream.write(`${cmd}\necho "${marker}"\n`);
        }
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.#shellState) {
      const recentBuf = this.#shellBuffer.substring(beforeLen);
      const state = this.#shellState.detectState(recentBuf);
      if (state === ShellState.LOCKED && this.#shellState.hasUnlockSequence) {
        const result = await this._unlockShell();
        const parsed = JSON.parse(result);
        if (parsed.result === "awaiting_key") {
          throw new Error(`Shell is locked. ${parsed.message}`);
        }
        if (parsed.result === "error") {
          throw new Error(`Unlock failed: ${parsed.message}`);
        }
        const retryMarker = `__END_MARKER_RETRY_${Date.now()}__`;
        const retryBefore = this.#shellBuffer.length;
        this.#shellStream.write(`${cmd}\necho "${retryMarker}"\n`);

        const retryDeadline = Date.now() + timeoutMs;
        while (Date.now() < retryDeadline) {
          const idx = this.#shellBuffer.indexOf(retryMarker, retryBefore);
          if (idx !== -1) {
            let output = this.#shellBuffer.substring(retryBefore, idx);
            const lines = output
              .split("\n")
              .filter((l) => !l.includes(retryMarker) && l.trim() !== cmd);
            return lines.join("\n").trim();
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }

    throw new Error(`shellSend timed out after ${timeoutMs}ms`);
  }

  async detectState(): Promise<string> {
    if (!this.#shellStream) {
      throw new Error("No shell session open. Call openShell() first.");
    }

    if (!this.#shellState) {
      return JSON.stringify({
        state: "unknown",
        reason: "No ShellStateManager configured",
        raw: this.#shellBuffer.substring(Math.max(0, this.#shellBuffer.length - 1000)),
      });
    }

    const bufferSnapshot = this.#shellBuffer;
    const state = this.#shellState.detectState(bufferSnapshot);

    return JSON.stringify({
      state,
      profile: this.#shellState.profile.name,
      hasUnlockSequence: this.#shellState.hasUnlockSequence,
      raw: bufferSnapshot.substring(Math.max(0, bufferSnapshot.length - 1000)),
    });
  }

  async unlockShell(timeoutMs: number = 30000, key?: string): Promise<string> {
    if (!this.#shellStream) {
      throw new Error("No shell session open. Call openShell() first.");
    }

    if (!this.#shellState) {
      throw new Error("No ShellStateManager configured. Set BOARD_SHELL_PROFILE or BOARD_UNLOCK_SEQUENCE env.");
    }

    if (!this.#shellState.hasUnlockSequence) {
      throw new Error(`Profile '${this.#shellState.profile.name}' has no unlock sequence defined.`);
    }

    const preState = this.#shellState.detectState(this.#shellBuffer);
    if (preState === ShellState.READY) {
      return JSON.stringify({ result: "already_unlocked", state: "ready" });
    }

    const result = await this._unlockShell(key);

    const postState = this.#shellState.detectState(this.#shellBuffer);
    const parsed = JSON.parse(result);
    parsed.verifyState = postState;

    return JSON.stringify(parsed);
  }

  /**
   * 关闭交互式 shell 会话，清理资源。
   */
  async closeShell(): Promise<void> {
    if (this.#shellStream) {
      this.#shellStream.close();
      this.#shellStream = null;
    }
    this.#shellBuffer = "";
  }

  async readFile(remotePath: string): Promise<string> {
    await this.ensureConnected();
    const client = this.#client!;
    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        const stream = sftp.createReadStream(remotePath);
        let data = "";
        stream.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        stream.on("end", () => {
          sftp.end();
          resolve(data);
        });
        stream.on("error", (err: Error) => {
          sftp.end();
          reject(err);
        });
      });
    });
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    await this.ensureConnected();
    const client = this.#client!;
    return new Promise<void>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.write(content);
        stream.end();
        stream.on("close", () => {
          sftp.end();
          resolve();
        });
        stream.on("error", (err: Error) => {
          sftp.end();
          reject(err);
        });
      });
    });
  }

  async listDir(remotePath: string): Promise<DirEntry[]> {
    await this.ensureConnected();
    const client = this.#client!;
    return new Promise<DirEntry[]>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        sftp.readdir(remotePath, (err: Error | undefined, list) => {
          sftp.end();
          if (err) return reject(err);
          resolve(
            list.map((item) => ({
              filename: item.filename,
              longname: item.longname,
              attrs: item.attrs,
            }))
          );
        });
      });
    });
  }

  async close(): Promise<void> {
    if (this.#client) {
      this.#client.end();
      this.#client = null;
    }
  }

  // ── private: file IPC ──────────────────────────────────────

  #saveChallengeToFile(content: string): void {
    if (!this.#config.challengeFile) return;
    try {
      writeFileSync(this.#config.challengeFile, content);
      console.error(`[INFO] Challenge saved to ${this.#config.challengeFile}`);
    } catch (e: unknown) {
      console.error(`[ERROR] Failed to write challenge file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #readPasswordFromFile(): string | null {
    if (!this.#config.passwordFile) return null;
    try {
      if (existsSync(this.#config.passwordFile)) {
        const pwd = readFileSync(this.#config.passwordFile, "utf8").trim();
        if (pwd) {
          writeFileSync(this.#config.passwordFile, "");
          return pwd;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  #clearIpcFiles(): void {
    if (!this.#config.challengeFile) return;
    try {
      if (existsSync(this.#config.challengeFile)) {
        writeFileSync(this.#config.challengeFile, "");
        console.error(`[INFO] Cleared challenge file: ${this.#config.challengeFile}`);
      }
    } catch (e: unknown) {
      console.error(`[ERROR] Failed to remove challenge file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async #pollPasswordFile(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pwd = this.#readPasswordFromFile();
      if (pwd) return pwd;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // ── private: SSH connection ───────────────────────────────

  /** Internal: perform the actual SSH connection handshake */
  #doConnect(): Promise<void> {
    const client = new Client();
    const connConfig: ConnectConfig = {
      host: this.#config.host,
      port: this.#config.port || 22,
      username: this.#config.username,
      readyTimeout: 10000,
    };

    if (this.#config.privateKey) {
      connConfig.privateKey = readFileSync(this.#config.privateKey, "utf8");
      if (this.#config.passphrase) {
        connConfig.passphrase = this.#config.passphrase;
      }
    } else if (this.#config.password) {
      connConfig.password = this.#config.password;
    }

    // 旧版内核(4.x)的 SSH 服务仅支持 ssh-rsa 主机密钥算法，
    // 新版 ssh2 客户端默认已禁用此算法，需通过 algorithms.serverHostKey 显式启用。
    if (this.#config.hostKeyAlgorithms && this.#config.hostKeyAlgorithms.length > 0) {
      connConfig.algorithms = {
        serverHostKey: this.#config.hostKeyAlgorithms as ServerHostKeyAlgorithm[],
      };
    }

    return new Promise<void>((resolve, reject) => {
      client.on("ready", () => {
        this.#client = client;
        resolve();
      });
      client.on("error", (err: Error) => {
        reject(err);
      });
      client.on("close", () => {
        this.#client = null;
      });
      client.on("end", () => {
        this.#client = null;
      });
      client.connect(connConfig);
    });
  }

  _sendForUnlock(cmd: string, expectPattern: RegExp, timeoutMs: number): Promise<string> {
    if (!this.#shellStream) {
      throw new Error("No shell session open");
    }

    const beforeLen = this.#shellBuffer.length;
    this.#shellStream.write(`${cmd}\n`);

    const deadline = Date.now() + timeoutMs;
    return new Promise<string>((resolve) => {
      const check = () => {
        const recent = this.#shellBuffer.substring(beforeLen);
        if (expectPattern.test(recent)) {
          setTimeout(() => {
            resolve(this.#shellBuffer.substring(beforeLen));
          }, 200);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(this.#shellBuffer.substring(beforeLen));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  async _unlockShell(key?: string, timeoutMs: number = 30000): Promise<string> {
    const steps = this.#shellState!.unlockSequence;
    const logs: string[] = [];
    let challengeRaw = "";

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // For steps that need user input but we don't have the key yet,
        // first save challenge and wait for key before sending anything
        if (step.userInput && !key) {
          // Save challenge to file if configured
          this.#saveChallengeToFile(challengeRaw);

          // If passwordFile is configured, poll for the key
          if (this.#config.passwordFile) {
            console.error(`[INFO] Polling ${this.#config.passwordFile} for unlock key...`);

            const polledKey = await this.#pollPasswordFile(timeoutMs);
            if (polledKey) {
              key = polledKey;
              logs.push(`[${step.description}] key_from_file`);
            } else {
              // Timeout waiting for file input
              logs.push(`[${step.description}] FILE_POLL_TIMEOUT`);
              console.error(`SSH _unlockShell: ${logs.join(", ")}`);
              return JSON.stringify({
                result: "awaiting_key",
                state: "unlocking",
                steps: logs,
                message: "Timed out waiting for key in password file. Write the key to the password file or call shell_unlock with the 'key' parameter.",
              });
            }
          } else {
            // No file IPC configured, fall back to MCP tool call
            logs.push(`[${step.description}] WAITING_FOR_USER_KEY`);
            console.error(`SSH _unlockShell: ${logs.join(", ")}`);
            return JSON.stringify({
              result: "awaiting_key",
              state: "unlocking",
              steps: logs,
              message: "Shell is waiting for unlock key. Call shell_unlock with the 'key' parameter.",
            });
          }
        }

        // Now we have the key (if needed), send the command
        const send = step.userInput ? key! : step.send;
        const mask = step.userInput ? "***" : send;

        const output = await this._sendForUnlock(
          send,
          new RegExp(step.expectPattern, "im"),
          step.timeoutMs
        );

        // Capture output from non-user-input steps for challenge code extraction
        if (!step.userInput) {
          challengeRaw = output;
        }

        const state = this.#shellState!.detectState(output);
        logs.push(`[${step.description}] send='${mask}' state=${state}`);

        if (state === ShellState.ERROR) {
          return JSON.stringify({
            result: "error",
            message: `Unlock failed at step "${step.description}": got state=${state}`,
            raw: output.substring(0, 500),
          });
        }

        if (state === ShellState.READY) {
          console.error(`SSH _unlockShell: ${logs.join(", ")} -> READY (early)`);
          return JSON.stringify({ result: "unlocked", state: "ready", steps: logs });
        }
      }

      console.error(`SSH _unlockShell: ${logs.join(", ")}`);
      return JSON.stringify({ result: "unlocked", state: "ready", steps: logs });
    } finally {
      this.#clearIpcFiles();
    }
  }
}
