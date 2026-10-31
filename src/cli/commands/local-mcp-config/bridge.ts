/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : bridge.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: 写什么 —— 本地启动定义构造与 remote-start-mcp.bat 探测
 *
 * 与 remote-mcp-config 的 bridge.ts（ssh 桥接）对偶：
 *   - buildLocalBridge  构造本地启动定义 `cmd /c <bat 绝对路径>`；
 *     bat 自身锚定 cwd 并持有全部环境变量，是 env 的单一事实来源，
 *     因此生成的客户端配置不含 env 块（改 env 只改 bat 一处）。
 *   - detectBatCandidates 按"运行入口 → 包根 / exe 目录 / cwd"三个候选
 *     探测 remote-start-mcp.bat 的绝对路径（存在性过滤 + 去重）。
 * ======================================================
 */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

import type { BridgeServer } from "../remote-mcp-config/types.js";

/** @brief bat 文件名（由 init 命令生成在项目根，注释与 .mcp.json env 保持同步） */
const BAT_NAME = "remote-start-mcp.bat";

/**
 * @brief 构造本地启动定义
 * @details `cmd /c <bat 绝对路径>`：经 cmd 转发后由 bat 内的 `cd /d` 锚定
 *          工作目录，AI 客户端从任何 cwd 拉起该 server 都能正确解析
 *          相对路径的配置与日志目录。
 * @param batPath remote-start-mcp.bat 的绝对路径（正反斜杠均可，bat 自身兼容）
 * @returns 本地启动定义（写入各客户端配置的 server 对象的逻辑形态）
 */
export function buildLocalBridge(batPath: string): BridgeServer {
  return { command: "cmd", args: ["/c", batPath] };
}

/**
 * @brief 探测 remote-start-mcp.bat 的绝对路径候选（存在性过滤 + 去重）
 * @details 三个候选覆盖三种运行形态：
 *   1. node + bin wrapper（源码仓库 / npm 本地安装 / 全局安装）：
 *      argv[1] = <包根>/bin/embedded-mcp-toolkit-cli.js（或
 *      <root>/node_modules/@smai-kit/.../bin/...），bat 在包根 = 入口上溯一级；
 *   2. 单文件 exe：argv[1] = exe 绝对路径，bat 可能与 exe 同目录（init 后
 *      用户复制的情况），存在则收录；
 *   3. 当前工作目录：从某个已 init 的项目根运行 CLI 时（remote-mcp-config
 *      的既有先例，bridge.ts 用 cwd 拼 bat 路径）。
 * @param entryArg process.argv[1]（可能为相对路径，内部 resolve）
 * @param cwd      当前工作目录
 * @returns 存在的 bat 绝对路径列表（已去重，保持探测顺序）
 */
export function detectBatCandidates(
  entryArg: string | undefined,
  cwd: string
): string[] {
  const found: string[] = [];
  const push = (p: string): void => {
    const abs = resolve(p);
    if (existsSync(abs) && !found.includes(abs)) {
      found.push(abs);
    }
  };
  if (entryArg) {
    const entry = resolve(entryArg);
    // node + bin wrapper：bat 在包根（入口目录上一级）
    push(resolve(dirname(entry), "..", BAT_NAME));
    // 单文件 exe：bat 与 exe 同目录
    push(resolve(dirname(entry), BAT_NAME));
  }
  // cwd：从已 init 的项目根运行
  push(resolve(cwd, BAT_NAME));
  return found;
}
