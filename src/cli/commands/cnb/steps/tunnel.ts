/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tunnel.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 0: 确保 Cloudflare Quick Tunnel 已就绪并取得域名
 *
 * CNB 容器内要 ssh 到 Windows，必须先有一条由 Windows 侧 cloudflared 反向
 * 注册到 Cloudflare 边缘的通路（方案见 docs/MCP-CNB云环境访问Windows本地MCP方案.md
 * 第三章）。域名重启即换，故每次流程都重新确认：隧道在跑就直接复用其域名，
 * 不在跑就调用 cloudflared 命令的 start 步骤拉起。
 * ======================================================
 */

import { log } from "@clack/prompts";

import { DEFAULT_TUNNEL_URL } from "../../cloudflared/constants.js";
import { isProcessAlive } from "../../cloudflared/tunnel-process.js";
import { readTunnelState } from "../../cloudflared/tunnel-state.js";
import { doStart } from "../../cloudflared/steps/start.js";

// ============================================================
// 步骤 0: 确保隧道域名可用
// ============================================================

/**
 * @brief 获取当前可用的 Quick Tunnel 域名（必要时自动拉起隧道）
 * @details 判定顺序：
 *          1. 状态文件有域名且记录的进程仍存活 → 直接复用（幂等，不重启隧道，
 *             避免每次执行都把域名换掉）；
 *          2. 进程已死或无状态文件 → 调用 cloudflared 的 start 步骤后台拉起，
 *             再从状态文件读取新分配的域名。
 * @returns Quick Tunnel 裸域名；拉起失败或域名未提取到返回 null
 */
export async function ensureTunnelDomain(): Promise<string | null> {
  log.info("检查 Cloudflare Quick Tunnel ...");

  const state = readTunnelState();
  if (state?.domain && (await isProcessAlive(state.pid))) {
    log.message(`    隧道运行中（PID ${state.pid}），域名: ${state.domain}`);
    return state.domain;
  }

  log.message("    隧道未运行，正在后台启动 ...");
  const started = await doStart(DEFAULT_TUNNEL_URL);
  if (!started) {
    log.message(
      "    隧道启动失败，请先执行 embedded-mcp-toolkit cloudflared install"
    );
    return null;
  }

  const fresh = readTunnelState();
  if (fresh?.domain) {
    log.message(`    新域名: ${fresh.domain}`);
    log.message(
      "    提示: 新域名 DNS 传播约需 1 分钟，期间容器侧连接可能报 no such host"
    );
    return fresh.domain;
  }

  log.message(
    "    隧道进程已启动，但域名尚未提取到（可稍后用 cloudflared status 重查）"
  );
  return null;
}
