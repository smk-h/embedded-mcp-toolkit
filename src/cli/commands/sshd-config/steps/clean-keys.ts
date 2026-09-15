/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : clean-keys.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [9]: 清理 authorized_keys 失效公钥
 * ======================================================
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { confirm, isCancel, log, multiselect } from "@clack/prompts";

import { LOCAL_PUBKEY_REL } from "../constants.js";
import {
  authorizedKeysPath,
  readAuthorizedKeyEntries,
  removeAuthorizedKeyEntries,
  type AuthorizedKeyEntry,
} from "../authorized-keys.js";

// ============================================================
// 菜单 [9]: 清理 authorized_keys 失效公钥
// ============================================================

/**
 * @brief 交互式清理 ~/.ssh/authorized_keys 中的失效公钥
 * @details 场景：CNB 等临时容器环境每次重建都会生成新密钥并把公钥追加进
 *          authorized_keys，失效公钥随之累积。本步骤列出全部公钥条目
 *          （类型 + SHA256 指纹 + 行尾注释 user@host），多选勾选后批量删除：
 *          1. 解析 authorized_keys 全部公钥条目（无条目则无需清理）
 *          2. 标记与 .embedded/ssh/id_mcp_server.pub 一致的"当前生效"条目
 *          3. multiselect 勾选待删条目，confirm 确认（含当前生效条目时附加警告）
 *          4. 批量精确匹配删除并重写文件，未选中条目不受影响
 *          文件读写全部委托 authorized-keys.ts，本文件只负责流程编排与交互。
 * @returns 实际删除了公钥返回 true
 */
export async function doCleanKeys(): Promise<boolean> {
  log.info("清理 authorized_keys 失效公钥 ...");

  const akPath = authorizedKeysPath();
  const entries = readAuthorizedKeyEntries();
  if (entries.length === 0) {
    log.message(`    ${akPath} 不存在或没有任何公钥，无需清理`);
    return false;
  }
  log.message(`    文件: ${akPath}`);
  log.message(`    共 ${entries.length} 条公钥`);

  // 当前生效公钥（.embedded/ssh/id_mcp_server.pub）：一致条目标记，删除前额外警告
  const activePubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  const activePubKey = existsSync(activePubPath)
    ? readFileSync(activePubPath, "utf8").trim()
    : "";
  const isActive = (entry: AuthorizedKeyEntry): boolean =>
    activePubKey !== "" && entry.line === activePubKey;

  // 勾选待删条目（value 用条目在数组中的下标，避免行内容重复时冲突）
  const selected = await multiselect<number>({
    message: "选择要删除的公钥（空格勾选，Enter 确认）",
    required: false,
    options: entries.map((entry, index) => ({
      value: index,
      label: `${entry.type}  ${entry.fingerprint}  ${
        entry.comment || "(无注释)"
      }${isActive(entry) ? "  (当前生效)" : ""}`,
    })),
  });
  if (isCancel(selected) || selected.length === 0) {
    log.message("    未选择任何条目，已取消");
    return false;
  }

  // 确认删除；勾选了当前生效条目时给出断连警告
  const selectedEntries = selected.map((i) => entries[i]);
  const hasActive = selectedEntries.some(isActive);
  const confirmed = await confirm({
    message: hasActive
      ? `将删除 ${selectedEntries.length} 条公钥，其中包含当前生效条目（删除后远端将无法免密登录），确认?`
      : `将从 authorized_keys 删除 ${selectedEntries.length} 条公钥，确认?`,
    active: "删除",
    inactive: "取消",
    initialValue: false,
  });
  if (isCancel(confirmed) || !confirmed) {
    log.message("    已取消");
    return false;
  }

  // 批量精确匹配删除并汇报
  const removed = removeAuthorizedKeyEntries(
    selectedEntries.map((e) => e.line)
  );
  if (removed === 0) {
    log.message("    未匹配到待删除条目（文件可能已被外部修改）");
    return false;
  }
  log.message(`    已删除 ${removed} 条公钥，剩余 ${entries.length - removed} 条`);
  log.success("authorized_keys 清理完成");
  return true;
}
