/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh-bridge.ts
 * Author     : sumu
 * Date       : 2026/09/18
 * Version    : x.x.x
 * Description: 远端 MCP 桥接的 ssh 保活参数（单一事实来源）
 * ======================================================
 */

/* ⚠️ 改值前先看这张清单 —— 本文件是保活值的唯一【代码】来源，
 * 但并非所有落点都能自动跟着改，分两类，动手时两类都要过一遍：
 *
 * 【一】自动跟随（改本文件即生效，无需另外动）
 *   1. remote-mcp-config 的全部客户端落点（buildBridgeServer → buildSshBridgeArgs）
 *   2. sshd-config 菜单 [8] 生成的 Linux 端模板（buildSshBridgeArgs）
 *   3. cnb 容器侧 MCP 配置的 args（steps/mcp-config.ts → buildSshBridgeArgs）
 *   4. cnb 写入容器 ~/.ssh/config 的隧道段（steps/push-key.ts → sshKeepaliveConfigLines）
 *
 * 【二】只能手工同步（落点是 JSON/YAML/Markdown 字面量，无法引用常量）
 *   5. .mcp.json                      本项目自身生效配置，同时是 init 的模板源
 *   6. .opencode/opencode.json        同上（opencode 用 command 数组形态）
 *   7. src/cli/commands/init-templates.ts
 *      ⚠️ 不要手改！它由 scripts/gen-init-templates.mjs 从上面两个 JSON 逐行生成。
 *         改完 5/6 后执行 `npm run gen:init-templates` 重新生成即可。
 *   8. .claude/skills/setup-file-utils-remote/SKILL.md
 *      共 4 处：校验表 1 处 + Claude/zcode/opencode 三种客户端示例各 1 处
 *   9. docs/Linux远程连接Windows MCP配置指南.md
 *  10. docs/MCP-CNB云环境访问Windows本地MCP方案.md
 *  11. docs/MCP-Cloudflare命名隧道固定域名方案.md
 *  12. docs/项目简介.md
 *
 * 【刻意不在清单内】docs/MCP-公网反向隧道跨机部署方案.md 用的是 30 秒，
 * 那是另一条链路（Windows 出站反向隧道 + 脚本式重连，按 90 秒判死链），
 * 与本文件的场景无关，不要顺手改。
 *
 * 快速自检（出现清单外文件即说明有新增落点漏登记）：
 *   grep -rn "ServerAlive" --include="*.ts" --include="*.json" --include="*.md" .
 */

/**
 * @brief 保活包间隔（秒）：空闲连接每 60 秒发一个
 *
 * 一个保活包让中间的 NAT / 防火墙 / 隧道设备一直看到流量，空闲映射不会被
 * 回收 —— 这是"长时间不用就断"的主因。取 60 秒而非更短：绝大多数设备的空闲
 * 回收阈值在分钟级（常见 5~30 分钟），60 秒已经够把连接焐住，又不必每分钟
 * 打扰一次链路。
 */
export const SSH_KEEPALIVE_SECONDS = 60;

/** @brief 保活包无应答的次数上限：3 × 60s = 180 秒后 ssh 主动断开退出 */
export const SSH_KEEPALIVE_COUNT_MAX = 3;

/**
 * @brief 命令行形态的保活选项：`-o ServerAliveInterval=60 -o ServerAliveCountMax=3`
 *
 * 为什么所有落点都要带：链路真断（黑洞、隧道死掉）时，本地 ssh 得先自己察觉
 * 才会退出。不加保活，完全空闲时 Linux 的 TCP keepalive 默认要 2 小时才动手，
 * 有数据要写也要等重传耗尽（约 15 分钟），这段时间 MCP 侧表现为"调用挂住"；
 * 加上后最迟 180 秒（3 × 60s）ssh 自己退出，MCP 客户端（Claude Code / ZCode /
 * opencode / CodeBuddy / dsh）的掉线检测与自动重连才有即时、可靠的触发点。
 *
 * 这几项是 ssh 客户端自身的选项，与被拉起的是哪个 MCP 客户端无关，
 * 所以 remote-mcp-config 的全部落点、sshd-config 的 Linux 端模板、cnb 的容器
 * 配置共用同一份，值只在这里维护。
 */
export const SSH_KEEPALIVE_ARGS: readonly string[] = [
  "-o",
  `ServerAliveInterval=${SSH_KEEPALIVE_SECONDS}`,
  "-o",
  `ServerAliveCountMax=${SSH_KEEPALIVE_COUNT_MAX}`,
];

/**
 * @brief 组装一条 MCP 桥接 ssh 命令的参数
 * @details 形态固定为 `-i <私钥> <保活选项> <user>@<host> <远端命令>`。
 *          选项必须排在目标主机之前：排在后面会被 ssh 当成远端命令的一部分。
 * @param keyPath       私钥路径（绝对路径，或供 ssh 展开的 `~/.ssh/xxx`）
 * @param target        目标主机（`<user>@<ip>`，或 ssh config 里已接管的别名）
 * @param remoteCommand 远端要执行的命令（通常是 remote-start-mcp.bat 的绝对路径）
 * @returns ssh 的 args 数组
 */
export function buildSshBridgeArgs(
  keyPath: string,
  target: string,
  remoteCommand: string
): string[] {
  return ["-i", keyPath, ...SSH_KEEPALIVE_ARGS, target, remoteCommand];
}

/**
 * @brief ssh config 形态的保活配置两行（cnb 写入容器 ~/.ssh/config 的隧道段）
 * @param indent 缩进（ssh config 的配置段按惯例缩进两格）
 * @returns 保活配置行数组
 */
export function sshKeepaliveConfigLines(indent = "  "): string[] {
  return [
    `${indent}ServerAliveInterval ${SSH_KEEPALIVE_SECONDS}`,
    `${indent}ServerAliveCountMax ${SSH_KEEPALIVE_COUNT_MAX}`,
  ];
}
