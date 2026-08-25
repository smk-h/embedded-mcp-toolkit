/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: SDK 类型契约与工具构建器
 *
 *   协议无关的工具定义层：零 MCP / DSH 依赖，只描述「工具是什么、
 *   怎么执行」，协议特有的封装交给各适配层完成。
 * ======================================================
 */

// SDK 类型契约与工具构建器 — 协议无关的工具定义层
//
//   零 MCP / DSH 依赖：只描述「工具是什么、怎么执行」，
//   协议特有的封装（inputSchema 包装、TextContent 拼装等）
//   一律交给各适配层完成（如 src/mcp/adapter.ts，未来 src/dsh/）。

// ── 类型 ────────────────────────────────────────────────────

/** SDK 工具配置：description + 纯 JSON Schema，不含任何协议特有字段 */
export interface SdkToolConfig {
  description: string;
  inputSchema: Record<string, unknown>; // 标准 JSON Schema（type/properties/required）
}

/**
 * SDK 工具回调：接收参数，返回纯文本
 *
 * 返回 `string` 表示单段输出；返回 `string[]` 表示多段输出
 * （适配层按需逐段包装，如 MCP 的多 TextContent）。
 */
export type SdkToolCallback<T = unknown> = (
  args: T
) => string | string[] | Promise<string | string[]>;

/** SDK 工具条目（泛型形式，捕获各 handler 自身的参数类型） */
export interface SdkToolDef<T = unknown> {
  name: string;
  config: SdkToolConfig;
  handler: SdkToolCallback<T>;
}

/** 异构回调的统一存储类型（`unknown` 是 TypeScript 中 `any` 的类型安全替代） */
export type AnySdkToolDef = SdkToolDef<unknown>;

// ── 构建器 ──────────────────────────────────────────────────

/**
 * 用泛型辅助函数创建 SDK 工具条目，同时捕获各 handler 自身的参数类型。
 *
 * 与 mcpDefineTool 不同，这里不做任何包装（无日志、无格式转换），
 * 保证 sdk 层输出即工具的真实执行逻辑。
 *
 * @param name 工具名（各协议层注册时沿用）
 * @param config 协议无关的工具配置
 * @param handler 工具执行函数，返回 string 或 string[]
 * @returns 统一存储类型的工具条目
 */
export function sdkDefineTool<T>(
  name: string,
  config: SdkToolConfig,
  handler: (args: T) => string | string[] | Promise<string | string[]>
): AnySdkToolDef {
  return { name, config, handler: handler as SdkToolCallback };
}
