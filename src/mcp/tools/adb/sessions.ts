/**
 * @file ADB 通道会话存储实例
 *
 * 实例化 ShellSessionStore 并导出，供 adb 目录内各工具 handler 共享。
 * disposeAllAdbShellSessions 保持原名，server.ts cleanup 钩子按名引用。
 */

import { ShellSessionStore } from "../../sessions/index.js";
import { AdbShell } from "../../../transports/adb.js";

/** @brief ADB 会话存储实例（前缀 "adb" → 生成 adb_1、adb_2 ...） */
export const adbStore = new ShellSessionStore<AdbShell>("adb");

/**
 * @brief 关闭所有活跃的 ADB Shell 会话
 *
 * 在 MCP Server 进程退出时调用，确保所有 adb shell 子进程被终止，
 * 避免僵尸进程残留。
 */
export async function disposeAllAdbShellSessions(): Promise<void> {
  await adbStore.disposeAll("adb_dispose");
}
