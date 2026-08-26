/**
 * =====================================================
 * PSH 一键登录健康检查 —— SSH 通道
 *
 *   验证 ssh_shell_login 的完整编排（原 demo ssh unlock 场景的
 *   自动化承接）：连接 → PSH 状态机探测 → 必要时解锁 → 会话可用。
 *
 *   用例：
 *     1. ssh_shell_login 返回 session_id（成功路径必含 "Session <id> opened"）
 *     2. 返回文本含明确的 PSH 结果描述（unlock succeeded / already unlocked 等）
 *     3. 会话真实可用：exec echo 标记命令回显正确
 *     4. ssh_shell_close 关闭成功
 *
 *   设备不可达 / 未配置 SSH 时标记「⊘ 跳过」并正常退出，
 *   便于在无硬件环境下批量回归不误报。
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *
 *   运行前置：已 build（out/ 存在）；目标设备 SSH 可达
 *   运行：node test/client/ssh/test-psh-login-ssh.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, skip, printResult } from "../common.mjs";
import { extractSessionId, splitOutputAndAnnotation } from "../common-exec.mjs";

const TOOLS = {
  login: "ssh_shell_login",
  exec: "ssh_shell_exec",
  close: "ssh_shell_close",
};

/** 已知的 PSH 成功结果描述（login 返回文本中的括号说明） */
const KNOWN_OK_MARKERS = [
  "PSH unlock succeeded",
  "PSH already unlocked",
  "PSH unlock completed from UNLOCKING state",
];

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
  console.log(`║  PSH 登录测试 —— SSH 通道 (${device.padEnd(12)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-psh-login-ssh", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 一键登录（连接 + PSH 探测 + 解锁）
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

    // 3. 分支判定：未配置 / 不可达 → 跳过；其余无 session_id → 失败
    if (text.includes("does not support SSH")) {
      skip(`一键登录 ${device}`, "设备未配置 SSH（host is none）");
      process.exit(0);
    }
    if (/SSH connection failed/.test(text)) {
      skip(
        `一键登录 ${device}`,
        `设备不可达：${text.trim().slice(0, 120)}`
      );
      process.exit(0);
    }

    sessionId = extractSessionId(text);
    if (!sessionId) {
      fail("一键登录应返回 session_id", `返回: ${text.trim().slice(0, 200)}`);
      process.exit(1);
    }
    pass(`SSH 会话已登录: ${sessionId}`);

    const okMarker = KNOWN_OK_MARKERS.find((m) => text.includes(m));
    if (okMarker) {
      pass(`PSH 结果描述明确: ${okMarker}`);
    } else {
      console.log("  ⊘ PSH 结果描述为非标准形态（如状态未知），已记录不判失败");
    }

    // 4. 会话可用性验证：echo 回环
    console.log("\n── 验证会话可用（echo 回环）──");
    const echo = await client.callTool({
      name: TOOLS.exec,
      arguments: { session_id: sessionId, command: "echo __LOGIN_OK__" },
    });
    const echoText = echo.content.map((c) => c.text).join("\n");
    const { output } = splitOutputAndAnnotation(echoText);
    if (output.includes("__LOGIN_OK__")) {
      pass("会话可执行命令，回显正确");
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
          pass("SSH 会话已关闭");
        } else {
          fail("关闭 SSH 会话", `返回: ${closedText.trim().slice(0, 120)}`);
        }
      } catch (err) {
        fail("关闭 SSH 会话", err.message);
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
