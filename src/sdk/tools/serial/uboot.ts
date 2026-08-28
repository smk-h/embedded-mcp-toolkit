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
import { UbootDetector } from "../../exec/prompt-detector.js";

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
    "Actions: 'detect' (default) — classify the live environment in two layers. " +
    "Passive first (zero side effects): buffer-tail anchors only — U-Boot prompt, login prompt, " +
    "kernel boot, autoboot countdown. Anything else (e.g. a bare '#' tail, ambiguous between " +
    "Linux root shell and custom U-Boot prompts) falls through to an active two-step probe: " +
    "'printenv' (>=2 U-Boot env verify keys → U-Boot), then 'echo $$' " +
    "(whole-line numeric PID → system; whole-line '$$' or 'Unknown command' → U-Boot). " +
    "Conclusive results sync the mark automatically. " +
    "WARNING: each probe consumes one line of input — do NOT detect while a command may still " +
    "be running or waiting for interactive input (e.g. Y/N). " +
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
 * @brief 被动形态分类结论（缓冲区尾部锚点，零副作用判定）
 *
 * detect 被动层对一段累积输出的分类结果：
 *   - uboot   ：末尾停靠在 U-Boot 提示符（=>/U-Boot> 或设备配置）
 *   - login   ：末尾停靠在 login:/Password: 登录提示（系统侧，未登录）
 *   - booting ：输出含内核启动特征（过渡态，同时是探测护栏）
 *   - autoboot：输出含 autoboot 倒计时提示（过渡态，同时是探测护栏）
 *
 * 刻意不含 "system"：通用提示符（$/#/> 等）在 U-Boot 与 Linux 间无形态
 * 区分度（定制 U-Boot 用 # 提示符、Linux root 用 #、sh 续行提示符是 >），
 * 形态判定会系统性误判，system 结论只能由主动行为探测得出。
 */
type PassiveEnvKind = "uboot" | "login" | "booting" | "autoboot";

/** @brief detect 最终结论 = 被动分类 ∪ 探测结论（system 仅来自探测） */
type UbootEnvKind = PassiveEnvKind | "system";

/** @brief 尾部锚定的登录提示符（getty login: / Password:），判定"当前停在登录提示" */
const TAIL_LOGIN_PROMPT_RE = /(?:login|password):\s*$/i;

/**
 * @brief echo $$ 探测判据（整行锚定，防回显自污染）
 *
 * 探测原理：Linux POSIX shell 的 echo 是内建且 $$ 展开为 PID（纯数字行）；
 * U-Boot 无 PID 概念，$$ 原样或经 process_macros 转义为单个 $ 输出；很老的
 * U-Boot 无 echo 命令则回 Unknown command（echo 是 POSIX 强制内建，Linux
 * 侧不可能出现该文案）。
 *
 * 必须整行锚定（m 标志 ^$）：串口会回显输入行 "echo $$"，其本身含字面
 * $$——若做子串匹配，回显行就会命中 "uboot" 判据，把 Linux 误判成
 * U-Boot。\s* 吸收行尾 \r（串口行尾是 \r\n）。
 */
/** @brief 整行纯数字 → Linux（$$ 展开为 PID） */
const ECHO_PID_LINE_RE = /^\d{1,10}\s*$/m;
/** @brief 整行 $ 或 $$ → U-Boot（不展开 / $$ 转义为 $，两种输出都覆盖） */
const ECHO_LITERAL_DOLLAR_LINE_RE = /^\$\$?\s*$/m;
/** @brief Unknown command → U-Boot（Linux echo 是内建，不会 not found） */
const ECHO_UNKNOWN_CMD_RE = /unknown command/i;

/**
 * @brief 被动分类结果：结论 + 命中的具体判据
 *
 * evidence 用于业务日志与 MCP 响应标注"最终是哪一条判据出的结果"，
 * 内容为命中的正则模式（默认值或用户配置合并后的实际生效源码）。
 */
type PassiveMatch = {
  kind: PassiveEnvKind;
  evidence: string;
};

