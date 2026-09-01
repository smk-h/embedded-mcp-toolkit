/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tools.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: MCP 工具适配 — 五组 sdk 工具的统一注册入口
 *
 *   本文件不再定义任何工具，仅把 src/sdk 的协议无关定义经
 *   adapter 适配为 MCP ToolEntry，保证 server.ts 零改动。
 * ======================================================
 */

import {
  sdkBasicTools,
  sdkAdbTools,
  sdkSshTools,
  sdkSshBuildTools,
  sdkSerialTools,
  sdkWinTools,
  sdkPshellTools,
} from "../sdk/index.js";
import { adaptSdkTool } from "./adapter.js";
import type { ToolEntry } from "./tool-registry.js";

// ── 工具列表 ────────────────────────────────────────────────

/** Basic 核心工具组（5 个）。添加新工具改到 src/sdk/tools/basic/index.ts，此处无需变动。 */
export const mcpBasicTools: ToolEntry[] = sdkBasicTools.map(adaptSdkTool);

/** ADB 工具组（8 个）。添加新工具改到 src/sdk/tools/adb/index.ts，此处无需变动。 */
export const mcpAdbTools: ToolEntry[] = sdkAdbTools.map(adaptSdkTool);

/** SSH 工具组（10 个，不含 ssh_build）。添加新工具改到 src/sdk/tools/ssh/index.ts，此处无需变动。 */
export const mcpSshTools: ToolEntry[] = sdkSshTools.map(adaptSdkTool);

/**
 * ssh_build 远程编译工具组（1 个）。
 * 是否注册到 MCP 由 server.ts 按启动场景决定（仅本地启动注册），
 * 策略见 pshell-policy.ts 的 shouldRegisterSshBuildTools。
 */
export const mcpSshBuildTools: ToolEntry[] = sdkSshBuildTools.map(adaptSdkTool);

/** Serial 工具组（11 个）。添加新工具改到 src/sdk/tools/serial/index.ts，此处无需变动。 */
export const mcpSerialTools: ToolEntry[] = sdkSerialTools.map(adaptSdkTool);

/** Windows 域工具组（3 个）。添加新工具改到 src/sdk/tools/win/index.ts，此处无需变动。 */
export const mcpWinTools: ToolEntry[] = sdkWinTools.map(adaptSdkTool);

/**
 * PowerShell 工具组（1 个：一次性执行 power_shell_exec）。
 * 是否注册到 MCP 由 server.ts 按启动场景决定，策略见 pshell-policy.ts。
 */
export const mcpPshellTools: ToolEntry[] = sdkPshellTools.map(adaptSdkTool);
