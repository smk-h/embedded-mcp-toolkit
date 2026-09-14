/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tunnel-detect.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 可执行文件探测（只读）
 *
 * 按优先级探测 cloudflared.exe：项目内便携版 → 系统安装路径 → PATH。
 * 只做探测不做安装，安装入口见 steps/install.ts。
 * ======================================================
 */

import { existsSync } from "fs";
import { resolve } from "path";

import { runCmd } from "../../shared/exec.js";
import {
  CLOUDFLARED_EXE_CANDIDATES,
  PORTABLE_EXE_REL,
} from "./constants.js";
import { type CloudflaredDetectResult } from "./types.js";

// ============================================================
// cloudflared 可执行文件探测
// ============================================================

/**
 * @brief 按优先级探测 cloudflared 可执行文件
 * @details 三级探测：
 *          (a) 项目内便携版 .embedded/bin/cloudflared.exe（install 菜单的落点，
 *              随项目走，优先级最高）；
 *          (b) 系统安装路径候选（winget / MSI 的默认落点）；
 *          (c) `where cloudflared` 查 PATH（scoop、手工加入 PATH 等场景）。
 *          全部未命中返回 source="none"，由调用方引导用户进入安装菜单。
 * @returns 探测结果（exePath + 命中来源）
 */
export async function findCloudflaredExe(): Promise<CloudflaredDetectResult> {
  // (a) 项目内便携版
  const portable = resolve(process.cwd(), PORTABLE_EXE_REL);
  if (existsSync(portable)) {
    return { exePath: portable, source: "embedded" };
  }

  // (b) 系统安装路径候选
  for (const candidate of CLOUDFLARED_EXE_CANDIDATES) {
    if (existsSync(candidate)) {
      return { exePath: candidate, source: "installed" };
    }
  }

  // (c) PATH 探测（where 逐行列出全部命中，取第一个）
  const where = await runCmd("where", ["cloudflared"], 15000);
  if (where.success) {
    const first = where.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (first) {
      return { exePath: first, source: "path" };
    }
  }

  return { exePath: null, source: "none" };
}
