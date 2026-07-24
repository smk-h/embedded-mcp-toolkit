/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : transfer-result.ts
 * Author     : sumu
 * Date       : 2026/07/24
 * Version    : 1.0.0
 * Description: 文件传输结果摘要（共享层）
 *
 *   定义跨通道复用的 TransferResult 接口与摘要格式化工具函数。
 *   原定义于 transports/ssh.ts（接口）与 mcp/tools/ssh/sftp.ts（格式化函数），
 *   串口 ZMODEM 传输（serial_upload / serial_download）需要同样格式，
 *   故提取到 shared 层供 SSH / Serial 两通道共用。
 * ======================================================
 */

// ── 传输结果接口 ────────────────────────────────────────────

/**
 * @brief 文件传输结果摘要
 *
 * 由各通道的文件传输方法返回（SSH 的 uploadFile/downloadFile、
 * 串口的 zmodemSend/zmodemReceive），工具层据此格式化为 MCP 文本响应。
 */
export interface TransferResult {
  direction: "upload" | "download"; // 传输方向：upload 本地→远端，download 远端→本地
  localPath: string; // 本地文件路径
  remotePath: string; // 远端文件路径
  bytes: number; // 传输字节数（源文件大小）
  durationMs: number; // 耗时（毫秒）
  success: boolean; // 是否成功
  error?: string; // 失败时的错误信息（成功时为 undefined）
}

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
  const verb = result.direction === "upload" ? "Upload" : "Download";
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
