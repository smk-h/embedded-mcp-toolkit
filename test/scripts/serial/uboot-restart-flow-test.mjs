/**
 * =====================================================
 * serial_enter_uboot restart 分支离线验证脚本
 *
 *   用 mock 串口会话（脚本化输出序列）离线驱动 serialEnterUbootHandler，
 *   验证 restart 参数与出口标记策略，不依赖真实硬件：
 *     1. restart=false + 已在 U-Boot      → 免重启直接成功（现状回归）
 *     2. restart=true  + 已在 U-Boot      → 发 reset 走完整周期，成功置位
 *     3. restart=true  + 拦截失败进内核   → 失败并清标记（确定性反证）
 *     4. restart=true  + 设备静默超时     → 失败但标记维持置位（缺失证据不清）
 *     5. restart=true  + 在 Linux shell   → 仍发 reboot（restart 不改变系统侧路径）
 *     6. restart=false + 在 Linux shell   → 发 reboot（现状回归）
 *     7. restart=true  + 停在 login 提示  → 失败快出，不发任何命令
 *     8. restart=true  + bootdelay=-2     → reset 后直接停提示符，免中断成功
 *     9. restart=true  + 空缓冲（新会话） → 回退发 reboot（环境未知按系统侧处理）
 *
 *   运行前置：已 build（out/ 存在）
 *   运行：node test/scripts/serial/uboot-restart-flow-test.mjs
 * =====================================================
 */

import { serialEnterUbootHandler } from "../../../out/sdk/tools/serial/uboot.js";
import {
  serialStore,
  isUbootSession,
} from "../../../out/sdk/tools/serial/sessions.js";

/**
 * @brief 构造 mock 串口会话
 *
 * 仿真 BaseShell 的缓冲区语义（read 清/不清、drain 增量排空、write/sendRaw
 * 的 clear 参数），输出按 chunks 顺序逐 drain 释放——每个轮询周期恰好消费
 * 一段，模拟设备按时间到达的串口数据。written 记录全部发出内容供断言。
 *
 * @param initialBuffer 预检阶段（read(0)）可见的缓冲区尾部
 * @param chunks        write 重启命令后按 drain 顺序释放的输出块
 */
function makeFakeShell({ initialBuffer = "", chunks = [] } = {}) {
  let buffer = initialBuffer;
  const pending = [...chunks];
  const written = [];
  return {
    getDeviceName: () => "mock-device",
    read: (clear = 1) => {
      const out = buffer;
      if (clear) buffer = "";
      return out;
    },
    drain: () => {
      const chunk = pending.length > 0 ? pending.shift() : "";
      buffer += chunk;
      return chunk;
    },
    write: (data, clear = 1) => {
      written.push(data);
      if (clear) buffer = "";
    },
    sendRaw: (data, clear = 1) => {
      written.push(data);
      if (clear) buffer = "";
    },
    written,
  };
}

// handler 内部通过 serialStore.get/withLock 取会话，直接替换为 mock 通道；
// markUbootSession/clearUbootSession 用真实实现（验证标记增删本身）
let currentShell = null;
serialStore.get = () => currentShell;
serialStore.withLock = async (_sessionId, fn) => fn();

/** 一轮成功的重启周期输出：autoboot 倒计时 → 中断后停靠提示符 */
const BOOT_CYCLE = [
  "\r\nU-Boot 2023.04\r\nDRAM: 512 MiB\r\nHit any key to stop autoboot:  2\r\n",
  "\r\n=>\r\n",
];
/** 拦截失败（倒计时与内核启动挤在同一轮询间隙内到达）的单块输出 */
const MISSED_WINDOW = [
  "\r\nU-Boot 2023.04\r\nHit any key to stop autoboot:  1\r\nStarting kernel ...\r\n\r\n[    0.000000] Linux version 5.10.0\r\n",
];

let passCount = 0;
let failCount = 0;

/**
 * @brief 断言辅助：累积 ✓/✗ 结果并在失败时打印期望与实际
 */
function check(label, actual, expected) {
  const pass = actual === expected;
  if (pass) passCount++;
  else failCount++;
  console.log(
    `  [${pass ? "✓" : "✗"}] ${label}${pass ? "" : ` (actual: ${JSON.stringify(actual)})`}`
  );
}

function checkIncludes(label, text, needle) {
  check(label, typeof text === "string" && text.includes(needle), true);
}

async function runScenario(name, { initialBuffer, restart, timeoutMs, chunks }) {
  const sessionId = `sess_${name}`;
  currentShell = makeFakeShell({ initialBuffer, chunks });
  console.log(`\n── ${name} ─`);
  const result = await serialEnterUbootHandler({
    session_id: sessionId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(restart !== undefined ? { restart } : {}),
  });
  return { result, written: currentShell.written, sessionId };
}

