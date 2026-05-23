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
  readonly #promptPattern: RegExp = /^.*[@:].*[#$]\s*$/m;

  constructor(config: SerialConfig) {
    this.#config = config;
  }

  get isConnected(): boolean {
    return this.#port !== null && this.#port.isOpen;
  }

  async connect(config?: Partial<SerialConfig>): Promise<void> {
    if (this.isConnected) {
      if (config) Object.assign(this.#config, config);
      return;
    }
    if (config) {
      Object.assign(this.#config, config);
    }
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
    if (!this.#port || !this.#port.isOpen) {
      await this.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.#port) {
      const port = this.#port;
      this.#port = null;
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    }
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
