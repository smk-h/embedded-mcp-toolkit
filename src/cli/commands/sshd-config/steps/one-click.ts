/**
 * @file src/cli/commands/sshd-config/steps/one-click.ts
 * @brief step8: 一键完成全流程
 */

import { log } from "@clack/prompts";

import { doInstallSsh } from "./install.js";
import { doGenerateKey } from "./generate-key.js";
import { doConfigSshd } from "./config-sshd.js";
import { doGenerateTemplate } from "./gen-template.js";

// ============================================================
// step8: 一键完成全流程
// ============================================================

/**
 * @brief 一键完成全流程：安装 → 生成密钥 → 配置 sshd → 生成模板
 * @details 顺序调用四个 step 函数，任一步返回 false 即中止并提示。
 *          安装方式选择（MSI / 在线）仍会交互式询问。
 * @returns 整体是否全部成功完成
 */
export async function doOneClickFlow(): Promise<boolean> {
  log.info("一键完成全流程 ...");

  if (!(await doInstallSsh())) {
    log.message("    安装步骤未完成，中止流程");
    return false;
  }
  if (!(await doGenerateKey())) {
    log.message("    生成密钥步骤未完成，中止流程");
    return false;
  }
  if (!(await doConfigSshd())) {
    log.message("    配置 sshd 步骤未完成，中止流程");
    return false;
  }
  if (!(await doGenerateTemplate())) {
    log.message("    生成模板步骤未完成，中止流程");
    return false;
  }

  log.success("全流程已完成，可从 Linux 免密登录 Windows");
  return true;
}
