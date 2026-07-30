// MCP Server — 创建 McpServer 实例、注册所有工具、提供启动入口

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { logger } from "../shared/logger.js";
import { mcpBasicTools } from "./tools/basic/index.js";
import { mcpSshTools } from "./tools/ssh/index.js";
import { mcpSerialTools } from "./tools/serial/index.js";
import { mcpWinTools } from "./tools/win/index.js";
import { mcpAdbTools } from "./tools/adb/index.js";

// ── package info ───────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf-8")
);

// ── server 实例 ────────────────────────────────────────────

export const server = new McpServer(
  { name: pkg.name, version: pkg.version },
  { capabilities: { logging: {} } }
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
    import("./tools/serial/sessions.js"),
    import("./tools/ssh/sessions.js"),
    import("./tools/win/sessions.js"),
    import("./tools/adb/sessions.js"),
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
  registerCleanupHooks();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
