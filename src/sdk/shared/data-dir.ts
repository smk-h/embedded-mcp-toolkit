/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : data-dir.ts
 * Author     : sumu
 * Date       : 2026/09/08
 * Version    : x.x.x
 * Description: 数据目录解析模块
 *
 *   统一解析 .embedded 数据目录与传输暂存目录（.embedded/tmp），
 *   作为 ZMODEM 下载 / SFTP 下载 / scp 跨机推送三类文件通道的
 *   默认落盘位置（用户未显式指定路径时）。
 *
 *   - EMBEDDED_DATA_DIR 环境变量可覆盖数据目录根（非标准部署逃生口）
 *   - 默认根 = cwd/.embedded，与 BOARD_CONFIG_PATH / LOG_DIR 等
 *     既有环境变量的"相对 cwd"约定一致（启动脚本已把 cwd 锚定项目根）
 *   - tmp 目录保证存在：ensure 一次后 scp 推送 / fastGet 落盘不缺目录
 * ======================================================
 */

import { mkdirSync } from "fs";
import { basename, join, resolve } from "path";

/** 数据目录根下的传输暂存子目录名 */
const TMP_SUBDIR = "tmp";

/**
 * @brief 解析数据目录根（不创建）
 * @details 优先 EMBEDDED_DATA_DIR 环境变量（绝对或相对 cwd 均可），
 *          缺省回落 cwd/.embedded。仅做路径解析，不触碰文件系统，
 *          供仅需展示路径的场景（instructions 文案等）使用。
 * @returns 数据目录根的绝对路径
 */
export function resolveEmbeddedRoot(): string {
  const configured = process.env.EMBEDDED_DATA_DIR;
  if (configured && configured.trim() !== "") {
    return resolve(configured);
  }
  return resolve(process.cwd(), ".embedded");
}

/**
 * @brief 解析传输暂存目录（.embedded/tmp）的绝对路径（不创建）
 * @returns 传输暂存目录的绝对路径
 */
export function resolveTransferTmpDir(): string {
  return join(resolveEmbeddedRoot(), TMP_SUBDIR);
}

/**
 * @brief 解析传输暂存目录并确保其存在
 * @details mkdirSync recursive 幂等：目录已存在时不报错、不改动内容。
 *          下载工具缺省路径与 MCP 启动预检都走这里，保证落盘前目录必在。
 *          创建失败（权限等）不吞异常，由调用方决定日志与兜底行为。
 * @returns 传输暂存目录的绝对路径
 */
export function ensureTransferTmpDir(): string {
  const dir = resolveTransferTmpDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @brief 为下载工具构造缺省本地落盘路径
 * @details 用户未指定 local_path 时调用。文件名取远端路径的 basename
 *          （与设备端命名保持一致，AI 客户端好对应）；basename 为空
 *          （remote_path 为空串）或已是 tmp 目录本身时用
 *          download-<时间戳> 兜底，避免落到目录路径上。
 *          路径形如：<数据根>/tmp/<remote_basename>
 * @param remotePath 远端源文件路径（仅取其 basename）
 * @returns tmp 目录下的本地目标文件绝对路径
 */
export function defaultDownloadLocalPath(remotePath: string): string {
  // path.basename 会剥掉尾部分隔符（"/data/backup/" → "backup"），
  // 再剥一次内层（"/data/" → "data" → "backup" 不会发生，但显式 trim 分隔符
  // 保证空串以外的纯分隔串也走兜底名）
  const name = basename(remotePath).replace(/[\\/]+$/, "");
  const fallback = `download-${Date.now().toString().slice(-9)}`;
  return join(ensureTransferTmpDir(), name !== "" ? name : fallback);
}
