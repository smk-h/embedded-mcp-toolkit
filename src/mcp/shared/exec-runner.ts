/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exec-runner.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : 1.0.0
 * Description: 交互式 shell exec 的统一编排逻辑
 *
 *   把三个通道（adb/ssh/serial）复制粘贴的 exec 主体逻辑抽到此处统一实现：
 *     前置冲刷 → 发命令 → 轮询 buffer 检测提示符 → 超时熔断发 Ctrl+C
 *
 *   各通道差异（取 shell、取提示符配置）通过 ExecInput 注入，机制保持通道无关。
 *
 *   底层轮询骨架（sleep + drain 累积 + deadline）借鉴 ssh_build 已验证的模式，
 *   结束检测采用三级策略：
 *     - 1级 marker 注入（确定性，首选）：拼接 (cmd); echo "MARKER:$?"，
 *       marker 出现即命令结束，附带退出码，不受刷屏影响
 *     - 2级 末尾锚定（快路径）：提示符正则锚定输出末尾，无刷屏设备秒判
 *     - 3级 行级扫描（慢路径，刷屏兜底）：提示符在中间行出现 + idle 窗口确认
 * ======================================================
 */

import type { InteractiveShell } from "../../transports/interactive-shell.js";
import { logger } from "../../shared/logger.js";

import { type ControlChar, PromptDetector } from "./prompt-detector.js";
import { classifyResident, type ResidentVerdict } from "./resident-detector.js";

/** @brief 常驻命令采样超时时长（毫秒），到点发 Ctrl+C 终止（中性语义） */
const DEFAULT_SAMPLING_TIMEOUT_MS = 10000;

/** @brief 普通命令兜底超时时长（毫秒），到点不发 Ctrl+C（异常语义，仅安全阀） */
const DEFAULT_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** @brief 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 200;

/** @brief 熔断后等待 SIGINT 生效的时长（毫秒） */
const INTERRUPT_SETTLE_MS = 300;

/** @brief 默认最小轮询持续时长（毫秒），兼容旧 delay 语义 */
const DEFAULT_MIN_DELAY_MS = 1000;

/** @brief PTY 回显剥离最大重试次数（每次等待 pollInterval） */
const ECHO_STRIP_MAX_RETRIES = 10;

/**
 * @brief exec 完成标记前缀
 *
 * 注入命令尾部（echo "MARKER:$?"），检测到此标记出现即命令结束。
 * 标记格式为 `___MCP_EXEC_DONE_<rand>___:<exitcode>`，随机后缀避免
 * 命令输出中偶然出现相同字符串导致误判。ssh_build 已验证此模式。
 */
const EXEC_MARKER_PREFIX = "___MCP_EXEC_DONE_";

/**
 * @brief 生成唯一的 exec 完成标记
 *
 * 每次调用生成不同的随机后缀，避免与命令输出碰撞。
 * @returns 形如 "___MCP_EXEC_DONE_a3f7b2___" 的唯一标记
 */
