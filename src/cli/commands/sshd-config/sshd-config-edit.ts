/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sshd-config-edit.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: sshd_config 辅助
 *
 * 在 sshd_config 行数组中查找匹配且未被注释的指令行、修改 sshd_config 文本内容。
 * 纯字符串处理，无外部依赖。
 * ======================================================
 */

// ============================================================
// sshd_config 辅助
// ============================================================

/**
 * @brief 在 sshd_config 行数组中查找匹配且未被注释的指令行
 * @details 统一 step3（回显最终配置）与 step4（检查配置）的指令行查找逻辑。
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
