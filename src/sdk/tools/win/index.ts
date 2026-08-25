/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: SDK Win 工具统一定义入口
 *
 *   协议无关的 Windows 主机工具聚合（PowerShell 会话 / 端口扫描 /
 *   网络扫描 / 子网检查）；MCP 侧注册见 src/mcp/tools/win/index.ts。
 * ======================================================
 */

// SDK Win 工具 — Windows 主机工具的统一定义入口（协议无关）

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

import { portScanConfig, portScanHandler } from "./port-scan.js";
import { networkScanConfig, networkScanHandler } from "./network-scan.js";
import { subnetCheckConfig, subnetCheckHandler } from "./subnet-check.js";
import {
  powerShellOpenConfig,
  powerShellOpenHandler,
  powerShellCloseConfig,
  powerShellCloseHandler,
  powerShellWriteConfig,
  powerShellWriteHandler,
  powerShellReadConfig,
  powerShellReadHandler,
  powerShellExecConfig,
  powerShellExecHandler,
} from "./powershell.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的核心工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const sdkWinTools: AnySdkToolDef[] = [
  sdkDefineTool("port_scan_tool", portScanConfig, portScanHandler),
  sdkDefineTool("network_scan_tool", networkScanConfig, networkScanHandler),
  sdkDefineTool("subnet_check_tool", subnetCheckConfig, subnetCheckHandler),
  sdkDefineTool(
    "power_shell_open",
    powerShellOpenConfig,
    powerShellOpenHandler
  ),
  sdkDefineTool(
    "power_shell_close",
    powerShellCloseConfig,
    powerShellCloseHandler
  ),
  sdkDefineTool(
    "power_shell_write",
    powerShellWriteConfig,
    powerShellWriteHandler
  ),
  sdkDefineTool(
    "power_shell_read",
    powerShellReadConfig,
    powerShellReadHandler
  ),
  sdkDefineTool(
    "power_shell_exec",
    powerShellExecConfig,
    powerShellExecHandler
  ),
];
