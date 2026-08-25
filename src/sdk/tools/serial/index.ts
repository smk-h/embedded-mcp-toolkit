/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: SDK Serial 工具统一定义入口
 *
 *   协议无关的串口工具聚合（shell 会话 / 一键登录 / U-Boot 编排 /
 *   ZMODEM 传输）；MCP 侧注册见 src/mcp/tools/serial/index.ts。
 * ======================================================
 */

// SDK Serial 工具 — 串口相关工具的统一定义入口（协议无关）

import { sdkDefineTool, type AnySdkToolDef } from "../../types.js";

import {
  serialOpenConfig,
  serialOpenHandler,
  serialCloseConfig,
  serialCloseHandler,
  serialWriteConfig,
  serialWriteHandler,
  serialReadConfig,
  serialReadHandler,
  serialExecConfig,
  serialExecHandler,
  serialSendCtrlConfig,
  serialSendCtrlHandler,
  serialShellLoginConfig,
  serialShellLoginHandler,
  serialEnterUbootConfig,
  serialEnterUbootHandler,
  serialUbootStateConfig,
  serialUbootStateHandler,
} from "./shell.js";
import {
  serialUploadConfig,
  serialUploadHandler,
  serialDownloadConfig,
  serialDownloadHandler,
} from "./transfer.js";

// ── 工具列表 ────────────────────────────────────────────────

/**
 * 所有已定义的串口工具列表。
 * 添加新工具时只需在此数组中追加一项即可。
 */
export const sdkSerialTools: AnySdkToolDef[] = [
  sdkDefineTool("serial_open", serialOpenConfig, serialOpenHandler),
  sdkDefineTool("serial_close", serialCloseConfig, serialCloseHandler),
  sdkDefineTool("serial_write", serialWriteConfig, serialWriteHandler),
  sdkDefineTool("serial_read", serialReadConfig, serialReadHandler),
  sdkDefineTool("serial_exec", serialExecConfig, serialExecHandler),
  sdkDefineTool(
    "serial_send_ctrl",
    serialSendCtrlConfig,
    serialSendCtrlHandler
  ),
  sdkDefineTool(
    "serial_shell_login",
    serialShellLoginConfig,
    serialShellLoginHandler
  ),
  sdkDefineTool(
    "serial_enter_uboot",
    serialEnterUbootConfig,
    serialEnterUbootHandler
  ),
  sdkDefineTool(
    "serial_uboot_state",
    serialUbootStateConfig,
    serialUbootStateHandler
  ),
  sdkDefineTool("serial_upload", serialUploadConfig, serialUploadHandler),
  sdkDefineTool("serial_download", serialDownloadConfig, serialDownloadHandler),
];
