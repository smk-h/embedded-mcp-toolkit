import { SerialPort } from "serialport";

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
  readonly #promptPattern: RegExp = /^.*[@:].*[#$]\s*$/m;

  constructor(config: SerialConfig) {
    this.#config = config;
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

  async connect(config?: Partial<SerialConfig>): Promise<void> {
    // Wait for any ongoing disconnect
    if (this.#disconnecting) {
      await this.#disconnecting;
    }

    // Already connected with same config - reuse
    if (this.isConnected) {
      if (config && !this.configsEqual(config)) {
        // Config differs, need to reconnect
        await this.#doDisconnect();
      } else {
        return;
      }
    }

    // Wait for any ongoing connect
    if (this.#connecting) {
      return this.#connecting;
    }

    // Apply new config before connecting
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
    // Wait for any ongoing connect
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
        // Force close if graceful close takes too long
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
          // Log but don't throw - port might be already closed
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
    return this.#cleanOutput(cmd, raw);
  }

  async read(timeoutMs: number = 2000): Promise<string> {
    await this.ensureConnected();
    const port = this.#port!;

    return new Promise<string>((resolve) => {
      let data = "";

      const onData = (chunk: Buffer) => {
        data += chunk.toString();
      };

      port.on("data", onData);

      const timer = setTimeout(() => {
        port.removeListener("data", onData);
        resolve(data);
      }, timeoutMs);

      // Reset timer on each data chunk (keep waiting while data flows)
      port.on("data", () => {
        clearTimeout(timer);
        timer.refresh();
      });
    });
  }

  write(data: string): void {
    if (!this.#port || !this.#port.isOpen) {
      throw new Error("Serial port not connected");
    }
    this.#port.write(data);
  }

  // ── private ──────────────────────────────────────────────

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

  #readUntilPrompt(port: SerialPort, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      let data = "";

      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (this.#promptPattern.test(data)) {
          // Got prompt — wait a tick for trailing data, then resolve
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

  #cleanOutput(cmd: string, raw: string): string {
    // Remove all prompt-like lines (global replace with multiline mode)
        let cleaned = raw.replace(/^.*[@:].*[#$]\s*$/gm, "");

    // Remove leading echo — the first non-empty line is typically the echoed command
    const lines = cleaned.split(/\r?\n/);
    if (lines.length > 0) {
      const first = lines[0].trim();
      if (first === cmd.trim() || first.endsWith(cmd.trim())) {
        lines.shift();
      }
    }

    // Trim leading and trailing empty lines
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }

    return lines.join("\n").trim();
  }
}
