/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : host-info.ts
 * Author     : embedded-mcp-toolkit
 * Date       : 2026/07/30
 * Version    : 1.0.0
 * Description: host_info MCP 工具
 *
 *   查询 MCP 宿主端点信息（username@ip），用于跨机部署场景下 AI 客户端
 *   构造 scp 等文件传输命令。作为 instructions 字段未被客户端采纳时的兜底通道。
 *   - 远程 SSH 启动：返回完整端点（username + hostIp + endpoint）
 *   - 本地启动：返回 local 状态，不提供端点
 *   - 解析失败（SSH_CONNECTION 异常）：返回 unavailable 状态
 * ======================================================
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import { resolveHostEndpoint } from "../../shared/host-endpoint.js";
import { buildRoutingHint } from "../../shared/build-routing.js";

// ── 声明 ────────────────────────────────────────────────────

/**
 * @brief host_info 工具配置
 * @details 无参查询工具。返回 MCP 宿主端点信息（username@ip），
 *          供 AI 客户端在跨机部署（MCP 在 Windows、AI 客户端在 Linux）下
 *          构造 scp 文件传输命令。
 */
export const hostInfoConfig = {
  description:
    "Query the MCP host endpoint (username@ip) for constructing cross-machine file transfers (scp) when this MCP runs on Windows and the AI client runs on Linux. " +
    "Returns 'local started' with no endpoint for local launches.",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * @brief 将端点解析结果格式化为多行文本
 * @details 按 scenario 分支构造对齐的 Label: value 文本，风格与 version_tool 一致。
 * @param ep 端点解析结果
 * @returns 文本行数组
 */
function formatHostEndpoint(ep: ReturnType<typeof resolveHostEndpoint>): string[] {
  // 本地启动：不提供端点
  if (ep.scenario === "local") {
    return [
      "Host:       local started",
      "Endpoint:   (local, no scp needed)",
      "Source:     local",
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
    ];
  }

  // 远程 SSH 启动且端点解析成功
  return [
    "Host:       remote-ssh started",
    `Endpoint:   ${ep.endpoint}`,
    `Username:   ${ep.username ?? "(unknown)"}`,
    `Host IP:    ${ep.hostIp ?? "(unknown)"}`,
    "Source:     ssh_connection",
    "",
    "Usage: You (the AI client) are running on Linux; this MCP server runs on Windows (the endpoint above). To transfer files between your Linux machine and Windows, run scp in YOUR OWN shell (not via the power_shell tool, which only operates on the Windows host itself). Always pass the passwordless key -i ~/.ssh/id_mcp_server:",
    `  - Linux <- Windows (pull):  scp -i ~/.ssh/id_mcp_server ${ep.endpoint}:"E:/path/to/file" ~/local/path`,
    `  - Linux -> Windows (push):  scp -i ~/.ssh/id_mcp_server ~/local/file ${ep.endpoint}:"E:/path/"`,
    "Do NOT use power_shell_* tools for cross-machine transfers — those run on Windows and would scp Windows to itself.",
    "",
    buildRoutingHint(),
  ];
}

// ── 实现 ────────────────────────────────────────────────────

/**
 * @brief host_info 处理函数
 * @details 查询当前 MCP 宿主端点。远程 SSH 启动返回 username@ip；
 *          本地启动返回 local 状态；解析失败返回 unavailable 状态。
 * @returns MCP 响应，包含端点信息文本
 */
export async function hostInfoHandler() {
  logger.info("[host_info]");
  const ep = resolveHostEndpoint();
  const info = formatHostEndpoint(ep).join("\n");
  return { content: [text(info)] };
}


