/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : check-status.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: step4: 检查 sshd 配置状态（只读诊断）
 * ======================================================
 */

import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { log } from "@clack/prompts";

import {
  SSHD_CONFIG_PATH,
  LOCAL_PUBKEY_REL,
  PUBKEY_LINE_RE,
  MENU_INSTALL_SSH,
  MENU_CONFIG_SSHD,
  MENU_GENERATE_KEY,
} from "../types.js";
import { runPowerShell } from "../exec.js";
import { detectOpenSshInstallMethod } from "../sshd-service.js";
import { findActiveConfigLine } from "../sshd-config-edit.js";

// ============================================================
// step4: 检查 sshd 配置状态（只读诊断）
// ============================================================

/**
 * @brief 检查 sshd 配置状态（纯只读诊断）
 * @details 不修改任何文件或服务，逐项检查并汇总展示当前"Linux→Windows 免密登录"
 *          所需的配置是否就绪：
 *          (a) sshd 服务状态：是否安装、Running、启动类型
 *          (b) sshd_config 关键项：PubkeyAuthentication / AuthorizedKeysFile / Match Group administrators
 *          (c) authorized_keys 状态：是否存在、含多少条公钥
 *          (d) 本地公钥状态：.embedded/ssh/id_mcp_server.pub 是否存在
 *          末尾给出汇总结论，列出异常项与建议执行的菜单项。
 */
export async function doCheckStatus(): Promise<void> {
  log.info("检查 sshd 配置状态（只读诊断）");

  const issues: string[] = [];

  // (a) sshd 服务状态
  log.info("sshd 服务状态");
  const svcResult = await runPowerShell(
    "$s = Get-Service sshd -ErrorAction SilentlyContinue; if ($s) { '{0}|{1}' -f $s.Status, $s.StartType } else { 'NOT_INSTALLED' }"
  );
  if (!svcResult.success || svcResult.stdout === "NOT_INSTALLED") {
    log.message("    sshd 服务未安装");
    issues.push(`[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`);
  } else {
    const parts = svcResult.stdout.split("|");
    const status = parts[0]?.trim() ?? "Unknown";
    const startType = parts[1]?.trim() ?? "Unknown";
    const isRunning = status === "Running";
    const isAuto = startType === "Automatic";
    log.message(`    状态: ${status}`);
    log.message(`    启动类型: ${startType}`);
    if (!isRunning) {
      issues.push(`启动 sshd 服务（或重新执行 [${MENU_INSTALL_SSH}]）`);
    }
    if (!isAuto) {
      issues.push(`将 sshd 设为开机自启（或重新执行 [${MENU_INSTALL_SSH}]）`);
    }
  }

  // (a.2) 安装方式（MSI / Capability / 未知）
  const installInfo = await detectOpenSshInstallMethod();
  log.message(
    `    安装方式: ${installInfo.methodLabel}(${installInfo.detail})`
  );

  // (b) sshd_config 关键项
  log.info("sshd_config 关键项");
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message(`    未找到 sshd_config: ${SSHD_CONFIG_PATH}`);
    issues.push(
      `[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务(生成 sshd_config)`
    );
  } else {
    const configContent = readFileSync(SSHD_CONFIG_PATH, "utf8");
    const configLines = configContent.split(/\r?\n/);

    // PubkeyAuthentication
    const pubKeyLine = findActiveConfigLine(
      configLines,
      /^\s*PubkeyAuthentication\s+/i
    );
    const pubKeyOk = pubKeyLine && /yes/i.test(pubKeyLine.trim());
    log.message(
      `    PubkeyAuthentication: ${pubKeyLine?.trim() ?? "(未设置，需为 yes)"}`
    );
    if (!pubKeyOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (PubkeyAuthentication yes)`);

    // AuthorizedKeysFile
    const authKeysLine = findActiveConfigLine(
      configLines,
      /^\s*AuthorizedKeysFile\s+/i
    );
    const authKeysOk =
      authKeysLine && authKeysLine.includes(".ssh/authorized_keys");
    log.message(
      `    AuthorizedKeysFile: ${authKeysLine?.trim() ?? "(未设置)"}`
    );
    if (!authKeysOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (AuthorizedKeysFile)`);

    // Match Group administrators（非注释行存在 = 仍激活）
    const matchAdminLine = findActiveConfigLine(
      configLines,
      /^\s*Match\s+Group\s+administrators/i
    );
    const matchAdminOk = !matchAdminLine;
    log.message(
      `    Match Group administrators: ${matchAdminOk ? "已禁用" : "仍激活（" + matchAdminLine.trim() + "）"}`
    );
    if (!matchAdminOk)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (禁用 administrators 分组)`);
  }

  // (c) authorized_keys 状态
  log.info("authorized_keys 状态");
  const akPath = join(homedir(), ".ssh", "authorized_keys");
  if (!existsSync(akPath)) {
    log.message(`    不存在: ${akPath}`);
    log.message("    公钥条数: 0");
    issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (写入 authorized_keys)`);
  } else {
    const akContent = readFileSync(akPath, "utf8");
    const keyCount = akContent
      .split(/\r?\n/)
      .filter((l) => PUBKEY_LINE_RE.test(l)).length;
    const hasKeys = keyCount > 0;
    log.message(`    路径: ${akPath}`);
    log.message(`    公钥条数: ${keyCount}`);
    if (!hasKeys)
      issues.push(`[${MENU_CONFIG_SSHD}] 配置 sshd (authorized_keys 为空)`);
  }

  // (d) 本地公钥状态
  log.info("本地公钥状态");
  const localPubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  const pubExists = existsSync(localPubPath);
  log.message(`    ${pubExists ? "存在" : "不存在"}: ${localPubPath}`);
  if (!pubExists) issues.push(`[${MENU_GENERATE_KEY}] 编译服务器生成密钥对`);

  // 汇总结论
  if (issues.length === 0) {
    log.success("配置就绪，可尝试从 Linux 免密登录");
  } else {
    log.message(`    存在 ${issues.length} 项异常，建议依次执行：`);
    // 去重（同一菜单项可能被多次建议）
    const unique = Array.from(new Set(issues));
    for (const item of unique) {
      log.message(`    ${item}`);
    }
  }
}
