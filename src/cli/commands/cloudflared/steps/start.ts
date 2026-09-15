/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : start.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [1]: 启动 Quick Tunnel（后台常驻）
 *
 * 流程：探测 cloudflared → 防重复与健康预检 → spawn detached 后台进程 →
 * 轮询日志提取 Quick Tunnel 域名 → 写状态文件 → 展示摘要与跨机连接指引。
 * ======================================================
 */

import { mkdirSync } from "fs";

import { log } from "@clack/prompts";

import {
  DEFAULT_TUNNEL_URL,
  DOMAIN_POLL_MS,
  DOMAIN_TIMEOUT_MS,
  LOG_FILE_REL,
  TUNNEL_DIR_REL,
} from "../constants.js";
import { findCloudflaredExe } from "../tunnel-detect.js";
import { checkTunnelHealth } from "../tunnel-health.js";
import {
  isProcessAlive,
  pollDomainFromLog,
  startDetached,
  stopProcessTree,
} from "../tunnel-process.js";
import {
  clearTunnelState,
  readTunnelState,
  writeTunnelState,
} from "../tunnel-state.js";
import { type TunnelState } from "../types.js";
import { resolveWorkspacePath } from "../workspace-paths.js";
import { printTunnelSummary } from "./summary.js";

// ============================================================
// 菜单 [1]: 启动隧道
// ============================================================

/**
 * @brief 启动 cloudflared Quick Tunnel 并提取分配的域名
 * @details 幂等设计：已运行且健康时直接展示现有域名，不重复拉起进程；
 *          进程存活但健康判定为 dead（域名被 Cloudflare 回收的僵尸隧道，
 *          永不自愈）时自动停止后重新拉起换新域名；残留状态文件（进程已
 *          退出）先清理再重启。域名提取依赖轮询，超时但进程存活时不算
 *          失败——status 会从日志补录域名。
 * @param url 隧道目标 URL（菜单/子命令未指定时由调用方传入 DEFAULT_TUNNEL_URL）
 * @returns 成功（含"已在运行"的幂等成功）返回 true
 */
export async function doStart(url: string = DEFAULT_TUNNEL_URL): Promise<boolean> {
  log.info("启动 cloudflared Quick Tunnel");

  // (1) 探测可执行文件
  const detected = await findCloudflaredExe();
  if (!detected.exePath) {
    log.error("未检测到 cloudflared,请先执行菜单 [5] 安装");
    return false;
  }

  // (2) 防重复与健康预检：进程存活 → 健康则幂等返回，僵尸则停掉换新
  const existing = readTunnelState();
  if (existing && (await isProcessAlive(existing.pid))) {
    const health = await checkTunnelHealth(existing);
    if (health.status !== "dead") {
      log.warn(`隧道已在运行(PID ${existing.pid}),不重复启动`);
      printTunnelSummary(existing);
      return true;
    }
    log.warn(`隧道进程存活但已失效(${health.detail}),停止后重新拉起换新域名`);
    await stopProcessTree(existing.pid);
    clearTunnelState();
  } else if (existing) {
    log.warn("发现残留状态文件(记录的进程已退出),清理后重新启动");
    clearTunnelState();
  }

  // (3) 后台启动（日志重定向到固定文件，每次启动截断重建）
  mkdirSync(resolveWorkspacePath(TUNNEL_DIR_REL), { recursive: true });
  const logFile = resolveWorkspacePath(LOG_FILE_REL);
  let pid: number;
  try {
    pid = startDetached(detected.exePath, url, logFile);
  } catch (error) {
    log.error(
      `cloudflared 启动失败: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
  log.message(`进程已启动(PID ${pid}),正在等待 Quick Tunnel 域名分配...`);

  // (4) 轮询提取域名（超时但进程存活不算失败）
  const domain = await pollDomainFromLog(logFile, pid, DOMAIN_TIMEOUT_MS, DOMAIN_POLL_MS);
  const state: TunnelState = {
    pid,
    url,
    domain,
    startedAt: new Date().toISOString(),
    exePath: detected.exePath,
    logFile,
  };
  writeTunnelState(state);

  if (!domain) {
    if (!(await isProcessAlive(pid))) {
      log.error("进程启动后立即退出,详见日志(菜单 [3] 查看);状态文件已清理");
      clearTunnelState();
      return false;
    }
    log.warn("等待域名超时,但进程仍在运行;稍后用菜单 [2] 或 status 重查");
    return true;
  }

  log.success("Quick Tunnel 已建立");
  printTunnelSummary(state);
  return true;
}
