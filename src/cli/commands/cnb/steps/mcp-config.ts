/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcp-config.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 3: 生成 CodeBuddy MCP 配置并写入容器用户级落点
 *
 * MCP Server 本体留在 Windows（握着串口/ADB），容器内 CodeBuddy 以 stdio 方式
 * 拉起它：`ssh <win_user>@127.0.0.1 remote-start-mcp.bat`。由于 127.0.0.1 已被
 * push-key 写入的 ssh config 接管，这条 ssh 命令实际经 Cloudflare 隧道落到
 * Windows 的 sshd，与"同网段直连"的配置形态完全一致（见方案文档三、4 节）。
 *
 * 落点取**容器用户级** ~/.codebuddy/mcp.json（不带点），而非项目级 <项目根>/.mcp.json：
 * 容器内"项目根"取决于用户实际打开哪个目录（如 /workspace 与 /workspace/<repo>
 * 可能并存），写死在某一层极易打偏，配置就读不到；用户级配置与打开哪个项目无关，
 * 容器重建后重跑一次即对整个开发环境生效。
 *
 * 模板先落盘到本地 .embedded/cnb/，再写入容器，便于用户复核与复用。
 * ======================================================
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { Client } from "ssh2";
import { log } from "@clack/prompts";

import { sshExec, sshReadText, sshWriteText } from "../../../shared/ssh.js";
import { buildSshBridgeArgs } from "../../../shared/ssh-bridge.js";
import {
  MCP_SCHEMA,
  MCP_TEMPLATE_REL,
  REMOTE_CONFIG_DIR_REL,
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
 * @brief 生成 CodeBuddy MCP 配置模板并写入容器用户级配置
 * @details 流程：
 *          1. 按本地端点构造桥接定义（ssh -i 专用私钥 <win_user>@127.0.0.1 + bat 路径）；
 *          2. 模板落盘到本地 .embedded/cnb/codebuddy-mcp.json 供复核；
 *          3. 在容器内创建 ~/.codebuddy 目录（缺失时）；
 *          4. 读取容器内 ~/.codebuddy/mcp.json（缺失当作空对象），补齐 $schema，
 *             只覆盖 mcpServers 下的 win-embedded-board 一项，其它 server 定义
 *             与顶层字段原样保留，再整体写回。
 * @param client   已连接的 CNB 环境 ssh2 Client
 * @param endpoint Windows 侧本地端点（ssh 用户名 + bat 绝对路径）
 * @param home     容器家目录绝对路径（由 push-key 步骤回传，SFTP 不识别 ~）
 * @returns 容器内实际写入的 MCP 配置路径；失败返回 null
 */
export async function doMcpConfig(
  client: Client,
  endpoint: LocalEndpoint,
  home: string
): Promise<string | null> {
  log.info("配置 CodeBuddy MCP 桥接 ...");

  // 1. 桥接定义（容器侧执行：ssh 到 127.0.0.1，由 ssh config 送入隧道）
  // 保活选项同时写在 args 与 ssh config 段里：args 排在 ssh config 之前生效（命令行
  // 优先级更高），容器重建后即使 config 段被覆盖，桥接命令自己仍然带保活。
  const server = {
    command: "ssh",
    args: buildSshBridgeArgs(
      `~/.ssh/${REMOTE_KEY_NAME}`,
      `${endpoint.sshUser}@${TUNNEL_ENDPOINT}`,
      endpoint.batPath
    ),
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

  // 3. 容器用户级落点：<home>/.codebuddy/mcp.json（不带点，CodeBuddy IDE 读这个）
  const remoteDir = `${home}/${REMOTE_CONFIG_DIR_REL}`;
  const remotePath = `${remoteDir}/${REMOTE_MCP_FILE_NAME}`;
  await sshExec(client, `mkdir -p "${remoteDir}"`);

  // 4. 合并写入（保留其它 MCP server 定义与顶层字段，如 projects）
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

  // $schema 仅在缺失时补齐（置顶），避免覆盖用户自定义的 schema 声明
  if (typeof json["$schema"] !== "string") {
    json = { $schema: MCP_SCHEMA, ...json };
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
