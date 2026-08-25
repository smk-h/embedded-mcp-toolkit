/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: MCP Serial 工具 — sdk Serial 工具的 MCP 适配入口
 *
 *   本文件不再定义任何工具，仅把 src/sdk 的协议无关定义经
 *   adapter 适配为 MCP ToolEntry（注册由 src/mcp/server.ts 负责）。
 * ======================================================
 */

import { sdkSerialTools } from "../../../sdk/index.js";
import { adaptSdkTool } from "../../adapter.js";
import type { ToolEntry } from "../../tool-registry.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的串口工具列表（由 sdkSerialTools 适配而来）。
 * 添加新工具改到 src/sdk/tools/serial/index.ts，此处无需变动。
 */
export const mcpSerialTools: ToolEntry[] = sdkSerialTools.map(adaptSdkTool);
