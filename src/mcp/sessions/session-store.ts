/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : session-store.ts
 * Author     : sumu
 * Date       : 2026/07/14
 * Version    : 1.0.0
 * Description: 泛型会话存储（实例存储层）
 *
 *   以 session_id 为键存储 BaseShell 子类实例，统一承担：
 *     - ID 生成（<prefix>_<自增>，格式与各通道现状逐字一致）
 *     - 注册/注销到中心化 registry
 *     - 批量清理（disposeAll）
 *
 *   与 registry.ts 成对共存：
 *     - registry 存"会话是什么"（轻量元数据：id → type/deviceName/connectionInfo）
 *     - store  存"会话连着谁"（实例引用：id → BaseShell 子类实例）
 *
 *   设计约束：
 *     - create 只管"生成 ID + 存 Map + 注册 registry"，不调 open（open 参数各异，由各通道 handler 负责）
 *     - remove 只管"删 Map + 注销 registry"，不调 close（close handler 需先 shell.close() 再 remove，职责分离）
 * ======================================================
 */

import { BaseShell } from "../../transports/base-shell.js";
import { registry, type SessionType } from "./registry.js";
import { text } from "../tool-registry.js";
import { logger } from "../../shared/logger.js";

// ── 类型 ────────────────────────────────────────────────────

/**
 * @brief 创建会话所需的元数据
 *
 * 不含 id（由 store 自动生成）和 createdAt（由 store 自动填充），
 * 由各通道的 open/login handler 构建后传入 create()。
 */
export interface CreateSessionMeta {
  type: SessionType; // 连接类型（ssh / serial / adb / powershell）
  deviceName: string; // 设备别名，如 "board-a"；PowerShell 为 "local"
  connectionInfo: string; // 人可读的连接细节，如 "192.168.16.103:22"、"COM3@115200"
}

/**
 * @brief getOrNotFound 的查询结果（判别联合）
 *
 * 命中时 ok=true 并携带 shell 实例；未命中时 ok=false 并携带统一文案的 MCP 响应。
 * 调用方用 `if (!result.ok) return result.response;` 一行处理 not-found 分支。
 */
export type GetResult<T extends BaseShell> =
  | { ok: true; shell: T }
  | { ok: false; response: { content: { type: "text"; text: string }[] } };

// ── ShellSessionStore ──────────────────────────────────────

/**
 * @brief 泛型会话存储
 *
 * 以 session_id 为键存储 BaseShell 子类实例，统一管理 ID 生成、registry 协调与批量清理。
 * 各通道实例化时传入前缀（"ssh" / "serial" / "adb" / "power"），计数器各自独立。
 *
 * @typeParam T - BaseShell 的具体子类类型
 */
export class ShellSessionStore<T extends BaseShell> {
  /** @brief 会话实例表：session_id → shell 实例 */
  readonly #sessions = new Map<string, T>();

  /** @brief 自增计数器，用于生成唯一 session_id */
  #counter = 0;

  /** @brief session ID 前缀，如 "ssh"、"serial"、"adb"、"power" */
  readonly #prefix: string;

  /**
   * @brief 构造会话存储
   *
   * @param prefix - session ID 前缀，决定生成的 ID 格式（如 "ssh" → "ssh_1"、"ssh_2"）
   */
  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  /**
   * @brief 创建会话：生成 ID、存入 Map、注册到 registry
   *
   * 只负责"生成 ID + 存 Map + 注册 registry"，不调 open（open 由各通道 handler 负责）。
   *
   * @param shell - 已 open 成功的 BaseShell 子类实例
   * @param meta  - 连接元数据（类型、设备名、连接信息）
   * @returns 生成的 session_id（如 "ssh_1"）
   */
  create(shell: T, meta: CreateSessionMeta): string {
    const sessionId = `${this.#prefix}_${++this.#counter}`;
    this.#sessions.set(sessionId, shell);
    registry.register({
      id: sessionId,
      type: meta.type,
      deviceName: meta.deviceName,
      connectionInfo: meta.connectionInfo,
      createdAt: new Date().toISOString(), // UTC
    });
    return sessionId;
  }

  /**
   * @brief 查询会话
   *
   * @param sessionId - 会话 ID
   * @returns shell 实例，不存在时返回 undefined
   */
  get(sessionId: string): T | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * @brief 查询会话，不存在时返回统一的 not-found MCP 响应
   *
   * 封装各 handler 里重复最多的 not-found 样板。返回值用判别联合，类型安全。
   * 调用方典型用法：
   *   const result = store.getOrNotFound(session_id);
   *   if (!result.ok) return result.response;
   *   const shell = result.shell;
   *
   * @param sessionId - 会话 ID
   * @returns 命中返回 { ok: true, shell }，未命中返回 { ok: false, response }
   */
  getOrNotFound(sessionId: string): GetResult<T> {
    const shell = this.#sessions.get(sessionId);
    if (shell) {
      return { ok: true, shell };
    }
    return {
      ok: false,
      response: {
        content: [text(`Session ${sessionId} not found.`)],
      },
    };
  }

  /**
   * @brief 删除会话：从 Map 删除、从 registry 注销
   *
   * 只负责"删 Map + 注销 registry"，不调 close（close 由各 handler 在合适时机调，
   * 如 close handler 先 `shell.close()` 再 `store.remove()`）。职责分离，
   * 避免存储类越权控制连接生命周期。
   *
   * @param sessionId - 要移除的会话 ID
   */
  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
    registry.unregister(sessionId);
  }

  /**
   * @brief 批量清理：遍历 close 所有会话、清空 Map、注销 registry
   *
   * 在 MCP Server 进程退出时由各通道的 disposeAll 包装函数调用。
   * 单个会话 close 失败不会中断其余会话的清理（try/catch 包裹）。
   *
   * @param logPrefix - dispose 日志前缀，如 "ssh_dispose"、"serial_dispose"
   */
  async disposeAll(logPrefix: string): Promise<void> {
    const entries = [...this.#sessions.entries()];
    for (const [id, shell] of entries) {
      try {
        await shell.close();
        logger.info(`[${logPrefix}] session ${id} closed`);
      } catch (err) {
        logger.error(`[${logPrefix}] session ${id} close failed:`, err);
      }
      registry.unregister(id);
    }
    this.#sessions.clear();
  }
}
