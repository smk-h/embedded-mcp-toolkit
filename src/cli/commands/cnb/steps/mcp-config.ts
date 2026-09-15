/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcp-config.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 3: 生成 CodeBuddy MCP 配置模板并写入容器
 *
 * MCP Server 本体留在 Windows（握着串口/ADB），容器内 CodeBuddy 以 stdio 方式
 * 拉起它：`ssh <win_user>@127.0.0.1 remote-start-mcp.bat`。由于 127.0.0.1 已被
 * push-key 写入的 ssh config 接管，这条 ssh 命令实际经 Cloudflare 隧道落到
 * Windows 的 sshd，与"同网段直连"的配置形态完全一致（见方案文档三、4 节）。
 *
 * 模板先落盘到本地 .embedded/cnb/，再写入容器项目根，便于用户复核与复用。
 * ======================================================
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { Client } from "ssh2";
import { log } from "@clack/prompts";

import { sshExec, sshReadText, sshWriteText } from "../../../shared/ssh.js";
import {
  MCP_SCHEMA,
  MCP_TEMPLATE_REL,
  REMOTE_MCP_FILE_NAME,
  REMOTE_KEY_NAME,
  SERVER_KEY,
  TUNNEL_ENDPOINT,
} from "../constants.js";
import { type LocalEndpoint } from "../types.js";

// ============================================================
// 步骤 3: 生成模板并写入容器
// ============================================================

/**
 * @brief 生成 CodeBuddy MCP 配置模板并写入容器内项目根
 * @details 流程：
 *          1. 按本地端点构造桥接定义（ssh -i 专用私钥 <win_user>@127.0.0.1 + bat 路径）；
 *          2. 模板落盘到本地 .embedded/cnb/codebuddy-mcp.json 供复核；
 *          3. 探测容器项目根是否存在，不存在则回退容器家目录；
 *          4. 读取容器内 .mcp.json（缺失当作空对象），只覆盖 mcpServers 下的
 *             win-embedded-board 一项，其它 server 定义原样保留，再整体写回。
 * @param client     已连接的 CNB 环境 ssh2 Client
 * @param endpoint   Windows 侧本地端点（ssh 用户名 + bat 绝对路径）
 * @param projectDir 容器内期望的项目根目录
 * @returns 容器内实际写入的 .mcp.json 路径；失败返回 null
 */
export async function doMcpConfig(
  client: Client,
  endpoint: LocalEndpoint,
  projectDir: string
): Promise<string | null> {
  log.info("配置 CodeBuddy MCP 桥接 ...");

  // 1. 桥接定义（容器侧执行：ssh 到 127.0.0.1，由 ssh config 送入隧道）
  const server = {
    command: "ssh",
    args: [
      "-i",
      `~/.ssh/${REMOTE_KEY_NAME}`,
      `${endpoint.sshUser}@${TUNNEL_ENDPOINT}`,
      endpoint.batPath,
    ],
  };
  const template = {
    $schema: MCP_SCHEMA,
    mcpServers: { [SERVER_KEY]: server },
  };

  // 2. 模板落盘（本地留档，内容与写入容器的一致）
  const templatePath = resolve(process.cwd(), MCP_TEMPLATE_REL);
  const templateDir = dirname(templatePath);
  if (!existsSync(templateDir)) {
    mkdirSync(templateDir, { recursive: true });
  }
  writeFileSync(templatePath, JSON.stringify(template, null, 2) + "\n", "utf8");
  log.message(`    模板已生成: ${templatePath}`);

  // 3. 定位容器内项目根：不存在则回退家目录，保证配置一定写得进去
  const targetDir = await resolveRemoteDir(client, projectDir);
  const remotePath = `${targetDir}/${REMOTE_MCP_FILE_NAME}`;

  // 4. 合并写入（保留其它 MCP server 定义）
  const existing = await sshReadText(client, remotePath);
  let json: Record<string, unknown> = {};
  if (existing.exists && existing.content) {
    try {
      json = JSON.parse(existing.content) as Record<string, unknown>;
    } catch (err) {
      log.message(
        `    容器内 ${remotePath} 不是合法 JSON: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  const current = json["mcpServers"];
  const servers: Record<string, unknown> =
    typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)
      : {};
  servers[SERVER_KEY] = server;
  json["mcpServers"] = servers;

  await sshWriteText(client, remotePath, JSON.stringify(json, null, 2) + "\n");
  log.message(`    已写入: ${remotePath}`);
  log.message(
    `    server: ${SERVER_KEY} = ssh -i ~/.ssh/${REMOTE_KEY_NAME} ${endpoint.sshUser}@${TUNNEL_ENDPOINT} <bat>`
  );

  return remotePath;
}

/**
 * @brief 确定容器内的落点目录
 * @details 期望目录存在（`test -d`）则直接采用；否则回退到容器家目录并在日志中
 *          说明，避免因路径猜测错误导致写入失败或写到意外位置。
 * @param client     已连接的 CNB 环境 ssh2 Client
 * @param preferDir  期望目录（如 /workspace）
 * @returns 实际可用的容器内目录绝对路径
 * @throws 家目录获取失败时抛出
 */
async function resolveRemoteDir(
  client: Client,
  preferDir: string
): Promise<string> {
  const probe = await sshExec(
    client,
    `test -d "${preferDir}" && echo OK || echo MISSING`
  );
  if (probe.trim() === "OK") {
    return preferDir.replace(/\/+$/, "");
  }

  const home = (await sshExec(client, "echo $HOME")).replace(/\s+/g, "");
  log.message(`    目录不存在: ${preferDir}，回退到容器家目录 ${home}`);
  return home;
}
