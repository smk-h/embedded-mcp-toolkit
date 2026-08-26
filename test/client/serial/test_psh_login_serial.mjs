/**
 * =====================================================
 * PSH/用户登录健康检查 —— 串口通道
 *
 *   验证 serial_shell_login 的完整编排（原 demo serial unlock /
 *   demo serial login 场景的自动化承接）：打开串口 → PSH 状态机
 *   探测 → 必要时解锁 / getty 用户登录 → 会话可用。
 *
 *   用例：
 *     1. serial_shell_login 返回 session_id
 *        （成功路径形如 "Session <id> opened on COMx ..." 或
 *          "Session <id> on COMx (existing, ...)"）
 *     2. 会话真实可用：serial_exec echo 标记命令回显正确
 *     3. serial_close 关闭成功
 *
 *   设备不可达（串口打开失败）/ 未配置串口时标记「⊘ 跳过」并正常
 *   退出，便于在无硬件环境下批量回归不误报。
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *
 *   运行前置：已 build（out/ 存在）；目标板卡串口已接好
 *   运行：node test/client/serial/test_psh_login_serial.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, skip, printResult } from "../common.mjs";
import { extractSessionId, splitOutputAndAnnotation } from "../common-exec.mjs";

const TOOLS = {
  login: "serial_shell_login",
  exec: "serial_exec",
  close: "serial_close",
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
  console.log(`║  PSH 登录测试 —— 串口通道 (${device.padEnd(12)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-psh-login-serial", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 一键登录（打开串口 + PSH 探测/解锁 + 用户登录）
    console.log(`\n── 一键登录 ${device} ──`);
    let result;
    try {
      result = await client.callTool({
        name: TOOLS.login,
        arguments: { device },
      });
    } catch (err) {
      fail(`${TOOLS.login} 调用异常`, err.message);
      process.exit(1);
    }
    printResult(result);
    const text = result.content.map((c) => c.text).join("");

    // 3. 分支判定：未配置 / 打不开 → 跳过；其余无 session_id → 失败
    if (text.includes("does not support serial")) {
      skip(`一键登录 ${device}`, "设备未配置串口（port is none）");
      process.exit(0);
    }
    if (/Serial open failed/.test(text)) {
      skip(
        `一键登录 ${device}`,
        `串口打开失败（占用/接线/供电）：${text.trim().slice(0, 120)}`
      );
      process.exit(0);
    }

    sessionId = extractSessionId(text);
    if (!sessionId) {
      fail("一键登录应返回 session_id", `返回: ${text.trim().slice(0, 200)}`);
      process.exit(1);
    }
    pass(`串口会话已登录: ${sessionId}`);
    if (text.includes("(existing,")) {
      pass("复用了该 COM 口的已有会话");
    }

    // 4. 会话可用性验证：echo 回环（串口速率慢，delay 放宽到 2000ms）
    console.log("\n── 验证会话可用（echo 回环）──");
    const echo = await client.callTool({
      name: TOOLS.exec,
      arguments: {
        session_id: sessionId,
        command: "echo __LOGIN_OK__",
        delay: 2000,
      },
    });
    const echoText = echo.content.map((c) => c.text).join("\n");
    const { output } = splitOutputAndAnnotation(echoText);
    if (output.includes("__LOGIN_OK__")) {
      pass("会话可执行命令，回显正确");
    } else if (/command not found/.test(output)) {
      skip("echo 回环", "设备 shell 缺少 echo 命令（罕见）");
    } else {
      fail("会话应可执行命令", `输出: ${output.trim().slice(0, 120)}`);
    }
  } finally {
    // 5. 关闭会话与连接
    if (sessionId) {
      try {
        const closed = await client.callTool({
          name: TOOLS.close,
          arguments: { session_id: sessionId },
        });
        const closedText = closed.content.map((c) => c.text).join("");
        if (closedText.includes("closed")) {
          pass("串口会话已关闭");
        } else {
          fail("关闭串口会话", `返回: ${closedText.trim().slice(0, 120)}`);
        }
      } catch (err) {
        fail("关闭串口会话", err.message);
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
