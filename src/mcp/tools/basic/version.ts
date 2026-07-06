import { fromJsonSchema } from "@modelcontextprotocol/server";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";

// ── 读取 package.json 获取版本信息 ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../package.json"), "utf-8")
);

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
