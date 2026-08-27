/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tool-registry.ts
 * Author     : sumu
 * Date       : 2026/05/26
 * Version    : x.x.x
 * Description: MCP 工具注册辅助 — 工具条目类型与批量注册
 * ======================================================
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";
import { logger } from "../sdk/shared/logger.js";

// ── 辅助函数 ────────────────────────────────────────────────

/** 快速构造 MCP TextContent 对象 */
export function text(content: string) {
  return { type: "text" as const, text: content };
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
  return {
    name,
    config,
    handler: withInvocationLog(name, handler as mcpToolCallback),
  };
}

/** 工具调用序号：进程内单调递增，用于配对同一次调用的开始/结束行 */
let invocationSeq = 0;

/**
 * 统一包裹工具执行：记录调用开始（含 AI 传入的原始参数）与调用结束。
 * 每次调用分配 #N 序号，开始/结束行同带序号，据此能精确配对每一次
 * 工具调用的边界（含并发同名调用）。┌─/└─ 角朝向不同，连续调用时
 * 上一条的结束与下一条的开始不会混淆。
 */
function withInvocationLog(
  name: string,
  handler: mcpToolCallback
): mcpToolCallback {
  return async (args: unknown) => {
    const raw = args === undefined ? "" : JSON.stringify(args);
    const seq = ++invocationSeq;
    logger.info(`┌─ #${seq} BEGIN [${name}] args=${raw}`);
    const started = Date.now();
    try {
      const result = await handler(args);
      const ms = Date.now() - started;
      logger.info(`└─ #${seq} END/SUCCESS [${name}] elapsed=${ms}ms`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - started;
      logger.error(
        `└─ #${seq} END/FAIL [${name}] elapsed=${ms}ms err=${msg}`
      );
      throw err;
    }
  };
}
