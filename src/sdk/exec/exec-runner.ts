/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exec-runner.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : x.x.x
 * Description: 交互式 shell exec 的统一编排逻辑
 *
 *   把三个通道（adb/ssh/serial）复制粘贴的 exec 主体逻辑抽到此处统一实现：
 *     前置冲刷 → 发命令 → 轮询 buffer 检测提示符 → 超时熔断发 Ctrl+C
 *
 *   各通道差异（取 shell、取提示符配置）通过 ExecInput 注入，机制保持通道无关。
 *
 *   底层轮询骨架（sleep + drain 累积 + deadline）借鉴 ssh_build 已验证的模式，
 *   结束检测采用两级策略：
 *     - 1级 marker 注入（确定性，首选）：命令尾部拼 echo "MARKER:$?"，
 *       marker 出现即命令结束，附带退出码，不受刷屏影响
 *     - 2级 末尾锚定（快路径）：提示符正则锚定输出末尾，无刷屏设备秒判
 *
 *   marker 包装按环境分两种风格（markerStyle，默认 subshell）：
 *     - subshell：POSIX shell（Linux/Android），(cmd); echo "MARKER:$?"——
 *       子 shell 兜住 exit/exec、尾部 & 等会破坏外层 echo 的命令，
 *       并隔离 fd/PS1 等 shell 状态对长生命周期会话的污染
 *     - plain：U-Boot hush，cmd; echo "MARKER:$?"——hush 无子 shell /
 *       后台任务语法，上述威胁不存在，去括号即可；; 为无条件分隔，
 *       echo 必然执行，1级 marker 检测照常生效（hush 展开 $? 得退出码，
 *       老 simple parser 不展开时按字面量 "$?" 匹配，exitCode 为 null）
 * ======================================================
 */

import type { InteractiveShell } from "../../sdk/transports/interactive-shell.js";
import { logger } from "../../sdk/shared/logger.js";

import { type ControlChar, PromptDetector } from "./prompt-detector.js";
import { classifyResident, type ResidentVerdict } from "./resident-detector.js";

/** @brief 常驻命令采样超时时长（毫秒），到点发 Ctrl+C 终止（中性语义） */
const DEFAULT_SAMPLING_TIMEOUT_MS = 10000;

/** @brief 普通命令兜底超时时长（毫秒），到点不发 Ctrl+C（异常语义，仅安全阀） */
const DEFAULT_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** @brief 轮询间隔（毫秒），内容分析循环的固定节奏 */
const POLL_INTERVAL_MS = 200;

/** @brief 熔断后等待 SIGINT 生效的时长（毫秒） */
const INTERRUPT_SETTLE_MS = 300;

