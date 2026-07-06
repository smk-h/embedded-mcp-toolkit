/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : registry.ts
 * Author     : opencode
 * Date       : 2026/06/09
 * Version    : 1.0.0
 * Description: 中心化会话注册表
 *
 *   统一记录所有连接类型（SSH / Serial / ADB / PowerShell）的会话元数据，
 *   提供双向查询能力：
 *     - session_id → 设备名、连接类型、连接信息
 *     - 设备名 → 该设备下的所有活跃会话
 *
 *   Registry 只存储轻量元数据（不含 Transport 实例），
 *   Transport 实例仍由各模块的 Map 独立管理。
 * ======================================================
 */

import { logger } from "../../shared/logger.js";

// ── 类型 ────────────────────────────────────────────────────

/** 会话连接类型 */
export type SessionType = "ssh" | "serial" | "adb" | "powershell";

/**
 * @brief 会话元数据
 *
 * 只包含标识信息，不持有 Transport 实例。
 */
export interface SessionMeta {
  id: string; // session_id，如 "ssh_1"、"serial_3"
  type: SessionType; // 连接类型
  deviceName: string; // 设备别名，如 "board-a"；PowerShell 为 "local"
  connectionInfo: string; // 人可读的连接细节，如 "192.168.16.103:22"、"COM3@115200"
  createdAt: string; // ISO 时间戳，创建时刻
}

// ── SessionRegistry ────────────────────────────────────────

/**
 * @brief 中心化会话注册表（单例）
 *
 * 双向索引：
 *   - #metaBySession : sessionId → SessionMeta
 *   - #sessionsByDevice : deviceName → Set<sessionId>
 *
 * 所有查询均为 O(1)。
 */
class SessionRegistry {
  /** sessionId → 元数据 */
  #metaBySession = new Map<string, SessionMeta>();

  /** deviceName → 该设备所有 sessionId 集合 */
  #sessionsByDevice = new Map<string, Set<string>>();

  /**
   * @brief 注册一个会话
   *
   * @param meta 会话元数据
   */
  register(meta: SessionMeta): void {
    this.#metaBySession.set(meta.id, meta);

    const deviceSet = this.#sessionsByDevice.get(meta.deviceName);
    if (deviceSet) {
      deviceSet.add(meta.id);
    } else {
      this.#sessionsByDevice.set(meta.deviceName, new Set([meta.id]));
    }

    logger.info(
      `[registry] registered ${meta.id} (${meta.type}) → device="${meta.deviceName}"`
    );
  }

  /**
   * @brief 注销一个会话
   *
   * @param sessionId 要移除的会话 ID
   */
  unregister(sessionId: string): void {
    const meta = this.#metaBySession.get(sessionId);
    if (meta) {
      const deviceSet = this.#sessionsByDevice.get(meta.deviceName);
      if (deviceSet) {
        deviceSet.delete(sessionId);
        if (deviceSet.size === 0) {
          this.#sessionsByDevice.delete(meta.deviceName);
        }
      }
    }
    this.#metaBySession.delete(sessionId);
    logger.info(`[registry] unregistered ${sessionId}`);
  }

  /**
   * @brief 根据 session_id 获取会话元数据
   *
   * @param sessionId 会话 ID
   * @returns 元数据，不存在时返回 undefined
   */
  getBySession(sessionId: string): SessionMeta | undefined {
    return this.#metaBySession.get(sessionId);
  }

  /**
   * @brief 根据设备名获取该设备所有活跃会话
   *
   * @param deviceName 设备别名
   * @returns 按创建时间降序排列的会话元数据数组
   */
  getByDevice(deviceName: string): SessionMeta[] {
    const sessionIds = this.#sessionsByDevice.get(deviceName);
    if (!sessionIds) {
      return [];
    }
    const result: SessionMeta[] = [];
    for (const id of sessionIds) {
      const meta = this.#metaBySession.get(id);
      if (meta) {
        result.push(meta);
      }
    }
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return result;
  }

  /**
   * @brief 获取全部活跃会话
   *
   * @returns 按类型分组、创建时间降序排列的元数据数组
   */
  listAll(): SessionMeta[] {
    const result: SessionMeta[] = [];
    for (const meta of this.#metaBySession.values()) {
      result.push(meta);
    }
    result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type.localeCompare(b.type);
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
    return result;
  }

  /**
   * @brief 按连接类型获取会话列表
   *
   * @param type 连接类型（ssh / serial / adb / powershell）
   * @returns 该类型下所有会话，按创建时间降序排列
   */
  listByType(type: SessionType): SessionMeta[] {
    const result: SessionMeta[] = [];
    for (const meta of this.#metaBySession.values()) {
      if (meta.type === type) {
        result.push(meta);
      }
    }
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return result;
  }

  /**
   * @brief 获取活跃会话总数
   *
   * @returns 当前注册的会话数量
   */
  get count(): number {
    return this.#metaBySession.size;
  }
}

/** 全局单例 */
export const registry = new SessionRegistry();
