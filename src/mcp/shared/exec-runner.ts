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
 *   但结束检测与超时处理与 ssh_build 不同：
 *     - ssh_build：注入 marker（确定性、不杀命令、能拿退出码）
 *     - runExec  ：提示符正则（启发式、超时发 Ctrl+C、拿不到退出码）
 *   两者仅轮询骨架复用，机制不同（详见 plan.md 技术决策）。
 * ======================================================
 */

import type { InteractiveShell } from "../../transports/interactive-shell.js";
import { logger } from "../../shared/logger.js";

import { type ControlChar, PromptDetector } from "./prompt-detector.js";

/** @brief 默认最大执行时长（毫秒），超过则熔断发 Ctrl+C */
const DEFAULT_MAX_DURATION_MS = 10000;

/** @brief 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 200;

/** @brief 熔断后等待 SIGINT 生效的时长（毫秒） */
const INTERRUPT_SETTLE_MS = 300;

/** @brief 默认最小轮询持续时长（毫秒），兼容旧 delay 语义 */
const DEFAULT_MIN_DELAY_MS = 1000;

/** @brief PTY 回显剥离最大重试次数（每次等待 pollInterval） */
const ECHO_STRIP_MAX_RETRIES = 10;

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
  /** 最大执行时长，默认 10000ms，超过则熔断 */
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
}

/**
 * @brief 统一 exec 的输出结果
 *
 * 三态语义：
 *   - 正常完成（检测到提示符）：interrupted=false, timedOut=false
 *   - 超时熔断（到 maxDuration 未现提示符）：interrupted=false, timedOut=true
 *     —— 中性语义。常用于「故意取 N 秒输出」（如 logcat 取 5 秒日志），
 *        是预期行为，不是异常。
 *   - 异常（发命令即无响应等）：走错误路径，不在此结构返回
 *
 * timed-out 与 interrupted 的区别：
 *   - timedOut：到达时间上限的预期行为（logcat 取 N 秒、top 采样），输出已收集，
 *     调用方应视为正常采样结果，不是出错。
 *   - interrupted：命令因异常被强行打断。当前 runExec 不会产生此状态（恒为 false），
 *     保留字段供未来异常路径（如进程崩溃、连接断开）使用。
 */
export interface ExecResult {
  /** 累积的全部输出文本 */
  readonly output: string;
  /** 是否因异常被中断（保留字段，当前实现恒为 false） */
  readonly interrupted: boolean;
  /** 是否因到达 maxDuration 超时熔断（中性语义，非异常） */
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
 *   1. 前置冲刷：drain() 丢弃缓冲区残留（避免上次未终止命令污染本次输出）
 *   2. 发命令：shell.write(command, clear)
 *   3. PTY 回显剥离：丢弃首行（提示符 + 命令回显），\n 之后才是真实输出
 *   4. 轮询 buffer（最长 maxDuration）：
 *      - 检测到提示符 → 立即返回（interrupted=false, timedOut=false）
 *      - 超过 maxDuration 仍未现提示符 → 发 Ctrl+C 熔断
 *        返回（interrupted=false, timedOut=true），标注中性「timed-out」
 *   5. 最小轮询持续时长：取 max(maxDuration, minDelay) 作为实际 deadline，
 *      保证短命令也有时间产出输出（兼容旧 delay 语义）
 *
 * @param input - exec 输入参数
 * @returns 结构化结果，由各通道 handler 格式化为 MCP 响应
 */
export async function runExec(input: ExecInput): Promise<ExecResult> {
  const maxDuration: number = input.maxDuration ?? DEFAULT_MAX_DURATION_MS;
  const pollInterval: number = input.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const clear: number = input.clear ?? 1;
  const minDelay: number = input.delay ?? DEFAULT_MIN_DELAY_MS;
  const stripEcho: boolean = input.stripEcho ?? true;

  // 最小持续时长：maxDuration 不能小于 minDelay，否则短命令可能拿不到输出
  const deadline: number = Math.max(maxDuration, minDelay);

  const startTime: number = Date.now();

  // ── 1. 前置冲刷：丢弃发送前缓冲区可能累积的残留 ──
  const flushed: string = input.shell.drain();
  if (flushed) {
    logger.info(
      `${input.logPrefix} flushed ${flushed.length} bytes before exec`
    );
  }

  // ── 2. 发命令 ──
  input.shell.write(input.command, clear);

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

  // ── 4. 轮询 buffer 检测提示符 ──
  while (Date.now() - startTime < deadline) {
    await sleep(pollInterval);
    accumulated += input.shell.drain();

    if (input.promptDetector.detect(accumulated)) {
      const elapsedMs: number = Date.now() - startTime;
      logger.info(
        `${input.logPrefix} prompt detected, returning after ${elapsedMs}ms`
      );
      return {
        output: accumulated.trim(),
        interrupted: false,
        timedOut: false,
        elapsedMs,
      };
    }
  }

  // ── 5. 超时熔断：发 Ctrl+C + 收集残留 ──
  logger.warn(
    `${input.logPrefix} timed out after ${maxDuration}ms (no prompt), sending Ctrl+C`
  );
  input.sendCtrl("c");
  await sleep(INTERRUPT_SETTLE_MS);
  accumulated += input.shell.drain();

  return {
    output: accumulated.trim(),
    interrupted: false,
    timedOut: true,
    elapsedMs: Date.now() - startTime,
  };
}
