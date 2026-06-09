/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : session_info.ts
 * Author     : opencode
 * Date       : 2026/06/09
 * Version    : 1.0.0
 * Description: session_info MCP 工具
 *
 *   提供跨连接类型的会话查询能力：
 *     - 按 session_id 查询 → 返回该会话的完整元数据
 *     - 按 device 查询 → 返回该设备的所有活跃会话
 *     - 无参数 → 返回全部活跃会话（跨类型总览）
 * ======================================================
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { registry, type SessionMeta } from "../../sessions/registry.js";

// ── session_info ──────────────────────────────────────────

/**
 * @brief session_info 工具配置
 *
 * 双向查询会话信息：
 *   - 传 session_id → 返回该会话的元数据
 *   - 传 device    → 返回该设备下所有会话
 *   - 都不传       → 返回当前全部活跃会话
 */
export const sessionInfoConfig = {
  description:
    "Query session information: pass session_id to get metadata for one session, pass device to list all sessions for a device, or omit both to list all active sessions across all connection types.",
  inputSchema: fromJsonSchema<{
    session_id?: string;
    device?: string;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "Session ID (e.g. ssh_1). Returns metadata for this session.",
      },
      device: {
        type: "string",
        description:
          "Device name (e.g. board-a). Lists all sessions for this device.",
      },
    },
  }),
};

/**
 * @brief 格式化单条会话元数据为多行字符串
 *
 * @param s 会话元数据
 * @returns 格式化后的文本行数组
 */
function formatSessionMeta(s: SessionMeta): string[] {
  return [
    `  [${s.id}]`,
    `  Type:         ${s.type}`,
    `  Device:       ${s.deviceName}`,
    `  Connection:   ${s.connectionInfo}`,
    `  Created:      ${s.createdAt}`,
    "",
  ];
}

/**
 * @brief session_info 处理函数
 *
 * 三种查询模式：
 *   1. session_id 传入 → 查询单个会话
 *   2. device 传入 → 查询该设备所有会话
 *   3. 都未传入 → 列出全部活跃会话
 *
 * @param args 工具参数，包含可选的 session_id 和 device
 * @returns MCP 响应
 */
export function sessionInfoHandler(args: {
  session_id?: string;
  device?: string;
}) {
  // 模式 1：按 session_id 单点查询
  if (args.session_id) {
    logger.info(`[session_info] session_id=${args.session_id}`);
    const meta = registry.getBySession(args.session_id);
    if (!meta) {
      return {
        content: [text(`Session '${args.session_id}' not found in registry.`)],
      };
    }
    const lines = formatSessionMeta(meta);
    return { content: [text(lines.join("\n").trim())] };
  }

  // 模式 2：按 device 查询该设备所有会话
  if (args.device) {
    logger.info(`[session_info] device=${args.device}`);
    const sessions = registry.getByDevice(args.device);
    if (sessions.length === 0) {
      return {
        content: [text(`No active sessions for device '${args.device}'.`)],
      };
    }
    const lines: string[] = [
      `Sessions for device '${args.device}' (${sessions.length}):`,
      "",
    ];
    for (const s of sessions) {
      lines.push(...formatSessionMeta(s));
    }
    return { content: [text(lines.join("\n").trim())] };
  }

  // 模式 3：列出全部活跃会话
  logger.info("[session_info] list all");
  const all = registry.listAll();
  if (all.length === 0) {
    return { content: [text("No active sessions.")] };
  }
  const lines: string[] = [`All active sessions (${all.length}):`, ""];
  for (const s of all) {
    lines.push(...formatSessionMeta(s));
  }
  return { content: [text(lines.join("\n").trim())] };
}
