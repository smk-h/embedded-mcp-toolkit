/**
 * @file MCP SSH SFTP 工具
 *
 * 在已建立的 SSH 会话上提供文件上传/下载能力，复用同一条 TCP+SSH 连接。
 * 通过 ssh2 的 SFTP 子系统（fastGet/fastPut）流式传输，适用于大文件场景。
 * 传输完成后返回字节数/耗时/速率摘要。
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import { sshStore } from "./sessions.js";
import { type TransferResult } from "../../../transports/ssh.js";

// ── 摘要格式化辅助 ──────────────────────────────────────────

/**
 * @brief 将字节数格式化为人可读字符串
 *
 * @param bytes 字节数
 * @return 形如 "104857600 bytes (100.00 MB)" 的字符串
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  // 不足 1KB 时只显示原始字节，避免冗余
  if (unitIndex === 0) {
    return `${bytes} bytes`;
  }
  return `${bytes} bytes (${value.toFixed(2)} ${units[unitIndex]})`;
}

/**
 * @brief 将传输速率格式化为人可读字符串
 *
 * @param bytesPerSec 每秒字节数
 * @return 形如 "31.25 MB/s" 的字符串
 */
function formatRate(bytesPerSec: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSec;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * @brief 将传输结果格式化为多行文本摘要
 *
 * 成功时输出方向、本地路径、远端路径、大小、耗时、速率六项；
 * 失败时输出方向、路径、错误信息。
 *
 * @param result 传输结果
 * @return 多行文本摘要
 */
export function formatTransferSummary(result: TransferResult): string {
  const verb =
    result.direction === "upload" ? "Upload" : "Download";
  const status = result.success ? "succeeded" : "failed";

  const lines = [`${verb} ${status}`];
  lines.push(`  local : ${result.localPath}`);
  lines.push(`  remote: ${result.remotePath}`);

  if (!result.success) {
    lines.push(`  error : ${result.error ?? "(unknown)"}`);
    return lines.join("\n");
  }

  const rate =
    result.durationMs > 0
      ? formatRate((result.bytes / result.durationMs) * 1000)
      : "N/A";

  lines.push(`  size  : ${formatBytes(result.bytes)}`);
  lines.push(`  time  : ${result.durationMs} ms`);
  lines.push(`  rate  : ${rate}`);
  return lines.join("\n");
}

// ── ssh_sftp_upload ─────────────────────────────────────────

/**
 * @brief ssh_sftp_upload 工具配置
 *
 * 将本地文件上传到远端板卡，复用已有 SSH 会话的连接。
 *
 * @param session_id  由 ssh_shell_open / ssh_shell_login 返回的会话 ID
 * @param local_path  本地源文件路径
 * @param remote_path 远端目标文件路径
 */
export const sshSftpUploadConfig = {
  description:
    "Upload a local file to the remote board over SFTP, reusing an existing SSH session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    local_path: string;
    remote_path: string;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open / ssh_shell_login",
      },
      local_path: {
        type: "string",
        description: "Local source file path",
      },
      remote_path: {
        type: "string",
        description: "Remote destination file path",
      },
    },
    required: ["session_id", "local_path", "remote_path"],
  }),
};

/**
 * @brief ssh_sftp_upload 处理函数
 *
 * 流程：
 *   1. 查找指定 session_id 的会话
 *   2. 调用 SSHShell.uploadFile 流式上传
 *   3. 格式化传输摘要并返回
 *
 * @param args 工具参数，包含 session_id、local_path、remote_path
 * @return MCP 响应，包含传输摘要文本
 */
export async function sshSftpUploadHandler(args: {
  session_id: string;
  local_path: string;
  remote_path: string;
}) {
  logger.info(
    `[ssh_sftp_upload] session_id=${args.session_id} local=${args.local_path} remote=${args.remote_path}`
  );
  const lookup = sshStore.getOrNotFound(args.session_id);
  if (!lookup.ok) {
    return lookup.response;
  }
  const shell = lookup.shell;

  const result = await shell.uploadFile(args.local_path, args.remote_path);
  logger.info(
    `[ssh_sftp_upload] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
  );
  return { content: [text(formatTransferSummary(result))] };
}

// ── ssh_sftp_download ───────────────────────────────────────

/**
 * @brief ssh_sftp_download 工具配置
 *
 * 将远端板卡文件下载到本地，复用已有 SSH 会话的连接。
 *
 * @param session_id  由 ssh_shell_open / ssh_shell_login 返回的会话 ID
 * @param remote_path 远端源文件路径
 * @param local_path  本地目标文件路径
 */
export const sshSftpDownloadConfig = {
  description:
    "Download a remote file from the board to local over SFTP, reusing an existing SSH session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    remote_path: string;
    local_path: string;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open / ssh_shell_login",
      },
      remote_path: {
        type: "string",
        description: "Remote source file path",
      },
      local_path: {
        type: "string",
        description: "Local destination file path",
      },
    },
    required: ["session_id", "remote_path", "local_path"],
  }),
};

/**
 * @brief ssh_sftp_download 处理函数
 *
 * 流程：
 *   1. 查找指定 session_id 的会话
 *   2. 调用 SSHShell.downloadFile 流式下载
 *   3. 格式化传输摘要并返回
 *
 * @param args 工具参数，包含 session_id、remote_path、local_path
 * @return MCP 响应，包含传输摘要文本
 */
export async function sshSftpDownloadHandler(args: {
  session_id: string;
  remote_path: string;
  local_path: string;
}) {
  logger.info(
    `[ssh_sftp_download] session_id=${args.session_id} remote=${args.remote_path} local=${args.local_path}`
  );
  const lookup = sshStore.getOrNotFound(args.session_id);
  if (!lookup.ok) {
    return lookup.response;
  }
  const shell = lookup.shell;

  const result = await shell.downloadFile(args.remote_path, args.local_path);
  logger.info(
    `[ssh_sftp_download] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
  );
  return { content: [text(formatTransferSummary(result))] };
}
