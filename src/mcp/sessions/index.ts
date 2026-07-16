/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/07/14
 * Version    : 1.0.0
 * Description: 会话域聚合导出
 *
 *   统一对外暴露会话基础设施：
 *     - ShellSessionStore：实例存储层（session-store.ts）
 *     - registry / SessionType / SessionMeta：元数据层（registry.ts）
 *
 *   各工具通道从此处统一引用，不再各自分散 import registry。
 * ======================================================
 */

export { ShellSessionStore } from "./session-store.js";
export type { CreateSessionMeta, GetResult } from "./session-store.js";

export { registry, type SessionType, type SessionMeta } from "./registry.js";