/** @brief PTY 回显剥离最大重试次数（每次等待一个轮询间隔） */
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
 * 匹配 `(?<!")<marker>:(\d+|\$\?)`，捕获退出码：
 *   - \d+  ：POSIX shell / U-Boot hush 展开的真实退出码
 *   - \$\? ：U-Boot 老 simple parser 不做变量展开，原样输出字面量 "$?"
 *            （此时无法得知退出码，调用方按 null 处理）
 *
 * 负向后行断言 (?<!") 排除 PTY 回显行里的字面 marker：注入的命令是
 * `echo "<marker>:$?"`，回显行中 marker 前紧邻双引号；而真实输出的
 * marker 前是行首/换行/其他输出字符。这样即使回显剥离（stripEcho）
 * 失败、回显行残留在 buffer 中，也不会把回显行误判为命令完成。
 * @param marker - 唯一标记字符串
 * @returns 匹配 marker 及退出码的正则
 */
function buildMarkerRegex(marker: string): RegExp {
  return new RegExp(`(?<!")${marker}:(\\d+|\\$\\?)`);
}

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
 * @brief marker 注入的包装风格
 *
 * - subshell：POSIX shell（Linux/Android）用。`(cmd); echo ...` 的子 shell
 *   兜住 exit/logout/exec 这类会杀掉/替换外层 shell 的命令、尾部 &（拼接后
 *   `cmd &; echo` 是语法错误，整行被拒），并隔离 fd 劫持、PS1 修改等
 *   shell 状态污染长生命周期会话
 * - plain：U-Boot hush 用。hush 无子 shell / 后台任务（&）语法，上述威胁
 *   不存在，去括号直接 `cmd; echo ...` 即为同等安全等级的等价写法
 */
export type MarkerStyle = "subshell" | "plain";

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
  /** 缓冲区清空标志（透传给 shell.write） */
  readonly clear?: number;
  /**
   * 最大执行时长（毫秒），覆盖默认超时（spec F6）。
   * 优先级最高，但只覆盖「时长」，超时动作仍按命令常驻性判定（常驻发 Ctrl+C、普通不发）。
   */
  readonly timeoutMs?: number;
  /** 提示符检测器（已根据设备配置初始化） */
  readonly promptDetector: PromptDetector;
  /** 控制字符发送函数（由各通道注入，封装传输层差异） */
  readonly sendCtrl: (key: ControlChar) => void;
  /** 日志前缀，如 "[adb_shell_exec]" */
  readonly logPrefix: string;
  /** 是否剥离 PTY 回显的首行（提示符+命令回显），默认 true */
  readonly stripEcho?: boolean;
  /**
   * marker 包装风格（默认 "subshell"）。
   * U-Boot 等无子 shell 语法的环境传 "plain"：去掉括号直接拼
   * `cmd; echo "MARKER:$?"`，1级 marker 检测照常生效；simple parser
   * 不展开 $? 时按字面量匹配，exitCode 为 null。
   */
  readonly markerStyle?: MarkerStyle;
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
  /**
   * 前置冲刷丢弃的缓冲区残留（发送命令前 drain 的内容）。
   * 不展示给用户，仅供调用方做环境证据回收：两次 exec 之间设备
   * 异步输出（如 reset 后晚到的内核启动日志）会滞留于此，串口
   * U-Boot 自校正据此判定是否已离开 U-Boot（shell.ts）。
   */
  readonly flushed: string;
  /** 命令退出码（marker 检测命中且目标 shell 展开了 $? 时可获取，其他场景为 null） */
  readonly exitCode: number | null;
  /** 是否因异常被中断（保留字段，当前实现恒为 false） */
  readonly interrupted: boolean;
  /**
   * 完成路径：
   *   - marker ：1级 marker 命中（确定性；输出截断于 marker，不含其后的提示符）
   *   - prompt ：2级 提示符末尾锚定命中（输出末尾即提示符）
   *   - timeout：超时熔断（采样/兜底）
   * 调用方可据此区分输出末尾的语义：marker 完成时末尾无提示符，
   * 不能凭输出末尾判断当前所处 shell 环境（如 U-Boot 标记自校正）。
   */
  readonly completedBy: "marker" | "prompt" | "timeout";
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
 *
 * 超时时长选择（spec F6）：
 *   - 调用方传 timeoutMs 时优先级最高（只覆盖时长，动作仍按常驻性）
 *   - 否则：常驻命令用采样时长（默认 10s），普通命令用兜底时长（默认 5min）
 *   - 两者均可被设备配置（execTimeoutConfig）覆盖
 *
 * @param input - exec 输入参数
 * @returns 结构化结果，由各通道 handler 格式化为 MCP 响应
 */
export async function runExec(input: ExecInput): Promise<ExecResult> {
  const clear: number = input.clear ?? 1;
  const stripEcho: boolean = input.stripEcho ?? true;
  const markerStyle: MarkerStyle = input.markerStyle ?? "subshell";

  // ── 0. 常驻分类：据此选超时时长与超时动作（spec F1/F3/F4） ──
  const verdict: ResidentVerdict = classifyResident(
    input.command,
    input.execTimeoutConfig?.residentCommands
  );
  const isResident: boolean = verdict.kind === "resident";
  // 未传 timeoutMs 时的分类默认时长：
  //   - 常驻命令（top/ping/logcat...）永远等不到结束标记，默认时长就是
  //     实际采样窗口，跑满到点发 Ctrl+C，短熔断才有意义（默认 10s）
  //   - 普通命令（ls/printenv...）正常远早于上限就经 marker/提示符返回，
  //     默认时长只是挂死安全阀，宁长勿短兜住 apt/dd 等合法慢命令（5min）
  const defaultTimeout: number = isResident
    ? (input.execTimeoutConfig?.samplingTimeoutMs ??
      DEFAULT_SAMPLING_TIMEOUT_MS)
    : (input.execTimeoutConfig?.fallbackTimeoutMs ??
      DEFAULT_FALLBACK_TIMEOUT_MS);
  // effectiveTimeout 的四种组合（时长与动作是正交维度，spec F6）：
  //   常驻 + 未传 → 10s；常驻 + 传入 → 传入值（"超时"即真实采样时长，
  //     传 30s 就真采 30s 再发 Ctrl+C）
  //   普通 + 未传 → 5min；普通 + 传入 → 传入值（只决定挂死时多快交还
  //     控制权，不影响命令正常跑完的速度）
  // 动作只看常驻性、不随 timeoutMs 变：常驻到点发 Ctrl+C，普通到点不发
  // （防误杀在跑的命令，reboot 传大时长拉长等待正是依赖这一点）
  const effectiveTimeout: number = input.timeoutMs ?? defaultTimeout;
  const deadline: number = effectiveTimeout;
  logger.info(
    `${input.logPrefix} classified: ${verdict.kind} (${verdict.reason}), effectiveTimeout=${effectiveTimeout}ms`
  );

  const startTime: number = Date.now();

  // ── 1. 前置冲刷：丢弃发送前缓冲区可能累积的残留 ──
  const flushed: string = input.shell.drain();
  if (flushed) {
    logger.info(
      `${input.logPrefix} flushed ${flushed.length} bytes before exec`
    );
  }

  // ── 2. 发命令（尾部拼 marker，包装风格按环境二选一） ──
  // ; 为无条件顺序分隔，echo 必然执行，两种风格 marker 都生效：
  //   subshell（POSIX shell）：(cmd); echo "MARKER:$?"
  //     子 shell 兜住 exit/exec、尾部 & 等会破坏外层 echo 的命令，
  //     并隔离 fd/PS1 等 shell 状态对会话的污染
  //   plain（U-Boot hush）：cmd; echo "MARKER:$?"
  //     hush 无子 shell / 后台任务语法，上述威胁不存在，去括号即等价
  const marker: string = generateMarker();
  const markerRegex: RegExp = buildMarkerRegex(marker);
  const fullCommand: string =
    markerStyle === "plain"
      ? `${input.command}; echo "${marker}:$?"`
      : `(${input.command}); echo "${marker}:$?"`;
  logger.info(
    `${input.logPrefix} command (${markerStyle} marker): ${fullCommand}`
  );
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
      await sleep(POLL_INTERVAL_MS);
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

  // ── 4. 轮询 buffer：两级检测 marker > 末尾锚定 ──
  // 两级检测策略（从确定到启发）：
  //   1. marker 命中：确定性检测，命令拼接的 echo "MARKER:$?" 出现即命令结束
  //      —— 不受刷屏影响，附带退出码，首选路径
  //   2. detect() 末尾锚定：无刷屏设备秒判
  //
  // 已移除原 3级 detectInLines() 行级扫描：marker 为子串匹配天然免疫刷屏，
  // 已完全覆盖其职责；对常驻命令（marker 永不出现）行级扫描反而可能提前截断
  // 采样输出，成为误判源。故只保留 marker + 末尾锚定两级，配合超时熔断兜底。
  while (Date.now() - startTime < deadline) {
    await sleep(POLL_INTERVAL_MS);
    accumulated += input.shell.drain();

    // ── 1级：marker 检测（确定性，首选） ──
    const markerMatch: RegExpMatchArray | null = accumulated.match(markerRegex);
    if (markerMatch) {
      // hush/POSIX shell 展开为数字；simple parser 原样输出字面量 "$?"（退出码未知）
      const rawExit: string = markerMatch[1];
      const exitCode: number | null =
        rawExit === "$?" ? null : parseInt(rawExit, 10);
      const elapsedMs: number = Date.now() - startTime;
      // 截断 marker 及其后的内容，只返回命令输出（marker 行本身也去掉）。
      // 用正则命中位置截断（而非 indexOf(marker)）：正则的 (?<!") 已排除
      // 回显行里的字面 marker，命中位置必是真实输出中的 marker
      const cleanOutput = accumulated
        .substring(0, markerMatch.index ?? 0)
        .trimEnd();
      logger.info(
        `${input.logPrefix} marker detected${exitCode === null ? " (literal $?, exit code unknown)" : `, exitCode=${exitCode}`}, returning after ${elapsedMs}ms`
      );
      return {
        output: cleanOutput,
        flushed,
        exitCode,
        interrupted: false,
        timeoutKind: "none",
        completedBy: "marker",
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
        flushed,
        exitCode: null,
        interrupted: false,
        timeoutKind: "none",
        completedBy: "prompt",
        timedOut: false,
        elapsedMs,
      };
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
      flushed,
      exitCode: null,
      interrupted: false,
      timeoutKind: "sampling",
      completedBy: "timeout",
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
    flushed,
    exitCode: null,
    interrupted: false,
    timeoutKind: "fallback",
    completedBy: "timeout",
    timedOut: true,
    elapsedMs: Date.now() - startTime,
  };
}
