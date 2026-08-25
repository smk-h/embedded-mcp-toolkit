/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sftp.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: C1. SFTP 文件操作（远端整文件读写）
 *
 * 打开/关闭 SFTP 会话、读取/写入远端文本文件、递归建目录、备份为 .bak。
 * 一次配置操作涉及多次 SFTP 读写，应复用同一会话句柄，避免反复开 channel
 * 触发远端 sshd 的会话/通道限制。
 * ======================================================
 */

import { Client, type SFTPWrapper } from "ssh2";

// ============================================================
// C1. SFTP 文件操作（远端整文件读写）
// ============================================================

/**
 * @brief 打开一个 SFTP 会话（复用单一句柄）
 * @details 一次配置操作涉及多次 SFTP 读写，若每次都 client.sftp() 新开 channel 会
 *          叠加打开大量 channel，触发远端 sshd 的会话/通道限制（表现为
 *          "Channel open failure: open failed"）。本函数在登录后开一个会话贯穿整个
 *          菜单循环，所有文件操作复用此句柄。
 * @param client 已连接的 ssh2 Client
 * @returns SFTPWrapper 句柄
 * @throws 打开 SFTP 会话失败时抛出
 */
export function openSftpSession(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

/**
 * @brief 关闭 SFTP 会话
 * @details 释放句柄，忽略关闭异常（连接即将断开）。
 * @param sftp SFTPWrapper 句柄
 */
export function closeSftpSession(sftp: SFTPWrapper): void {
  try {
    sftp.end();
  } catch {
    // 忽略关闭异常
  }
}

/**
 * @brief 读取远端文本文件
 * @details 先用 stat 探测文件是否存在（不存在返回 {exists:false}，不视为错误）；
 *          存在则用 readFile 读取全文为 UTF-8 字符串。
 * @param sftp      已打开的 SFTP 会话句柄
 * @param remotePath 远端文件绝对路径
 * @returns 读取结果；exists=false 表示文件不存在
 * @throws 读取失败时抛出（存在性探测本身不抛）
 */
export function sftpReadText(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ exists: boolean; content?: string }> {
  return new Promise((resolve, reject) => {
    // 先探测存在性：stat 失败（ENOENT 等）视为不存在
    sftp.stat(remotePath, (statErr) => {
      if (statErr) {
        resolve({ exists: false });
        return;
      }
      // 存在则读取全文（readFile 回调返回 Buffer）
      sftp.readFile(remotePath, (readErr, data) => {
        if (readErr) return reject(readErr);
        resolve({ exists: true, content: data.toString("utf8") });
      });
    });
  });
}

/**
 * @brief 递归创建远端目录（mkdir -p）
 * @details SFTP 的 mkdir 不递归，需逐级 stat 检查 + mkdir。
 *          已存在的目录跳过，不视为错误。
 * @param sftp    已打开的 SFTP 会话句柄
 * @param dirPath 远端目录绝对路径
 * @throws 创建失败时抛出
 */
export function sftpEnsureDir(
  sftp: SFTPWrapper,
  dirPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 拆分路径逐级创建（绝对路径以 / 开头，首段为空字符串跳过）
    const segments = dirPath.split("/").filter((s) => s.length > 0);
    let current = "";

    /**
     * @brief 递归处理下一级目录
     */
    function next(): void {
      if (segments.length === 0) {
        resolve();
        return;
      }
      current += "/" + segments.shift();
      sftp.stat(current, (statErr) => {
        if (!statErr) {
          // 已存在，继续下一级
          next();
          return;
        }
        // 不存在则创建
        sftp.mkdir(current, (mkdirErr) => {
          if (mkdirErr) return reject(mkdirErr);
          next();
        });
      });
    }

    next();
  });
}

/**
 * @brief 写入远端文本文件
 * @details 先确保父目录存在（递归创建），再 writeFile 写入 UTF-8 文本。
 * @param sftp       已打开的 SFTP 会话句柄
 * @param remotePath 远端目标文件绝对路径
 * @param content    要写入的文本内容
 * @throws 写入失败时抛出
 */
export async function sftpWriteText(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  // 确保父目录存在（SFTP 不会自动建目录）
  const dirPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
  if (dirPath) {
    await sftpEnsureDir(sftp, dirPath);
  }

  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(remotePath, content, "utf8", (writeErr) => {
      if (writeErr) return reject(writeErr);
      resolve();
    });
  });
}

/**
 * @brief 备份远端文件为 <path>.bak
 * @details 原文件存在则读取内容写到 .bak；.bak 已存在则跳过（保留首次备份）。
 *          原文件不存在时返回 false（无需备份）。
 * @param sftp       已打开的 SFTP 会话句柄
 * @param remotePath 远端文件绝对路径
 * @returns true=产生了新备份；false=原文件不存在或 .bak 已存在
 * @throws 备份失败时抛出
 */
export async function sftpBackup(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<boolean> {
  const bakPath = remotePath + ".bak";

  // 检查 .bak 是否已存在（已存在则保留首次备份，跳过）
  const bakInfo = await sftpReadText(sftp, bakPath);
  if (bakInfo.exists) {
    return false;
  }

  // 检查原文件是否存在
  const srcInfo = await sftpReadText(sftp, remotePath);
  if (!srcInfo.exists) {
    return false;
  }

  // 写备份
  await sftpWriteText(sftp, bakPath, srcInfo.content ?? "");
  return true;
}
