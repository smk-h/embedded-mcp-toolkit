/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : push-key.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 2: 把私钥推送到 CNB 容器并写入隧道 ssh config
 *
 * CNB 容器每次重启都是全新镜像，家目录内的私钥与 ssh config 全部丢失——这正是
 * 本命令存在的原因：每次重建后重跑一遍即可恢复免密通道。写入采用"标记段替换"
 * 保证幂等：容器内 ssh config 的其它内容一律保留，只替换本命令管理的隧道段。
 * ======================================================
 */

import { Client } from "ssh2";
import { log } from "@clack/prompts";

import { sshExec, sshReadText, sshWriteText } from "../../../shared/ssh.js";
import { sshKeepaliveConfigLines } from "../../../shared/ssh-bridge.js";
import {
  REMOTE_KEY_NAME,
  REMOTE_SSH_CONFIG,
  TUNNEL_BEGIN,
  TUNNEL_END,
  TUNNEL_ENDPOINT,
} from "../constants.js";
import { type PushKeyResult } from "../types.js";
import { readLocalPrivateKey } from "./local-key.js";

// ============================================================
// 步骤 2: 推送私钥 + 写隧道 ssh config
// ============================================================

/**
 * @brief 把本地私钥推送到容器，并在容器内写入隧道 ssh config
 * @details 流程：
 *          1. 确保容器内 ~/.ssh 存在且权限为 700；
 *          2. 展开容器家目录（SFTP 不识别 ~），把私钥写入
 *             ~/.ssh/id_mcp_cnb_server 并 chmod 600（权限过宽 ssh 会拒用）；
 *          3. 读取容器内 ~/.ssh/config，替换（或追加）隧道配置段：
 *             `Host 127.0.0.1` + ProxyCommand 指向本次隧道域名。
 *          写成 `Host 127.0.0.1` 是为了与 MCP 的端点解析对齐——隧道拓扑下
 *          host_info 输出的端点是 `<win_user>@127.0.0.1`，AI 据此执行的
 *          ssh / scp 需要本段 config 才能被送进隧道（见方案文档四、2、3 节）。
 * @param client 已连接的 CNB 环境 ssh2 Client
 * @param domain 当前 Quick Tunnel 域名（裸域名，不带协议前缀）
 * @param winUser Windows 登录用户名（写入 config 的 User，便于直接 ssh 127.0.0.1）
 * @returns 各落点路径；私钥缺失或家目录不可用时返回 null
 */
export async function doPushKey(
  client: Client,
  domain: string,
  winUser: string
): Promise<PushKeyResult | null> {
  log.info("推送私钥到 CNB 开发环境 ...");

  const privateKey = readLocalPrivateKey();
  if (!privateKey) {
    log.message("    未找到本地私钥，请先完成本地密钥对生成");
    return null;
  }

  // 容器家目录：SFTP 与后续路径拼接都需要绝对路径
  const home = (await sshExec(client, "echo $HOME")).replace(/\s+/g, "");
  if (!home) {
    log.message("    获取容器家目录失败");
    return null;
  }

  // 1. ~/.ssh 目录（存在则幂等，权限过宽 ssh 会拒绝使用私钥）
  await sshExec(client, "mkdir -p ~/.ssh && chmod 700 ~/.ssh");

  // 2. 私钥落盘 + 收敛权限
  const remoteKeyPath = `${home}/.ssh/${REMOTE_KEY_NAME}`;
  await sshWriteText(client, remoteKeyPath, privateKey);
  await sshExec(client, `chmod 600 "${remoteKeyPath}"`);
  log.message(`    私钥已写入: ${remoteKeyPath} (600)`);

  // 3. 隧道 ssh config（标记段替换，保留用户其它配置）
  const remoteConfigPath = `${home}/${REMOTE_SSH_CONFIG}`;
  const existing = await sshReadText(client, remoteConfigPath);
  const merged = upsertTunnelBlock(
    existing.exists ? (existing.content ?? "") : "",
    domain,
    winUser
  );
  await sshWriteText(client, remoteConfigPath, merged);
  log.message(`    ssh config 已更新: ${remoteConfigPath}`);
  log.message(
    `    隧道段: Host ${TUNNEL_ENDPOINT} → cloudflared access ssh --hostname ${domain}`
  );

  return { remoteKeyPath, remoteConfigPath, home };
}

/**
 * @brief 幂等替换 ssh config 中的隧道配置段
 * @details 先按标记删除旧隧道段（含标记行），保留其余全部内容，再把新段追加到
 *          文件末尾。标记之间的内容不对用户可见，避免用户误改后无法覆盖更新。
 * @param content 容器内 ssh config 原内容（不存在时传空串）
 * @param domain  当前 Quick Tunnel 域名
 * @param winUser Windows 登录用户名
 * @returns 替换后的完整 config 内容（以换行结尾）
 */
function upsertTunnelBlock(
  content: string,
  domain: string,
  winUser: string
): string {
  const block = [
    TUNNEL_BEGIN,
    `Host ${TUNNEL_ENDPOINT}`,
    `  HostName ${TUNNEL_ENDPOINT}`,
    `  User ${winUser}`,
    `  IdentityFile ~/.ssh/${REMOTE_KEY_NAME}`,
    `  ProxyCommand cloudflared access ssh --hostname ${domain}`,
    "  StrictHostKeyChecking accept-new",
    ...sshKeepaliveConfigLines(),
    TUNNEL_END,
  ].join("\n");

  // 逐行过滤旧隧道段（标记前的用户内容原样保留）
  const kept: string[] = [];
  let inBlock = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === TUNNEL_BEGIN) {
      inBlock = true;
      continue;
    }
    if (trimmed === TUNNEL_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      kept.push(line);
    }
  }

  // 折叠删除后可能出现的连续空行，保持文件整洁
  const rest = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return (rest ? rest + "\n\n" : "") + block + "\n";
}
