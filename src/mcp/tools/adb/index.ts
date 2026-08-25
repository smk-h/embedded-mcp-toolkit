/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: MCP ADB 工具 — sdk ADB 工具的 MCP 适配入口
 *
 *   本文件不再定义任何工具，仅把 src/sdk 的协议无关定义经
 *   adapter 适配为 MCP ToolEntry（注册由 src/mcp/server.ts 负责）。
 * ======================================================
 */

import { sdkAdbTools } from "../../../sdk/index.js";
import { adaptSdkTool } from "../../adapter.js";
import type { ToolEntry } from "../../tool-registry.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * @brief 所有已定义的 ADB 工具列表（由 sdkAdbTools 适配而来）
 *
 * 添加新工具改到 src/sdk/tools/adb/index.ts，此处无需变动。
 */
export const mcpAdbTools: ToolEntry[] = sdkAdbTools.map(adaptSdkTool);
