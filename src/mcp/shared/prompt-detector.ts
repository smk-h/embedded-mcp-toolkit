/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : prompt-detector.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : 1.0.0
 * Description: Shell 状态/提示符检测器与控制字符映射
 *
 *   提供以下共享能力，供三个通道（adb/ssh/serial）的 exec 编排与
 *   serial_enter_uboot 工具复用：
 *     1. ControlChar / CONTROL_CHAR_MAP
 *        —— 控制字符类型与字节映射（Ctrl+C/U/D/Z），供 send_ctrl 工具使用
 *     2. PromptDetector
 *        —— 判断累积输出是否已出现 shell 提示符（命令结束信号），
 *           支持默认正则 + 设备配置覆盖，用于 exec 的命令结束判定
 *     3. UbootDetector
 *        —— U-Boot 状态四件套检测（autoboot 提示 / 命令提示符 /
 *           环境变量键 / 内核启动特征），供 serial_enter_uboot 编排；
 *           配置值直接 new RegExp(source, flags) 构造，不做预处理
 * ======================================================
 */

import type { UbootYaml } from "../../shared/config.js";

/**
 * @brief 支持的控制字符类型
 *
 * 对应终端常用控制字符：
 *   - c : Ctrl+C（\x03）→ SIGINT，中断当前命令
 *   - u : Ctrl+U（\x15）→ 清除当前输入行
 *   - d : Ctrl+D（\x04）→ EOF，结束输入
 *   - z : Ctrl+Z（\x1a）→ SIGTSTP，挂起当前命令
 */
export type ControlChar = "c" | "u" | "d" | "z";

/**
 * @brief 控制字符到字节字符串的映射
 *
 * send_ctrl 工具与 exec 熔断逻辑通过此映射查表得到待发送的字节，
 * 避免散落的字面量。值采用 Readonly 防止运行期被篡改。
 */
export const CONTROL_CHAR_MAP: Readonly<Record<ControlChar, string>> = {
  c: "\x03", // Ctrl+C → SIGINT
  u: "\x15", // Ctrl+U → 清行
  d: "\x04", // Ctrl+D → EOF
  z: "\x1a", // Ctrl+Z → 挂起
};

/**
 * @brief shell 提示符检测器
 *
 * 判断一段累积输出是否已出现 shell 提示符（命令结束信号）。
 * 支持默认提示符集与设备配置覆盖：
 *   - 未传 customPattern：使用 DEFAULT_PATTERN，覆盖 Android / Linux / U-Boot 常见 prompt
 *   - 传 customPattern：按设备配置的正则识别（应对自定义 PS1）
 *
 * 仅检测「输出末尾」是否以提示符结尾，避免命令输出中间偶然出现的 # / $ 被误判。
 */
