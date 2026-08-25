/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : adapter.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: SDK → MCP 适配器
 *
 *   把协议无关的工具定义包装为 MCP 工具条目：
 *   inputSchema 包装 + 返回值转 TextContent，领域逻辑留在 src/sdk。
 * ======================================================
 */

// SDK → MCP 适配器 — 把协议无关的工具定义包装为 MCP 工具条目
//
//   职责（仅此两件事，领域逻辑一律留在 src/sdk）：
//     1. inputSchema：纯 JSON Schema → fromJsonSchema 包装
//     2. 返回值：string | string[] → { content: TextContent[] }

import { fromJsonSchema } from "@modelcontextprotocol/server";

import type { AnySdkToolDef } from "../sdk/index.js";
import { mcpDefineTool, text, type ToolEntry } from "./tool-registry.js";

/**
 * @brief 将 SDK 工具定义适配为 MCP 工具条目
 *
 * @param def SDK 工具定义（name + 纯 JSON Schema 配置 + 返回纯文本的 handler）
 * @returns MCP ToolEntry（含调用日志包装，由 mcpDefineTool 统一注入）
 */
export function adaptSdkTool(def: AnySdkToolDef): ToolEntry {
  return mcpDefineTool(
    def.name,
    {
      description: def.config.description,
      inputSchema: fromJsonSchema(def.config.inputSchema),
    },
    async (args) => {
      const out = await def.handler(args);
      const lines = Array.isArray(out) ? out : [out];
      return { content: lines.map(text) };
    }
  );
}
