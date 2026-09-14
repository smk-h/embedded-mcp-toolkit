/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : stop.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [4]: 停止 Quick Tunnel
 *
 * 读取状态文件中的 pid，taskkill 杀整棵进程树后清理状态文件。
 * 全程幂等：无状态、进程已死等情形均收敛到"状态干净"。
 * ======================================================
 */

import { log } from "@clack/prompts";

import { isProcessAlive, stopProcessTree } from "../tunnel-process.js";
import { clearTunnelState, readTunnelState } from "../tunnel-state.js";

// ============================================================
// 菜单 [4]: 停止隧道
// ============================================================

/**
 * @brief 停止 cloudflared Quick Tunnel 并清理状态
 * @details 幂等收敛：无状态文件视为从未启动（直接成功）；taskkill 失败时
 *          复核进程存活——进程已死同样清理状态并成功返回，仅"进程仍在但
 *          杀不掉"才判失败（此时需用户手工排查，状态文件保留以便重试）。
 * @returns 停止成功（或本就未运行）返回 true
 */
export async function doStop(): Promise<boolean> {
  const state = readTunnelState();
  if (!state) {
    log.warn("隧道未启动(无状态文件),无需停止");
    return true;
  }

  log.info(`正在停止隧道进程(PID ${state.pid})...`);
  const killed = await stopProcessTree(state.pid);
  if (killed) {
    clearTunnelState();
    log.success("隧道已停止,状态文件已清理");
    return true;
  }

  // taskkill 失败：区分"进程早已退出"与"仍在但停止失败"
  if (!(await isProcessAlive(state.pid))) {
    clearTunnelState();
    log.warn("记录的进程已不存在,已清理残留状态");
    return true;
  }

  log.error(`停止失败,进程(PID ${state.pid})仍在运行,请手工排查后重试`);
  return false;
}
