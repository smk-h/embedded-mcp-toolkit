/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: SSH 传输层共享模块
 *
 * 提供 SSH 连接、命令执行、文件上传/下载、地址解析等传输能力，供 sshd-config 与
 * remote-mcp-config 两个交互式命令共用。本模块不含任何业务概念，是纯粹的 SSH + IO
 * 辅助库：不依赖 @clack/prompts，不输出业务日志，不感知 MCP/claude/zcode。
 *
 * 设计原则：函数实现与从 sshd-config.ts 迁出时保持逐字一致（仅补 export 与 JSDoc），
 * 确保迁移本身不引入行为回归；新增的 sshUpload 与既有 sshDownload 对称实现。
 * ======================================================
 */

import { Client, type ConnectConfig } from "ssh2";

// ============================================================
// 类型
// ============================================================

/**
 * @brief 远程 Linux 服务器连接信息（仅内存，不落盘）
 * @details 由交互式命令收集，用于建立 SSH 连接。password 仅存在于进程内存，
 *          不写入日志或磁盘。
 */
export interface LinuxServerInfo {
  host: string;
  port: number; // SSH 端口，默认 22
  username: string;
  password: string; // 仅内存，不落盘
}

// ============================================================
// 地址解析
// ============================================================

/**
 * @brief 解析紧凑格式的服务器地址
 * @details 支持 `user@host[:port]` 格式，例如：
 *          - `cnb-dso-xxx@cnb.space`
 *          - `root@1.2.3.4:2222`
 *          - `user@host.example.com`
 *          未带端口时默认 22。user、host 均不能为空。
 * @param input 用户输入的地址字符串
 * @returns 解析结果；格式非法返回 null
 */
export function parseServerAddress(
  input: string
): { host: string; port: number; username: string } | null {
  const trimmed = input.trim();
  // 必须包含 @ 分隔用户名与主机
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const username = trimmed.slice(0, atIdx);
  const rest = trimmed.slice(atIdx + 1);
  if (!username || !rest) return null;

  // 可选 :port（取最后一个冒号，避免 IPv6 地址干扰；本场景主要为域名/IPv4）
  let host = rest;
  let port = 22;
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx > 0) {
    const portPart = rest.slice(colonIdx + 1);
    const parsedPort = parseInt(portPart, 10);
    // 端口必须是纯数字且在合法范围
    if (/^\d+$/.test(portPart) && parsedPort > 0 && parsedPort <= 65535) {
      host = rest.slice(0, colonIdx);
      port = parsedPort;
    }
  }

  if (!host) return null;
  return { host, port, username };
}

// ============================================================
// SSH 连接与执行
// ============================================================

/**
 * @brief 建立到远程主机的 SSH 连接
 * @details 基于 ssh2 Client 直接连接，不经过业务层的 SSHShell。
 * @param info 远程服务器连接信息
 * @returns 已连接的 ssh2 Client 实例
 * @throws 连接失败时抛出
 */
export function sshConnect(info: LinuxServerInfo): Promise<Client> {
  const client = new Client();
  return new Promise<Client>((resolve, reject) => {
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.connect({
      host: info.host,
      port: info.port,
      username: info.username,
      password: info.password,
      readyTimeout: 10000,
    } as ConnectConfig);
  });
}

/**
 * @brief 在已建立的 SSH 连接上执行一条命令
 * @details 收集 stdout 与 stderr，命令结束后返回完整 stdout（trim 尾部空白）。
 * @param client  已连接的 ssh2 Client
 * @param command 要执行的 shell 命令
 * @returns 命令的 stdout 输出（已 trim）
 * @throws 执行失败时抛出
 */
export function sshExec(client: Client, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      // stderr 仅作调试参考，不阻断流程，此处显式消费避免 unhandled 事件告警
      stream.stderr.on("data", () => {
        /* 忽略远端 stderr */
      });
      stream.on("close", () => {
        resolve(stdout.trim());
      });
    });
  });
}

// ============================================================
// SFTP 文件传输
// ============================================================

/**
 * @brief 从远端 SFTP 下载文件到本地
 * @details 基于 ssh2 的 sftp 子系统，使用 fastGet 流式下载。
 * @param client     已连接的 ssh2 Client
 * @param remotePath 远端文件绝对路径（SFTP 不识别 ~，需先展开）
 * @param localPath  本地目标文件路径
 * @throws SFTP 不可用或下载失败时抛出
 */
export function sshDownload(
  client: Client,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

/**
 * @brief 上传本地文件到远端（与 sshDownload 对称）
 * @details 基于 ssh2 的 sftp 子系统，使用 fastPut 流式上传。
 *          remotePath 的父目录需已存在（调用方负责确保），fastPut 不递归建目录。
 * @param client     已连接的 ssh2 Client
 * @param localPath  本地源文件路径
 * @param remotePath 远端目标文件绝对路径
 * @throws SFTP 不可用或上传失败时抛出
 */
export function sshUpload(
  client: Client,
  localPath: string,
  remotePath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

// ============================================================
// 连接关闭
// ============================================================

/**
 * @brief 关闭 SSH 连接
 * @param client ssh2 Client 实例
 */
export function sshDisconnect(client: Client): void {
  try {
    client.end();
  } catch {
    // 忽略关闭时的异常
  }
}
