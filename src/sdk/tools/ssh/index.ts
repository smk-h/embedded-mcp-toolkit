/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : 1.0.0
 * Description: SDK SSH 工具统一定义入口
 *
 *   协议无关的 SSH 工具聚合（shell 会话 / 一键登录 / 远程编译 / SFTP）；
 *   MCP 侧注册见 src/mcp/tools/ssh/index.ts。
 * ======================================================
 */

// SDK SSH 工具 — SSH 相关工具的统一定义入口（协议无关）

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

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
  sshShellSendCtrlConfig,
  sshShellSendCtrlHandler,
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
export const sdkSshTools: AnySdkToolDef[] = [
  sdkDefineTool("ssh_shell_open", sshShellOpenConfig, sshShellOpenHandler),
  sdkDefineTool("ssh_shell_close", sshShellCloseConfig, sshShellCloseHandler),
  sdkDefineTool("ssh_shell_write", sshShellWriteConfig, sshShellWriteHandler),
  sdkDefineTool("ssh_shell_read", sshShellReadConfig, sshShellReadHandler),
  sdkDefineTool("ssh_shell_exec", sshShellExecConfig, sshShellExecHandler),
  sdkDefineTool(
    "ssh_shell_send_ctrl",
    sshShellSendCtrlConfig,
    sshShellSendCtrlHandler
  ),
  sdkDefineTool(
    "ssh_shell_connection",
    sshConnectionsConfig,
    sshConnectionsHandler
  ),
  sdkDefineTool("ssh_shell_login", sshShellLoginConfig, sshShellLoginHandler),
  sdkDefineTool("ssh_build", sshBuildConfig, sshBuildHandler),
  sdkDefineTool("ssh_sftp_upload", sshSftpUploadConfig, sshSftpUploadHandler),
  sdkDefineTool(
    "ssh_sftp_download",
    sshSftpDownloadConfig,
    sshSftpDownloadHandler
  ),
];
