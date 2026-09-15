/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : summary.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 4: 全流程结果展示（落点回显 + 容器侧 ssh 命令）
 * ======================================================
 */

import { log } from "@clack/prompts";

import { REMOTE_KEY_NAME, SERVER_KEY, TUNNEL_ENDPOINT } from "../constants.js";
import { type LocalEndpoint } from "../types.js";

// ============================================================
// 步骤 4: 结果展示
// ============================================================

/**
 * @brief 打印全流程结果与容器侧免密登录命令
 * @details 回显三处落点（容器内私钥、隧道 config、MCP 配置）与本地模板路径，
 *          最后给出用户在 CNB 开发环境中可直接复制的 ssh 命令——执行它即可
 *          免密登录到 Windows 本机。
 * @param params 展示所需参数
 * @param params.endpoint       Windows 侧本地端点
 * @param params.domain         当前 Quick Tunnel 域名
 * @param params.remoteKeyPath  容器内私钥绝对路径
 * @param params.remoteConfigPath 容器内 ssh config 绝对路径
 * @param params.remoteMcpPath  容器内 MCP 配置文件绝对路径
 * @param params.templatePath   本地 MCP 模板绝对路径
 */
export function printFinalSummary(params: {
  endpoint: LocalEndpoint;
  domain: string;
  remoteKeyPath: string;
  remoteConfigPath: string;
  remoteMcpPath: string;
  templatePath: string;
}): void {
  const { endpoint, domain } = params;

  log.info("配置结果");
  log.message(`    隧道域名:      ${domain}`);
  log.message(`    容器内私钥:    ${params.remoteKeyPath}`);
  log.message(`    容器内 ssh config: ${params.remoteConfigPath}`);
  log.message(`    容器内 MCP 配置:   ${params.remoteMcpPath}`);
  log.message(`    本地模板:      ${params.templatePath}`);

  log.success("CNB 免密通道已就绪");

  log.info("在 CNB 开发环境中执行以下命令（免密登录到 Windows）");
  log.message(
    `    ssh -i ~/.ssh/${REMOTE_KEY_NAME} ${endpoint.sshUser}@${TUNNEL_ENDPOINT}`
  );
  log.message(
    `    简写（ssh config 已带 User/IdentityFile）: ssh ${TUNNEL_ENDPOINT}`
  );

  log.info("下一步");
  log.message(
    `    1. 重启 CodeBuddy 使 ~/.codebuddy/mcp.json 生效，即可调用 ${SERVER_KEY} 工具`
  );
  log.message(
    "    2. 若容器刚重建过，重跑本命令即可恢复免密通道（无需改 Windows 侧配置）"
  );
  log.message(
    "    3. 新分配的隧道域名 DNS 传播约需 1 分钟，期间连接可能报 no such host"
  );
}
