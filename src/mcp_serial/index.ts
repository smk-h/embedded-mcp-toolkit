// MCP Serial 工具 — 串口相关工具的统一定义入口（只导出工具，注册由 src/mcp.ts 负责）

import { mcpDefineTool, ToolEntry } from "../helper/mcp_helper.js";

import {
  serialOpenConfig,
  serialOpenHandler,
  serialCloseConfig,
  serialCloseHandler,
  serialWriteConfig,
  serialWriteHandler,
  serialReadConfig,
  serialReadHandler,
  serialListConfig,
  serialListHandler,
  serialExecConfig,
  serialExecHandler,
  serialShellLoginConfig,
  serialShellLoginHandler,
  serialEnterUbootConfig,
  serialEnterUbootHandler,
} from "./serial_shell.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的串口工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const mcpSerialTools: ToolEntry[] = [
  mcpDefineTool("serial_open", serialOpenConfig, serialOpenHandler),
  mcpDefineTool("serial_close", serialCloseConfig, serialCloseHandler),
  mcpDefineTool("serial_write", serialWriteConfig, serialWriteHandler),
  mcpDefineTool("serial_read", serialReadConfig, serialReadHandler),
  mcpDefineTool("serial_list", serialListConfig, serialListHandler),
  mcpDefineTool("serial_exec", serialExecConfig, serialExecHandler),
  mcpDefineTool(
    "serial_shell_login",
    serialShellLoginConfig,
    serialShellLoginHandler
  ),
  mcpDefineTool(
    "serial_enter_uboot",
    serialEnterUbootConfig,
    serialEnterUbootHandler
  ),
];
