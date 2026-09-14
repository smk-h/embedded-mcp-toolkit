/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sshd-service.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: sshd 服务注册（变更操作）
 *
 * 确保 Windows 端 sshd 服务已注册：服务不存在时用 `sshd.exe install` 补注册。
 * 只读探测（服务查询 / 安装方式判定）见 sshd-detect.ts。
 * ======================================================
 */

import { SSHD_EXE_CANDIDATES } from "./constants.js";
import { runCmd } from "../../shared/exec.js";
import { isSshdServiceRegistered, findSshdExe } from "./sshd-detect.js";

// ============================================================
// sshd 服务注册
// ============================================================

/**
 * @brief 确保 sshd 服务已注册
 * @details MSI 静默安装有时只释放文件不注册服务（当系统中已存在 OpenSSH 文件时尤其常见）。
 *          本函数先检查 `sshd` 服务是否存在，不存在则用 `sshd.exe install` 注册。
 * @returns true=服务已就绪（已注册或注册成功）；false=注册失败
 */
export async function ensureSshdService(): Promise<boolean> {
  // 先检查服务是否已注册
  if (await isSshdServiceRegistered()) {
    return true;
  }

  // 服务未注册，用 sshd.exe install 注册
  const sshdExe = findSshdExe();
  if (!sshdExe) {
    console.error("[err] 未找到 sshd.exe，无法注册服务");
    console.error(`     已尝试: ${SSHD_EXE_CANDIDATES.join(", ")}`);
    return false;
  }

  console.log(`[run] 注册 sshd 服务 (${sshdExe} install)...`);
  const installResult = await runCmd(sshdExe, ["install"]);
  if (!installResult.success) {
    console.error(
      `[err] 注册 sshd 服务失败: ${installResult.stderr || "未知错误"}`
    );
    return false;
  }
  console.log("[info] sshd 服务已注册");
  return true;
}
