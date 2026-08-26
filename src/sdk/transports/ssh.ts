/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh.ts
 * Author     : sumu
 * Date       : 2026/05/28
 * Version    : x.x.x
 * Description: SSHShell 传输层 — SSH 连接与 SFTP 通道
 * ======================================================
 */

import { stat, unlink } from "node:fs/promises";

import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
  type Stats,
} from "ssh2";

import { BaseShell } from "./base-shell.js";
import { type TransferResult } from "../shared/transfer-result.js";

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
 * @brief SSH 交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过 SSH 协议与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */
export class SSHShell extends BaseShell {
  #client: Client | null = null;
  #stream: ClientChannel | null = null;
  #sftp: SFTPWrapper | null = null; // 懒加载的 SFTP 子系统，首次文件传输时才建立
  #config: SSHShellConfig;

  /** @brief SSH/Serial 通道的 banner 采集等待时长 */
  protected bannerWaitMs = 500;

  /**
   * @brief 构造函数
   * @param config SSH 连接配置
   */
  constructor(config: SSHShellConfig) {
    super();
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
   * @brief 建立 SSH 连接、分配 PTY、注册数据监听
   *
   * 模板方法 acquire：建立 ssh2 Client 连接，分配 PTY 伪终端启动远端 shell，
   * 注册 stream 的 data/stderr/close 监听（data 内调 appendData）。
   * 不负责 banner 采集（由基类 open 统一处理）。
   */
  protected async acquire(): Promise<void> {
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
    // 监听 stream 的 data/stderr 事件，收集输出到内部缓冲区并写入文件日志
    stream.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    stream.stderr.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    stream.on("close", () => {
      this.#stream = null;
    });

    this.#stream = stream;
  }

  /**
   * @brief 向 SSH shell 发送原始字节
   *
   * payload 已含换行处理，此处只校验连接是否已建立并发送。
   * SSH 已分配 PTY 伪终端，\x03 会被远端终端驱动自动转换为 SIGINT。
   *
   * @param payload 已拼接换行的完整发送内容
   * @throws 连接未打开时抛出 "Shell not open. Call open() first."
   */
  protected rawWrite(payload: string): void {
    if (!this.#stream) throw new Error("Shell not open. Call open() first.");
    this.#stream.write(payload);
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
   * @brief 关闭 SSH 连接，释放通道资源
   *
   * 释放顺序：SFTP 子系统 → shell 通道 → SSH 连接。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
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
  }
}
