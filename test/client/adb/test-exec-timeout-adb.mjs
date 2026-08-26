/**
 * =====================================================
 * exec 超时与常驻命令识别 端到端测试 —— ADB 通道
 *
 *   验证 ch13 的「常驻命令分类 + 双超时分支」机制（adb_shell_exec）：
 *     1. 普通瞬时命令正常返回，无超时标注
 *     2. 普通长命令（sleep 12）不被 10s 误杀
 *     3. 常驻命令（ping/top）采样超时，默认 10s 发 Ctrl+C
 *     4. maxDuration 覆盖采样时长（动作不变）
 *     5. 兜底超时（普通命令 sleep + 短 maxDuration），不发 Ctrl+C
 *     6. tail -f（B 类参数模式）采样超时
 *
 *   注意：adb 通道无 login 工具，直接 adb_shell_open。若设备登录后处于
 *   PSH 锁定模式，需先用 serial/ssh 通道解锁，或在 adb shell 内手动 debug 解锁。
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *
 *   运行前置：已 build（out/ 存在）；adb 已连接设备
 *   运行：node test/client/adb/test-exec-timeout-adb.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, printResult } from "../common.mjs";
import {
  extractSessionId,
  splitOutputAndAnnotation,
  probeCommands,
  runExecTestCases,
  callClose,
  callExec,
} from "../common-exec.mjs";

/** ADB 通道工具名映射 */
const ADB_TOOLS = {
  exec: "adb_shell_exec",
  sendCtrl: "adb_shell_send_ctrl",
  close: "adb_shell_close",
  logTag: "adb",
};

async function main() {
  // 设备名与运行配置通过 serverEnv 注入 MCP server 子进程
  const serverEnv = {
    DEVICE: "board-lubancat",
    BOARD_CONFIG_PATH: "./.embedded/configs/config.yaml",
    LOG_SAVE: "1",
    LOG_DIR: "./.embedded/log",
    SAVE2FILE_PATH: "./.embedded/log",
  };
  const device = serverEnv.DEVICE;

  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  exec 超时测试 —— ADB 通道 (${device.padEnd(12)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-exec-adb", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 打开 ADB Shell 会话（adb 无 login，直接 open）
    console.log(`\n── 打开 ADB Shell 会话（${device}）──`);
    const openResult = await client.callTool({
      name: "adb_shell_open",
      arguments: { device },
    });
    printResult(openResult);
    const openText = openResult.content.map((c) => c.text).join("");
    sessionId = extractSessionId(openText);

    if (!sessionId) {
      fail(
        "打开 ADB 会话",
        "未能提取 session_id。请确认 adb 已连接设备（adb devices 可见）"
      );
      process.exit(1);
    }
    pass(`ADB 会话已打开: ${sessionId}`);

    // 2b. 探测当前是否处于 PSH 锁定模式（adb 无自动解锁）
    //     若锁定，提示用户手动解锁后再继续；若已解锁则直接跑用例
    const { text: probeText } = await callExec(
      client,
      ADB_TOOLS,
      sessionId,
      "echo probe-unlock-state"
    );
    const { output: probeOutput } = splitOutputAndAnnotation(probeText);

    if (
      probeOutput.includes("Command not supported") ||
      probeOutput.includes("locked>")
    ) {
      console.log("\n  ⚠ 检测到 PSH 锁定模式。请在另一终端手动解锁后按回车继续...");
      console.log("    （或先通过 ssh/serial 通道解锁同一台设备）");
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      await new Promise((resolve) => {
        rl.question("  解锁完成后按回车继续: ", () => {
          rl.close();
          resolve();
        });
      });
    } else if (probeOutput.includes("probe-unlock-state")) {
      pass("设备已解锁，可直接测试");
    }

    // 3. 探测设备命令可用性（缺失命令的用例自动跳过）
    await probeCommands(client, ADB_TOOLS, sessionId);

    // 4. 运行全部 exec 测试用例
    await runExecTestCases(client, ADB_TOOLS, sessionId);
  } finally {
    // 4. 关闭会话
    if (sessionId) {
      try {
        await callClose(client, ADB_TOOLS, sessionId);
        pass("ADB 会话已关闭");
      } catch (err) {
        fail("关闭 ADB 会话", err.message);
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
