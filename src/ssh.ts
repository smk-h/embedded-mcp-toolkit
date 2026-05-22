import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { readFileSync } from "node:fs";

interface SSHConfig {
  host: string;
  port?: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string;
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

export class SSHManager {
  readonly #config: SSHConfig;
  #client: Client | null = null;
  #connecting: Promise<void> | null = null;

  constructor(config: SSHConfig) {
    this.#config = config;
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
}
