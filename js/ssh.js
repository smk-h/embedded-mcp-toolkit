import { Client } from "ssh2";
import { readFileSync } from "fs";

export class SSHManager {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  async connect() {
    const client = new Client();
    const connConfig = {
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      readyTimeout: 10000,
    };

    if (this.config.privateKey) {
      connConfig.privateKey = readFileSync(this.config.privateKey, "utf8");
      if (this.config.passphrase) {
        connConfig.passphrase = this.config.passphrase;
      }
    } else {
      connConfig.password = this.config.password;
    }

    return new Promise((resolve, reject) => {
      client.on("ready", () => {
        this.client = client;
        resolve();
      });
      client.on("error", (err) => {
        reject(err);
      });
      client.on("close", () => {
        this.client = null;
      });
      client.on("end", () => {
        this.client = null;
      });
      client.connect(connConfig);
    });
  }

  async ensureConnected() {
    if (!this.client) {
      await this.connect();
    }
  }

  async exec(cmd) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (data) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        stream.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code });
        });
      });
    });
  }

  async readFile(remotePath) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createReadStream(remotePath);
        let data = "";
        stream.on("data", (chunk) => {
          data += chunk.toString();
        });
        stream.on("end", () => {
          sftp.end();
          resolve(data);
        });
        stream.on("error", (err) => {
          sftp.end();
          reject(err);
        });
      });
    });
  }

  async writeFile(remotePath, content) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.write(content);
        stream.end();
        stream.on("close", () => {
          sftp.end();
          resolve();
        });
        stream.on("error", (err) => {
          sftp.end();
          reject(err);
        });
      });
    });
  }

  async listDir(remotePath) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.readdir(remotePath, (err, list) => {
          sftp.end();
          if (err) return reject(err);
          resolve(list.map((item) => ({
            filename: item.filename,
            longname: item.longname,
            attrs: item.attrs,
          })));
        });
      });
    });
  }

  async close() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
