/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : install.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [5]: 安装 cloudflared（检测 / winget / 便携版）
 *
 * 已安装则只打印路径；未安装时提供两种安装途径：
 * winget（系统级安装）或下载便携版 exe 到 .embedded/bin（随项目走）。
 * ======================================================
 */

import { mkdirSync } from "fs";
import { resolve } from "path";

import { log, select, isCancel } from "@clack/prompts";

import { runCmd, runPowerShell } from "../../../shared/exec.js";
import { downloadFile } from "../../../shared/download.js";
import {
  CLOUDFLARED_PORTABLE_URL,
  MENU_INSTALL,
  PORTABLE_EXE_REL,
} from "../constants.js";
import { findCloudflaredExe } from "../tunnel-detect.js";

// ============================================================
// 安装途径菜单值
// ============================================================

/** @brief 安装途径：winget 系统级安装 */
export const INSTALL_WINGET = "1";
/** @brief 安装途径：下载便携版到 .embedded/bin */
export const INSTALL_PORTABLE = "2";
/** @brief 安装途径：返回 */
export const INSTALL_CANCEL = "0";

/** @brief 安装途径菜单可选 value 联合类型 */
export type InstallChoice =
  | typeof INSTALL_WINGET
  | typeof INSTALL_PORTABLE
  | typeof INSTALL_CANCEL;

// ============================================================
// 菜单 [5]: 安装 cloudflared
// ============================================================

/**
 * @brief 检测并按需安装 cloudflared
 * @details 已安装（含便携版/系统路径/PATH 命中）时打印路径直接返回；
 *          未安装时提供两种途径：
 *          (a) winget：系统级安装，装完落在 Program Files (x86)；
 *          (b) 便携版：下载 GitHub releases 最新版到 .embedded/bin，
 *              不污染系统、随项目走（探测优先级最高）。
 *          安装完成后统一用 `cloudflared --version` 验证可执行性。
 * @returns 安装（或已安装）成功返回 true
 */
export async function doInstall(): Promise<boolean> {
  // (1) 已安装检测
  const detected = await findCloudflaredExe();
  if (detected.exePath) {
    log.success(`cloudflared 已安装: ${detected.exePath}(来源: ${detected.source})`);
    return true;
  }

  // (2) 选择安装途径
  log.warn(`未检测到 cloudflared(${MENU_INSTALL} 号菜单触发安装)`);
  const choice = await select<InstallChoice>({
    message: "选择 cloudflared 安装方式",
    options: [
      {
        value: INSTALL_WINGET,
        label: `[${INSTALL_WINGET}] winget 安装(系统级,需已安装 winget)`,
      },
      {
        value: INSTALL_PORTABLE,
        label: `[${INSTALL_PORTABLE}] 下载便携版到 ${PORTABLE_EXE_REL}(不污染系统)`,
      },
      { value: INSTALL_CANCEL, label: `[${INSTALL_CANCEL}] 返回` },
    ],
  });
  if (isCancel(choice) || choice === INSTALL_CANCEL) {
    return false;
  }

  // (3a) winget 安装
  if (choice === INSTALL_WINGET) {
    log.info("通过 winget 安装 cloudflared(可能需要几分钟)...");
    const result = await runPowerShell(
      "winget install --id Cloudflare.cloudflared " +
        "--accept-source-agreements --accept-package-agreements --silent"
    );
    if (!result.success) {
      log.error(`winget 安装失败: ${result.stderr.trim() || result.stdout.trim()}`);
      log.message("    可改选便携版下载,或到 https://developers.cloudflare.com/cloudflare/one connections/ 下载");
      return false;
    }
  }

  // (3b) 便携版下载
  if (choice === INSTALL_PORTABLE) {
    const dest = resolve(process.cwd(), PORTABLE_EXE_REL);
    mkdirSync(resolve(dest, ".."), { recursive: true });
    log.info(`下载便携版到 ${dest} ...`);
    try {
      await downloadFile(CLOUDFLARED_PORTABLE_URL, dest);
    } catch (error) {
      log.error(
        `下载失败: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  // (4) 验证可执行性
  const verify = await findCloudflaredExe();
  if (!verify.exePath) {
    log.error("安装后仍未探测到 cloudflared(当前进程的 PATH 可能未刷新,重开终端后重试)");
    return false;
  }
  const version = await runCmd(verify.exePath, ["--version"], 30000);
  if (!version.success) {
    log.error("cloudflared --version 执行失败,安装产物可能不完整");
    return false;
  }
  log.success(`安装完成: ${verify.exePath}(${version.stdout.trim()})`);
  return true;
}
