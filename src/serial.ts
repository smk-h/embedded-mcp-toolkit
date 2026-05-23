import { SerialPort } from "serialport";
import { ShellStateManager, ShellState } from "./shell-state.js";

interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits?: 8 | 5 | 6 | 7;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd";
}

export class SerialManager {
  readonly #config: SerialConfig;
  #port: SerialPort | null = null;
  #connecting: Promise<void> | null = null;
  #disconnecting: Promise<void> | null = null;
  #shellState: ShellStateManager | null = null;

  constructor(config: SerialConfig) {
    this.#config = config;
  }

  setShellStateManager(sm: ShellStateManager | null): void {
    this.#shellState = sm;
  }

  get isConnected(): boolean {
    return this.#port !== null && this.#port.isOpen;
  }

  get config(): SerialConfig {
    return { ...this.#config };
  }

  configsEqual(other: Partial<SerialConfig>): boolean {
    return (
      (other.port === undefined || this.#config.port === other.port) &&
      (other.baudRate === undefined || this.#config.baudRate === other.baudRate) &&
      (other.dataBits === undefined || this.#config.dataBits === other.dataBits) &&
      (other.stopBits === undefined || this.#config.stopBits === other.stopBits) &&
      (other.parity === undefined || this.#config.parity === other.parity)
    );
  }

  get #promptPattern(): RegExp {
    if (this.#shellState) {
      return this.#shellState.buildPromptPattern();
    }
    return /^.*[@:].*[#$]\s*$/m;
  }

  async connect(config?: Partial<SerialConfig>): Promise<void> {
    if (this.#disconnecting) {
      await this.#disconnecting;
    }

    if (this.isConnected) {
      if (config && !this.configsEqual(config)) {
        await this.#doDisconnect();
      } else {
        return;
      }
    }

    if (this.#connecting) {
      return this.#connecting;
    }

    if (config) {
      Object.assign(this.#config, config);
    }

    this.#connecting = this.#doConnect();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  async ensureConnected(): Promise<void> {
    if (!this.#port || !this.#port.isOpen) {
      await this.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.#connecting) {
      try {
        await this.#connecting;
      } catch {
        // Ignore connect errors during disconnect
      }
    }

    if (this.#disconnecting) {
      return this.#disconnecting;
    }

    this.#disconnecting = this.#doDisconnect();
    try {
      await this.#disconnecting;
    } finally {
      this.#disconnecting = null;
    }
  }

  async #doDisconnect(): Promise<void> {
    if (!this.#port) {
      return;
    }

    const port = this.#port;
    this.#port = null;

    await new Promise<void>((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try {
          port.destroy();
        } catch {
          // Ignore destroy errors
        }
        resolve();
      }, 2000);

      port.close((err) => {
        clearTimeout(timeout);
        if (err) {
          console.error("Serial close error:", err.message);
        }
        resolve();
      });
    });
  }

  async exec(cmd: string, timeoutMs: number = 5000): Promise<string> {
    await this.ensureConnected();
    const port = this.#port!;

    await this.#drain(port);

    port.write(cmd + "\r\n");

    const raw = await this.#readUntilPrompt(port, timeoutMs);

    if (this.#shellState) {
      const state = this.#shellState.detectState(raw);

      if (state === ShellState.LOCKED) {
        this.#tryUpgradeProfile(raw);
        if (this.#shellState.hasUnlockSequence) {
          const unlockResult = await this._unlockShell(port);
          const parsed = JSON.parse(unlockResult);
          if (parsed.result === "awaiting_key") {
            return `[SHELL_LOCKED] Auto-unlock initiated but key required.\n${parsed.message}\n\nPartial output before unlock:\n${this.#cleanOutput(cmd, raw)}`;
          }
          if (parsed.result === "error") {
            return `[UNLOCK_FAILED] ${parsed.message}\n\nPartial output:\n${this.#cleanOutput(cmd, raw)}`;
          }
          await this.#drain(port);
          port.write(cmd + "\r\n");
          const raw2 = await this.#readUntilPrompt(port, timeoutMs);
          return this.#cleanOutput(cmd, raw2);
        }
      }
    }

    return this.#cleanOutput(cmd, raw);
  }

  async detectState(timeoutMs: number = 2000): Promise<string> {
    await this.ensureConnected();
    const port = this.#port!;

    await this.#drain(port);

    // ── 串口安全状态检测 ──
    // 先静默读取已有输出，判断当前是否处于输入等待状态（如 PSH 的 "key>"）。
    // 若直接发送 echo probe（带 \r\n），会被当成输入提交，导致解锁失败。
    const pending = await this.#read(port, 500);
    if (this.#shellState) {
      const pendingState = this.#shellState.detectState(pending);
      if (pendingState !== ShellState.UNKNOWN) {
        return JSON.stringify({
          state: pendingState,
          profile: this.#shellState.profile.name,
          hasUnlockSequence: this.#shellState.hasUnlockSequence,
          raw: pending.substring(0, 1000),
          note: "State detected from pending serial output without sending probe",
        });
      }
    }

    port.write("echo __PSH_STATE_PROBE__\r\n");

    const raw = await this.#read(port, timeoutMs);

    if (!this.#shellState) {
      return JSON.stringify({
        state: "unknown",
        reason: "No ShellStateManager configured",
        raw: raw.substring(0, 1000),
      });
    }

    const state = this.#shellState.detectState(raw);
    return JSON.stringify({
      state,
      profile: this.#shellState.profile.name,
      hasUnlockSequence: this.#shellState.hasUnlockSequence,
      raw: raw.substring(0, 1000),
    });
  }

  async unlockShell(timeoutMs: number = 30000, key?: string): Promise<string> {
    await this.ensureConnected();

    if (!this.#shellState) {
      throw new Error("No ShellStateManager configured. Set BOARD_SHELL_PROFILE or BOARD_UNLOCK_SEQUENCE env.");
    }

    const port = this.#port!;
    await this.#drain(port);

    if (!this.#shellState.hasUnlockSequence) {
      const peekRaw = await this.#read(port, 500);
      this.#tryUpgradeProfile(peekRaw);
      if (!this.#shellState.hasUnlockSequence) {
        throw new Error(`Profile '${this.#shellState.profile.name}' has no unlock sequence defined. Use BOARD_SHELL_PROFILE=psh or set BOARD_UNLOCK_SEQUENCE.`);
      }
    }

    // ── 串口安全预检测 ──
    // 先静默读取已有输出判断当前状态。若已处于解锁输入等待（如 "key>"），
    // 直接跳过 echo probe，避免 probe 被当成输入提交。
    const prePeek = await this.#read(port, 500);
    const peekState = this.#shellState.detectState(prePeek);

    if (peekState === ShellState.READY) {
      return JSON.stringify({ result: "already_unlocked", state: "ready" });
    }

    // 若已处于解锁等待状态且有 key，直接进入 unlock sequence（跳过 echo probe）
    if (peekState === ShellState.UNLOCKING && key) {
      const result = await this._unlockShell(port, key);
      const parsed = JSON.parse(result);
      if (parsed.result === "awaiting_key") {
        return result;
      }
      // 验证解锁后状态
      await this.#drain(port);
      port.write("echo __PSH_POST_STATE__\r\n");
      const postRaw = await this.#readUntilPrompt(port, 3000);
      const postState = this.#shellState.detectState(postRaw);
      parsed.verifyState = postState;
      return JSON.stringify(parsed);
    }

    port.write("echo __PSH_PRE_STATE__\r\n");
    const preRaw = await this.#read(port, 2000);
    const preState = this.#shellState.detectState(preRaw);

    if (preState === ShellState.READY) {
      return JSON.stringify({ result: "already_unlocked", state: "ready" });
    }

    const result = await this._unlockShell(port, key);

    await this.#drain(port);
    port.write("echo __PSH_POST_STATE__\r\n");
    const postRaw = await this.#readUntilPrompt(port, 3000);
    const postState = this.#shellState.detectState(postRaw);

    const parsed = JSON.parse(result);
    if (parsed.result !== "awaiting_key") {
      parsed.verifyState = postState;
    }

    return JSON.stringify(parsed);
  }

  async read(timeoutMs: number = 2000): Promise<string> {
    await this.ensureConnected();
    const port = this.#port!;
    return this.#read(port, timeoutMs);
  }

  write(data: string): void {
    if (!this.#port || !this.#port.isOpen) {
      throw new Error("Serial port not connected");
    }
    this.#port.write(data);
  }

  // ── private ──────────────────────────────────────────────

  #tryUpgradeProfile(raw: string): void {
    if (!this.#shellState) return;
    if (this.#shellState.hasUnlockSequence) return;
    const builtin = ShellStateManager.matchBuiltin(raw);
    if (builtin) {
      console.error(`Serial: auto-detected shell profile '${builtin.name}' from output, upgrading from heuristic`);
      this.#shellState = new ShellStateManager(builtin);
    }
  }

  #doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = new SerialPort({
        path: this.#config.port,
        baudRate: this.#config.baudRate,
        dataBits: (this.#config.dataBits ?? 8) as 8 | 5 | 6 | 7,
        stopBits: (this.#config.stopBits ?? 1) as 1 | 1.5 | 2,
        parity: (this.#config.parity ?? "none") as "none" | "even" | "odd",
        autoOpen: false,
      });

      port.open((err) => {
        if (err) return reject(err);
        this.#port = port;
        resolve();
      });

      port.on("close", () => {
        this.#port = null;
      });

      port.on("error", () => {
        this.#port = null;
      });
    });
  }

  #drain(port: SerialPort): Promise<void> {
    return new Promise<void>((resolve) => {
      const discard = () => {};
      port.on("data", discard);
      setTimeout(() => {
        port.removeListener("data", discard);
        resolve();
      }, 150);
    });
  }

  #read(port: SerialPort, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      let data = "";

      const onData = (chunk: Buffer) => {
        data += chunk.toString();
      };

      port.on("data", onData);

      setTimeout(() => {
        port.removeListener("data", onData);
        resolve(data);
      }, timeoutMs);
    });
  }

  #readUntilPrompt(port: SerialPort, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      let data = "";
      const pattern = this.#promptPattern;

      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (pattern.test(data)) {
          setTimeout(() => {
            port.removeListener("data", onData);
            resolve(data);
          }, 80);
        }
      };

      port.on("data", onData);

      setTimeout(() => {
        port.removeListener("data", onData);
        resolve(data);
      }, timeoutMs);
    });
  }

  #waitForPattern(port: SerialPort, pattern: RegExp, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      let data = "";

      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (pattern.test(data)) {
          setTimeout(() => {
            port.removeListener("data", onData);
            resolve(data);
          }, 150);
        }
      };

      port.on("data", onData);

      setTimeout(() => {
        port.removeListener("data", onData);
        resolve(data);
      }, timeoutMs);
    });
  }

  async _unlockShell(port: SerialPort, key?: string): Promise<string> {
    const steps = this.#shellState!.unlockSequence;
    const logs: string[] = [];
    let userInputNeeded = false;
    let challengeRaw = "";

    for (const step of steps) {
      if (step.userInput && !key) {
        userInputNeeded = true;
        logs.push(`[${step.description}] WAITING_FOR_USER_KEY`);
        break;
      }

      const send = step.userInput ? key! : step.send;

      await this.#drain(port);
      port.write(send + "\r\n");

      const raw = await this.#waitForPattern(
        port,
        new RegExp(step.expectPattern, "im"),
        step.timeoutMs
      );

      if (!step.userInput) {
        challengeRaw = raw;
      }

      const state = this.#shellState!.detectState(raw);
      logs.push(`[${step.description}] send='${step.userInput ? "***" : send}' state=${state}`);

      if (state === ShellState.ERROR) {
        return JSON.stringify({
          result: "error",
          message: `Unlock failed at step "${step.description}": got state=${state}`,
          raw: raw.substring(0, 500),
        });
      }

      if (state === ShellState.READY) {
        console.error(`Serial _unlockShell: ${logs.join(", ")} -> READY (early)`);
        return JSON.stringify({ result: "unlocked", state: "ready", steps: logs });
      }
    }

    if (userInputNeeded) {
      const challengeCode = this.#shellState!.extractChallengeCode(challengeRaw);
      console.error(`Serial _unlockShell: ${logs.join(", ")}`);
      return JSON.stringify({
        result: "awaiting_key",
        state: "unlocking",
        steps: logs,
        message: "Shell is waiting for unlock key. Call shell_unlock with the 'key' parameter.",
        challenge_code: challengeCode,
        challenge_raw: challengeRaw.substring(0, 500),
      });
    }

    console.error(`Serial _unlockShell: ${logs.join(", ")}`);
    return JSON.stringify({ result: "unlocked", state: "ready", steps: logs });
  }

  #cleanOutput(cmd: string, raw: string): string {
    let cleaned = raw.replace(/^.*[@:].*[#$]\s*$/gm, "");

    if (this.#shellState) {
      const pp = this.#shellState.buildPromptPattern();
      cleaned = cleaned.replace(new RegExp(pp.source, "gm"), "");
    }

    const lines = cleaned.split(/\r?\n/);
    if (lines.length > 0) {
      const first = lines[0].trim();
      if (first === cmd.trim() || first.endsWith(cmd.trim())) {
        lines.shift();
      }
    }

    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }

    return lines.join("\n").trim();
  }
}
