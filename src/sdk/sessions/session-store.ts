/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : session-store.ts
 * Author     : sumu
 * Date       : 2026/07/14
 * Version    : x.x.x
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

import { BaseShell } from "../../sdk/transports/base-shell.js";
import { registry, type SessionType } from "./registry.js";
import { logger } from "../../sdk/shared/logger.js";

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
  logPath?: string; // 日志文件完整路径，来自 enableFromEnv 的返回值；未启用时为 undefined
}

// ── SessionMutex ───────────────────────────────────────────

/**
 * @brief 异步互斥锁（Promise-based mutex）
 *
 * 基于 Promise 链实现：acquire() 返回一个 Promise，持有锁的调用 release() 后
 * 队列中下一个 acquire() 的 Promise 才 resolve。同一时刻只有一个 acquire 持有锁。
 *
 * 用于 per-session 串行化：同一 session 的并发工具调用排队执行，
 * 避免共享 OutputBuffer 被并发 drain/write 污染。
 *
 * 无外部依赖，Node 单线程事件循环下 Promise 链天然保证 FIFO 公平性。
 */
class SessionMutex {
  /** @brief 是否已锁定 */
  #locked = false;
  /** @brief 等待队列：每个 entry 是 release 时要 resolve 的函数 */
  #queue: (() => void)[] = [];

  /**
   * @brief 获取锁，返回释放函数
   *
   * 锁空闲时立即返回（同步 resolve）；锁已被持有时入队等待，
   * 当前持有者调 release 后队列首部的 waiter 才被唤醒。
   *
   * @returns release 函数，调用后释放锁并唤醒下一个 waiter
   */
  async acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return () => this.release();
    }
    // 锁已被持有，入队等待
    return new Promise<() => void>((resolve) => {
      this.#queue.push(() => {
        this.#locked = true;
        resolve(() => this.release());
      });
    });
  }

  /**
   * @brief 释放锁并唤醒队列中下一个 waiter
   */
  private release(): void {
    this.#locked = false;
    const next = this.#queue.shift();
    if (next) {
      next();
    }
  }
}

// ── ShellSessionStore ──────────────────────────────────────

/**
 * @brief 泛型会话存储
 *
 * 以 session_id 为键存储 BaseShell 子类实例，统一管理 ID 生成、registry 协调与批量清理。
 * 各通道实例化时传入前缀（"ssh" / "serial" / "adb" / "power"），计数器各自独立。
 *
 * 每个 session 绑定一把独立的 SessionMutex，通过 withLock() 串行化对该 session 的并发操作。
 * 不同 session 的锁互相独立，不会互相阻塞。
 *
 * @typeParam T - BaseShell 的具体子类类型
 */
export class ShellSessionStore<T extends BaseShell> {
  /** @brief 会话实例表：session_id → shell 实例 */
  readonly #sessions = new Map<string, T>();

  /** @brief per-session 互斥锁表：session_id → SessionMutex */
  readonly #mutexes = new Map<string, SessionMutex>();

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
    this.#mutexes.set(sessionId, new SessionMutex());
    registry.register({
      id: sessionId,
      type: meta.type,
      deviceName: meta.deviceName,
      connectionInfo: meta.connectionInfo,
      createdAt: new Date().toISOString(), // UTC
      logPath: meta.logPath,
    });
    return sessionId;
  }

  /**
   * @brief 预览下一个将分配的 session_id
   *
   * 返回 `${prefix}_${counter+1}`，但不递增计数器、不写实例表、不调 registry。
   * 供调用方在 create() 之前先用该预览 ID 调用 enableFromEnv 建日志文件，
   * 拿到日志路径后再由 create() 一次性写入会话元数据。
   *
   * 并发安全：单线程事件循环下，peekNextId → enableFromEnv → create 三步
   * 之间无 await（均为同步调用），在同一微任务内完成，不存在另一个调用抢占计数器的窗口。
   *
   * @returns 下一个将分配的 session_id（如 "ssh_1"）
   */
  peekNextId(): string {
    return `${this.#prefix}_${this.#counter + 1}`;
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
    this.#mutexes.delete(sessionId);
    registry.unregister(sessionId);
  }

  /**
   * @brief 在 session 互斥锁保护下执行异步操作
   *
   * 同一 session_id 的并发调用会串行排队：先到先执行，后到者在 acquire() 处 await 等待，
   * 前一个调用的 fn resolve 后才获得锁开始执行。确保同一 session 的 OutputBuffer
   * 不会被并发 drain/write 污染。
   *
   * 不同 session_id 的锁互相独立，不会互相阻塞。
   *
   * session 不存在时直接执行 fn（让 fn 内部的 get() 返回 not-found 结果），
   * 不阻塞调用方。
   *
   * @param sessionId - 会话 ID
   * @param fn - 需要在锁保护下执行的异步函数
   * @returns fn 的返回值
   */
  async withLock<R>(sessionId: string, fn: () => Promise<R>): Promise<R> {
    const mutex = this.#mutexes.get(sessionId);
    if (!mutex) {
      // session 不存在（可能已被 close/remove），直接执行 fn 让调用方走 not-found 逻辑
      return fn();
    }
    const release = await mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
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
    this.#mutexes.clear();
  }
}
