/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : gen-template.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: step7: 生成 Linux 端 MCP 配置模板
 * ======================================================
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { log, box } from "@clack/prompts";

import {
  REMOTE_MCP_TEMPLATE_REL,
  MENU_INSTALL_SSH,
  MENU_GENERATE_KEY,
  MENU_CONFIG_SSHD,
} from "../types.js";
import { collectConnectionInfo } from "../../../shared/cli-helpers.js";

// ============================================================
// step7: 生成 Linux 端 MCP 配置模板
// ============================================================

/**
 * @brief 生成 Linux 端 Claude Code 的 .mcp.json 配置模板
 * @details 自动采集本机用户名与 IPv4 地址，结合专用密钥名（id_mcp_server）与
 *          remote-start-mcp.bat 脚本路径，生成一份 Linux 端可直接使用的
 *          .mcp.json 模板，写入 .embedded/ssh/mcp-remote-template.json。
 *
 *          生成后打印模板路径与内容摘要，提示用户复制到 Linux 端项目根目录
 *          并按需修改 IP / 脚本路径。多网卡时取首个 IP 作为示例，同时在模板
 *          注释中列出其它候选 IP。
 */
export async function doGenerateTemplate(): Promise<boolean> {
  log.info("开始生成 Linux 端 MCP 配置模板");

  const { sshUser, ipList } = collectConnectionInfo();

  if (ipList.length === 0) {
    log.message("    未检测到可用的 IPv4 地址，无法生成模板");
    log.message("    请确认网络连接正常后重试");
    return false;
  }

  // 取首个 IP 作为模板默认值，其余 IP 在提示中列出
  const primaryIp = ipList[0].ip;
  const keyPath = "~/.ssh/id_mcp_server";

  // Windows 上 remote-start-mcp.bat 的绝对路径（模板中用户需确认与修改）
  // 统一用正斜杠：JSON 无需转义反斜杠，视觉清爽，且 Windows 的 node / ssh
  // 完全支持正斜杠路径（node 内部 path 与 spawn 均做归一化）
  const batPath = join(resolve(process.cwd()), "remote-start-mcp.bat").replace(
    /\\/g,
    "/"
  );

  // 构造 .mcp.json 模板内容
  // prettier-ignore
  const template = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    mcpServers: {
      "embedded-board": {
        command: "ssh",
        args: [
          "-i",
          keyPath,
          `${sshUser}@${primaryIp}`,
          batPath,
        ],
      },
    },
  };
  // 序列化（2 空格缩进，与项目 .mcp.json 风格一致）
  const content = JSON.stringify(template, null, 2) + "\n";

  // 写入 .embedded/ssh/mcp-remote-template.json
  const templatePath = resolve(process.cwd(), REMOTE_MCP_TEMPLATE_REL);
  const templateDir = dirname(templatePath);
  if (!existsSync(templateDir)) {
    mkdirSync(templateDir, { recursive: true });
  }
  writeFileSync(templatePath, content, "utf8");

  // 生成结果
  log.info("Windows 用户名和IP地址");
  log.message(`    Windows 用户名: ${sshUser}`);
  log.message(`    模板默认 IP:   ${primaryIp}`);
  if (ipList.length > 1) {
    log.message("    其它可用 IP:");
    for (const entry of ipList.slice(1)) {
      log.message(`      ${entry.ip}（${entry.iface}）`);
    }
  }
  log.success(`模板已生成: ${templatePath}`);

  // 使用步骤
  log.info("使用步骤");
  log.message(
    `    1. 将 ${templatePath} 复制到 Linux 项目根目录并重命名为 .mcp.json`
  );
  log.message("    2. 按需修改以下内容：");
  log.message(
    `       - ssh 连接的 IP（当前为 ${primaryIp}，若不通换用其它候选 IP）`
  );
  log.message(`       - remote-start-mcp.bat 的绝对路径（当前为 ${batPath}）`);
  log.message("    3. 在 Linux 端重启 Claude Code 使配置生效");
  log.message(
    "    注意: MCP 客户端首次连接 Windows 会触发主机密钥确认，需先在 Linux 端手动执行一次 ssh 连接并输入 yes 完成信任，之后客户端即可自动免密连接"
  );
  log.message(
    `    前置条件：已依次执行 [${MENU_INSTALL_SSH}] 安装 → [${MENU_GENERATE_KEY}] 生成密钥 → [${MENU_CONFIG_SSHD}] 配置 sshd`
  );
  log.message("    否则 ssh 连接会失败（密码提示 / 连接拒绝）");

  // 模板内容预览（box 包裹，标题作为独立节点）
  log.info("模板内容如下");
  box(content.replace(/\n$/, ""), "模板内容预览");
  return true;
}
