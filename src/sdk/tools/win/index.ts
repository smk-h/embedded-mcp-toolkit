/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: SDK Win 工具统一定义入口
 *
 *   协议无关的 Windows 主机工具聚合，分两组导出：
 *     - sdkWinTools    域工具（端口扫描/网络扫描/子网检查），任何场景都注册
 *     - sdkPshellTools PowerShell 工具（一次性执行 exec），仅远程 SSH 场景注册
 *                      到 MCP——本地 Windows 客户端自带 shell 可直执行
 *                      PowerShell，经 MCP 绕行是冗余；注册策略见
 *                      src/mcp/pshell-policy.ts
 * ======================================================
 */

// SDK Win 工具 — Windows 主机工具的统一定义入口（协议无关）

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

import { portScanConfig, portScanHandler } from "./port-scan.js";
import { networkScanConfig, networkScanHandler } from "./network-scan.js";
import { subnetCheckConfig, subnetCheckHandler } from "./subnet-check.js";
import {
  powerShellExecConfig,
  powerShellExecHandler,
} from "./powershell.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * Windows 域工具列表（协议无关的查询/分析类工具）。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const sdkWinTools: AnySdkToolDef[] = [
  sdkDefineTool("port_scan_tool", portScanConfig, portScanHandler),
  sdkDefineTool("network_scan_tool", networkScanConfig, networkScanHandler),
  sdkDefineTool("subnet_check_tool", subnetCheckConfig, subnetCheckHandler),
];

/**
 * PowerShell 工具列表（一次性执行 exec）。
 * 是否注册到 MCP 由 server.ts 按启动场景决定，见 pshell-policy.ts。
 */
export const sdkPshellTools: AnySdkToolDef[] = [
  sdkDefineTool(
    "power_shell_exec",
    powerShellExecConfig,
    powerShellExecHandler
  ),
];
