/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : prompt-detector.ts
 * Author     : sumu
 * Date       : 2026/07/17
 * Version    : x.x.x
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

import type { UbootYaml } from "../../sdk/shared/config.js";

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
 * 提供一种检测模式：
 *   - detect()：仅检测「输出末尾」是否以提示符结尾（快路径，适合无刷屏设备）
 *
 * 注：曾提供 detectInLines() 行级扫描用于刷屏设备兜底，但 marker 注入为子串匹配、
 * 天然免疫刷屏已完全覆盖其职责，且行级扫描对常驻命令可能提前截断采样输出成为误判源，
 * 故已移除。刷屏设备场景由 marker（1级）直接命中，无需行级扫描。
 */
export class PromptDetector {
  /**
   * @brief 默认提示符正则（末尾锚定）
   *
   * 锚定输出末尾（$），匹配以下结尾的提示符：
   *   - Android :  / $  、  :/ $  、  :/ #
   *   - Linux   :  $  、  #  、  >
   *   - U-Boot  :  =>  、  U-Boot>
   *
   * 行尾 # 分支带否定后顾 (?<!#)：断言"行尾这个 # 的前一个字符不能
   * 是 #"。断言只检查、不消费字符，纯粹是个条件闸门——排除且仅排除
   * "# 前面还是 #"这一种情况：
   *   - root@board:~#  → 行尾 # 前是空格，断言通过，命中（真提示符）
   *   - / #            → 同上，命中（裸 # 提示符）
   *   - Loading: ##### → 行尾 # 前还是 #，断言失败，不命中（进度条刷屏）
   *   - Loading: #     → # 前是空格，断言通过，命中（已知残留边界，
   *                      瞬时帧窗口极短，由 1级 marker 与 U-Boot 受限
   *                      检测器 createUbootPromptDetector 兜底）
   *
   * 为何用 (?<!#) 而非 [^#]#：后者要求 # 前必须存在一个字符，整行仅
   * 一个 # 的极简提示符（行首即 #）会失配；(?<!#) 只加条件不加要求，
   * 原可匹配的用例一个不少。
   *
   * 背景：真实提示符的 # 前不会是 #，而 U-Boot TFTP/升级类命令用连续
   * # 刷进度条，不排除会把进度帧误判为 root 提示符导致 exec 提前返回
   * （2026-08-27 实测：alg 升级真实执行 42s，406ms 即被截胡）。
   *
   * 不追求覆盖所有自定义 PS1，未命中时由 exec 的 timeoutMs 熔断兜底
   * （见 spec.md「不做的事」第 5 条）。
   */
  static readonly DEFAULT_PATTERN =
    /(?:[^\r\n]*[:/]?\s*[/~]\s*[#$]\s*|[^\r\n]*(?<!#)#\s*|[^\r\n]*[$>]\s*|[^\r\n]*=>\s*)$/;

  /** @brief 实际使用的提示符正则（末尾锚定，默认或配置覆盖） */
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
   * @brief 检测累积输出是否以提示符结尾（快路径）
   *
   * PTY 回显的命令行本身不以提示符结尾，只有命令执行完返回到交互态时
   * 才会出现提示符。因此检测「输出末尾」即可判定命令是否结束。
   *
   * 注：对刷屏设备（后台持续向 console 输出日志）此方法可能失效——提示符
   * 出现后被后续日志行从末尾挤走，$ 锚定失配。此类场景由 runExec 的 1级
   * marker 注入兜底（marker 为子串匹配，天然免疫刷屏）。
   *
   * @param accumulated - 当前累积的全部输出
   * @returns true 表示已检测到提示符，命令结束
   */
  detect(accumulated: string): boolean {
    return this.pattern.test(accumulated);
  }
}

/**
 * @brief autoboot 中断键类型
 *
 * matchAutoboot 命中后应发送的按键，分两层决定（命中行文本优先，见
 * UbootDetector 类注释「中断键选择规则」）：
 *   - "\n"  ：通用措辞且行内无按键提示（换行是最通用的打断键）
 *   - "\x15"：Ctrl+u 字样（命中行或正则源码）
 *   - "\x03"：Ctrl+c 字样（命中行或正则源码）
 *   - " "   ：SPACE 字样（空格是这类提示的指定打断键）
 */
export type UbootInterruptKey = "\n" | "\x15" | "\x03" | " ";

/**
 * @brief U-Boot 检测默认值
 *
 * 未配置 serial.uboot 时，UbootDetector 回退到这些默认值（spec F4 / AC1）：
 *   - 所有字段值都是 JavaScript 正则源码字符串，由 new RegExp(source, flags) 构造
 *   - prompt 等价 /(?:=>|U-Boot>)\s*$/（无 i 标志，=> 和 U-Boot> 是固定大小写）
 *   - autobootPrompts 构造时带 i 标志，数组顺序即优先级
 *
 * autobootPrompts 覆盖主流 U-Boot 的四类措辞（2026-08-31 扩充：此前只认
 * "Hit ... to stop autoboot" 两种，Press/interrupt/abort/SPACE/Ctrl+c 等
 * 厂商变体全部落空，enter_uboot 只能烧满总超时才失败）：
 *   - 动词兼容 stop/interrupt/abort，句首兼容 Hit/Press
 *   - Ctrl+u 优先（发 \x15），其余按 Ctrl+c（\x03）/ SPACE（空格）/ 换行
 *
 * 正则字符串里反斜杠双写（\\s、\\+）是 TypeScript 源码字面量的转义要求，
 * 与用户在 YAML 配置里的写法一致（详见 docs/regex-guide.md）。
 */
const UbootDefaults = {
  autobootPrompts: [
    "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot", // Ctrl+u 优先（发 \x15）
    "(?:Hit|Press)\\s+Ctrl\\+c\\s+to\\s+(?:stop|interrupt|abort)\\s+autoboot", // 发 \x03
    "(?:Hit|Press)\\s+(?:any\\s+key|a\\s+key|key)\\s+to\\s+(?:stop|interrupt|abort)\\s+autoboot", // 发换行
    "(?:Hit|Press)\\s+SPACE\\s+to\\s+(?:stop|interrupt|abort)\\s+autoboot", // 发空格
  ],
  prompt: "(?:=>|U-Boot>)\\s*$", // 等价原硬编码 UBOOT_PROMPT_RE
  verifyEnvKeys: ["baudrate", "bootdelay"],
  verifyTimeoutMs: 4000,
  kernelBootPattern: "Starting\\s+kernel|Linux\\s+version",
} as const;

/**
 * @brief autoboot 命中行的按键提示字样 → 中断键（优先级自上而下）
 *
 * 行内提示扫描表：厂商常把指定按键附在通用文案里（正则命中的部分可能
 * 不含按键），命中行出现这些字样时优先发对应控制键。优先级沿用静态
 * 映射的约定：Ctrl+u → Ctrl+c → SPACE；分隔符兼容 + 和 -
 * （CTRL+C / CTRL-C 都有厂商在用）。
 */
const AUTOBOOT_KEY_HINTS: ReadonlyArray<{
  re: RegExp;
  key: UbootInterruptKey;
}> = [
  { re: /ctrl\s*[-+]\s*u/i, key: "\x15" },
  { re: /ctrl\s*[-+]\s*c/i, key: "\x03" },
  { re: /\bspace\b/i, key: " " },
];

/**
 * @brief 依 autoboot 命中行文本决定中断键，行内无提示字样时回退静态映射
 *
 * 只扫命中所在行（以命中起点定位行边界），不扫全量输出——累积缓冲里
 * 历史日志的巧合字样不应影响本次选键。倒计时数字与提示同行
 * （如 ":  2  1  0"），不含提示字样，无干扰。
 *
 * @param output 累积的串口输出
 * @param matchIndex autoboot 正则命中的起始下标
 * @param fallback 命中条目构造期按正则源码选定的静态中断键
 * @returns 本次应发送的中断键
 */
function resolveAutobootKey(
  output: string,
  matchIndex: number,
  fallback: UbootInterruptKey
): UbootInterruptKey {
  const lineStart = output.lastIndexOf("\n", matchIndex) + 1;
  const lineEnd = output.indexOf("\n", matchIndex);
  const line =
    lineEnd === -1 ? output.slice(lineStart) : output.slice(lineStart, lineEnd);
  for (const hint of AUTOBOOT_KEY_HINTS) {
    if (hint.re.test(line)) return hint.key;
  }
  return fallback;
}

/**
 * @brief U-Boot 状态检测器
 *
 * 持有从配置解析来的四类正则与验证键，提供四个 match 方法：
 *   - matchAutoboot   识别 autoboot 提示，返回对应中断键（"\n" / "\x15" / "\x03" / " "）
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
 * 中断键选择规则（两层，命中行文本优先，2026-09-03 起）：
 *   1. 行内提示：取正则命中所在整行，行内出现 Ctrl+u / Ctrl+c / SPACE
 *      字样（大小写不敏感，分隔符兼容 + 和 -）时优先发对应控制键——
 *      厂商常把指定按键写成括号后缀（Rockchip
 *      "Hit key to stop autoboot('CTRL+C')"），正则命中的通用措辞本身
 *      不含按键，只看正则源码会错发换行（LubanCat-2 实测踩坑）。
 *   2. 静态回退：行内无提示字样时，按条目正则源码字样选键（含 Ctrl+c
 *      字样返回 \x03，含 Ctrl+u 返回 \x15，含 SPACE 返回空格，其余换行）。
 * 数组顺序即正则匹配优先级。
 */
export class UbootDetector {
  /** @brief autoboot 正则与对应中断键的映射，按配置数组顺序 */
  private readonly autobootEntries: ReadonlyArray<{
    re: RegExp;
    interruptKey: UbootInterruptKey;
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
   *   - autobootPrompts：用户在前 + 默认在后（用户优先级更高，2026-09-03 起；
   *     此前默认在前，用户更精确的规则会被通用默认规则抢先而永不命中）
   *   - verifyEnvKeys：默认 ∪ 用户（去重）
   *   - prompt：联合正则（剥离尾部 \s*$ 后 (?:A|B) 合并）
   *
   * 用户 config 为 undefined 或字段为空时，合并结果等同默认值本身（AC1 兼容）。
   *
   * @param config 设备配置的 uboot 子段
   * @throws {Error} 当配置字段是无效正则（如括号不闭合）时，由 new RegExp 抛出
   */
  constructor(config?: UbootYaml) {
    // autobootPrompts：用户在前（优先级高），默认在后（兜底识别），按字面
    // 去重保持顺序——用户与默认字面重复时保留用户的（在前），删默认的（在后）
    const userAutoboot = config?.autobootPrompts ?? [];
    const mergedAutoboot = dedupPreserveOrder([
      ...userAutoboot,
      ...UbootDefaults.autobootPrompts,
    ]);
    this.autobootEntries = mergedAutoboot.map((s) => ({
      // autoboot 文案可能大小写不一，带 i 标志（与原 AUTOBOOT_*_RE 一致）
      re: new RegExp(s, "i"),
      // 静态回退键：行内无按键提示字样时使用。含 "Ctrl+c" 字样的条目发
      // \x03，含 "Ctrl+u" 的发 \x15，含 "SPACE" 的发空格，其余发换行
      // （注意 s 是正则源码字符串，"+" 会被用户转义成 "\+"，故匹配时
      // 兼容两种写法；命中行文本的优先级更高，见 resolveAutobootKey）
      interruptKey: /ctrl\\?\+c/i.test(s)
        ? "\x03"
        : /ctrl\\?\+u/i.test(s)
          ? "\x15"
          : /\bspace\b/i.test(s)
            ? " "
            : "\n",
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
   * @brief 匹配 autoboot 提示，返回命中的正则源码与对应中断键
   *
   * 中断键两层决定（命中行文本优先）：
   *   1. 正则命中所在行出现 Ctrl+u / Ctrl+c / SPACE 字样时发对应控制键
   *      ——覆盖 Rockchip "Hit key to stop autoboot('CTRL+C')" 这类
   *      按键藏在括号后缀里的厂商文案；
   *   2. 行内无提示字样时回退条目静态映射（构造期按正则源码字样选定）。
   *
   * 业务日志/响应需要标注"最终是哪一条 autoboot prompt 命中"，故连同
   * 正则源码一起返回；matchAutoboot 是只取中断键的快捷方式。
   *
   * @param output 累积的串口输出
   * @returns 命中条目（正则源码 + 中断键），未命中返回 null
   */
  public matchedAutoboot(
    output: string
  ): { source: string; interruptKey: UbootInterruptKey } | null {
    for (const entry of this.autobootEntries) {
      const m = entry.re.exec(output);
      if (m) {
        return {
          source: entry.re.source,
          interruptKey: resolveAutobootKey(output, m.index, entry.interruptKey),
        };
      }
    }
    return null;
  }

  /**
   * @brief 匹配 autoboot 提示
   * @param output 累积的串口输出
   * @returns 命中的中断键（"\n" / "\x15" / "\x03" / " "），未命中返回 null
   */
  public matchAutoboot(output: string): UbootInterruptKey | null {
    return this.matchedAutoboot(output)?.interruptKey ?? null;
  }

  /**
   * @brief 匹配命令提示符（输出末尾），命中时返回实际生效的正则源码
   *
   * 单一事实源：promptRe 是"默认 ∪ 用户配置"合并后的联合正则，业务
   * 侧可借此看到"命中的到底是哪个（合并后的）模式"。
   *
   * @param output 累积的串口输出
   * @returns 命中返回正则源码，未命中返回 null
   */
  public matchedPrompt(output: string): string | null {
    return this.promptRe.test(output) ? this.promptRe.source : null;
  }

  /**
   * @brief 匹配命令提示符（输出末尾）
   * @param output 累积的串口输出
   * @returns 命中返回 true
   */
  public matchPrompt(output: string): boolean {
    return this.matchedPrompt(output) !== null;
  }

  /**
   * @brief 匹配事后验证的环境变量键，返回命中的键名列表
   *
   * printenv 输出形如 "baudrate=115200\nbootdelay=3"，用字面量 key= 匹配，
   * 不走正则——键名是固定标识符，正则转换无收益反增错。
   *
   * @param output printenv 命令的输出
   * @returns 命中的键名数组（保持 verifyKeys 的配置顺序）
   */
  public matchedVerifyKeys(output: string): string[] {
    const lower = output.toLowerCase();
    return this.verifyKeys.filter((k) => lower.includes(`${k}=`));
  }

  /**
   * @brief 匹配事后验证的环境变量键
   * @param output printenv 命令的输出
   * @returns 任一验证键命中返回 true
   */
  public matchVerifyKey(output: string): boolean {
    return this.matchedVerifyKeys(output).length > 0;
  }

  /**
   * @brief 统计 printenv 输出命中的验证键个数
   *
   * 供 serial_uboot_state detect 的主动探测层使用：单键命中可能是 Linux
   * 侧环境变量的巧合（如调试脚本 export 过 baudrate），≥2 键才足以支撑
   * "停在 U-Boot"的结论。serial_enter_uboot 验证层仍用 matchVerifyKey
   * 单键判定——刚重启后的输出不存在 Linux 环境变量，误撞面不同。
   *
   * @param output printenv 命令的输出
   * @returns 命中的验证键个数
   */
  public countVerifyKeys(output: string): number {
    return this.matchedVerifyKeys(output).length;
  }

  /**
   * @brief 匹配内核启动特征（用于即判失败），命中时返回实际生效的正则源码
   *
   * 主层与验证层都应检查：设备可能在中断失败后越过 uboot 进入 kernel，
   * 命中即立即返回失败，不等超时。
   *
   * @param output 累积的串口输出
   * @returns 命中返回正则源码，未命中返回 null
   */
  public matchedKernelBoot(output: string): string | null {
    return this.kernelBootRe.test(output) ? this.kernelBootRe.source : null;
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
    return this.matchedKernelBoot(output) !== null;
  }

  /**
   * @brief 导出合并后的 U-Boot 提示符正则源码
   *
   * 供 createUbootPromptDetector 构造 U-Boot 会话专用的受限检测器。
   * 返回字符串快照（new RegExp 的 source），不是 RegExp 实例，
   * 外部无法借此修改内部状态。
   *
   * @returns 合并（默认 ∪ 用户配置）后的 prompt 正则源码
   */
  public getPromptSource(): string {
    return this.promptRe.source;
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
      interruptKey: UbootInterruptKey;
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
 * @brief 构造 U-Boot 会话专用的受限提示符检测器
 *
 * U-Boot 会话（serial_enter_uboot 标记）的 exec 2级快路径只认 U-Boot
 * 提示符集（默认 =>/U-Boot> 与用户配置合并），而非通用默认正则：
 * TFTP/升级类命令用连续 # 刷进度条，通用正则"行尾 #"分支会把进度帧
 * 误判为 Linux root 提示符导致提前返回。U-Boot 会话 plain 包装必有
 * marker，命令真结束由 1级 marker 确定性判定；boot/bootm 离开 U-Boot
 * 后 plain marker 在 Linux sh 下照常展开，环境切换由内核启动特征驱动
 * 自校正（serial_exec），无需通用提示符参与。
 *
 * @param config 设备配置的 uboot 子段（可选）
 * @returns 只识别 U-Boot 提示符的 PromptDetector
 * @throws {Error} 配置含非法正则时由 new RegExp 抛出（调用方应捕获并降级）
 */
export function createUbootPromptDetector(config?: UbootYaml): PromptDetector {
  return new PromptDetector(new UbootDetector(config).getPromptSource());
}

/**
 * @brief 数组去重，保持首次出现顺序
 *
 * 用于 autobootPrompts 合并时去重——用户配置与默认值字面相同时只保留一份
 * （用户在前，优先级更高）。注意仅做字面相等判断，不做正则语义等价判断。
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
