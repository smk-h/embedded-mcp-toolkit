// MCP Basic 工具 — sdk basic 工具的 MCP 适配入口（注册由 src/mcp/server.ts 负责）
//
//   本文件不再定义任何工具，仅把 src/sdk 的协议无关定义经
//   adapter 适配为 MCP ToolEntry，保证 server.ts 零改动。

import { sdkBasicTools } from "../../../sdk/index.js";
import { adaptSdkTool } from "../../adapter.js";
import type { ToolEntry } from "../../tool-registry.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的核心工具列表（由 sdkBasicTools 适配而来）。
 * 添加新工具改到 src/sdk/tools/basic/index.ts，此处无需变动。
 */
export const mcpBasicTools: ToolEntry[] = sdkBasicTools.map(adaptSdkTool);
