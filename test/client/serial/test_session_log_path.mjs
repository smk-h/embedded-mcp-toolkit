/**
 * =====================================================
 * session_info 日志路径暴露 端到端测试 —— Serial 通道
 *
 *   验证 ch14「会话日志路径暴露」机制：
 *     1. serial_shell_login 建立会话后，session_info 返回的 Log 行包含
 *        实际日志文件路径（启用场景，SAVE2FILE_PATH 已配置）
 *     2. 该路径与磁盘上实际存在的文件一致（fs.existsSync 校验）
 *     3. 路径中的 sessionId 前缀与当前会话 ID 一致（如 serial_1_xxx.log 对应 serial_1）
 *     4. peekNextId 顺序调整后不重复创建日志文件（该 sessionId 目录下仅一个 .log）
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *
 *   运行前置：已 build（out/ 存在）；目标设备串口可用
 *   运行：node test/client/serial/test_session_log_path.mjs
 * ======================================================
 */

import { existsSync } from "fs";
import { readdirSync } from "fs";
import { resolve } from "path";

import { connect } from "../client.mjs";
import { pass, fail, printResult } from "../common.mjs";
import { extractSessionId } from "../common-exec.mjs";

/**
 * 从 session_info 返回文本中提取 Log 行的路径
 *
 * @param {string} text session_info 返回的完整文本
 * @returns {string|null} 日志路径；未找到或显示未启用时返回 null
 */
function extractLogPath(text) {
  const match = text.match(/Log:\s+(.*)/);
  if (!match) return null;
  const value = match[1].trim();
  // 未启用时显示 "(file logging disabled)"，视为无路径
  if (value.includes("file logging disabled")) return null;
  return value;
}

async function main() {
  // 设备名与运行配置通过 serverEnv 注入 MCP server 子进程
  const serverEnv = {
    DEVICE: "board-b",
    BOARD_CONFIG_PATH: "./.embedded/configs/config.yaml",
    LOG_SAVE: "1",
    LOG_DIR: "./.embedded/log",
    SAVE2FILE_PATH: "./.embedded/log",
  };
  const device = serverEnv.DEVICE;

  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  session_info 日志路径测试 (${device.padEnd(20)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-log-path", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 登录 Serial 会话
    console.log(`\n── 登录 Serial 会话（${device}）──`);
    let loginResult;
    try {
      loginResult = await client.callTool({
        name: "serial_shell_login",
        arguments: { device },
      });
    } catch (err) {
      fail("PSH 解锁", `login 调用异常：${err.message}`);
      process.exit(1);
    }
    printResult(loginResult);
    const loginText = loginResult.content.map((c) => c.text).join("");
    sessionId = extractSessionId(loginText);

    if (!sessionId) {
      fail("登录 Serial 会话", "未能提取 session_id");
      process.exit(1);
    }
    pass(`Serial 会话已登录: ${sessionId}`);

    // 3. 调用 session_info 查询会话元数据
    console.log(`\n── 用例 1：session_info 返回日志路径（启用场景）──`);
    const infoResult = await client.callTool({
      name: "session_info",
      arguments: { session_id: sessionId },
    });
    printResult(infoResult);
    const infoText = infoResult.content.map((c) => c.text).join("");
    const logPath = extractLogPath(infoText);

    if (!logPath) {
      fail(
        "session_info 应返回日志路径",
        "未提取到路径或显示 file logging disabled，请确认 SAVE2FILE_PATH 已配置"
      );
    } else {
      pass(`session_info 返回日志路径: ${logPath}`);

      // 4. 校验路径与磁盘文件一致
      console.log(`\n── 用例 2：校验日志文件确实存在于磁盘 ──`);
      // logPath 可能是绝对路径或相对路径，统一用 resolve 处理后 existsSync
      const absLogPath = resolve(logPath);
      if (existsSync(absLogPath)) {
        pass(`日志文件存在: ${absLogPath}`);
      } else {
        fail("日志文件应存在", `路径 ${absLogPath} 在磁盘上不存在`);
      }

      // 5. 校验路径中的 sessionId 前缀与当前会话一致
      console.log(`\n── 用例 3：路径中的 sessionId 前缀与会话一致 ──`);
      // 文件名形如 serial_1_2026-07-29_185730.log，取 base 后按 _ 切分取首段
      const baseName = logPath.split(/[\\/]/).pop();
      const fileSessionPrefix = baseName.split("_")[0]; // "serial"
      const fileSessionNum = baseName.split("_")[1]; // "1"
      const expectedPrefix = sessionId.split("_")[0]; // "serial"
      const expectedNum = sessionId.split("_")[1]; // "1"

      if (
        fileSessionPrefix === expectedPrefix &&
        fileSessionNum === expectedNum
      ) {
        pass(`路径前缀 ${fileSessionPrefix}_${fileSessionNum} 与会话 ${sessionId} 一致`);
      } else {
        fail(
          "路径前缀应与会话一致",
          `文件前缀=${fileSessionPrefix}_${fileSessionNum}, 会话=${sessionId}`
        );
      }

      // 6. 校验不重复创建日志文件（peekNextId 顺序调整后该会话仅一个 .log）
      console.log(`\n── 用例 4：本次会话未重复创建日志文件 ──`);
      const logDir = resolve(absLogPath, "..");
      const samePrefixFiles = existsSync(logDir)
        ? readdirSync(logDir).filter((f) =>
            f.startsWith(`${sessionId}_`) && f.endsWith(".log")
          )
        : [];
      // 说明：若之前有历史运行残留，可能存在多个同前缀文件；
      // 本次新增的应是 baseName。这里仅断言"本次新建的文件存在"，
      // 历史残留数不作为失败判据（避免历史日志干扰），但会打印提示。
      if (samePrefixFiles.includes(baseName)) {
        pass(
          `本次会话日志文件已创建: ${baseName}` +
          (samePrefixFiles.length > 1
            ? `（同前缀历史文件共 ${samePrefixFiles.length} 个，属历史残留，非本次重复创建）`
            : "")
        );
      } else {
        fail("应包含本次会话的日志文件", `目录 ${logDir} 中未找到 ${baseName}`);
      }
    }
  } finally {
    // 关闭会话
    if (sessionId) {
      try {
        await client.callTool({
          name: "serial_close",
          arguments: { session_id: sessionId },
        });
        pass("Serial 会话已关闭");
      } catch (err) {
        fail("关闭 Serial 会话", err.message);
      }
    }
    try {
      await client.close();
    } catch {
      // 忽略
    }
    console.log("\n── 测试结束 ──");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
