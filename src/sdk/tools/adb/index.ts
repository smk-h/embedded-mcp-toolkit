/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: SDK ADB 工具统一定义入口
 *
 *   协议无关的 ADB 工具聚合（设备扫描 + 交互式 shell 会话）；
 *   MCP 侧注册见 src/mcp/tools.ts。
 * ======================================================
 */

// SDK ADB 工具 — ADB 工具的统一定义入口（协议无关）

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

import {
  adbDeviceListConfig,
  adbDeviceListHandler,
  adbExecConfig,
  adbExecHandler,
} from "./exec.js";
import {
  adbShellOpenConfig,
  adbShellOpenHandler,
  adbShellCloseConfig,
  adbShellCloseHandler,
  adbShellWriteConfig,
  adbShellWriteHandler,
  adbShellReadConfig,
  adbShellReadHandler,
  adbShellExecConfig,
  adbShellExecHandler,
  adbShellSendCtrlConfig,
  adbShellSendCtrlHandler,
} from "./shell.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * @brief 所有已定义的 ADB 工具列表
 *
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const sdkAdbTools: AnySdkToolDef[] = [
  sdkDefineTool("adb_device_list", adbDeviceListConfig, adbDeviceListHandler),
  sdkDefineTool("adb_exec", adbExecConfig, adbExecHandler),
  sdkDefineTool("adb_shell_open", adbShellOpenConfig, adbShellOpenHandler),
  sdkDefineTool("adb_shell_close", adbShellCloseConfig, adbShellCloseHandler),
  sdkDefineTool("adb_shell_write", adbShellWriteConfig, adbShellWriteHandler),
  sdkDefineTool("adb_shell_read", adbShellReadConfig, adbShellReadHandler),
  sdkDefineTool("adb_shell_exec", adbShellExecConfig, adbShellExecHandler),
  sdkDefineTool(
    "adb_shell_send_ctrl",
    adbShellSendCtrlConfig,
    adbShellSendCtrlHandler
  ),
];
