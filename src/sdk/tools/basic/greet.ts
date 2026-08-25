/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : greet.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: greet SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";

// ── 声明 ──

export const greetConfig: SdkToolConfig = {
  description: "Greet someone by name",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
};

// ── 实现 ──

export async function greetHandler(args: { name: string }): Promise<string> {
  logger.info(`[greet_tool] name=${args.name}`);
  return `Hello, ${args.name}!`;
}
