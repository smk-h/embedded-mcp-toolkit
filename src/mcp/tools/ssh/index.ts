// MCP SSH 工具 — SSH 相关工具的统一定义入口（只导出工具，注册由 src/mcp.ts 负责）

import { mcpDefineTool, ToolEntry } from "../../tool-registry.js";

import {
  sshShellOpenConfig,
  sshShellOpenHandler,
  sshShellCloseConfig,
  sshShellCloseHandler,
  sshShellWriteConfig,
  sshShellWriteHandler,
  sshShellReadConfig,
  sshShellReadHandler,
  sshShellExecConfig,
  sshShellExecHandler,
  sshConnectionsConfig,
  sshConnectionsHandler,
  sshShellLoginConfig,
  sshShellLoginHandler,
} from "./shell.js";
import { sshBuildConfig, sshBuildHandler } from "./build.js";
import {
  sshSftpUploadConfig,
  sshSftpUploadHandler,
  sshSftpDownloadConfig,
  sshSftpDownloadHandler,
} from "./sftp.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的 SSH 工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const mcpSshTools: ToolEntry[] = [
  mcpDefineTool("ssh_shell_open", sshShellOpenConfig, sshShellOpenHandler),
  mcpDefineTool("ssh_shell_close", sshShellCloseConfig, sshShellCloseHandler),
  mcpDefineTool("ssh_shell_write", sshShellWriteConfig, sshShellWriteHandler),
  mcpDefineTool("ssh_shell_read", sshShellReadConfig, sshShellReadHandler),
  mcpDefineTool("ssh_shell_exec", sshShellExecConfig, sshShellExecHandler),
  mcpDefineTool(
    "ssh_shell_connection",
    sshConnectionsConfig,
    sshConnectionsHandler
  ),
  mcpDefineTool("ssh_shell_login", sshShellLoginConfig, sshShellLoginHandler),
  mcpDefineTool("ssh_build", sshBuildConfig, sshBuildHandler),
  mcpDefineTool("ssh_sftp_upload", sshSftpUploadConfig, sshSftpUploadHandler),
  mcpDefineTool(
    "ssh_sftp_download",
    sshSftpDownloadConfig,
    sshSftpDownloadHandler
  ),
];
