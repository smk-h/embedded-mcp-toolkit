/**
 * @file SSH 通道会话存储实例
 *
 * 实例化 ShellSessionStore 并导出，供 ssh 目录内各工具 handler 共享，
 * 也供 build.ts / sftp.ts 跨文件查询会话。
 * disposeAllSshSessions 保持原名，server.ts cleanup 钩子按名引用。
 */

import { ShellSessionStore } from "../../sessions/index.js";
import { SSHShell } from "../../../transports/ssh.js";

/** @brief SSH 会话存储实例（前缀 "ssh" → 生成 ssh_1、ssh_2 ...） */
export const sshStore = new ShellSessionStore<SSHShell>("ssh");

/**
 * @brief 关闭所有活跃的 SSH 会话
 *
 * 在 MCP Server 进程退出时调用，确保所有 SSH 连接被正确关闭，
 * 释放网络资源。
 */
export async function disposeAllSshSessions(): Promise<void> {
  await sshStore.disposeAll("ssh_dispose");
}
