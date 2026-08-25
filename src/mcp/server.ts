/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : server.ts
 * Author     : sumu
 * Date       : 2026/05/26
 * Version    : x.x.x
 * Description: MCP 服务器入口 — 传输初始化与全部工具注册
 * ======================================================
 */

// MCP Server — 创建 McpServer 实例、注册所有工具、提供启动入口

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as os from "os";
import { resolveHostEndpoint } from "../sdk/host/host-endpoint.js";
import { buildRoutingInstructions } from "../sdk/host/build-routing.js";

import { logger } from "../sdk/shared/logger.js";
import { pkg } from "../sdk/shared/package-info.js";
import {
  mcpBasicTools,
  mcpSshTools,
  mcpSerialTools,
  mcpWinTools,
  mcpAdbTools,
} from "./tools.js";

// ── package info ───────────────────────────────────────────
// 经由 package-info 统一读取：npm/源码模式读磁盘，单文件 exe 模式用打包期注入的字面量

// ── server 实例 ────────────────────────────────────────────

// ── 远程 SSH 启动时的宿主端点提示 ────────────────────

// 解析宿主端点(username@ip)。仅远程 SSH 启动(存在 SSH_CONNECTION)时产出端点;
// 本地启动返回 local 场景,不注入端点相关内容,保持原有行为不变。
const hostEndpoint = resolveHostEndpoint();
// 远程 SSH 启动:把宿主端点通过 instructions 告知对端 AI 客户端,
// 供其构造跨机文件传输(scp)命令。本地启动:instructions 为 undefined。
const instructions =
  hostEndpoint.scenario === "remote-ssh" && hostEndpoint.endpoint
    ? [
        "This MCP server runs on Windows and is invoked over SSH from a remote AI client running on Linux.",
        `You (the AI client) are on Linux; the MCP host (Windows) endpoint is ${hostEndpoint.endpoint}.`,
        "To transfer files between your Linux machine and the Windows MCP host, run scp in your own Linux shell always passing the passwordless key -i ~/.ssh/id_mcp_server",
        "(NOT via the power_shell_* tools, which execute on the Windows host and would only scp Windows to itself).",
        `To pull a file from Windows: scp -i ~/.ssh/id_mcp_server ${hostEndpoint.endpoint}:"E:/path" ~/local/.`,
        `To push to Windows: scp -i ~/.ssh/id_mcp_server ~/local/file ${hostEndpoint.endpoint}:"E:/path/".`,
        buildRoutingInstructions(),
      ].join(" ")
    : undefined;

export const server = new McpServer(
  { name: pkg.name, version: pkg.version },
  { capabilities: { logging: {} }, instructions }
);

// ── 工具批量注册 ───────────────────────────────────────────

for (const { name, config, handler } of mcpBasicTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpSshTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpSerialTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpWinTools) {
  server.registerTool(name, config, handler);
}

for (const { name, config, handler } of mcpAdbTools) {
  server.registerTool(name, config, handler);
}

// ── 进程退出自动清理 ───────────────────────────────────────

/**
 * @brief 进程退出时关闭所有活跃的 shell 会话
 *
 * 在 SIGINT (Ctrl+C)、SIGTERM、beforeExit 时触发，
 * 确保串口、SSH、PowerShell 连接被正确释放，
 * 避免端口占用和僵尸进程。
 */
async function cleanupAllSessions() {
  // 动态导入避免循环依赖，仅在清理时加载
  const [
    { disposeAllSerialSessions },
    { disposeAllSshSessions },
    { disposeAllPowerShellSessions },
    { disposeAllAdbShellSessions },
  ] = await Promise.all([
    import("../sdk/tools/serial/sessions.js"),
    import("../sdk/tools/ssh/sessions.js"),
    import("../sdk/tools/win/sessions.js"),
    import("../sdk/tools/adb/sessions.js"),
  ]);
  await Promise.allSettled([
    disposeAllSerialSessions(),
    disposeAllSshSessions(),
    disposeAllPowerShellSessions(),
    disposeAllAdbShellSessions(),
  ]);
  logger.info("[mcp] all sessions disposed");
}