function generateMarker(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${EXEC_MARKER_PREFIX}${rand}___`;
}

/**
 * @brief 构造 marker 检测正则
 *
 * 匹配 `<marker>:<digits>`，捕获退出码。
 * @param marker - 唯一标记字符串
 * @returns 匹配 marker 及退出码的正则
 */
function buildMarkerRegex(marker: string): RegExp {
  return new RegExp(`${marker}:(\\d+)`);
}

/**
 * @brief 刷屏设备行级检测的噪声阈值（字节）
 *
 * 提示符行之后追加的数据量若小于此值，认为是后台日志噪声而非命令输出，
 * 判定命令已结束。设备后台一行日志通常 80-120 字节，256 字节可容纳约
 * 2 行噪声，既能容忍提示符后被 1-2 行后台日志覆盖，又不会把大量日志
 * 误判为噪声截断。
 */
const NOISE_THRESHOLD_BYTES = 256;

/**
 * @brief 刷屏设备行级检测的 idle 确认周期数
 *
 * 提示符在中间行出现后，需要连续 N 个轮询周期都满足"新数据量 < 噪声阈值"
 * 才判定命令结束。避免命令输出中间短暂停顿（提示符尚未出现但偶有行尾 # / $）
 * 导致的误判。N=3 配合 200ms 轮询约 600ms 确认延迟。
 */
const IDLE_CONFIRM_CYCLES = 3;

/**
 * @brief exec 超时类型
 *
 * 区分两种超时语义，便于调用方（含 LLM）判断后续动作（spec F5）：
 *   - none     ：正常完成（提示符检测命中）
 *   - sampling ：常驻命令采样超时（中性，到点发 Ctrl+C）
 *   - fallback ：普通命令兜底超时（异常，到点不发 Ctrl+C）
 */
export type ExecTimeoutKind = "none" | "sampling" | "fallback";

/**
 * @brief 设备级 exec 超时配置片段
 *
 * 由 config.ts 的 getExecTimeoutConfig 读取并注入 runExec。字段全部可选，
 * 未配置时由 runExec 用默认值兜底（采样 10s / 兜底 5min）。
 */
export interface ExecTimeoutConfig {
  /** 常驻命令扩展名单（首 token 精确匹配），与内置白名单并集，未配置为 undefined */
  readonly residentCommands?: readonly string[];
  /** 采样超时时长（毫秒），常驻命令用，未配置默认 10000 */
  readonly samplingTimeoutMs?: number;
  /** 兜底超时时长（毫秒），普通命令用，未配置默认 300000（5 分钟） */
  readonly fallbackTimeoutMs?: number;
}

/**
 * @brief 统一 exec 的输入参数
 *
 * 各通道 exec handler 构造此对象后调用 runExec。
 * 通道差异（shell 实例、提示符配置、sendCtrl 实现）通过本对象注入。
 */
export interface ExecInput {
  /** 目标 shell 实例（任意通道的 BaseShell 子类） */
  readonly shell: InteractiveShell;
  /** 要执行的命令字符串 */
  readonly command: string;
  /** 旧 delay 参数（保留向后兼容，作为最小轮询持续时长下限） */
  readonly delay?: number;
  /** 旧 clear 参数（保留向后兼容，透传给 shell.write） */
  readonly clear?: number;
  /**
   * 最大执行时长（毫秒），覆盖默认超时（spec F6）。
   * 优先级最高，但只覆盖「时长」，超时动作仍按命令常驻性判定（常驻发 Ctrl+C、普通不发）。
   */
  readonly maxDuration?: number;
  /** 轮询间隔，默认 200ms */
  readonly pollInterval?: number;
  /** 提示符检测器（已根据设备配置初始化） */
  readonly promptDetector: PromptDetector;
  /** 控制字符发送函数（由各通道注入，封装传输层差异） */
  readonly sendCtrl: (key: ControlChar) => void;
  /** 日志前缀，如 "[adb_shell_exec]" */
  readonly logPrefix: string;
  /** 是否剥离 PTY 回显的首行（提示符+命令回显），默认 true */
  readonly stripEcho?: boolean;
  /** 设备级 exec 超时配置（常驻命令扩展名单 + 采样/兜底时长），由 handler 注入 */
  readonly execTimeoutConfig?: ExecTimeoutConfig;
}

/**
 * @brief 统一 exec 的输出结果
 *
 * 三态语义（由 timeoutKind 权威承载）：
 *   - 正常完成（检测到提示符）：timeoutKind="none", timedOut=false
 *   - 常驻命令采样超时：timeoutKind="sampling", timedOut=true
 *     —— 中性语义。常用于「故意取 N 秒输出」（如 logcat 取 10 秒日志、top 采样），
 *        到点发 Ctrl+C 终止，是预期行为，不是异常。
 *   - 普通命令兜底超时：timeoutKind="fallback", timedOut=true
 *     —— 异常语义。提示符正则未匹配上（自定义 PS1、异常设备）时的安全阀，
 *        到点不发 Ctrl+C，调用方需手动确认/终止。
 *   - 异常（发命令即无响应等）：走错误路径，不在此结构返回
 *
 * timeoutKind 与 timedOut 的关系：
 *   - timeoutKind：超时类型的权威枚举（none/sampling/fallback）
 *   - timedOut：派生布尔（= timeoutKind !== "none"），保留向后兼容
 *   - interrupted：命令因异常被强行打断。当前 runExec 不会产生此状态（恒为 false），
 *     保留字段供未来异常路径（如进程崩溃、连接断开）使用。
 */
export interface ExecResult {
  /** 累积的全部输出文本 */
  readonly output: string;
  /** 命令退出码（marker 检测命中时可获取，其他场景为 null） */
  readonly exitCode: number | null;
  /** 是否因异常被中断（保留字段，当前实现恒为 false） */
  readonly interrupted: boolean;
  /** 超时类型（取代单纯布尔 timedOut 的语义载体，none 表示未超时） */
  readonly timeoutKind: ExecTimeoutKind;
  /** 是否超时（= timeoutKind !== "none"，派生布尔，保持向后兼容） */
  readonly timedOut: boolean;
  /** 实际执行时长（毫秒），用于格式化标注 */
  readonly elapsedMs: number;
}

/**
 * @brief sleep 毫秒的轻量封装
 * @param ms - 等待毫秒数
 * @returns 到期后 resolve
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @brief 执行交互式 shell 命令的统一流程
 *
 * 流程：
 *   0. 常驻分类：判定命令是否常驻（ping/logcat/top...），据此选超时时长与动作
 *   1. 前置冲刷：drain() 丢弃缓冲区残留（避免上次未终止命令污染本次输出）
 *   2. 发命令：shell.write(command, clear)
 *   3. PTY 回显剥离：丢弃首行（提示符 + 命令回显），\n 之后才是真实输出
 *   4. 轮询 buffer（最长 effectiveTimeout）：
 *      - 检测到提示符 → 立即返回（timeoutKind="none"）
 *      - 超过 effectiveTimeout 仍未现提示符 → 按常驻性分支熔断：
 *        · 常驻命令（采样超时）：发 Ctrl+C 终止，返回 timeoutKind="sampling"（中性）
 *        · 普通命令（兜底超时）：不发 Ctrl+C，返回 timeoutKind="fallback"（异常）
 *   5. 最小轮询持续时长：取 max(effectiveTimeout, minDelay) 作为实际 deadline，
 *      保证短命令也有时间产出输出（兼容旧 delay 语义）
 *
 * 超时时长选择（spec F6）：
 *   - 调用方传 maxDuration 时优先级最高（只覆盖时长，动作仍按常驻性）
 *   - 否则：常驻命令用采样时长（默认 10s），普通命令用兜底时长（默认 5min）
 *   - 两者均可被设备配置（execTimeoutConfig）覆盖
 *
 * @param input - exec 输入参数
 * @returns 结构化结果，由各通道 handler 格式化为 MCP 响应
 */
export async function runExec(input: ExecInput): Promise<ExecResult> {
  const pollInterval: number = input.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const clear: number = input.clear ?? 1;
  const minDelay: number = input.delay ?? DEFAULT_MIN_DELAY_MS;
  const stripEcho: boolean = input.stripEcho ?? true;

  // ── 0. 常驻分类：据此选超时时长与超时动作（spec F1/F3/F4） ──
  const verdict: ResidentVerdict = classifyResident(
    input.command,
    input.execTimeoutConfig?.residentCommands
  );
  const isResident: boolean = verdict.kind === "resident";
  // 常驻命令用采样时长（默认 10s），普通命令用兜底时长（默认 5min）
  const defaultTimeout: number = isResident
    ? (input.execTimeoutConfig?.samplingTimeoutMs ??
      DEFAULT_SAMPLING_TIMEOUT_MS)
    : (input.execTimeoutConfig?.fallbackTimeoutMs ??
      DEFAULT_FALLBACK_TIMEOUT_MS);
  // maxDuration 优先级最高（spec F6），只覆盖时长，超时动作仍按常驻性
  const effectiveTimeout: number = input.maxDuration ?? defaultTimeout;
  logger.info(
    `${input.logPrefix} classified: ${verdict.kind} (${verdict.reason}), effectiveTimeout=${effectiveTimeout}ms`
  );

  // 最小持续时长：effectiveTimeout 不能小于 minDelay，否则短命令可能拿不到输出
  const deadline: number = Math.max(effectiveTimeout, minDelay);

  const startTime: number = Date.now();

  // ── 1. 前置冲刷：丢弃发送前缓冲区可能累积的残留 ──
  const flushed: string = input.shell.drain();
  if (flushed) {
    logger.info(
      `${input.logPrefix} flushed ${flushed.length} bytes before exec`
    );
  }

  // ── 2. 发命令（拼接 marker） ──
  // 子 shell 包裹原始命令 + echo marker:$?，命令结束后 marker 必然出现
  //   (cmd); echo "MARKER:$?"
  // 子 shell 保证 cmd 中的 | && ; 不影响外层 echo 的执行
  const marker: string = generateMarker();
  const markerRegex: RegExp = buildMarkerRegex(marker);
  const fullCommand: string = `(${input.command}); echo "${marker}:$?"`;
  logger.info(`${input.logPrefix} command with marker: ${fullCommand}`);
  input.shell.write(fullCommand, clear);

  // ── 3. PTY 回显剥离：丢弃首行（提示符 + 命令回显） ──
  // PTY 模式下设备会原样回显输入的命令行（如 "rk3568:/ $ echo hi"），
  // 这一行不是真实输出，需剥离。\n 之后的内容才是命令的真实输出。
  // 非 PTY 通道可传 stripEcho=false 跳过；当前三通道均为 PTY，默认开启。
  // 借鉴 ssh_build 步骤 4 的做法：最多重试若干次找第一个 \n。
  let accumulated: string = "";
  if (stripEcho) {
    let echoBuffer: string = "";
    let retries: number = ECHO_STRIP_MAX_RETRIES;
    while (retries > 0) {
      retries--;
      await sleep(pollInterval);
      echoBuffer += input.shell.drain();
      const nlIdx: number = echoBuffer.indexOf("\n");
      if (nlIdx !== -1) {
        // \n 之后的内容作为真实输出的起始
        accumulated = echoBuffer.substring(nlIdx + 1);
        logger.info(
          `${input.logPrefix} echo stripped (${ECHO_STRIP_MAX_RETRIES - retries} retries)`
        );
        break;
      }
    }
    if (retries < 0) {
      // 重试耗尽仍未找到 \n：保留已收集内容，记录告警
      accumulated = echoBuffer;
      logger.warn(
        `${input.logPrefix} echo strip failed: no newline within ${ECHO_STRIP_MAX_RETRIES} retries`
      );
    }
  }

  // ── 4. 轮询 buffer：三级检测 marker > 末尾锚定 > 行级匹配 ──
  // 三级检测策略（从快到慢、从确定到启发）：
  //   1. marker 命中：确定性检测，命令拼接的 echo "MARKER:$?" 出现即命令结束
  //      —— 不受刷屏影响，附带退出码，首选路径
  //   2. detect() 末尾锚定：无刷屏设备秒判
  //   3. detectInLines() 行级扫描：刷屏设备提示符被日志挤出末尾时兜底
  //      判定条件：提示符出现在 accumulated 中间行 + 其后数据量 < 噪声阈值
  //      + 连续 IDLE_CONFIRM_CYCLES 个周期新数据量稳定在噪声水平
  let idleConfirmCount = 0; // 连续满足噪声阈值的周期数
  let lastAccumulatedLen = accumulated.length; // 上轮 accumulated 长度，用于计算增量

  while (Date.now() - startTime < deadline) {
    await sleep(pollInterval);
    accumulated += input.shell.drain();

    // ── 1级：marker 检测（确定性，首选） ──
    const markerMatch = accumulated.match(markerRegex);
    if (markerMatch) {
      const exitCode: number = parseInt(markerMatch[1], 10);
      const elapsedMs: number = Date.now() - startTime;
      // 截断 marker 及其后的内容，只返回命令输出（marker 行本身也去掉）
      const markerIdx = accumulated.indexOf(marker);
      const cleanOutput = accumulated.substring(0, markerIdx).trimEnd();
      logger.info(
        `${input.logPrefix} marker detected, exitCode=${exitCode}, returning after ${elapsedMs}ms`
      );
      return {
        output: cleanOutput,
        exitCode,
        interrupted: false,
        timeoutKind: "none",
        timedOut: false,
        elapsedMs,
      };
    }

    // ── 2级：末尾锚定（无刷屏设备快路径） ──
    if (input.promptDetector.detect(accumulated)) {
      const elapsedMs: number = Date.now() - startTime;
      logger.info(
        `${input.logPrefix} prompt detected (tail), returning after ${elapsedMs}ms`
      );
      return {
        output: accumulated.trim(),
        exitCode: null,
        interrupted: false,
        timeoutKind: "none",
        timedOut: false,
        elapsedMs,
      };
    }

    // ── 3级：行级扫描（刷屏设备兜底） ──
    const lineMatch = input.promptDetector.detectInLines(accumulated);
    if (lineMatch) {
      // 提示符行后的数据量（后台噪声）
      const trailing = lineMatch.trailingBytes;
      // 本轮新增数据量
      const delta = accumulated.length - lastAccumulatedLen;
      lastAccumulatedLen = accumulated.length;

      if (trailing < NOISE_THRESHOLD_BYTES && delta < NOISE_THRESHOLD_BYTES) {
        idleConfirmCount++;
        if (idleConfirmCount >= IDLE_CONFIRM_CYCLES) {
          const elapsedMs: number = Date.now() - startTime;
          // 截断提示符后的噪声数据，只返回提示符之前的内容（含提示符行）
          const cleanOutput = accumulated.substring(0, lineMatch.matchEnd);
          logger.info(
            `${input.logPrefix} prompt detected (line-level, trailing=${trailing}B, idle=${idleConfirmCount} cycles), returning after ${elapsedMs}ms`
          );
          return {
            output: cleanOutput.trim(),
            exitCode: null,
            interrupted: false,
            timeoutKind: "none",
            timedOut: false,
            elapsedMs,
          };
        }
      } else {
        // 新数据量超过噪声阈值，说明命令仍在产出或后台日志量大，重置计数
        idleConfirmCount = 0;
      }
    } else {
      // 未匹配到提示符行，重置计数
      idleConfirmCount = 0;
      lastAccumulatedLen = accumulated.length;
    }
  }

  // ── 5. 超时熔断：按常驻性分支（spec F3/F4/F5） ──
  if (isResident) {
    // 常驻命令采样超时：发 Ctrl+C 终止（中性语义，避免 ping/logcat 后台持续运行污染后续会话）
    logger.warn(
      `${input.logPrefix} sampling timeout after ${effectiveTimeout}ms (no prompt), sending Ctrl+C`
    );
    input.sendCtrl("c");
    await sleep(INTERRUPT_SETTLE_MS);
    accumulated += input.shell.drain();
    return {
      output: accumulated.trim(),
      exitCode: null,
      interrupted: false,
      timeoutKind: "sampling",
      timedOut: true,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 普通命令兜底超时：不发 Ctrl+C（避免误杀可能已完成只是提示符没匹配上的命令）
  logger.warn(
    `${input.logPrefix} fallback timeout after ${effectiveTimeout}ms (no prompt), NOT sending Ctrl+C`
  );
  accumulated += input.shell.drain();
  return {
    output: accumulated.trim(),
    exitCode: null,
    interrupted: false,
    timeoutKind: "fallback",
    timedOut: true,
    elapsedMs: Date.now() - startTime,
  };
}
