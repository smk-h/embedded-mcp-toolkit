/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : opencode
 * Date       : 2026/05/31
 * Version    : 1.0.0
 * Description: MCP ADB 工具 — ADB Shell 工具的统一定义入口
 *
 *   只导出工具，注册由 src/mcp/server.ts 负责。
 * ======================================================
 */
import { mcpDefineTool, ToolEntry } from "../../tool-registry.js";

import {
  adbShellOpenConfig,
  adbShellOpenHandler,
  adbShellCloseConfig,
  adbShellCloseHandler,
  adbShellWriteConfig,
  adbShellWriteHandler,
  adbShellReadConfig,
  adbShellReadHandler,
  adbShellListConfig,
  adbShellListHandler,
  adbShellExecConfig,
  adbShellExecHandler,
} from "./shell.js";
import {
  adbDeviceListConfig,
  adbDeviceListHandler,
  adbExecConfig,
  adbExecHandler,
} from "./exec.js";

/**
 * @brief 所有已定义的 ADB 工具列表
 *
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const mcpAdbTools: ToolEntry[] = [
  mcpDefineTool("adb_device_list", adbDeviceListConfig, adbDeviceListHandler),
  mcpDefineTool("adb_exec", adbExecConfig, adbExecHandler),
  mcpDefineTool("adb_shell_open", adbShellOpenConfig, adbShellOpenHandler),
  mcpDefineTool("adb_shell_close", adbShellCloseConfig, adbShellCloseHandler),
  mcpDefineTool("adb_shell_write", adbShellWriteConfig, adbShellWriteHandler),
  mcpDefineTool("adb_shell_read", adbShellReadConfig, adbShellReadHandler),
  mcpDefineTool("adb_shell_list", adbShellListConfig, adbShellListHandler),
  mcpDefineTool("adb_shell_exec", adbShellExecConfig, adbShellExecHandler),
];
