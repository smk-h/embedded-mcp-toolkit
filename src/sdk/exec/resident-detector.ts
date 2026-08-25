/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : resident-detector.ts
 * Author     : sumu
 * Date       : 2026/07/28
 * Version    : x.x.x
 * Description: 常驻命令检测器
 *
 *   判断用户传入的命令字符串是否为「常驻命令」——即永不返回 shell 提示符、
 *   持续输出（如 ping/logcat/top/tail -f）。用于 exec 编排层（exec-runner.ts）
 *   决定超时时长与超时动作：
 *     - 常驻命令：短熔断（采样），到点发送 Ctrl+C 终止（中性语义）
 *     - 普通命令：兜底超时，到点不发送 Ctrl+C（异常语义）
 *
 *   识别策略（spec F1）：
 *     1. 提取命令行首 token（第一个空白/管道/重定向/括号之前的命令名）
 *     2. A 类——首 token 精确匹配内置白名单（ping/logcat/top 等），命中即常驻
 *     3. B 类——首 token 命中特定命令（dmesg/journalctl/tail）且携带 follow 参数
 *        （-f/-F/--follow/-w），才判为常驻
 *     4. 用户配置扩展名单（spec F2）按首 token 精确匹配，与内置 A 类并集
 *
 *   纯函数式，不碰 shell，不产生副作用。
 * ======================================================
 */

/**
 * @brief 常驻检测结论
 *
 * 判定命令是否为常驻命令，附带命中原因（供 exec 编排层写日志，spec N4）。
 */
export type ResidentVerdict =
  | { kind: "resident"; reason: string } // 常驻命令（命中规则名 + 首 token）
  | { kind: "normal"; reason: string }; // 普通命令（首 token 值，供日志）

/**
 * @brief 内置 A 类常驻命令白名单（首 token 精确匹配）
 *
 * 这类命令只要出现在命令行首位即判为常驻——它们默认持续输出、永不返回提示符：
 *   - 网络类：ping、ping6
 *   - 日志类：logcat（Android 系统日志）
 *   - 监控类：top、htop（周期刷新）
 *   - 跟踪类：strace（系统调用跟踪）、tcpdump（抓包）、watch（周期执行）
 *
 * 注：dmesg/journalctl/tail 默认是瞬时命令，仅带 follow 参数时才常驻（见 B 类）。
 */
const BUILTIN_RESIDENT_TOKENS: ReadonlySet<string> = new Set<string>([
  "ping",
  "ping6",
  "logcat",
  "top",
  "htop",
  "strace",
  "tcpdump",
  "watch",
]);

/**
 * @brief 内置 B 类常驻命令的参数模式（首 token + follow flag）
 *
 * 这类命令默认瞬时返回，仅携带持续输出参数时才常驻。每条记录为「命令名 → 检测
 * follow flag 的正则」。正则要求 flag 作为独立 token 出现（前后为空白/等号/串尾），
 * 避免误匹配（如 -f 不应命中 -file）。
 *
 * 正则源码字符串里反斜杠双写（\\s）是 TypeScript 字面量转义要求，与 prompt-detector.ts
 * 中 UbootDefaults 的写法一致。
 */
const BUILTIN_FOLLOW_PATTERNS: Readonly<Record<string, RegExp>> = {
  // dmesg: -w 或 --follow 表示持续输出
  dmesg: /(?:^|\s)(?:-w|--follow)(?=\s|=|$)/,
  // journalctl: -f 或 --follow 表示持续输出
  journalctl: /(?:^|\s)(?:-f|--follow)(?=\s|=|$)/,
  // tail: -f / -F / --follow 表示持续跟踪
  tail: /(?:^|\s)(?:-f|-F|--follow)(?=\s|=|$)/,
};

/**
 * @brief 首 token 分隔符正则
 *
 * 命令名的结束边界：遇到空白、管道 |、分号 ;、重定向 > <、与 &、括号 ( )、反引号 ` 即止。
 * 这样 "echo hi | grep foo" 的首 token 是 echo（遇管道即止），符合 spec F1 定义。
 */
const FIRST_TOKEN_SEPARATOR = /[\s|;>&<()`]/;

/**
 * @brief 提取命令行的首 token（命令名）
 *
 * 按空白/管道/重定向/括号等 shell 元字符分割，取第一段；去除首尾成对引号。
 * 这样只看实际执行的第一个命令名，忽略管道后接的命令与参数（spec F1）。
 *
 * @param command 用户原始命令字符串
 * @returns 首 token；空命令或纯空白返回空串
 */
function extractFirstToken(command: string): string {
  const trimmed: string = command.trim();
  if (trimmed === "") {
    return "";
  }
  // 按分隔符分割取首段
  const first: string | undefined = trimmed.split(FIRST_TOKEN_SEPARATOR)[0];
  const token: string = first ?? "";
  if (token === "") {
    return "";
  }
  // 去除首尾成对的单/双引号（如 "my command" → my command）
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * @brief 判定命令是否为常驻命令
 *
 * 识别优先级（先命中先返回）：
 *   1. 用户配置扩展名单（首 token 精确匹配，reason 标 user-config）
 *   2. 内置 A 类白名单（首 token 精确匹配，reason 标 builtin-set）
 *   3. 内置 B 类参数模式（首 token 命中命令名 + 携带 follow flag，reason 标 builtin-pattern）
 *   4. 均未命中 → 普通命令（reason 标首 token 值）
 *
 * @param command 用户原始命令字符串（如 "tail -f /var/log/x"）
 * @param extraResidentCommands 设备配置追加的常驻命令名（首 token 精确匹配），可选
 * @returns ResidentVerdict，含命中原因供 exec 编排层写日志
 */
export function classifyResident(
  command: string,
  extraResidentCommands?: readonly string[]
): ResidentVerdict {
  const token: string = extractFirstToken(command);
  if (token === "") {
    return { kind: "normal", reason: "empty command" };
  }

  // 1. 用户配置扩展名单（首 token 精确匹配）
  if (extraResidentCommands && extraResidentCommands.includes(token)) {
    return { kind: "resident", reason: `user-config: ${token}` };
  }

  // 2. 内置 A 类白名单（首 token 精确匹配）
  if (BUILTIN_RESIDENT_TOKENS.has(token)) {
    return { kind: "resident", reason: `builtin-set: ${token}` };
  }

  // 3. 内置 B 类参数模式（首 token 命中命令名 + 携带 follow flag）
  const followRe: RegExp | undefined = BUILTIN_FOLLOW_PATTERNS[token];
  if (followRe && followRe.test(command)) {
    return {
      kind: "resident",
      reason: `builtin-pattern: ${token} with follow flag`,
    };
  }

  // 4. 均未命中 → 普通命令
  return { kind: "normal", reason: `first-token: ${token}` };
}
