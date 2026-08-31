/**
 * =====================================================
 * serial_enter_uboot 端到端测试 —— Serial 通道
 *
 *   验证 ch10 的「重启 → 中断 autoboot → 进入 U-Boot」机制（serial_enter_uboot）：
 *     1. 调用 serial_shell_login 登录串口会话（连接 + PSH 解锁）
 *     2. 调用 serial_enter_uboot 重启设备并进入 U-Boot 命令行
 *        —— 断言返回「Entered U-Boot successfully」且标注 via prompt / via verify
 *     3. 进入 U-Boot 后执行 printenv，断言能拿到环境变量（baudrate/bootdelay）
 *        —— 证明设备确实停在 U-Boot 命令行，而非内核态
 *     4. 执行 U-Boot 普通命令 help/version，断言无超时标注
 *
 *   解锁：调用 serial_shell_login 后，设备会发出挑战码写入
 *   .embedded/configs/challenge.txt，请手动在终端输入应答密钥
 *   （server 端 KeyProvider 会轮询 password_input.txt 读取）。
 *
 *   设备名通过 serverEnv 注入 MCP server 子进程（DEVICE 字段）。
 *   换设备时改下方 DEVICE 常量即可。
 *   注意：进入 U-Boot 会重启设备，会话离开登录态；本测试结束后
 *   若需继续操作设备，需重新 login。
 *
 *   运行前置：已 build（out/ 存在）；目标设备串口可用
 *   运行：node test/client/serial/test-enter-uboot.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, printResult } from "../common.mjs";
import {
  extractSessionId,
  splitOutputAndAnnotation,
  callExec,
  callClose,
} from "../common-exec.mjs";

/** Serial 通道工具名映射 */
const SERIAL_TOOLS = {
  exec: "serial_exec",
  sendCtrl: "serial_send_ctrl",
  close: "serial_close",
  logTag: "serial",
};

/**
 * 判断 enter_uboot 返回是否表示成功进入 U-Boot
 *
 * handler 成功返回文本形如：
 *   "Entered U-Boot successfully (via prompt, interrupt: Enter).\n\n<output>"
 *   "Entered U-Boot successfully (via verify, interrupt: Ctrl+u).\n\n<output>"
 * 失败形如：
 *   "Failed to enter U-Boot: ..."
 *   "Timeout after 60000ms waiting for U-Boot."
 *
 * @param {string} text enter_uboot 返回的完整文本
 * @returns {{ok: boolean, via?: string, interrupt?: string, output: string}}
 */
