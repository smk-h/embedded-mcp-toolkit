// MCP Core 工具 — 通用工具的统一定义入口（只导出工具，注册由 src/mcp.ts 负责）

import { mcpDefineTool, ToolEntry } from "../../tool-registry.js";

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
export const mcpWinTools: ToolEntry[] = [
  mcpDefineTool("port_scan_tool", portScanConfig, portScanHandler),
  mcpDefineTool("network_scan_tool", networkScanConfig, networkScanHandler),
  mcpDefineTool("subnet_check_tool", subnetCheckConfig, subnetCheckHandler),
  mcpDefineTool(
    "power_shell_open",
    powerShellOpenConfig,
    powerShellOpenHandler
  ),
  mcpDefineTool(
    "power_shell_close",
    powerShellCloseConfig,
    powerShellCloseHandler
  ),
  mcpDefineTool(
    "power_shell_write",
    powerShellWriteConfig,
    powerShellWriteHandler
  ),
  mcpDefineTool(
    "power_shell_read",
    powerShellReadConfig,
    powerShellReadHandler
  ),
  mcpDefineTool(
    "power_shell_exec",
    powerShellExecConfig,
    powerShellExecHandler
  ),
];
