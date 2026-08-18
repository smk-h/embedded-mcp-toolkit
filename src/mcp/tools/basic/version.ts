import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import { pkg } from "../../../shared/package-info.js";

// ── 版本信息来自 package-info（npm/源码模式读磁盘，exe 模式用注入字面量） ──

// ── 声明 ──

export const versionConfig = {
  description: "Get the MCP server version and toolkit information",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

// ── 实现 ──

export async function versionHandler() {
  logger.info("[version_tool]");
  const info = [
    `Name:    ${pkg.name}`,
    `Version: ${pkg.version}`,
    `Node:    ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
  ].join("\n");
  return { content: [text(info)] };
}
