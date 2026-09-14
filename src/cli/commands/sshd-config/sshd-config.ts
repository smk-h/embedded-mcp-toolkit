/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sshd-config.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: sshd_config 辅助（查找 / 修改 / 备份 / 恢复）
 *
 * 集中 Windows 端 C:\ProgramData\ssh\sshd_config 的全部读写逻辑：
 *   - findActiveConfigLine         查找未被注释的指令行（回显 / 诊断）
 *   - modifySshdConfig             开启公钥认证、指定 AuthorizedKeysFile、禁用 administrators 分组
 *   - backupSshdConfig             首次备份为 .bak（已存在不覆盖）
 *   - restoreSshdConfigFromBackup  从 .bak 恢复并删除备份（卸载回滚）
 * 供配置步骤（修改 + 备份）与卸载步骤（恢复）对称复用，避免同一文件的读写散落各处。
 * ======================================================
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
} from "fs";
import { log } from "@clack/prompts";

import { SSHD_CONFIG_PATH } from "./constants.js";

// ============================================================
// sshd_config 文本处理
// ============================================================

/**
 * @brief 在 sshd_config 行数组中查找匹配且未被注释的指令行
 * @details 统一配置步骤（回显最终配置）与检查步骤（检查配置）的指令行查找逻辑。
 *          注释行（以 # 开头）不视为有效指令。
 * @param lines   sshd_config 的行数组
 * @param pattern 指令匹配正则（匹配 trimmed 后的整行）
 * @returns 匹配到的行；未匹配返回 undefined
 */
export function findActiveConfigLine(
  lines: string[],
  pattern: RegExp
): string | undefined {
  return lines.find((l) => pattern.test(l.trim()) && !l.trim().startsWith("#"));
}

/**
 * @brief 修改 sshd_config 文本内容
 * @details 对 sshd_config 逐行处理：
 *          1. 确保 PubkeyAuthentication yes
 *          2. 确保 AuthorizedKeysFile .ssh/authorized_keys
 *          3. 注释掉 Match Group administrators 整段（含 Match 行及其下所有指令）
 *          缺失的指令在文件末尾追加。
 * @param content 原始 sshd_config 文本
 * @returns 修改后的文本
 */
export function modifySshdConfig(content: string): string {
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  let inMatchAdmin = false;
  let foundPubkey = false;
  let foundAuthKeys = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 已在 Match Group administrators 块内
    if (inMatchAdmin) {
      // 遇到新的 Match 指令 → 退出 admin 块（该行本身不注释，正常处理）
      if (/^Match\s+/i.test(trimmed) && !trimmed.startsWith("#")) {
        inMatchAdmin = false;
        // 不 continue，让该行走下面的正常处理
      } else {
        // 仍在 admin 块内，注释掉非空非注释行
        if (trimmed && !trimmed.startsWith("#")) {
          result.push("# " + line);
        } else {
          result.push(line);
        }
        continue;
      }
    }

    // 检测进入 Match Group administrators 块
    if (/^Match\s+Group\s+administrators/i.test(trimmed)) {
      inMatchAdmin = true;
      // 注释掉 Match 行本身
      result.push("# " + line);
      continue;
    }

    // 处理 PubkeyAuthentication
    if (
      /^\s*PubkeyAuthentication\s+/i.test(trimmed) &&
      !trimmed.startsWith("#")
    ) {
      result.push("PubkeyAuthentication yes");
      foundPubkey = true;
      continue;
    }

    // 处理 AuthorizedKeysFile
    if (
      /^\s*AuthorizedKeysFile\s+/i.test(trimmed) &&
      !trimmed.startsWith("#")
    ) {
      result.push("AuthorizedKeysFile .ssh/authorized_keys");
      foundAuthKeys = true;
      continue;
    }

    result.push(line);
  }

  // 追加缺失的指令
  if (!foundPubkey) {
    result.push("PubkeyAuthentication yes");
  }
  if (!foundAuthKeys) {
    result.push("AuthorizedKeysFile .ssh/authorized_keys");
  }

  return result.join("\n");
}

// ============================================================
// sshd_config 备份与恢复
// ============================================================

/**
 * @brief 备份 sshd_config 为 .bak（已存在不覆盖，保留首次备份）
 * @details 修改前调用，卸载时由 restoreSshdConfigFromBackup 恢复，两者成对使用。
 *          调用前应确认 sshd_config 存在。
 * @returns true=本次已生成备份；false=备份已存在（沿用首次备份）
 */
export function backupSshdConfig(): boolean {
  const bakPath = SSHD_CONFIG_PATH + ".bak";
  if (existsSync(bakPath)) {
    log.message(`    备份已存在，保留首次备份: ${bakPath}`);
    return false;
  }
  copyFileSync(SSHD_CONFIG_PATH, bakPath);
  log.message(`    已备份: ${bakPath}`);
  return true;
}

/**
 * @brief 从 .bak 备份恢复 sshd_config
 * @details 修改前备份为 .bak（首次备份不覆盖）。卸载时若 .bak 存在，则用它覆盖回
 *          sshd_config，恢复修改前的原始配置。恢复后删除 .bak（已完成使命）。
 *          sshd_config 不存在或 .bak 不存在时静默跳过。
 */
export function restoreSshdConfigFromBackup(): void {
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message("    sshd_config 不存在，跳过恢复");
    return;
  }
  const bakPath = SSHD_CONFIG_PATH + ".bak";
  if (!existsSync(bakPath)) {
    log.message("    未找到 sshd_config.bak 备份，跳过恢复");
    return;
  }
  try {
    copyFileSync(bakPath, SSHD_CONFIG_PATH);
    unlinkSync(bakPath);
    log.message("    sshd_config 已从备份恢复（.bak 已删除）");
  } catch (err) {
    log.message(
      `    [err] 恢复 sshd_config 失败: ${err instanceof Error ? err.message : err}`
    );
    log.message("    [info] 可手动执行: copy /Y sshd_config.bak sshd_config");
  }
}

/**
 * @brief 读取 sshd_config 文本内容
 * @details 统一读取入口，避免各步骤自行 readFileSync。
 * @returns sshd_config 文本；文件不存在时返回 null
 */
export function readSshdConfig(): string | null {
  if (!existsSync(SSHD_CONFIG_PATH)) {
    return null;
  }
  return readFileSync(SSHD_CONFIG_PATH, "utf8");
}

/**
 * @brief 写入 sshd_config 文本内容
 * @param content 待写入的完整文本
 */
export function writeSshdConfig(content: string): void {
  writeFileSync(SSHD_CONFIG_PATH, content, "utf8");
}
