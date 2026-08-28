/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : uboot.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: Serial U-Boot 编排 SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 *   serial_enter_uboot：重启打断 autoboot 进入 U-Boot 命令行（两层检测）。
 *   serial_uboot_state：会话 U-Boot 标记的查询 / 检测 / 强制设置。
 *   标记决定 serial_exec 在该会话的 marker 包装风格（plain / subshell）。
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import { getUbootConfig } from "../../shared/config.js";
import {
  serialStore,
  isUbootSession,
  markUbootSession,
  clearUbootSession,
} from "./sessions.js";
import { PromptDetector, UbootDetector } from "../../exec/prompt-detector.js";

// ── serial_enter_uboot ────────────────────────────────────────
/**
 * @brief serial_enter_uboot 工具配置
 *
 * 通过串口重启设备并在 U-Boot 自动引导倒计时期间发送按键中断引导，
 * 进入 U-Boot 命令行。支持检测多种 autoboot 提示和 U-Boot 命令提示符。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param timeoutMs   等待 autoboot 提示的总超时时间（毫秒，默认 60000 即 60 秒，
 *                    秒数 × 1000 = 毫秒）
 */
export const serialEnterUbootConfig: SdkToolConfig = {
  description:
    "Enter U-Boot by rebooting the device and stopping autoboot. " +
    "Detection rules (autoboot prompts, command prompt, verify env keys) " +
    "are configurable via device config serial.uboot; falls back to built-in defaults. " +
    "Two-layer strategy: prompt match first; if not matched within a short window, " +
    "sends 'printenv' and verifies U-Boot env keys. Fails fast on kernel boot or verify timeout.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      timeoutMs: {
        type: "number",
        description:
          "Total timeout in ms to wait for the autoboot prompt after reboot (default: 60000 = 60s). " +
          "Entering U-Boot requires a full device reboot, so the wait is genuinely long — " +
          "scale generously and convert seconds to ms by multiplying by 1000 (e.g. 90s = 90000).",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief serial_enter_uboot 处理函数
 *
 * 流程（两层检测，对应 spec F3）：
 *   1. 从设备配置读 serial.uboot 构造 UbootDetector；配置非法立即返回错误
 *   2. 发送 reboot 重启设备
 *   3. 阶段 1 — autoboot 提示检测：命中配置的 autobootPrompts 即发对应中断键
 *      （含 "Ctrl+c" 字样发 \x03，含 "Ctrl+u" 字样发 \x15，否则发换行）
 *   4. 阶段 2 — 主层：中断后窗口内，命中命令提示符即成功返回（via prompt）；
 *      内核启动特征则立即失败
 *   5. 阶段 3 — 验证层：主层窗口耗尽，发 printenv 一次，命中环境变量键即成功
 *      （via verify）；窗口耗尽或内核启动特征则快速失败
 *   6. 总超时兜底
 *
 * @param args  工具参数，包含 session_id 和可选的 timeoutMs（默认 60000 毫秒）
 * @return MCP 响应，包含进入 U-Boot 的结果和输出
 */
export async function serialEnterUbootHandler(args: {
  session_id: string;
  timeoutMs?: number;
}) {
  const timeoutMs = args.timeoutMs ?? 60000;
  logger.info(
    `[serial_enter_uboot] session_id=${args.session_id} timeoutMs=${timeoutMs}`
  );

  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    // 构造 U-Boot 检测器：从设备配置读 uboot 子段，未配置走默认值
    // 配置非法（re: 后跟无效正则）时立即返回配置错误，不进入轮询
    let detector: UbootDetector;
    try {
      detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[serial_enter_uboot] config error: ${msg}`);
      return `Failed to build U-Boot detector (config error): ${msg}`;
    }

    // 发送 reboot 重启设备
    shell.write("reboot", 1);
    logger.info(
      `[serial_enter_uboot] cmd=reboot sent, waiting for autoboot prompt...`
    );

    const deadline = Date.now() + timeoutMs;
    const verifyTimeoutMs = detector.verifyTimeoutMs;
    let allOutput = "";
    let interruptKey = "";
    let interruptedAt = 0; // 中断键发送时刻，用于主层窗口计时
    let verifyStarted = false; // 是否已发 printenv（保证只发一次）
    let verifyStartedAt = 0; // printenv 发送时刻，用于验证层窗口计时

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const chunk = shell.read(0); // 不清空缓冲区，持续累积
      if (chunk) allOutput += chunk;

      // 阶段 1：autoboot 提示检测（未中断时）
      if (!interruptKey) {
        const key = detector.matchAutoboot(allOutput);
        if (key) {
          shell.sendRaw(key, 1);
          interruptKey =
            key === "\x03" ? "Ctrl+C" : key === "\x15" ? "Ctrl+u" : "Enter";
          interruptedAt = Date.now();
          allOutput = ""; // 重置，接下来只收集 U-Boot 阶段输出
          logger.info(
            `[serial_enter_uboot] detected autoboot prompt, sent ${interruptKey}`
          );
          continue;
        }

      }

      // 已中断后才进入主层 / 验证层判定
      if (!interruptKey) {
        continue;
      }

      // 内核启动特征 → 立即失败（不论主层还是验证层）
      if (detector.matchKernelBoot(allOutput)) {
        logger.warn(
          "[serial_enter_uboot] kernel boot detected, abort (device bypassed U-Boot)"
        );
        return `Failed to enter U-Boot: kernel boot detected (device bypassed U-Boot).\n\n${allOutput.trim() || "(no output)"}\n\nRetry recommended.`;
      }

      // 阶段 2：主层 — 提示符命中即成功
      if (!verifyStarted && detector.matchPrompt(allOutput)) {
        const finalOutput = shell.read(1);
        if (finalOutput) allOutput += finalOutput;
        logger.info(
          `[serial_enter_uboot] prompt matched (via prompt), entered U-Boot`
        );
        markUbootSession(args.session_id);
        return `Entered U-Boot successfully (via prompt, interrupt: ${interruptKey}).\n\n${allOutput.trim()}`;
      }

      // 主层窗口耗尽 → 触发验证层（仅一次）
      if (!verifyStarted && Date.now() - interruptedAt >= verifyTimeoutMs) {
        shell.sendRaw("\nprintenv\n", 1);
        verifyStarted = true;
        verifyStartedAt = Date.now();
        allOutput = ""; // 重置，接下来只收集 printenv 输出
        logger.info(
          "[serial_enter_uboot] prompt not matched in main window, sent printenv for verification"
        );
        continue;
      }

      // 阶段 3：验证层 — 环境变量键命中即成功
      if (verifyStarted) {
        if (detector.matchVerifyKey(allOutput)) {
          const finalOutput = shell.read(1);
          if (finalOutput) allOutput += finalOutput;
          logger.info(
            "[serial_enter_uboot] verify key matched (via verify), entered U-Boot"
          );
          markUbootSession(args.session_id);
          return `Entered U-Boot successfully (via verify, interrupt: ${interruptKey}).\n\n${allOutput.trim()}`;
        }

        // 验证层窗口耗尽 → 快速失败
        if (Date.now() - verifyStartedAt >= verifyTimeoutMs) {
          logger.warn(
            `[serial_enter_uboot] verify timeout (${verifyTimeoutMs}ms), no env key matched`
          );
          return `Failed to enter U-Boot: no U-Boot env key matched within ${verifyTimeoutMs}ms.\n\n${allOutput.trim() || "(no output)"}\n\nRetry recommended.`;
        }
      }
    }

    // 总超时兜底
    const remaining = shell.read(1);
    if (remaining) allOutput += remaining;

    logger.warn(
      `[serial_enter_uboot] overall timeout after ${timeoutMs}ms, interruptKey=${interruptKey || "(none)"}`
    );
    return `Timeout after ${timeoutMs}ms waiting for U-Boot.\n\n${allOutput.trim() || "(no output)"}`;
  });
}

// ── serial_uboot_state ────────────────────────────────────────

/**
 * @brief serial_uboot_state 工具配置
 *
 * 查询 / 主动检测 / 强制设置会话的 U-Boot 标记。标记决定 serial_exec 在该
 * 会话的 marker 包装风格（U-Boot 态用 plain 无子 shell，其余用 subshell）。
 *
 * @param session_id  由 serial_open 返回的会话 ID
 * @param action      detect（默认）/ set / clear / status
 */
export const serialUbootStateConfig: SdkToolConfig = {
  description:
    "Query, detect, or force-set the U-Boot mark of a serial session. " +
    "The mark decides serial_exec's marker wrapping (U-Boot sessions use plain style without subshell). " +
    "Actions: 'detect' (default) — classify the live environment from buffered tail evidence first " +
    "(zero side effects); if inconclusive, send a bare Enter to redraw the prompt. " +
    "Conclusive results sync the mark automatically. " +
    "WARNING: do NOT detect while a command may still be running or waiting for interactive input (e.g. Y/N) — " +
    "the probe Enter could answer it. " +
    "'set'/'clear' — force the mark when auto-detection is out of sync; " +
    "'status' — read the mark only, no device I/O.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      action: {
        type: "string",
        enum: ["detect", "set", "clear", "status"],
        description:
          "detect (default) = probe live environment and sync mark; set/clear = force mark; status = read mark only",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief 环境分类结论
 *
 * detect 动作对一段累积输出的分类结果：
 *   - uboot   ：末尾停靠在 U-Boot 提示符
 *   - system  ：末尾停靠在非 U-Boot 的 shell 提示符（Linux/Android）
 *   - login   ：末尾停靠在 login:/Password: 登录提示（系统侧，未登录）
 *   - booting ：输出含内核启动特征（过渡态）
 *   - autoboot：输出含 autoboot 倒计时提示（过渡态）
 */
type UbootEnvKind = "uboot" | "system" | "login" | "booting" | "autoboot";

/** @brief 尾部锚定的登录提示符（getty login: / Password:），判定"当前停在登录提示" */
const TAIL_LOGIN_PROMPT_RE = /(?:login|password):\s*$/i;

/**
 * @brief 对一段累积输出做环境分类
 *
 * 判定顺序即优先级：先看输出末尾的「当前停靠点」（U-Boot 提示符 → 登录提示 →
 * 通用提示符），末尾无提示符再看「过程特征」（内核启动 → autoboot 倒计时），
 * 均未命中返回 null（无结论）。
 * @param detector      U-Boot 检测器（提示符/内核特征/autoboot）
 * @param promptDetector 通用提示符检测器（默认正则，覆盖 Linux/Android）
 * @param output        累积输出
 * @returns 环境分类；无结论返回 null
 */
function classifyUbootEnv(
  detector: UbootDetector,
  promptDetector: PromptDetector,
  output: string
): UbootEnvKind | null {
  if (output === "") {
    return null;
  }
  if (detector.matchPrompt(output)) {
    return "uboot";
  }
  if (TAIL_LOGIN_PROMPT_RE.test(output)) {
    return "login";
  }
  if (promptDetector.detect(output)) {
    return "system";
  }
  if (detector.matchKernelBoot(output)) {
    return "booting";
  }
  if (detector.matchAutoboot(output)) {
    return "autoboot";
  }
  return null;
}

/** @brief 标记状态文本 */
function ubootMarkText(marked: boolean, note: string): string {
  return `U-Boot mark: ${marked ? "set" : "clear"} (${note})`;
}

/**
 * @brief serial_uboot_state 处理函数
 *
 * 四个动作：
 *   - status：只读标记，无设备 I/O
 *   - set / clear：强制覆盖标记（自动检测失同步时的权威手动入口）
 *   - detect：分类当前真实环境并同步标记。两级策略：
 *     1. 被动优先——缓冲区未消费内容的尾部就是设备最近输出，命中即零副作用判定
 *     2. 主动兜底——发空回车让设备重绘提示符（500ms × 3 轮轮询）
 *   结论性结果（uboot/system/login）同步标记；过渡态（booting/autoboot）与
 *   无结论（unknown，可能命令仍在跑）不动标记。
 *
 * @param args 工具参数，包含 session_id 和可选 action
 * @return MCP 响应，包含环境分类结论与标记状态
 */
export async function serialUbootStateHandler(args: {
  session_id: string;
  action?: "detect" | "set" | "clear" | "status";
}) {
  const action = args.action ?? "detect";
  logger.info(
    `[serial_uboot_state] session_id=${args.session_id} action=${action}`
  );
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return serialStore.withLock(args.session_id, async () => {
    const wasMarked = isUbootSession(args.session_id);

    if (action === "status") {
      return ubootMarkText(wasMarked, "queried, no device I/O");
    }
    if (action === "set") {
      markUbootSession(args.session_id);
      return ubootMarkText(
        true,
        "forced set — serial_exec will use plain marker (no subshell)"
      );
    }
    if (action === "clear") {
      clearUbootSession(args.session_id);
      return ubootMarkText(
        false,
        "forced clear — serial_exec will use subshell marker wrapper"
      );
    }

    // ── detect ──
    let detector: UbootDetector;
    try {
      detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[serial_uboot_state] config error: ${msg}`);
      return `Failed to build U-Boot detector (config error): ${msg}`;
    }
    const promptDetector = new PromptDetector();

    // 1. 被动：缓冲区未消费内容的尾部即设备最近输出
    let kind: UbootEnvKind | null = classifyUbootEnv(
      detector,
      promptDetector,
      shell.read(0)
    );
    let source = "buffer";
    // 2. 主动：发空回车重绘提示符（可能回答挂起的交互提示，见工具描述警告）
    if (!kind) {
      shell.write("", 0);
      source = "probe";
      for (let i = 0; i < 3 && !kind; i++) {
        await new Promise((r) => setTimeout(r, 500));
        kind = classifyUbootEnv(detector, promptDetector, shell.read(0));
      }
    }

    // 结论性结果同步标记；booting/autoboot 过渡态与 unknown 不动标记
    let markChanged = false;
    if (kind === "uboot") {
      markUbootSession(args.session_id);
      markChanged = !wasMarked;
    } else if (kind === "system" || kind === "login") {
      clearUbootSession(args.session_id);
      markChanged = wasMarked;
    }

    const lines: string[] = [
      `Environment: ${kind ?? "unknown"} (via ${source})`,
    ];
    if (!kind) {
      lines.push(
        "(no conclusive evidence within probe window — shell may be busy running a command)"
      );
    }
    const nowMarked = isUbootSession(args.session_id);
    lines.push(
      markChanged
        ? `U-Boot mark: ${nowMarked ? "set" : "clear"} (was ${wasMarked ? "set" : "clear"}, synced from detection)`
        : `U-Boot mark: ${nowMarked ? "set" : "clear"} (unchanged)`
    );
    logger.info(
      `[serial_uboot_state] detected=${kind ?? "unknown"} via=${source} mark=${nowMarked ? "set" : "clear"}`
    );
    return lines.join("\n");
  });
}
