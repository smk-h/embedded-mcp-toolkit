/**
 * =====================================================
 * exec 超时与常驻命令识别 端到端测试 —— Serial 通道
 *
 *   验证 ch13 的「常驻命令分类 + 双超时分支」机制（serial_exec）：
 *     1. 普通瞬时命令正常返回，无超时标注
 *     2. 普通长命令（sleep 12）不被 10s 误杀
 *     3. 常驻命令（ping/top）采样超时，默认 10s 发 Ctrl+C
 *     4. maxDuration 覆盖采样时长（动作不变）
 *     5. 兜底超时（普通命令 sleep + 短 maxDuration），不发 Ctrl+C
 *     6. tail -f（B 类参数模式）采样超时
 *
 *   解锁：调用 serial_shell_login 后，设备会发出挑战码写入
 *   .embedded/configs/challenge.txt，请手动在终端输入应答密钥
 *   （server 端 KeyProvider 会轮询 password_input.txt 读取）。
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *
 *   运行前置：已 build（out/ 存在）；目标设备串口可用
 *   运行：node test/client/serial/test-exec-timeout-serial.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, printResult } from "../common.mjs";
import {
  extractSessionId,
  probeCommands,
  runExecTestCases,
  callClose,
} from "../common-exec.mjs";

/** Serial 通道工具名映射 */
const SERIAL_TOOLS = {
  exec: "serial_exec",
  sendCtrl: "serial_send_ctrl",
  close: "serial_close",
  logTag: "serial",
};

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
  console.log(`║  exec 超时测试 —— Serial 通道 (${device.padEnd(10)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-exec-serial", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 登录 Serial 会话（连接 + PSH 检测 + 解锁）
    //    解锁密钥：login 会触发挑战-应答，请在终端手动输入应答密钥
    console.log(`\n── 登录 Serial 会话（${device}，PSH 解锁）──`);
    console.log("  ℹ 若出现挑战码，请在终端输入应答密钥（写入 password_input.txt）");

    let loginResult;
    try {
      loginResult = await client.callTool({
        name: "serial_shell_login",
        arguments: { device },
      });
    } catch (err) {
      fail(
        "PSH 解锁",
        `login 调用异常（连接已关闭）：${err.message}。` +
        "请在挑战码出现时及时输入应答密钥，或确认设备 PSH 密钥正确"
      );
      process.exit(1);
    }
    printResult(loginResult);
    const loginText = loginResult.content.map((c) => c.text).join("");
    sessionId = extractSessionId(loginText);

    if (!sessionId) {
      fail(
        "登录 Serial 会话",
        "未能提取 session_id（设备不可达或 PSH 解锁失败）。" +
          "请确认串口已连接、设备已上电；若需解锁请在挑战码出现时输入应答密钥"
      );
      process.exit(1);
    }
    pass(`Serial 会话已登录: ${sessionId}`);

    // 3. 探测设备命令可用性（缺失命令的用例自动跳过）
    await probeCommands(client, SERIAL_TOOLS, sessionId);

    // 4. 运行全部 exec 测试用例
    await runExecTestCases(client, SERIAL_TOOLS, sessionId);
  } finally {
    // 4. 关闭会话
    if (sessionId) {
      try {
        await callClose(client, SERIAL_TOOLS, sessionId);
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
