// MCP Server — 创建 McpServer 实例、注册所有工具、提供启动入口

import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { mcpBasicTools } from "./mcp_basic/index.js";
import { mcpSshTools } from "./mcp_ssh/index.js";
import { mcpSerialTools } from "./mcp_serial/index.js";

// ── package info ───────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8")
);

// ── server 实例 ────────────────────────────────────────────

export const server = new McpServer({ name: pkg.name, version: pkg.version });

// ── 工具批量注册 ───────────────────────────────────────────

for (const { name, config, handler } of mcpBasicTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpSshTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpSerialTools) {
  server.registerTool(name, config, handler);
}

// ── 启动入口 ───────────────────────────────────────────────

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
