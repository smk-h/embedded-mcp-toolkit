/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : summary.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 隧道状态摘要展示（start / status 共用）
 *
 * 统一输出隧道运行信息与 CNB/远端侧的连接命令示例，避免
 * start 与 status 两个 step 各自维护一份展示文案。
 * ======================================================
 */

import { log } from "@clack/prompts";
import { userInfo } from "os";

import { REMOTE_KEY_NAME } from "../../cnb/constants.js";
import { type TunnelState } from "../types.js";

// ============================================================
// 摘要展示
// ============================================================

/**
 * @brief 打印隧道运行摘要与跨机连接指引
 * @details 展示内容：
 *          (a) 进程 PID、目标 URL、启动时间、日志路径；
 *          (b) Quick Tunnel 域名（未分配时提示稍后重查——新域名 DNS 传播
 *              约需 1 分钟，实测见 docs/MCP-CNB云环境访问Windows本地MCP方案.md）；
 *          (c) CNB/远端侧可直接复制的 ssh 连接命令（含 ProxyCommand 与
 *              免密密钥路径——密钥名取 cnb 命令推送进容器的 REMOTE_KEY_NAME，
 *              与 sshd-config 流程的 id_mcp_server 是两套密钥；端点用户名
 *              取当前 Windows 登录用户）。
 * @param state 隧道状态
 */
export function printTunnelSummary(state: TunnelState): void {
  log.message(`    PID:       ${state.pid}`);
  log.message(`    目标:      ${state.url}`);
  log.message(`    启动时间:  ${state.startedAt}`);
  log.message(`    日志:      ${state.logFile}`);

  if (!state.domain) {
    log.warn("Quick Tunnel 域名尚未分配,稍后用 status 重查");
    return;
  }

  log.message(`    域名:      ${state.domain}`);
  log.message("");
  log.info("远端(CNB 容器/Linux)连接本机的命令示例");
  const winUser = userInfo().username;
  // 密钥名复用 cnb 命令的容器侧常量：该示例在 CNB 容器内执行，私钥由 cnb
  // 命令推送到 ~/.ssh/<REMOTE_KEY_NAME>（与 sshd-config 流程的 id_mcp_server
  // 是两套密钥，写死会随 cnb 侧改名而失配）
  log.message(
    `    ssh -i ~/.ssh/${REMOTE_KEY_NAME}` +
      ` -o ProxyCommand="cloudflared access ssh --hostname ${state.domain}"` +
      ` ${winUser}@${state.domain}`
  );
  log.message(
    "    提示: 新域名 DNS 传播约需 1 分钟,立即连接可能报 no such host;免密可执行 embedded-mcp-toolkit cnb 一键完成密钥生成/授权/推送"
  );
}
