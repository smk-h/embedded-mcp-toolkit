/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : local-key.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 步骤 1: Windows 本地生成密钥对并写入 authorized_keys
 *
 * 与 sshd-config 的 [3]（在 Linux 编译服务器生成密钥）方向相反：本步骤在
 * **Windows 本机**生成 CNB 专用密钥对（id_mcp_cnb_server），公钥追加进本机
 * ~/.ssh/authorized_keys，私钥随后由 push-key 步骤推送到 CNB 容器——于是
 * 容器持有私钥、Windows 持有对应公钥，形成"容器 → Windows"的免密通道。
 * ======================================================
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { log } from "@clack/prompts";

import { runCmd } from "../../../shared/exec.js";
import { appendAuthorizedKey } from "../../sshd-config/authorized-keys.js";
import { LOCAL_KEY_REL, LOCAL_PUBKEY_REL } from "../constants.js";
import { type LocalKeyResult } from "../types.js";

// ============================================================
// 步骤 1: 生成密钥对 + 写 authorized_keys
// ============================================================

/**
 * @brief 在 Windows 本地生成 CNB 专用密钥对，并把公钥写入本机 authorized_keys
 * @details 流程：
 *          1. 密钥对已存在（私钥 + 公钥齐全）→ 复用，不重复生成；
 *          2. 仅存在其一（不完整）→ 先清理再生成，避免 ssh-keygen 触发交互式
 *             "Overwrite (y/n)?" 确认（execFile 无法回应 stdin，会卡死）；
 *          3. 调用本机 ssh-keygen 生成 rsa 4096 无口令密钥；
 *          4. 公钥内容追加到 ~/.ssh/authorized_keys（按内容去重）。
 *          复用 sshd-config 的 appendAuthorizedKey，与既有免密流程保持同一份
 *          authorized_keys 维护逻辑。
 * @returns 生成结果（含公钥内容）；ssh-keygen 不可用或执行失败返回 null
 */
export async function doLocalKey(): Promise<LocalKeyResult | null> {
  log.info("生成本地 CNB 专用密钥对 ...");

  const keyPath = resolve(process.cwd(), LOCAL_KEY_REL);
  const pubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  const hasKeyPair = existsSync(keyPath) && existsSync(pubPath);

  if (hasKeyPair) {
    log.message(`    复用已有密钥: ${keyPath}`);
  } else {
    // 半残密钥对（仅私钥或仅公钥）会让 ssh-keygen 停在覆盖确认上，先清理
    if (existsSync(keyPath) || existsSync(pubPath)) {
      rmSync(keyPath, { force: true });
      rmSync(pubPath, { force: true });
      log.message("    检测到不完整密钥对，已清理后重新生成");
    }

    const keyDir = dirname(keyPath);
    if (!existsSync(keyDir)) {
      mkdirSync(keyDir, { recursive: true });
    }

    const generated = await runCmd(
      "ssh-keygen",
      ["-t", "rsa", "-b", "4096", "-N", "", "-C", "mcp-cnb", "-f", keyPath],
      120000
    );
    if (!generated.success || !existsSync(keyPath) || !existsSync(pubPath)) {
      log.message(`    ssh-keygen 执行失败: ${generated.stderr || "未知错误"}`);
      log.message("    请确认本机已安装 OpenSSH 客户端（ssh-keygen 可用）");
      return null;
    }
    log.message(`    已生成私钥: ${keyPath}`);
  }

  // 公钥追加进本机 authorized_keys：容器持私钥即可免密登录本机
  const pubKey = readFileSync(pubPath, "utf8").trim();
  if (!pubKey) {
    log.message(`    公钥内容为空: ${pubPath}`);
    return null;
  }
  log.info("写入本机 authorized_keys ...");
  appendAuthorizedKey(pubKey);

  return { keyPath, pubPath, pubKey };
}

/**
 * @brief 读取本地私钥内容（换行统一为 LF）
 * @details Windows 生成的私钥可能带 CRLF；虽然 OpenSSH 的 PEM 解析容忍 \r，
 *          但推送前归一化可避免远端工具链的边界差异。
 * @returns 私钥文本（LF 换行）；文件不存在返回 null
 */
export function readLocalPrivateKey(): string | null {
  const keyPath = resolve(process.cwd(), LOCAL_KEY_REL);
  if (!existsSync(keyPath)) {
    return null;
  }
  return readFileSync(keyPath, "utf8").replace(/\r\n/g, "\n");
}