/**
 * @brief 判断错误是否为管道断开（EPIPE / EOF）
 *
 * EPIPE 表示对端已关闭管道：MCP stdio 传输中即客户端掉线。
 * 这类错误不可恢复，继续写只会反复抛错，必须退出进程。
 */
function isBrokenPipe(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") return true;
  // 兼容部分 Windows/SDK 包装：消息里带 broken pipe 或 write EPIPE
  return /EPIPE|broken pipe/i.test(err.message);
}

let cleanupRunning = false;

async function doCleanupAndExit(reason: string) {
  if (cleanupRunning) return;
  cleanupRunning = true;
  logger.info(`[mcp] ${reason}, cleaning up...`);
  await cleanupAllSessions();
  process.exit(0);
}

function registerCleanupHooks() {
  // stdin 管道关闭：MCP 客户端断开连接 → 跨 Windows / Linux 统一触发清理
  process.stdin.on("end", () => {
    doCleanupAndExit("stdin closed (client disconnected)");
  });

  process.stdin.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(`[mcp] stdin error: ${msg}, cleaning up...`);
    doCleanupAndExit("stdin error");
  });

  // SIGINT / SIGTERM：Linux/macOS 上 Ctrl+C 或 kill 命令
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      doCleanupAndExit(`${signal} received`);
    });
  }

  // unhandledRejection / uncaughtException 兜底：
  // zmodem.js 等第三方库内部 Promise 链可能 reject 无人接答，
  // Node 默认会终止进程（导致 MCP 连接崩溃）。这里只记录日志、吞掉异常，
  // 让工具层的 try-catch 能正常返回错误结果，不杀进程。
  //
  // 但 EPIPE 例外：它意味着 MCP 客户端已断开、stdio 管道写端关闭。
  // SDK 仍会持续往 stdout 写响应，每次写都再次抛 EPIPE → uncaughtException
  // → 写日志 → 死循环（曾刷出 16MB 日志）。因此检测到管道断开必须退出进程。
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.warn(`[mcp] unhandledRejection swallowed: ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (isBrokenPipe(err)) {
      // 管道已断 → 客户端掉线，直接走清理退出，避免 SDK 反复写 stdout 形成死循环
      doCleanupAndExit(`uncaughtException: ${msg} (pipe broken)`);
      return;
    }
    logger.warn(`[mcp] uncaughtException swallowed: ${msg}`);
  });
}

// ── 启动入口 ───────────────────────────────────────────────

export async function startMcpServer() {
  const envVars = {
    DEVICE: process.env.DEVICE,
    BOARD_CONFIG_PATH: process.env.BOARD_CONFIG_PATH,
    LOG_SAVE: process.env.LOG_SAVE,
    LOG_DIR: process.env.LOG_DIR,
    SAVE2FILE_PATH: process.env.SAVE2FILE_PATH,
  };
  logger.info(`MCP server starting... cwd: ${process.cwd()}`);
  logger.info(`MCP server env: ${JSON.stringify(envVars)}`);

  // SSH 会话环境变量（仅当本进程经由 ssh 远程启动时由 sshd 注入）。
  // 字段语义（OpenSSH 约定，空格分隔）：
  //   SSH_CONNECTION = <client-ip> <client-port> <server-ip> <server-port>
  //   SSH_CLIENT     = <client-ip> <client-port> <server-port>
  //   SSH_TTY        = 分配的伪终端设备名
  // 缺失表示非 ssh 会话启动（如本地直启）；显式记录 "(unset)" 以区分"未设置"与"空值"。
  const sshEnv = {
    // 登录用户名：优先 os.userInfo()（跨平台可靠），回退到环境变量
    USER:
      os.userInfo().username ||
      process.env.USERNAME ||
      process.env.USER ||
      process.env.LOGNAME ||
      "(unknown)",
    SSH_CONNECTION: process.env.SSH_CONNECTION ?? "(unset)",
    SSH_CLIENT: process.env.SSH_CLIENT ?? "(unset)",
    SSH_TTY: process.env.SSH_TTY ?? "(unset)",
  };
  logger.info(`MCP server ssh: ${JSON.stringify(sshEnv)}`);
  logger.info(`MCP server endpoint: ${JSON.stringify(hostEndpoint)}`);
  registerCleanupHooks();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