async function main() {
  // 1. restart=false + 已在 U-Boot：免重启直接成功，不发任何命令
  {
    const { result, written, sessionId } = await runScenario("uboot_idle", {
      initialBuffer: "\r\nU-Boot 2023.04\r\n=>",
      restart: false,
    });
    checkIncludes("返回 Already in U-Boot", result, "Already in U-Boot");
    check("未发送任何串口命令", written.length, 0);
    check("标记置位", isUbootSession(sessionId), true);
  }

  // 2. restart=true + 已在 U-Boot：发 reset 走完整周期，成功后标记保持置位
  {
    const { result, written, sessionId } = await runScenario("uboot_restart_ok", {
      initialBuffer: "\r\nU-Boot 2023.04\r\n=>",
      restart: true,
      chunks: BOOT_CYCLE,
    });
    check("发送 reset 而非 reboot", written[0], "reset");
    check("发送过 autoboot 中断键（换行）", written.includes("\n"), true);
    checkIncludes("成功进入 U-Boot", result, "Entered U-Boot successfully (via prompt");
    check("标记置位", isUbootSession(sessionId), true);
  }

  // 3. restart=true + 拦截失败进内核：失败并清标记（确定性反证）
  {
    const { result, sessionId } = await runScenario("uboot_restart_kernel", {
      initialBuffer: "\r\nU-Boot 2023.04\r\n=>",
      restart: true,
      chunks: MISSED_WINDOW,
    });
    checkIncludes("报告内核启动失败", result, "kernel boot detected");
    checkIncludes("提示默认模式重试", result, "default mode (reboot path)");
    check("标记已清位", isUbootSession(sessionId), false);
  }

  // 4. restart=true + 设备静默超时：失败但标记维持置位（缺失证据不清）
  {
    const { result, sessionId } = await runScenario("uboot_restart_timeout", {
      initialBuffer: "\r\nU-Boot 2023.04\r\n=>",
      restart: true,
      timeoutMs: 1200,
      chunks: [],
    });
    checkIncludes("报告总超时", result, "Timeout after 1200ms");
    checkIncludes("提示 detect 定位", result, "serial_uboot_state");
    check("标记维持置位", isUbootSession(sessionId), true);
  }

  // 5. restart=true + 在 Linux shell：仍发 reboot，成功后置位
  {
    const { result, written, sessionId } = await runScenario("linux_restart", {
      initialBuffer: "root@board:~# \n",
      restart: true,
      chunks: BOOT_CYCLE,
    });
    check("发送 reboot（系统侧路径不变）", written[0], "reboot");
    checkIncludes("成功进入 U-Boot", result, "Entered U-Boot successfully");
    check("标记置位", isUbootSession(sessionId), true);
  }

  // 6. restart=false + 在 Linux shell：发 reboot（现状回归）
  {
    const { result, written, sessionId } = await runScenario("linux_default", {
      initialBuffer: "root@board:~# \n",
      restart: false,
      chunks: BOOT_CYCLE,
    });
    check("发送 reboot", written[0], "reboot");
    checkIncludes("成功进入 U-Boot", result, "Entered U-Boot successfully");
    check("标记置位", isUbootSession(sessionId), true);
  }

  // 7. restart=true + 停在 login 提示：失败快出，不发任何命令，标记不动
  {
    const { result, written, sessionId } = await runScenario("login_abort", {
      initialBuffer: "davinci login: ",
      restart: true,
    });
    checkIncludes("报告 login 拦截", result, "login/Password prompt");
    check("未发送任何串口命令", written.length, 0);
    check("标记保持清位", isUbootSession(sessionId), false);
  }

  // 8. restart=true + bootdelay=-2：reset 后直接停提示符，免中断成功
  {
    const { result, written, sessionId } = await runScenario("uboot_no_autoboot", {
      initialBuffer: "\r\nU-Boot 2023.04\r\n=>",
      restart: true,
      chunks: ["\r\n\r\nU-Boot 2023.04\r\n=>\r\n"],
    });
    check("发送 reset", written[0], "reset");
    check("未发送中断键", written.includes("\n"), false);
    checkIncludes("免中断成功", result, "no interrupt needed");
    check("标记置位", isUbootSession(sessionId), true);
  }

  // 9. restart=true + 空缓冲（新会话、设备状态未知）：回退发 reboot
  {
    const { written, sessionId } = await runScenario("empty_buffer_fallback", {
      initialBuffer: "",
      restart: true,
      chunks: [
        "Unknown command 'reboot' - try 'help'\r\n\r\n=>\r\n",
      ],
    });
    check("环境未知时回退 reboot", written[0], "reboot");
    check("标记置位（提示符命中即成功）", isUbootSession(sessionId), true);
  }

  console.log(
    `\n${failCount === 0 ? "✓ All tests passed!" : "✗ Some tests FAILED!"} (${passCount} passed, ${failCount} failed)`
  );
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