function parseEnterUbootResult(text) {
  const successMatch = text.match(
    /Entered U-Boot successfully \(via (\w+),\s*interrupt:\s*([^)]+)\)/
  );
  if (successMatch) {
    // 成功文本中 <output> 在空行之后
    const output = text.split("\n\n").slice(1).join("\n\n").trim();
    return {
      ok: true,
      via: successMatch[1], // "prompt" | "verify"
      interrupt: successMatch[2], // "Enter" | "Ctrl+u" | "Ctrl+C" | "SPACE"
      output,
    };
  }
  // 两条免中断快速路径（2026-08-31 新增）：预检发现已在 U-Boot（免重启）、
  // 重启后直接停靠提示符（bootdelay=-2 类设备，无需打断 autoboot）
  const fastMatch = text.match(
    /(?:Already in U-Boot|Entered U-Boot successfully) \(via (pre-check|prompt)/
  );
  if (fastMatch) {
    const output = text.split("\n\n").slice(1).join("\n\n").trim();
    return { ok: true, via: fastMatch[1], interrupt: "(none)", output };
  }
  return { ok: false, output: text.trim() };
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
  console.log(`║  serial_enter_uboot 测试 (${device.padEnd(24)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-enter-uboot", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  let inUboot = false; // 是否已成功进入 U-Boot（用于 finally 决定是否发 reboot 回内核）
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

    // 3. 调用 serial_enter_uboot：重启设备并进入 U-Boot 命令行
    console.log("\n── 用例 1：serial_enter_uboot 重启并进入 U-Boot 命令行 ──");
    console.log("  ℹ 此操作会重启设备，请耐心等待 autoboot 倒计时被中断");
    console.log("  ▶ call: serial_enter_uboot");

    const start = Date.now();
    let enterResult;
    try {
      enterResult = await client.callTool({
        name: "serial_enter_uboot",
        arguments: { session_id: sessionId, timeoutMs: 90000 },
      });
    } catch (err) {
      fail("serial_enter_uboot 调用异常", err.message);
      process.exit(1);
    }
    const elapsed = Date.now() - start;
    printResult(enterResult);
    console.log(`  ⏱ ${elapsed}ms`);

    const enterText = enterResult.content.map((c) => c.text).join("");
    const parsed = parseEnterUbootResult(enterText);

    if (parsed.ok) {
      pass(
        `成功进入 U-Boot（via ${parsed.via}, interrupt: ${parsed.interrupt}，${elapsed}ms）`
      );
      inUboot = true;
    } else {
      // 区分四类失败：登录提示 / 内核已启动 / 验证层超时 / 总超时，便于排查
      let detail = parsed.output;
      if (/login\/Password prompt/.test(enterText)) {
        detail = "会话停在 login/Password 提示，reboot 会被当作凭据吞掉；请先 serial_shell_login 登录再重试";
      } else if (/kernel boot detected/.test(enterText)) {
        detail = "内核已启动，设备绕过了 U-Boot（倒计时未被中断），请调大 bootdelay 或提前中断";
      } else if (/no U-Boot env key matched/.test(enterText)) {
        detail = "验证层超时，命令提示符与环境变量键均未命中，请检查 serial.uboot.prompt 配置";
      } else if (/Timeout after/.test(enterText)) {
        detail = "总超时，未等到 autoboot 提示，请确认设备确实会重启进入 U-Boot 阶段";
      }
      fail("serial_enter_uboot 应进入 U-Boot", detail);
      process.exit(1);
    }

    // 4. 进入 U-Boot 后执行 printenv，断言能拿到环境变量
    //    （证明设备确实停在 U-Boot 命令行，而非内核态）
    console.log("\n── 用例 2：进入 U-Boot 后执行 printenv 验证环境变量 ──");
    const { text: printenvText, elapsed: printenvElapsed } = await callExec(
      client,
      SERIAL_TOOLS,
      sessionId,
      "printenv"
    );
    const { output: printenvOutput, annotation: printenvAnnotation } =
      splitOutputAndAnnotation(printenvText);

    const hasEnv =
      printenvOutput.includes("baudrate=") ||
      printenvOutput.includes("bootdelay=") ||
      printenvOutput.includes("bootargs=") ||
      printenvOutput.includes("bootcmd=");

    if (hasEnv && printenvAnnotation === "") {
      pass(`printenv 返回 U-Boot 环境变量（${printenvElapsed}ms，已确认停在 U-Boot 命令行）`);
    } else {
      fail(
        "printenv 应返回环境变量",
        `elapsed=${printenvElapsed}ms, annotation="${printenvAnnotation}", hasEnv=${hasEnv}`
      );
    }

    // 5. 执行 U-Boot 普通命令 help/version，断言无超时标注
    console.log("\n── 用例 3：U-Boot 命令行执行 help/version（瞬时，无超时标注）──");
    const { text: helpText, elapsed: helpElapsed } = await callExec(
      client,
      SERIAL_TOOLS,
      sessionId,
      "help"
    );
    const { output: helpOutput, annotation: helpAnnotation } =
      splitOutputAndAnnotation(helpText);

    // help 输出通常含 U-Boot 命令关键字，至少非空且无超时标注即算通过
    const helpOk =
      (helpOutput.includes("?") ||
        helpOutput.includes("-") ||
        helpOutput.length > 0) &&
      helpAnnotation === "";

    if (helpOk) {
      pass(`U-Boot help 正常返回（${helpElapsed}ms，无超时标注）`);
    } else {
      fail("U-Boot help 应正常返回无标注", `annotation="${helpAnnotation}"`);
    }
  } finally {
    // 关闭会话前，若设备停在 U-Boot，发出 reset 命令让它回到内核态
    // （serial_close 仅关串口不重启设备；这里主动 reset 恢复设备运行态）
    if (inUboot && sessionId) {
      console.log("\n── 恢复：reset 让设备从 U-Boot 重新启动内核 ──");
      try {
        await client.callTool({
          name: "serial_write",
          arguments: { session_id: sessionId, command: "reset" },
        });
        pass("已发送 reset（设备将重启回到内核态）");
      } catch (err) {
        fail("发送 reset", err.message);
      }
    }

    // 关闭会话
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
