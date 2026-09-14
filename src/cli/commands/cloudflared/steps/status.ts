/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : status.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [2]: 查看隧道状态与域名（只读）
 *
 * 进程存活探测 + 状态摘要展示；域名缺失时从日志补录（覆盖 start 时
 * 提取超时的场景）。
 * ======================================================
 */

import { log } from "@clack/prompts";

import { extractDomainFromLog, isProcessAlive } from "../tunnel-process.js";
import { readTunnelState, writeTunnelState } from "../tunnel-state.js";
import { type TunnelState } from "../types.js";
import { printTunnelSummary } from "./summary.js";

// ============================================================
// 菜单 [2]: 查看状态
// ============================================================

/**
 * @brief 查看隧道运行状态（只读，域名缺失时补录状态文件除外）
 * @details 展示：进程存活状态、PID、目标 URL、域名、启动时间、日志路径。
 *          补录逻辑：start 时域名提取超时（进程在跑但 DNS/注册慢）的场景下，
 *          status 重扫日志文件，提取到即回写状态文件并提示。
 * @returns true（"未启动"属于正常状态展示，不算失败）
 */
export async function doStatus(): Promise<boolean> {
  const state = readTunnelState();
  if (!state) {
    log.warn("隧道未启动(无状态文件)");
    log.message("    使用菜单 [1] 或 embedded-mcp-toolkit cloudflared start 启动");
    return true;
  }

  const alive = await isProcessAlive(state.pid);
  log.info(`隧道状态: ${alive ? "运行中" : "已停止"}`);

  if (!alive) {
    log.warn("记录的进程已退出(可能异常终止)");
    log.message(`    PID:      ${state.pid}(残留)`);
    log.message(`    日志:     ${state.logFile}(菜单 [3] 查看排查)`);
    log.message("    重新启动: 菜单 [1] 或 embedded-mcp-toolkit cloudflared start");
    return true;
  }

  // 域名补录：start 超时的场景由 status 兜底
  let display: TunnelState = state;
  if (!state.domain) {
    const found = await extractDomainFromLog(state.logFile);
    if (found) {
      display = { ...state, domain: found };
      writeTunnelState(display);
      log.message("    (已从日志补录域名)");
    }
  }

  printTunnelSummary(display);
  return true;
}