export class PromptDetector {
  /**
   * @brief 默认提示符正则
   *
   * 锚定输出末尾（$），匹配以下结尾的提示符：
   *   - Android :  / $  、  :/ $  、  :/ #
   *   - Linux   :  $  、  #  、  >
   *   - U-Boot  :  =>  、  U-Boot>
   *
   * 不追求覆盖所有自定义 PS1，未命中时由 exec 的 maxDuration 熔断兜底
   * （见 spec.md「不做的事」第 5 条）。
   */
  static readonly DEFAULT_PATTERN =
    /(?:[^\r\n]*[:/]?\s*[/~]\s*[#$]\s*|[^\r\n]*[#>$]\s*|[^\r\n]*=>\s*)$/;

  /** @brief 实际使用的提示符正则（默认或配置覆盖） */
  private readonly pattern: RegExp;

  /**
   * @brief 构造提示符检测器
   * @param customPattern - 可选的自定义提示符正则字符串，来自设备配置 promptPattern
   */
  constructor(customPattern?: string) {
    // 配置覆盖优先；未配置时用默认正则
    this.pattern = customPattern
      ? new RegExp(customPattern)
      : PromptDetector.DEFAULT_PATTERN;
  }

  /**
   * @brief 检测累积输出是否以提示符结尾
   *
   * PTY 回显的命令行本身不以提示符结尾，只有命令执行完返回到交互态时
   * 才会出现提示符。因此检测「输出末尾」即可判定命令是否结束。
   *
   * @param accumulated - 当前累积的全部输出
   * @returns true 表示已检测到提示符，命令结束
   */
  detect(accumulated: string): boolean {
    return this.pattern.test(accumulated);
  }
}

/**
 * @brief U-Boot 检测默认值
 *
 * 未配置 serial.uboot 时，UbootDetector 回退到这些默认值。
 * 保持与改动前硬编码实现完全等价的行为（spec F4 / AC1）：
 *   - 所有字段值都是 JavaScript 正则源码字符串，由 new RegExp(source, flags) 构造
 *   - prompt 等价原 /(?:=>|U-Boot>)\s*$/（无 i 标志，=> 和 U-Boot> 是固定大小写）
 *   - autobootPrompts 等价原 AUTOBOOT_*_RE（构造时带 i 标志）
 *   - 数组顺序遵循"先 Ctrl+u 再 any key"——数组顺序即优先级
 *
 * 正则字符串里反斜杠双写（\\s、\\+）是 TypeScript 源码字面量的转义要求，
 * 与用户在 YAML 配置里的写法一致（详见 docs/regex-guide.md）。
 */
const UbootDefaults = {
  autobootPrompts: [
    "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot", // Ctrl+u 优先（发 \x15）
    "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot", // 次之（发换行）
  ],
  prompt: "(?:=>|U-Boot>)\\s*$", // 等价原硬编码 UBOOT_PROMPT_RE
  verifyEnvKeys: ["baudrate", "bootdelay"],
  verifyTimeoutMs: 4000,
  kernelBootPattern: "Starting\\s+kernel|Linux\\s+version",
} as const;

/**
 * @brief U-Boot 状态检测器
 *
 * 持有从配置解析来的四类正则与验证键，提供四个 match 方法：
 *   - matchAutoboot   识别 autoboot 提示，返回对应中断键（"\n" 或 "\x15"）
 *   - matchPrompt     识别命令提示符（默认锚输出末尾）
 *   - matchVerifyKey  识别 printenv 输出里的环境变量键（字面量匹配 key=）
 *   - matchKernelBoot 识别内核启动特征（用于即判失败）
 *
 * 不直接操作串口，仅做匹配；由 serial_enter_uboot handler 编排时序。
 *
 * 配置值直接用 new RegExp(source, flags) 构造，不做任何预处理——
 * 所见即所得，正则行为完全可预测（spec F2 / AC4）。
 *
 * flags 约定（与原硬编码完全一致）：
 *   - autoboot / kernelBoot 带 "i"（文案可能大小写不一）
 *   - prompt 无 flags（=> 和 U-Boot> 固定大小写）
 *
 * 中断键选择规则：遍历 autobootPrompts 数组，命中含 "Ctrl+u" 字样
 * （大小写不敏感）的条目返回 \x15，其余返回换行。数组顺序即优先级。
 */
export class UbootDetector {
  /** @brief autoboot 正则与对应中断键的映射，按配置数组顺序 */
  private readonly autobootEntries: ReadonlyArray<{
    re: RegExp;
    interruptKey: "\n" | "\x15";
  }>;

  /** @brief 命令提示符正则 */
  private readonly promptRe: RegExp;

  /** @brief 事后验证的环境变量键名（小写，用于大小写不敏感匹配） */
  private readonly verifyKeys: readonly string[];

  /** @brief 内核启动特征正则 */
  private readonly kernelBootRe: RegExp;

  /** @brief 验证层超时窗口（毫秒） */
  public readonly verifyTimeoutMs: number;

  /**
   * @brief 构造 U-Boot 状态检测器
   *
   * 三字段与默认值**合并**（非替换，spec F4）：
   *   - autobootPrompts：默认在前 + 用户在后（默认优先级更高）
   *   - verifyEnvKeys：默认 ∪ 用户（去重）
   *   - prompt：联合正则（剥离尾部 \s*$ 后 (?:A|B) 合并）
   *
   * 用户 config 为 undefined 或字段为空时，合并结果等同默认值本身（AC1 兼容）。
   *
   * @param config 设备配置的 uboot 子段
   * @throws {Error} 当配置字段是无效正则（如括号不闭合）时，由 new RegExp 抛出
   */
  constructor(config?: UbootYaml) {
    // autobootPrompts：默认在前（优先级高），用户追加在后（补充识别），按字面去重保持顺序
    const userAutoboot = config?.autobootPrompts ?? [];
    const mergedAutoboot = dedupPreserveOrder([
      ...UbootDefaults.autobootPrompts,
      ...userAutoboot,
    ]);
    this.autobootEntries = mergedAutoboot.map((s) => ({
      // autoboot 文案可能大小写不一，带 i 标志（与原 AUTOBOOT_*_RE 一致）
      re: new RegExp(s, "i"),
      // 含 "Ctrl+u" 字样的条目对应发 \x15，其余发换行（与原硬编码逻辑等价）
      // 注意 s 是正则源码字符串，"+" 会被用户转义成 "\+"，故匹配时兼容两种写法
      interruptKey: /ctrl\\?\+u/i.test(s) ? "\x15" : "\n",
    }));

    // prompt：用户值与默认字面相等则跳过合并（避免 (?:A|A) 冗余）；否则联合
    // 仅判断字面相等（不判断正则语义等价），覆盖"用户照抄默认值"的常见场景
    const userPrompt = config?.prompt;
    const mergedPrompt =
      userPrompt && userPrompt !== UbootDefaults.prompt
        ? UbootDetector.mergePromptPattern(UbootDefaults.prompt, userPrompt)
        : UbootDefaults.prompt;
    this.promptRe = new RegExp(mergedPrompt);

    // verifyEnvKeys：默认 ∪ 用户，去重，全部小写化用于大小写不敏感匹配
    const userVerify = config?.verifyEnvKeys ?? [];
    const mergedVerify = Array.from(
      new Set([...UbootDefaults.verifyEnvKeys, ...userVerify])
    );
    this.verifyKeys = mergedVerify.map((k) => k.toLowerCase());

    // 内核日志可能大小写不一，带 i 标志（不参与合并，用户无法配置）
    this.kernelBootRe = new RegExp(UbootDefaults.kernelBootPattern, "i");
    this.verifyTimeoutMs = UbootDefaults.verifyTimeoutMs;
  }

  /**
   * @brief 合并默认 prompt 正则与用户 prompt 正则
   *
   * 策略（保守，避免边界 case）：
   *   1. 用 /\s*\$$/ 剥离两者的尾部 \s*$，得到核心部分
   *   2. 剥离成功 → 联合为 (?:(?:<默认核心>)|(?:<用户核心>))\s*$
   *   3. 剥离失败（用户正则末尾无 \s*$）→ 退化为 (?:(?:<默认>)|(?:<用户>))，各自保留原锚
   *
   * 默认值末尾总有 \s*$（UbootDefaults.prompt 保证），故分支 2 是常态；
   * 分支 3 仅在用户写非常规正则时触发。
   *
   * @param defaultPattern 默认 prompt 正则源码
   * @param userPattern 用户配置的 prompt 正则源码
   * @returns 合并后的正则源码
   */
  private static mergePromptPattern(
    defaultPattern: string,
    userPattern: string
  ): string {
    const trailingAnchor = /\s*\$$/;
    const defaultCore = defaultPattern.replace(trailingAnchor, "");
    const userCore = userPattern.replace(trailingAnchor, "");
    const defaultStripped = defaultCore !== defaultPattern;
    const userStripped = userCore !== userPattern;

    if (defaultStripped && userStripped) {
      // 两者都能剥离尾部锚 → 联合核心后统一加 \s*$
      return `(?:(?:${defaultCore})|(?:${userCore}))\\s*$`;
    }
    // 任一无法剥离 → 简单联合，各自保留原样（最坏退化为 | 拼接）
    return `(?:(?:${defaultPattern})|(?:${userPattern}))`;
  }

  /**
   * @brief 匹配 autoboot 提示
   * @param output 累积的串口输出
   * @returns 命中的中断键（"\n" 或 "\x15"），未命中返回 null
   */
  public matchAutoboot(output: string): "\n" | "\x15" | null {
    for (const entry of this.autobootEntries) {
      if (entry.re.test(output)) {
        return entry.interruptKey;
      }
    }
    return null;
  }

  /**
   * @brief 匹配命令提示符（输出末尾）
   * @param output 累积的串口输出
   * @returns 命中返回 true
   */
  public matchPrompt(output: string): boolean {
    return this.promptRe.test(output);
  }

  /**
   * @brief 匹配事后验证的环境变量键
   *
   * printenv 输出形如 "baudrate=115200\nbootdelay=3"，用字面量 key= 匹配，
   * 不走正则——键名是固定标识符，正则转换无收益反增错。
   *
   * @param output printenv 命令的输出
   * @returns 任一验证键命中返回 true
   */
  public matchVerifyKey(output: string): boolean {
    const lower = output.toLowerCase();
    return this.verifyKeys.some((k) => lower.includes(`${k}=`));
  }

  /**
   * @brief 匹配内核启动特征（用于即判失败）
   *
   * 主层与验证层都应检查：设备可能在中断失败后越过 uboot 进入 kernel，
   * 命中即立即返回失败，不等超时。
   *
   * @param output 累积的串口输出
   * @returns 命中内核启动特征返回 true
   */
  public matchKernelBoot(output: string): boolean {
    return this.kernelBootRe.test(output);
  }

  /**
   * @brief 导出内部状态用于调试（CLI 自测、日志排查）
   *
   * 返回合并默认值后实际生效的正则源码与配置项的只读快照，
   * 供 regex-verify 命令的 -v 模式展示，让用户看到"我的配置 + 默认值
   * 合并后最终构造出的正则长什么样"。
   *
   * 注意：返回的是字符串快照（new RegExp 的 source），不是 RegExp 实例，
   * 避免外部修改内部状态。flags 信息（如 i）单独标注。
   *
   * @returns 调试状态对象
   */
  public getDebugState(): {
    autobootPatterns: ReadonlyArray<{
      source: string;
      flags: string;
      interruptKey: "\n" | "\x15";
    }>;
    prompt: { source: string; flags: string };
    verifyKeys: readonly string[];
    kernelBoot: { source: string; flags: string };
    verifyTimeoutMs: number;
  } {
    return {
      autobootPatterns: this.autobootEntries.map((e) => ({
        source: e.re.source,
        flags: e.re.flags,
        interruptKey: e.interruptKey,
      })),
      prompt: {
        source: this.promptRe.source,
        flags: this.promptRe.flags,
      },
      verifyKeys: this.verifyKeys,
      kernelBoot: {
        source: this.kernelBootRe.source,
        flags: this.kernelBootRe.flags,
      },
      verifyTimeoutMs: this.verifyTimeoutMs,
    };
  }
}

/**
 * @brief 数组去重，保持首次出现顺序
 *
 * 用于 autobootPrompts 合并时去重——用户配置与默认值字面相同时只保留一份
 * （默认在前，优先级更高）。注意仅做字面相等判断，不做正则语义等价判断。
 *
 * @param arr 输入数组
 * @returns 去重后的新数组（保持首次出现顺序）
 */
function dedupPreserveOrder<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}
