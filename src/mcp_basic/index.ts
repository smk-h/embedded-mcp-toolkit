// MCP Core 工具 — 通用工具的统一定义入口（只导出工具，注册由 src/mcp.ts 负责）

import { mcpDefineTool, ToolEntry } from '../helper/mcp_helper.js';

import { greetConfig, greetHandler } from './greet_tool.js';
import { versionConfig, versionHandler } from './version_tool.js';
import { deviceInfoConfig, deviceInfoHandler } from './device_info_tool.js';

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的核心工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const mcpBasicTools: ToolEntry[] = [
    mcpDefineTool('greet_tool',       greetConfig,       greetHandler),
    mcpDefineTool('version_tool',     versionConfig,     versionHandler),
    mcpDefineTool('device_info_tool', deviceInfoConfig,  deviceInfoHandler),
];
