// mcp 共享辅助函数、类型与工具构建器

import { fromJsonSchema } from "@modelcontextprotocol/server";

// ── 辅助函数 ────────────────────────────────────────────────

/** 快速构造 MCP TextContent 对象 */
export function text(content: string) {
  return { type: "text" as const, text: content };
}

/** 获取错误的可读消息 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 类型 ────────────────────────────────────────────────────

/** MCP 工具回调：接收参数，返回 content 数组 */
export type mcpToolCallback = (
  args: unknown
) =>
  | { content: { type: "text"; text: string }[] }
  | Promise<{ content: { type: "text"; text: string }[] }>;

/** 工具配置 */
export interface mcpToolConfig {
  description: string;
  inputSchema: ReturnType<typeof fromJsonSchema>;
}

/** 工具条目 */
export interface ToolEntry {
  name: string;
  config: mcpToolConfig;
  handler: mcpToolCallback;
}

// ── 构建器 ──────────────────────────────────────────────────

/**
 * 用泛型辅助函数创建工具条目，同时捕获各 handler 自身的参数类型。
 * `unknown` 用于异构回调的统一存储，是 TypeScript 中 `any` 的类型安全替代。
 */
export function mcpDefineTool<T>(
  name: string,
  config: mcpToolConfig,
  handler: (args: T) => ReturnType<mcpToolCallback>
): ToolEntry {
  return { name, config, handler: handler as mcpToolCallback };
}
