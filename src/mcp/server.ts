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
    import("./tools/serial/shell.js"),
    import("./tools/ssh/shell.js"),
    import("./tools/win/powershell.js"),
    import("./tools/adb/shell.js"),
  ]);
  await Promise.allSettled([
    disposeAllSerialSessions(),
    disposeAllSshSessions(),
    disposeAllPowerShellSessions(),
    disposeAllAdbShellSessions(),
  ]);
  logger.info("[mcp] all sessions disposed");
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
