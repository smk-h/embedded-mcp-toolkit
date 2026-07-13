/**
 * @file Serial 通道会话存储实例
 *
 * 实例化 ShellSessionStore 并导出，供 serial 目录内各工具 handler 共享。
 * disposeAllSerialSessions 保持原名，server.ts cleanup 钩子按名引用。
 *
 * 注意：Serial 的 portToSession（COM 口防重）作为通道特有逻辑，
 * 保留在 shell.ts 内，不在此处也不进基类。
 */

import { ShellSessionStore } from "../../sessions/index.js";
import { SerialShell } from "../../../transports/serial.js";

/** @brief Serial 会话存储实例（前缀 "serial" → 生成 serial_1、serial_2 ...） */
export const serialStore = new ShellSessionStore<SerialShell>("serial");

/**
 * @brief COM 口到 session_id 的映射，用于防止同一串口被重复打开
 *
 * 通道特有逻辑，保留在 serial 目录（不进基类）。
 * 由 shell.ts 的 open/close/login 配合 serialStore 使用。
 */
export const portToSession = new Map<string, string>();

/**
 * @brief 关闭所有活跃的串口会话
 *
 * 在 MCP Server 进程退出时调用，确保所有串口连接被正确关闭，
 * 释放端口资源，避免串口残留占用。
 */
export async function disposeAllSerialSessions(): Promise<void> {
  await serialStore.disposeAll("serial_dispose");
  portToSession.clear();
}
