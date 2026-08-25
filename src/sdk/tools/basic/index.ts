/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: SDK Basic 工具统一定义入口
 *
 *   协议无关的通用工具聚合；MCP 侧注册见 src/mcp/tools/basic/index.ts。
 * ======================================================
 */

// SDK Basic 工具 — 通用工具的统一定义入口（协议无关）
//
//   只导出工具定义与执行函数；MCP 侧注册见 src/mcp/tools/basic/index.ts。

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

import { greetConfig, greetHandler } from "./greet.js";
import { versionConfig, versionHandler } from "./version.js";
import { deviceInfoConfig, deviceInfoHandler } from "./device-info.js";
import { sessionInfoConfig, sessionInfoHandler } from "./session_info.js";
import { hostInfoConfig, hostInfoHandler } from "./host-info.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的核心工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const sdkBasicTools: AnySdkToolDef[] = [
  sdkDefineTool("greet_tool", greetConfig, greetHandler),
  sdkDefineTool("version_tool", versionConfig, versionHandler),
  sdkDefineTool("device_info_tool", deviceInfoConfig, deviceInfoHandler),
  sdkDefineTool("session_info", sessionInfoConfig, sessionInfoHandler),
  sdkDefineTool("host_info", hostInfoConfig, hostInfoHandler),
];
