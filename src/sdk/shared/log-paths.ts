/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : log-paths.ts
 * Author     : embedded-mcp-toolkit
 * Date       : 2026/08/23
 * Version    : 1.0.0
 * Description: 日志目录解析模块
 *
 *   基于 MCP 进程工作目录（process.cwd）与 LOG_SAVE / LOG_DIR / SAVE2FILE_PATH
 *   环境变量，解析出业务日志与原始数据日志的保存根目录（绝对路径），并标注
 *   每条通道是否启用。供 host_info 工具暴露"日志保存目录"使用，帮助 AI 客户端
 *   拿到绝对路径后用 power_shell / scp 自行完成日志清理，避免相对路径依赖 cwd
 *   在跨机部署下难以定位的问题。
 * ======================================================
 */

import { resolve } from "path";

// ── 类型定义 ────────────────────────────────────────────────

/**
 * @brief 单条日志通道的解析结果
 * @details enabled 表示该通道是否实际落盘（业务日志看 LOG_SAVE，原始数据日志看
 *          SAVE2FILE_PATH 是否置位）；dir 为绝对路径（相对 cwd 解析），未启用时
 *          仍给 dir，便于客户端了解"若启用会写到哪"。
 */
export interface LogChannel {
  enabled: boolean; // 该通道是否启用文件落盘
  dir: string; // 日志保存目录（绝对路径，基于 cwd 解析）
}

/**
 * @brief 日志目录整体解析结果
 * @details cwd 为 MCP 进程工作目录；business 为业务日志通道（LOG_SAVE + LOG_DIR）；
 *          rawData 为原始数据日志通道（SAVE2FILE_PATH）。
 */
export interface LogPaths {
  cwd: string; // MCP 进程工作目录（绝对路径）
  business: LogChannel; // 业务日志通道
  rawData: LogChannel; // 原始数据日志通道
}

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * @brief 判定 LOG_SAVE 是否为真值
 * @details 与 logger.ts ensureInit() 口径一致：仅 "1" / "true" 视为启用文件保存。
 * @param value LOG_SAVE 环境变量原始值（可能为 undefined）
 * @returns 启用返回 true
 */
function isLogSaveEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * @brief 判定 SAVE2FILE_PATH 是否置位
 * @details 与 file-logger.ts enableFromEnv() 口径一致：值为 "none" 或空（undefined/空串）
 *          时视为未启用；其余任何非空值（含相对路径）视为启用。
 * @param value SAVE2FILE_PATH 环境变量原始值（可能为 undefined）
 * @returns 启用返回 true
 */
function isRawDataEnabled(value: string | undefined): boolean {
  return !!value && value !== "none";
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * @brief 解析日志保存目录（含绝对路径与启用状态）
 * @details 解析规则：
 *          1. cwd = process.cwd()，即 MCP 进程工作目录（相对路径解析基准）
 *          2. 业务日志：dir = resolve(LOG_DIR ?? "./log")；enabled = LOG_SAVE 为真值
 *          3. 原始数据日志：dir = resolve(SAVE2FILE_PATH)（未置位时以空目录占位）；
 *             enabled = SAVE2FILE_PATH 非空且非 "none"
 *          两条通道独立启用，互不影响。
 * @returns 结构化日志目录信息；本函数不依赖文件系统状态，仅依据环境变量与 cwd
 */
export function resolveLogPaths(): LogPaths {
  const cwd = process.cwd();

  // 业务日志通道：LOG_DIR 默认 "./log"（与 logger.ts 口径一致），resolve 成绝对路径
  const businessDir = resolve(process.env.LOG_DIR ?? "./log");

  // 原始数据日志通道：SAVE2FILE_PATH 未置位或为 "none" 时视为未启用，目录以 cwd 占位
  // （实际不会写文件）；否则 resolve 成绝对路径
  const rawDirValue = process.env.SAVE2FILE_PATH ?? "";
  const rawDataDir =
    rawDirValue && rawDirValue !== "none" ? resolve(rawDirValue) : cwd;

  return {
    cwd,
    business: {
      enabled: isLogSaveEnabled(process.env.LOG_SAVE),
      dir: businessDir,
    },
    rawData: {
      enabled: isRawDataEnabled(process.env.SAVE2FILE_PATH),
      dir: rawDataDir,
    },
  };
}
