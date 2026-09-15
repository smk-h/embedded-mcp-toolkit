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
 *   - appendAuthorizedKey        写入 MCP 专用公钥（按内容去重）
 *   - removeAuthorizedKey        按内容精确匹配移除公钥行
 *   - readAuthorizedKeyEntries   解析全部公钥条目（类型/指纹/注释）
 *   - removeAuthorizedKeyEntries 按条目批量移除公钥行
 * 供配置步骤（写入）、卸载步骤（移除）与清理步骤（列出/批量删除）复用，
 * 避免同一文件的增删散落多处。
 * ======================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { log } from "@clack/prompts";

import { PUBKEY_LINE_RE } from "./constants.js";

// ============================================================
// authorized_keys 读写
// ============================================================

/**
 * @brief 获取 Windows 端 authorized_keys 的绝对路径
 * @returns ~/.ssh/authorized_keys 的绝对路径
 */
export function authorizedKeysPath(): string {
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

// ============================================================
// 公钥条目解析与批量清理
// ============================================================

/**
 * @brief authorized_keys 中的单条公钥条目
 * @param lineNumber 行号（0 起，对应原始文件行顺序）
 * @param type       密钥类型（ssh-rsa / ssh-ed25519 / ecdsa-sha2-... 等）
 * @param fingerprint SHA256 指纹（ssh-keygen -lf 风格，如 SHA256:AbCd...），
 *                    解析失败时为 "(unknown)"
 * @param comment    行尾注释（通常是 user@host），缺失时为空串
 * @param line       原始行内容（trim 后）
 */
export interface AuthorizedKeyEntry {
  lineNumber: number;
  type: string;
  fingerprint: string;
  comment: string;
  line: string;
}

/**
 * @brief 计算公钥的 SHA256 指纹（对齐 ssh-keygen -lf 输出格式）
 * @details 对 base64 解码后的密钥数据取 SHA256，再 base64 编码并去掉 padding，
 *          与 `ssh-keygen -lf` 显示的 SHA256:xxx 一致，便于用户用系统工具核对。
 * @param keyBase64 公钥行的 base64 数据段
 * @returns "SHA256:..." 形式的指纹；解码失败返回 null
 */
function keyFingerprint(keyBase64: string): string | null {
  const blob = Buffer.from(keyBase64, "base64");
  // base64 解码静默失败时不报错但内容失真，用长度粗筛明显非法的输入
  if (blob.length === 0) {
    return null;
  }
  const digest = createHash("sha256").update(blob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * @brief 解析 authorized_keys 中的全部公钥条目
 * @details 只保留匹配 PUBKEY_LINE_RE 的公钥行（跳过注释与空行），逐条解析出
 *          密钥类型、行尾注释与 SHA256 指纹。文件不存在时返回空数组。
 *          注释可能重复（CNB 每次重建容器用户名/主机名可能相同），指纹是
 *          区分条目的可靠依据。
 * @returns 公钥条目数组（按文件行顺序）
 */
export function readAuthorizedKeyEntries(): AuthorizedKeyEntry[] {
  const akPath = authorizedKeysPath();
  if (!existsSync(akPath)) {
    return [];
  }

  const content = readFileSync(akPath, "utf8");
  const entries: AuthorizedKeyEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!PUBKEY_LINE_RE.test(line)) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const type = tokens[0] ?? "";
    const keyBase64 = tokens[1] ?? "";
    // 注释 = base64 段之后的剩余部分（可能含空格，重新拼接）
    const comment = tokens.slice(2).join(" ");
    const fingerprint = keyFingerprint(keyBase64) ?? "(unknown)";
    entries.push({ lineNumber: i, type, fingerprint, comment, line });
  }
  return entries;
}

/**
 * @brief 从 authorized_keys 批量移除指定公钥行
 * @details 按整行 trim 后与待删行精确匹配删除，未选中的条目（含注释行、空行
 *          以外的内容）保持原顺序不受影响。文件不存在或未匹配到时返回 0。
 * @param removeLines 待删除的公钥行内容（trim 后的单行，来自条目的 line 字段）
 * @returns 实际移除的行数
 */
export function removeAuthorizedKeyEntries(removeLines: string[]): number {
  const akPath = authorizedKeysPath();
  if (!existsSync(akPath) || removeLines.length === 0) {
    return 0;
  }

  const removeSet = new Set(removeLines);
  const lines = readFileSync(akPath, "utf8").split(/\r?\n/);
  const filtered = lines.filter((l) => !removeSet.has(l.trim()));
  const removed = lines.length - filtered.length;
  if (removed === 0) {
    return 0;
  }

  // 重写文件（过滤掉空行尾部的多余换行）
  const newContent = filtered.filter((l) => l.trim() !== "").join("\n");
  if (newContent) {
    writeFileSync(akPath, newContent + "\n", "utf8");
  } else {
    // 全部公钥被移除——保留空文件而非删除（避免权限丢失）
    writeFileSync(akPath, "", "utf8");
  }
  return removed;
}
