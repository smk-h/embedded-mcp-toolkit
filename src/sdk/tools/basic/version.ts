/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : version.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: version SDK 工具（协议无关，MCP 注册见 src/mcp/tools/basic）
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";
import { pkg } from "../../../shared/package-info.js";

// ── 版本信息来自 package-info（npm/源码模式读磁盘，exe 模式用注入字面量） ──

// ── 声明 ──

export const versionConfig: SdkToolConfig = {
  description: "Get the MCP server version and toolkit information",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ── 实现 ──

export async function versionHandler(): Promise<string> {
  logger.info("[version_tool]");
  return [
    `Name:    ${pkg.name}`,
    `Version: ${pkg.version}`,
    `Node:    ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
  ].join("\n");
}