/**
 * @brief 对一段累积输出做被动形态分类
 *
 * 只保留高置信锚点与探测护栏，判定顺序即优先级：
 *   1. U-Boot 提示符（尾部锚定）→ uboot
 *   2. 登录提示（尾部锚定）→ login
 *   3. 内核启动特征 → booting（过渡态）
 *   4. autoboot 倒计时 → autoboot（过渡态）
 * 3/4 级是探测护栏：autoboot 期间探测命令的回车会打断引导进入 U-Boot
 * （状态改变事故），booting 期间探测无消费者纯浪费，故必须先于探测。
 * 通用提示符（PromptDetector）不再作为结论判据——形态无区分度，未命中
 * 以上判据一律交给主动行为探测。均未命中返回 null（无结论）。
 *
 * 每级都用 matched* 变体取回命中的具体模式（而非仅布尔结论），调用方
 * 可在日志/响应里展示"最终是哪一个匹配出的结果"。
 *
 * @param detector U-Boot 检测器（提示符/内核特征/autoboot）
 * @param output   累积输出
 * @returns 分类结论与命中判据；无结论返回 null
 */
function classifyUbootEnv(
  detector: UbootDetector,
  output: string
): PassiveMatch | null {
  if (output === "") {
    return null;
  }
  const prompt = detector.matchedPrompt(output);
  if (prompt !== null) {
    return { kind: "uboot", evidence: `prompt regex /${prompt}/` };
  }
  if (TAIL_LOGIN_PROMPT_RE.test(output)) {
    return {
      kind: "login",
      evidence: `login prompt regex /${TAIL_LOGIN_PROMPT_RE.source}/i`,
    };
  }
  const kernelBoot = detector.matchedKernelBoot(output);
  if (kernelBoot !== null) {
    return { kind: "booting", evidence: `kernel boot regex /${kernelBoot}/i` };
  }
  const autoboot = detector.matchedAutoboot(output);
  if (autoboot !== null) {
    return {
      kind: "autoboot",
      evidence: `autoboot prompt regex /${autoboot.source}/i`,
    };
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
 *     1. 被动优先——缓冲区尾部的高置信锚点（U-Boot 提示符/登录提示）直接
 *        结论；内核启动/autoboot 特征报过渡态并兼作探测护栏，零副作用
 *     2. 主动兜底——两段式行为探测：先 printenv（≥2 环境特征键 → uboot），
 *        无键再 echo $$（整行数字 → system，整行 $$/$ 或 Unknown command
 *        → uboot）；形态判据对 # 等无区分度提示符不可靠，行为判据才是
 *        兜底权威
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
  // 动作参数缺省为 detect——"查一下现在是什么环境并顺手同步标记"是最常用入口
  const action = args.action ?? "detect";
  // 入口日志：会话 ID 与动作，与出口日志呼应，便于串联一次调用的完整时序
  logger.info(
    `[serial_uboot_state] session_id=${args.session_id} action=${action}`
  );
  // 从会话表取串口 shell 实例；会话不存在（未 open 或已 close）直接报错返回
  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  // 整个动作包在会话锁内执行：串口是独占资源，防止与 serial_exec /
  // serial_read 等并发工具同时操作同一会话，造成输出交错与判定污染
  return serialStore.withLock(args.session_id, async () => {
    // 入口先采样标记原值，结尾据此对比"本次检测是否改变了标记"
    const wasMarked = isUbootSession(args.session_id);

    // ── status：只读标记现值，不发任何串口数据（零设备 I/O）──
    if (action === "status") {
      return ubootMarkText(wasMarked, "queried, no device I/O");
    }
    // ── set：强制置位标记（自动检测失同步时的权威人工入口）──
    // 置位后 serial_exec 在该会话用 plain marker（无子 shell 包裹）
    if (action === "set") {
      markUbootSession(args.session_id);
      return ubootMarkText(
        true,
        "forced set — serial_exec will use plain marker (no subshell)"
      );
    }
    // ── clear：强制清位标记 ──
    // 清位后 serial_exec 恢复 subshell marker 包装（POSIX shell 默认）
    if (action === "clear") {
      clearUbootSession(args.session_id);
      return ubootMarkText(
        false,
        "forced clear — serial_exec will use subshell marker wrapper"
      );
    }

    // ── detect：分类当前真实环境并同步标记 ──
    // 构造 U-Boot 检测器：getUbootConfig 读设备配置的 serial.uboot 子段，
    // 构造时与内置默认值合并。配置里的正则是字符串源码，new RegExp() 在
    // 构造期即校验——非法正则（如括号不闭合）在此抛出，立即返回配置错误，
    // 不进入轮询（失败快速化，不浪费串口等待窗口）
    let detector: UbootDetector;
    try {
      detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    } catch (err) {
      // Error 实例取 message，其余类型 String() 兜底，避免错误处理自身抛错
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[serial_uboot_state] config error: ${msg}`);
      return `Failed to build U-Boot detector (config error): ${msg}`;
    }

    // 第 1 级——被动形态判定（零副作用）：
    // shell.read(0) 读会话缓冲区中未消费的全部内容且不清空（clear=0），
    // 缓冲区尾部即设备最近的输出。classifyUbootEnv 按优先级链只认高置信
    // 锚点：U-Boot 提示符 → 登录提示 → 内核启动特征（护栏）→ autoboot
    // 倒计时（护栏）；全未命中返回 null——含 # 等形态无区分度的停靠场景，
    // 交给下一级行为探测。命中时连同具体判据（evidence）一起返回
    const passive = classifyUbootEnv(detector, shell.read(0));
    let kind: UbootEnvKind | null = passive?.kind ?? null;
    // 结论来源标记：buffer=被动判定；probe/probe:printenv/probe:echo=探测各段
    let source = "buffer";
    // 最终命中的具体判据（哪条正则/哪几个键/哪个探测判据），拼进响应与日志
    let detail = passive?.evidence ?? "";

    // 第 2 级——主动行为探测：被动判据全未命中时兜底。形态判据对 U-Boot/
    // Linux 共用提示符（# 等）无区分度，命令响应差异才是权威判据
    if (!kind) {
      source = "probe";
      // drain() 排空缓冲区历史但保持收集状态。必须先排空：printenv 键
      // 匹配是子串匹配（找 "baudrate="），历史输出里残留的旧 printenv
      // 结果会造成假命中；echo 判据虽是整行锚定，同样只应对探测响应成立
      shell.drain();

      // 探测 1：printenv——判定 U-Boot 的正向判据。
      // write("printenv", 0)：write 默认追加换行，实际发送 "printenv\n"；
      // 第 2 参 clear=0 追加收集——探测响应从排空后的空缓冲开始累积
      shell.write("printenv", 0);
      // 探测窗口起点。env 全量输出可能很长（串口波特率低、收发慢），
      // 窗口复用检测器的 verifyTimeoutMs（默认 4000ms，与 enter_uboot
      // 验证层同款），窗口内每 500ms 轮询一次缓冲
      const printenvAt = Date.now();
      while (Date.now() - printenvAt < detector.verifyTimeoutMs) {
        // 轮询间隔 500ms：给设备留出执行与回传时间，避免空转
        await new Promise((r) => setTimeout(r, 500));
        // 列出累积输出里命中的 U-Boot 环境特征键名（baudrate、bootdelay…）
        const hitKeys = detector.matchedVerifyKeys(shell.read(0));
        // ≥2 键才判 uboot：单键可能是 Linux 侧环境变量的巧合（如调试
        // 脚本 export 过 baudrate），两个及以上几乎必是 U-Boot 环境表
        if (hitKeys.length >= 2) {
          kind = "uboot";
          source = "probe:printenv"; // 响应标注结论来自 printenv 探测
          detail = `verify keys [${hitKeys.join(", ")}]`; // 命中的具体键名
          break;
        }
        // 窗口耗尽无键 → 落入探测 2（U-Boot 空 env 或 Linux 侧都无法
        // 在此定论，交给 echo $$ 区分）
      }

      // 探测 2：echo $$——printenv 无键时区分 Linux 与 U-Boot。
      // 原理：POSIX shell 的 echo 是内建且 $$ 展开为 PID（纯数字行）；
      // U-Boot 无 PID 概念，$$ 原样或被转义为单个 $ 输出；很老的 U-Boot
      // 没有 echo 命令则回 Unknown command（echo 是 POSIX 强制内建，
      // Linux 侧不可能出现该文案）
      if (!kind) {
        shell.drain(); // 再次排空：echo 的整行锚定判据只对探测响应成立
        shell.write("echo $$", 0); // 发送 "echo $$\n"
        const echoAt = Date.now();
        // 响应只有一行，2s 窗口足够（printenv 才需要长窗口）
        const echoTimeoutMs = 2000;
        while (Date.now() - echoAt < echoTimeoutMs) {
          // 轮询间隔 500ms，与探测 1 一致
          await new Promise((r) => setTimeout(r, 500));
          const out = shell.read(0); // 读累积探测响应（不清缓冲）
          // 判据 1：存在一整行纯数字（1~10 位）→ $$ 被展开为 PID →
          // POSIX shell 在场 → system。整行锚定（m 标志）是必须的：
          // 串口回显的输入行 "echo $$" 自身含字面 $$，子串匹配会把
          // Linux 误判成 U-Boot
          if (ECHO_PID_LINE_RE.test(out)) {
            kind = "system";
            source = "probe:echo";
            detail = "echo probe: whole-line numeric PID ($$ expanded)";
            break;
          }
          // 判据 2/3：整行 $ 或 $$（U-Boot 不展开 / $$ 转义为 $，两种
          // 输出都覆盖），或 Unknown command（老 U-Boot 无 echo）→ uboot。
          // 判据 1 优先：数字行命中即短路，不会走到这里
          if (
            ECHO_LITERAL_DOLLAR_LINE_RE.test(out) ||
            ECHO_UNKNOWN_CMD_RE.test(out)
          ) {
            kind = "uboot";
            source = "probe:echo";
            // 分别标注是哪条判据命中：Unknown command 或字面 $ 行
            detail = ECHO_UNKNOWN_CMD_RE.test(out)
              ? "echo probe: Unknown command (no echo builtin)"
              : "echo probe: whole-line literal $/$$ (no PID expansion)";
            break;
          }
        }
        // 两段探测窗口耗尽仍无响应 → kind 保持 null → 末尾报 unknown
        // （设备可能忙于执行命令、停在非停靠态，此时不应翻转标记）
      }
    }

    // ── 标记同步：只有结论性结果才动标记 ──
    //   uboot（确定在 U-Boot 命令行）→ 置位，serial_exec 走 plain 包装
    //   system / login（确定在系统侧）→ 清位，serial_exec 走 subshell 包装
    //   booting / autoboot（过渡态）与 unknown（无结论）→ 不动标记：
    //   设备正处于状态切换或证据不足，此时翻转标记只会引入错误
    let markChanged = false;
    if (kind === "uboot") {
      markUbootSession(args.session_id);
      markChanged = !wasMarked; // 原来无标记、现在置位 = 标记发生了变化
    } else if (kind === "system" || kind === "login") {
      clearUbootSession(args.session_id);
      markChanged = wasMarked; // 原来有标记、现在清位 = 标记发生了变化
    }

    // ── 组装 MCP 响应（多行文本）──
    // 第 1 行：环境分类结论 + 证据来源；kind 为 null 时报告 unknown
    const lines: string[] = [
      `Environment: ${kind ?? "unknown"} (via ${source})`,
    ];
    // 第 2 行（可选）：最终命中的具体判据（哪条正则/哪几个键名），
    // 让调用方在业务日志里直接看到结论的出处
    if (detail) {
      lines.push(`Matched: ${detail}`);
    }
    // unknown 时追加提示：探测窗口内无结论性证据，shell 可能忙于执行命令
    if (!kind) {
      lines.push(
        "(no conclusive evidence within probe window — shell may be busy running a command)"
      );
    }
    // 重读标记现值（上面可能已被本次检测同步过）
    const nowMarked = isUbootSession(args.session_id);
    // 末行：标记状态——变化时报告前后值（was X），未变则标注 unchanged
    lines.push(
      markChanged
        ? `U-Boot mark: ${nowMarked ? "set" : "clear"} (was ${wasMarked ? "set" : "clear"}, synced from detection)`
        : `U-Boot mark: ${nowMarked ? "set" : "clear"} (unchanged)`
    );
    // 出口日志：结论 / 来源 / 命中判据 / 标记终值，供联查时与入口日志对照
    logger.info(
      `[serial_uboot_state] detected=${kind ?? "unknown"} via=${source} matched=${detail || "(none)"} mark=${nowMarked ? "set" : "clear"}`
    );
    // 多行文本拼成单个字符串返回给 MCP 调用方
    return lines.join("\n");
  });
}
