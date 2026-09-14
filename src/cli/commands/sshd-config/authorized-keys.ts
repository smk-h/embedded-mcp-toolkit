/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : authorized-keys.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: authorized_keys 读写辅助
 *
 * 集中 Windows 端 ~/.ssh/authorized_keys 的公钥维护：
 *   - appendAuthorizedKey  写入 MCP 专用公钥（按内容去重）
 *   - removeAuthorizedKey  按内容精确匹配移除公钥行
 * 供配置步骤（写入）与卸载步骤（移除）对称复用，避免同一文件的增删散落两处。
 * ======================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "@clack/prompts";

// ============================================================
// authorized_keys 读写
// ============================================================

/**
 * @brief 获取 Windows 端 authorized_keys 的绝对路径
 * @returns ~/.ssh/authorized_keys 的绝对路径
 */
function authorizedKeysPath(): string {
  return join(homedir(), ".ssh", "authorized_keys");
}

/**
 * @brief 把公钥追加到 ~/.ssh/authorized_keys（按内容去重）
 * @details 目录不存在时自动创建；公钥已存在时跳过；追加前确保原文末尾有换行，
 *          避免与最后一行粘连。整行 trim 后精确比对，不做模糊匹配。
 * @param pubKey 公钥内容（单行，调用方已 trim）
 * @returns true=本次已写入；false=已存在（跳过）
 */
export function appendAuthorizedKey(pubKey: string): boolean {
  const sshDir = join(homedir(), ".ssh");
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true });
    log.message(`    创建目录: ${sshDir}`);
  }

  const akPath = authorizedKeysPath();
  const existingContent = existsSync(akPath)
    ? readFileSync(akPath, "utf8")
    : "";
  const existingLines = existingContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

  if (existingLines.includes(pubKey)) {
    log.message("    公钥已存在于 authorized_keys, 跳过");
    return false;
  }

  // 确保末尾有换行再追加
  const prefix =
    existingContent === "" || existingContent.endsWith("\n")
      ? existingContent
      : existingContent + "\n";
  writeFileSync(akPath, prefix + pubKey + "\n", "utf8");
  log.message(`    公钥已写入: ${akPath}`);
  return true;
}

/**
 * @brief 从 ~/.ssh/authorized_keys 移除指定公钥
 * @details 按整行 trim 后与公钥内容精确匹配删除对应行，保留其它公钥不受影响。
 *          文件不存在或未匹配到时静默跳过（非错误，可能未执行过写入步骤）。
 * @param pubKey 待移除的公钥内容（单行，调用方已 trim）
 * @returns 实际移除的行数（0 表示未匹配到）
 */
export function removeAuthorizedKey(pubKey: string): number {
  const akPath = authorizedKeysPath();
  if (!existsSync(akPath)) {
    log.message("    authorized_keys 不存在，无需清理");
    return 0;
  }

  const akContent = readFileSync(akPath, "utf8");
  const lines = akContent.split(/\r?\n/);
  // 精确匹配：整行 trim 后等于公钥的行视为需删除
  const before = lines.length;
  const filtered = lines.filter((l) => l.trim() !== pubKey);
  const removed = before - filtered.length;

  if (removed === 0) {
    log.message("    authorized_keys 中未找到 MCP 公钥，无需清理");
    return 0;
  }

  // 重写文件（过滤掉空行尾部的多余换行）
  const newContent = filtered.filter((l) => l.trim() !== "").join("\n");
  if (newContent) {
    writeFileSync(akPath, newContent + "\n", "utf8");
  } else {
    // 所有公钥都被移除，文件变空——保留空文件而非删除（避免权限丢失）
    writeFileSync(akPath, "", "utf8");
  }
  log.message(`    已从 authorized_keys 移除 MCP 公钥（${removed} 条）`);
  return removed;
}
