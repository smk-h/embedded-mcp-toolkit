import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../helper/mcp_helper.js";
import { logger } from "../common/logger.js";

// ── 声明 ──

export const greetConfig = {
  description: "Greet someone by name",
  inputSchema: fromJsonSchema<{ name: string }>({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }),
};

// ── 实现 ──

export async function greetHandler(args: { name: string }) {
  logger.info(`[greet_tool] name=${args.name}`);
  return { content: [text(`Hello, ${args.name}!`)] };
}
