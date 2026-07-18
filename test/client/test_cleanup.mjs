import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logDir = resolve(__dirname, "../log");

// ── 日志工具 ──────────────────────────────────────────────

function findLatestLog() {
  const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
  if (files.length === 0) return null;
  files.sort().reverse();
  return join(logDir, files[0]);
}

function grepLog(logPath, pattern) {
  const content = readFileSync(logPath, "utf-8");
  return content.split("\n").filter((l) => pattern.test(l));
}

// ── session 追踪 ──────────────────────────────────────────

/** { sessionId → { type: 'ssh'|'serial'|'power', openTag: string, disposeTag: string } } */
const openedSessions = new Map();

function recordSession(type, sessionId) {
  const tags = {
    ssh: { open: "ssh_shell_open", dispose: "ssh_dispose" },
    serial: { open: "serial_open", dispose: "serial_dispose" },
    power: { open: "power_shell_open", dispose: "power_dispose" },
  };
  openedSessions.set(sessionId, { type, ...tags[type] });
}

/**
 * 提取 session_id 正则：匹配 Session xxx_数字
 */
function extractSessionId(text, prefix) {
  const m = text.match(new RegExp(`Session (${prefix}_\\d+)`));
  return m ? m[1] : null;
}

// ── 单个会话打开辅助 ──────────────────────────────────────

async function tryOpen(client, toolName, args, label, typeTag) {
  try {
    const r = await client.callTool({ name: toolName, arguments: args });
    const text = r.content.map((c) => c.text).join("");
    const sid = extractSessionId(text, typeTag);
    if (sid) {
      recordSession(typeTag, sid);
      pass(`${label}: ${sid}`);
      printResult(r);
      return sid;
    }
    // 返回了结果但没有 session_id（如端口被占用提示）
    pass(`${label}: (no session_id — ${text.slice(0, 80).replace(/\n/g, " ")}...)`);
    return null;
  } catch (err) {
    fail(`${label}`, err.message);
    return null;
  }
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   cleanupAllSessions 全类型测试         ║");
  console.log("║   ssh / serial / power 三种 shell       ║");
  console.log("╚══════════════════════════════════════════╝");

  const serverEnv = {
    DEVICE: "board-b",
    BOARD_CONFIG_PATH: "./.embedded/configs/config.yaml",
    LOG_SAVE: "1",
    LOG_DIR: "./log",
  };

  // ── 连接 ────────────────────────────────────────
  let client;
  try {
    const conn = await connect({ name: "test-cleanup", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  // ── 打开各类型会话（逐个，方便观察日志） ─────────────
  console.log("\n── 步骤 1: 打开 SSH 会话 ──");
  await tryOpen(client, "ssh_shell_open", { timeout: 5 }, "ssh_shell_open", "ssh");

  console.log("\n── 步骤 2: 打开 Serial 会话 ──");
  await tryOpen(client, "serial_open", {}, "serial_open", "serial");

  console.log("\n── 步骤 3: 打开 PowerShell 会话 × 2 ──");
  await tryOpen(client, "power_shell_open", {}, "power_shell_open #1", "power");
  await tryOpen(client, "power_shell_open", {}, "power_shell_open #2", "power");

  if (openedSessions.size === 0) {
    console.log("\n  未成功打开任何会话（SSH/Serial 设备不可达），跳过后续步骤");
    await client.close();
    process.exit(0);
  }

  // ── 验证会话列表 ─────────────────────────────────
  console.log("\n── 步骤 4: 验证各类型 list ──");

  for (const listCmd of ["ssh_shell_list", "serial_list", "power_shell_list"]) {
    try {
      const r = await client.callTool({ name: listCmd, arguments: {} });
      const text = r.content.map((c) => c.text).join("");
      const type = listCmd.split("_")[0]; // ssh / serial / power
      const typeSessions = [...openedSessions.entries()]
        .filter(([, v]) => v.type === type)
        .map(([k]) => k);

      if (typeSessions.length > 0) {
        const allFound = typeSessions.every((id) => text.includes(id));
        assert(allFound, `${listCmd} 包含: ${typeSessions.join(", ")}`);
        printResult(r);
      } else {
        console.log(`  - ${listCmd}: 无此类型会话，跳过`);
      }
    } catch (err) {
      fail(listCmd, err.message);
    }
  }

  // ── 触发退出 ─────────────────────────────────────
  console.log("\n── 步骤 5: 触发服务端退出 ──");
  const logBefore = findLatestLog();
  console.log(`  断开前日志: ${logBefore ?? "(无)"}`);

  await client.close();
  pass("MCP 客户端已断开（stdin close → cleanup → exit）");

  await new Promise((r) => setTimeout(r, 3000));

  // ── 检查日志 ─────────────────────────────────────
  console.log("\n── 步骤 6: 验证日志 ──");
  const logAfter = findLatestLog();
  console.log(`  日志文件: ${logAfter ?? "(无)"}`);

  if (!logAfter) {
    fail("日志检查", "未找到日志文件");
    return;
  }

  // ① [mcp] all sessions disposed
  {
    const lines = grepLog(logAfter, /\[mcp\] all sessions disposed/);
    assert(lines.length > 0, "[mcp] all sessions disposed", `匹配 ${lines.length} 条`);
    if (lines.length > 0) console.log(`  → ${lines[0].trim()}`);
  }

  // ② 每个已打开 session 的 dispose 记录
  for (const [sid, info] of openedSessions) {
    const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = grepLog(logAfter, new RegExp(`\\[${info.dispose}\\] session ${escaped} closed`));
    assert(lines.length > 0, `[${info.dispose}] session ${sid} closed`, `匹配 ${lines.length} 条`);
    if (lines.length > 0) console.log(`  → ${lines[0].trim()}`);
  }

  // ③ 每个已打开 session 的 open 日志（验证之前的 logger.info 增强）
  for (const [sid, info] of openedSessions) {
    const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = grepLog(logAfter, new RegExp(`\\[${info.open}\\] session opened: ${escaped}`));
    assert(lines.length > 0, `[${info.open}] session opened: ${sid}`, `匹配 ${lines.length} 条`);
    if (lines.length > 0) console.log(`  → ${lines[0].trim()}`);
  }

  // ④ stdin close 触发清理
  {
    const lines = grepLog(logAfter, /\[mcp\] stdin closed \(client disconnected\)/);
    assert(lines.length > 0, "[mcp] stdin closed (client disconnected)", `匹配 ${lines.length} 条`);
    if (lines.length > 0) console.log(`  → ${lines[0].trim()}`);
  }

  console.log("\n── 完成 ──");
  console.log(`  成功打开 ${openedSessions.size} 个会话，验证通过`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
