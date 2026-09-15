/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tunnel-state.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: Quick Tunnel 运行状态的持久化读写
 *
 * CLI 进程退出后，后台 cloudflared 进程仍独立常驻；状态文件
 * (.embedded/cloudflared/state.json) 是跨进程衔接的唯一凭据：
 * pid 供存活探测与停止、logFile 供域名补扫、url 供展示。
 * ======================================================
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

import { STATE_FILE_REL } from "./constants.js";
import { type TunnelState } from "./types.js";
import { resolveWorkspacePath } from "./workspace-paths.js";

// ============================================================
// 状态文件读写
// ============================================================

/**
 * @brief 解析状态文件绝对路径（不创建）
 * @returns 状态文件绝对路径（相对工作区根解析——后台隧道跨 CLI 进程存活，
 *          路径不得随执行时的 cwd 漂移，否则换目录执行会读不到原状态）
 */
export function resolveStateFile(): string {
  return resolveWorkspacePath(STATE_FILE_REL);
}

/**
 * @brief 读取隧道运行状态
 * @details 文件不存在或内容损坏（JSON 解析失败）统一返回 null，由调用方
 *          按"从未启动"处理；损坏文件会在下次 writeTunnelState 时被覆盖。
 * @returns 状态对象；无状态文件或解析失败返回 null
 */
export function readTunnelState(): TunnelState | null {
  const file = resolveStateFile();
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as TunnelState;
  } catch {
    return null;
  }
}

/**
 * @brief 写入隧道运行状态（自动创建父目录，幂等）
 * @param state 状态对象
 */
export function writeTunnelState(state: TunnelState): void {
  const file = resolveStateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * @brief 清理隧道运行状态文件（存在才删，幂等）
 * @details 停止成功或进程已死时调用，避免残留 pid 指向无关进程。
 */
export function clearTunnelState(): void {
  const file = resolveStateFile();
  if (existsSync(file)) {
    rmSync(file);
  }
}
