/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : host-info.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: host_info SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 *   查询 MCP 宿主端点信息（username@ip），用于跨机部署场景下 AI 客户端
 *   构造 scp 等文件传输命令。作为 instructions 字段未被客户端采纳时的兜底通道。
 *   - 远程 SSH 启动：返回完整端点（username + hostIp + endpoint）
 *   - 本地启动：返回 local 状态，不提供端点
 *   - 解析失败（SSH_CONNECTION 异常）：返回 unavailable 状态
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import { pkg } from "../../shared/package-info.js";
import { resolveHostEndpoint } from "../../host/host-endpoint.js";
import { resolveLogPaths, type LogPaths } from "../../host/log-paths.js";
import { buildRoutingHint } from "../../host/build-routing.js";
import { resolveTransferTmpDir } from "../../shared/data-dir.js";

// ── 声明 ────────────────────────────────────────────────────

/**
 * @brief host_info 工具配置
 * @details 无参查询工具。返回 MCP 宿主端点信息（username@ip），
 *          供 AI 客户端在跨机部署（MCP 在 Windows、AI 客户端在 Linux）下
 *          构造 scp 文件传输命令。
 */
export const hostInfoConfig: SdkToolConfig = {
  description:
    `Query the MCP host endpoint (username@ip) of ${pkg.name} for constructing cross-machine file transfers (scp) when this MCP (${pkg.name}) runs on Windows and the AI client runs on Linux. ` +
    `Also returns the ${pkg.name} log directory (shared by business logs and per-session raw-data logs) and the exact business log file path of the current run (the YYYY-MM-DD_HHMMSS.log the server is appending to) for locating/reading/cleaning up logs. ` +
    "Returns 'local started' with no endpoint for local launches.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * @brief 将日志/传输目录解析结果格式化为多行文本
 * @details 输出 cwd、日志总目录（业务日志与会话原始日志共用，业务日志平铺、
 *          会话日志按设备分子目录；仅当两条通道配置分路时才把会话日志目录单独
 *          列出）、当前运行实际写入的业务日志文件路径，以及传输暂存目录
 *          （.embedded/tmp）。供 AI 客户端拿到绝对路径后用 power_shell（Windows
 *          本机）或 scp（跨机）自行清理/读取日志、定位传输文件。两种部署方式
 *          （本地 / Linux→Windows 桥接）下 MCP 工具都运行在 MCP 所在主机，
 *          返回的绝对路径即该主机上的真实保存位置。
 * @param lp 日志目录解析结果
 * @returns 文本行数组
 */
function formatLogDirectories(lp: LogPaths): string[] {
  // 目录展示：部署配置里 LOG_DIR 与 SAVE2FILE_PATH 通常同指一个目录，此时合并为
  // 一行 log dir，避免同一路径重复占两行；分路配置时才把会话日志目录单独列出
  const sameDir = lp.business.dir === lp.rawData.dir;
  const businessState = lp.business.enabled ? "enabled" : "disabled";
  const rawDataState = lp.rawData.enabled ? "enabled" : "disabled";
  // 业务日志文件：enabled 时给出当前运行实际写入的文件绝对路径；
  // disabled 时 logger 尚无文件，显式说明而不是给误导性占位
  const businessFileLine = lp.business.file
    ? `  business log file: ${lp.business.file}  (current run)`
    : "  business log file: (disabled, no file written)";
  const lines = [
    `Log directories (${pkg.name} MCP server):`,
    `  server cwd:       ${lp.cwd}`,
    `  log dir:          ${lp.business.dir}  (business: ${businessState}, session: ${rawDataState})`,
  ];
  if (!sameDir) {
    lines.push(
      `  session log dir:  ${lp.rawData.dir}  (session: ${rawDataState})`
    );
  }
  lines.push(
    businessFileLine,
    `  transfer tmp:     ${resolveTransferTmpDir()}  (default landing dir for ZMODEM/SFTP downloads and scp pushes)`,
    "",
    "Notes:",
    "  - log dir is the shared home of two kinds of logs: business logs (LOG_SAVE) sit flat as one YYYY-MM-DD_HHMMSS.log per run ('business log file' above is the current run's), and session raw-data logs (SAVE2FILE_PATH) sit in per-device subdirs ({device}/{session}_YYYY-MM-DD_HHMMSS.log).",
    "  - 'disabled' means that channel is not currently writing to disk; the dir above is where it WOULD save if enabled.",
    `  - To clean up logs, run power_shell on the ${pkg.name} MCP host against these dirs (e.g. Get-ChildItem '...' -Recurse | Remove-Item), or scp from your Linux shell in mode 2.`
  );
  return lines;
}

/**
 * @brief 将端点解析结果格式化为多行文本
 * @details 按 scenario 分支构造对齐的 Label: value 文本，风格与 version_tool 一致。
 *          所有分支末尾均追加 Log directories 段（日志目录与启用状态）。
 * @param ep 端点解析结果
 * @param lp 日志目录解析结果
 * @returns 文本行数组
 */
function formatHostEndpoint(
  ep: ReturnType<typeof resolveHostEndpoint>,
  lp: LogPaths
): string[] {
  // 本地启动：不提供端点，仅给日志目录
  if (ep.scenario === "local") {
    return [
      "Host:       local started",
      "Endpoint:   (local, no scp needed)",
      "Source:     local",
      "",
      ...formatLogDirectories(lp),
    ];
  }

  // 远程 SSH 启动但端点不可用（SSH_CONNECTION 格式异常）
  if (!ep.endpoint) {
    return [
      "Host:       remote-ssh started",
      "Endpoint:   (unavailable)",
      "Source:     unavailable",
      "",
      buildRoutingHint(),
      "",
      ...formatLogDirectories(lp),
    ];
  }

  // 远程 SSH 启动且端点解析成功
  const tmpDirForScp = `${resolveTransferTmpDir().replace(/\\/g, "/")}/`;
  return [
    "Host:       remote-ssh started",
    `Endpoint:   ${ep.endpoint}`,
    `Username:   ${ep.username ?? "(unknown)"}`,
    `Host IP:    ${ep.hostIp ?? "(unknown)"}`,
    "Source:     ssh_connection",
    "",
    `Usage: You (the AI client) are running on Linux; the ${pkg.name} MCP server runs on Windows (the endpoint above). To transfer files between your Linux machine and Windows, run scp in YOUR OWN shell (not via the power_shell tool, which only operates on the Windows host itself). Always pass the passwordless key -i ~/.ssh/id_mcp_server:`,
    `  - Linux <- Windows (pull):  scp -i ~/.ssh/id_mcp_server ${ep.endpoint}:"E:/path/to/file" ~/local/path`,
    `  - Linux -> Windows (push):  scp -i ~/.ssh/id_mcp_server ~/local/file ${ep.endpoint}:"${tmpDirForScp}"`,
    "The push target above is the transfer tmp dir (.embedded/tmp) — the default landing spot on this MCP host. Files pushed there can be picked up by serial_upload / ssh_sftp_upload, or pulled back over SFTP/ZMODEM downloads.",
    "Do NOT use power_shell_* tools for cross-machine transfers — those run on Windows and would scp Windows to itself.",
    "",
    buildRoutingHint(),
    "",
    ...formatLogDirectories(lp),
  ];
}

// ── 实现 ────────────────────────────────────────────────────

/**
 * @brief host_info 处理函数
 * @details 查询当前 MCP 宿主端点。远程 SSH 启动返回 username@ip；
 *          本地启动返回 local 状态；解析失败返回 unavailable 状态。
 * @returns 端点信息文本
 */
export async function hostInfoHandler(): Promise<string> {
  logger.info("[host_info]");
  const ep = resolveHostEndpoint();
  const lp = resolveLogPaths();
  return formatHostEndpoint(ep, lp).join("\n");
}
