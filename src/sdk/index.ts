/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: SDK 聚合出口
 *
 *   外部项目统一从此处引用 sdk 能力（类型契约 + 各工具组定义），
 *   不经由 mcp/ 目录，保证复用时不引入协议歧义。
 * ======================================================
 */

// SDK 聚合出口 — 协议无关的工具定义与执行能力
//
//   外部项目（含未来 dsh 插件层）统一从此处引用 sdk 能力，
//   不经由 mcp/ 目录，保证复用时不引入协议歧义。

export type {
  SdkToolConfig,
  SdkToolCallback,
  SdkToolDef,
  AnySdkToolDef,
} from "./types.js";
export { sdkDefineTool } from "./types.js";

export { sdkBasicTools } from "./tools/basic/index.js";
export { sdkAdbTools } from "./tools/adb/index.js";
export { sdkSshTools } from "./tools/ssh/index.js";
export { sdkSerialTools } from "./tools/serial/index.js";
