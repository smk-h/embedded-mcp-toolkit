/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : log.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [3]: 查看隧道日志尾部
 *
 * 输出 tunnel.log 的尾部 N 行，用于域名未分配、进程意外退出等
 * 场景的快速排查。
 * ======================================================
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { log } from "@clack/prompts";

import { LOG_FILE_REL } from "../constants.js";
import { readTunnelState } from "../tunnel-state.js";

// ============================================================
// 菜单 [3]: 查看日志
// ============================================================

/**
 * @brief 查看隧道日志尾部
 * @details 日志路径优先取状态文件（与实际运行的隧道一致），无状态文件时
 *          回落固定路径（覆盖"启动后立即失败、状态已清理"的排查场景）。
 *          cloudflared 的预检结果、注册域名、断线重连记录都在此日志中。
 * @param lines 输出尾部行数，默认 50
 * @returns true（日志不存在属于正常状态展示，不算失败）
 */
export async function doLog(lines = 50): Promise<boolean> {
  const state = readTunnelState();
  const logFile =
    state?.logFile ?? resolve(process.cwd(), LOG_FILE_REL);

  if (!existsSync(logFile)) {
    log.warn(`日志文件不存在: ${logFile}(隧道从未启动)`);
    return true;
  }

  const allLines = readFileSync(logFile, "utf-8").split(/\r?\n/);
  const tail = allLines.slice(-lines);
  console.log(`---- ${logFile}(尾部 ${tail.length} 行 / 共 ${allLines.length} 行) ----`);
  console.log(tail.join("\n"));
  return true;
}
