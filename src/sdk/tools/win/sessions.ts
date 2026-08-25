/**
 * @file PowerShell 通道会话存储实例
 *
 * 实例化 ShellSessionStore 并导出，供 win 目录内各工具 handler 共享。
 * disposeAllPowerShellSessions 保持原名，server.ts cleanup 钩子按名引用。
 */

import { ShellSessionStore } from "../../sessions/index.js";
import { PowerShellShell } from "../../../transports/powershell.js";

/** @brief PowerShell 会话存储实例（前缀 "power" → 生成 power_1、power_2 ...） */
export const powerStore = new ShellSessionStore<PowerShellShell>("power");

/**
 * @brief 关闭所有活跃的 PowerShell 会话
 *
 * 在 MCP Server 进程退出时调用，确保所有 powershell.exe 子进程被终止，
 * 避免僵尸进程残留。
 */
export async function disposeAllPowerShellSessions(): Promise<void> {
  await powerStore.disposeAll("power_dispose");
}
