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
 * 第三章）。域名重启即换，故每次流程都重新确认：隧道在跑、健康（域名可解析）
 * 就直接复用其域名，否则调用 cloudflared 命令的 start 步骤拉起；进程存活但已被
 * Cloudflare 回收的僵尸隧道（dead）先停掉再拉新，域名暂未解析生效（pending）则
 * 交给 start 步骤的重试逻辑等 DNS 传播。只有确认域名**可解析**才放行——带着
 * 未生效的域名去写容器侧配置没有意义。
 * ======================================================
 */

import { log } from "@clack/prompts";

import { DEFAULT_TUNNEL_URL } from "../../cloudflared/constants.js";
import { checkTunnelHealth } from "../../cloudflared/tunnel-health.js";
import {
  isProcessAlive,
  stopProcessTree,
} from "../../cloudflared/tunnel-process.js";
import {
  clearTunnelState,
  readTunnelState,
} from "../../cloudflared/tunnel-state.js";
import { doStart } from "../../cloudflared/steps/start.js";

// ============================================================
// 步骤 0: 确保隧道域名可用
// ============================================================

/**
 * @brief 获取当前**解析就绪**的 Quick Tunnel 域名（必要时自动拉起隧道）
 * @details 本步骤是后续所有容器侧配置的前提：域名未解析生效就写进容器
 *          ssh config 的 ProxyCommand 必然失效，配置出来毫无意义，故一律
 *          返回 null 中止流程，绝不带着未生效的域名继续。判定顺序：
 *          1. 状态文件有域名且记录的进程仍存活 → 健康预检：
 *             - dead（进程存活的僵尸隧道，域名已被回收且不会自愈）→ 停止后
 *               走重新拉起，防止死域名被写进容器配置；
 *             - ok（域名可解析，与边缘注册同生共死）→ 直接复用（幂等，不
 *               重启隧道，避免每次执行都把域名换掉）；
 *             - pending（域名暂未解析生效）→ 交给 start 步骤的重试逻辑等
 *               DNS 传播就绪，而不是把未生效的域名当成功放行；
 *          2. 进程已死或无状态文件 → 调用 cloudflared 的 start 步骤后台拉起；
 *             该步骤自带"域名解析就绪等待（5s 间隔重试，约 1 分钟）"，返回
 *             true 即代表域名已解析生效，再从状态文件读取域名。
 * @returns Quick Tunnel 裸域名；建立失败或域名未就绪返回 null
 */
export async function ensureTunnelDomain(): Promise<string | null> {
  log.info("检查 Cloudflare Quick Tunnel ...");

  const state = readTunnelState();
  if (state?.domain && (await isProcessAlive(state.pid))) {
    const health = await checkTunnelHealth(state);
    if (health.status === "dead") {
      log.warn(
        `    隧道进程存活但已失效（${health.detail}），停止后换新域名 ...`
      );
      await stopProcessTree(state.pid);
      clearTunnelState();
    } else if (health.status === "ok") {
      log.message(`    隧道运行中（PID ${state.pid}），域名: ${state.domain}`);
      return state.domain;
    } else {
      log.message(
        `    隧道域名尚未解析生效（${health.detail}），等待就绪后继续 ...`
      );
    }
  } else {
    log.message("    隧道未运行，正在后台启动 ...");
  }

  // doStart 返回 true 即域名已解析生效；否则已耗尽重试次数
  const started = await doStart(DEFAULT_TUNNEL_URL);
  if (!started) {
    log.message("    隧道域名不可用，已中止后续配置（不写入容器侧文件）");
    log.message(
      "    请执行 embedded-mcp-toolkit cloudflared stop 后重新运行本命令"
    );
    return null;
  }

  const fresh = readTunnelState();
  if (!fresh?.domain) {
    log.message("    隧道状态异常：未记录域名，已中止后续配置");
    return null;
  }

  log.message(`    域名已就绪: ${fresh.domain}`);
  log.message(
    "    提示: 域名已解析生效，容器侧首次连接若仍报 no such host，稍等数秒重试即可"
  );
  return fresh.domain;
}
