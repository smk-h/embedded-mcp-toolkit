/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sessions.ts
 * Author     : sumu
 * Date       : 2026/07/14
 * Version    : x.x.x
 * Description: 实例化 ShellSessionStore 并导出，供 serial 目录内各工具 handler 共享。
 *
 * disposeAllSerialSessions 保持原名，server.ts cleanup 钩子按名引用。
 *
 * 注意：Serial 的 portToSession（端口防重，键为 COM 口或 TCP 端点）作为通道特有逻辑，
 * 保留在 shell.ts 内，不在此处也不进基类。
 * ======================================================
 */

import { ShellSessionStore } from "../../sessions/index.js";
import { SerialShell } from "../../transports/serial.js";
import { logger } from "../../shared/logger.js";

/** @brief Serial 会话存储实例（前缀 "serial" → 生成 serial_1、serial_2 ...） */
export const serialStore = new ShellSessionStore<SerialShell>("serial");

/**
 * @brief 端口标识到 session_id 的映射，用于防止同一串口/TCP 端点被重复打开
 *
 * 键为 serial_open 的 port 参数原值：物理串口（COM3 等）或 TCP 端点
 * （tcp://host:port）。通道特有逻辑，保留在 serial 目录（不进基类）。
 * 由 shell.ts 的 open/close/login 配合 serialStore 使用。
 */
export const portToSession = new Map<string, string>();

/**
 * @brief U-Boot 态会话集合
 *
 * serial_enter_uboot 成功进入 U-Boot 后标记对应 session_id，serial_exec
 * 据此把 marker 包装切为 plain 风格（去掉子 shell 括号——U-Boot 的 hush
 * shell 不支持该语法；`; echo` 无条件执行，1级 marker 检测照常生效）。
 * 会话关闭时由 serial_close / disposeAllSerialSessions 清理。
 */
const ubootSessions = new Set<string>();

/** @brief 标记会话当前处于 U-Boot 命令行 */
export function markUbootSession(sessionId: string): void {
  ubootSessions.add(sessionId);
  logger.info(`[serial] U-Boot mark set for session ${sessionId}`);
}

/** @brief 判定会话是否处于 U-Boot 命令行（serial_exec 据此决定 marker 包装风格） */
export function isUbootSession(sessionId: string): boolean {
  return ubootSessions.has(sessionId);
}

/** @brief 清除会话的 U-Boot 标记（会话关闭时调用） */
export function clearUbootSession(sessionId: string): void {
  ubootSessions.delete(sessionId);
  logger.info(`[serial] U-Boot mark cleared for session ${sessionId}`);
}

/**
 * @brief 关闭所有活跃的串口会话
 *
 * 在 MCP Server 进程退出时调用，确保所有串口连接被正确关闭，
 * 释放端口资源，避免串口残留占用。
 */
export async function disposeAllSerialSessions(): Promise<void> {
  await serialStore.disposeAll("serial_dispose");
  portToSession.clear();
  ubootSessions.clear();
}
