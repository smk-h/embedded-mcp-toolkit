/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : workspace-paths.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 模块的工作区路径锚定（不随 cwd 漂移）
 *
 * 后台 cloudflared 进程的生命周期与 CLI 解耦，靠状态文件跨进程衔接；
 * 若状态/日志路径基于执行时的 cwd 解析，换目录执行 CLI 就读不到原状态，
 * 防重复启动随之失效，可能拉起第二条隧道。这里把 .embedded 相关路径
 * 统一锚定到"向上查找 .embedded 标记的工作区根"，找不到时兜底 cwd
 * （与历史行为一致，不改变"在项目根执行"这一常规用法的语义）。
 * ======================================================
 */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

/** @brief 工作区数据目录标记（init / MCP tmp 通道都可能创建，须与项目标记同时命中才认账） */
const WORKSPACE_MARKER = ".embedded";
/** @brief 项目根标记（Node 项目必有，用于排除子目录里游离的 .embedded） */
const PROJECT_MARKER = "package.json";

// ============================================================
// 工作区根解析
// ============================================================

/**
 * @brief 判定某目录是否为工作区根（双标记同时命中）
 * @details 只认 ".embedded + package.json 并存"的目录：MCP server 模式被
 *          拉起时会在 cwd 就地创建 .embedded/tmp（文件通道落点），CLI 若在
 *          子目录执行过也会留下游离的 .embedded——单标记会被这类嵌套目录
 *          截胡，把工作区根错判到子目录，故叠加项目标记排除。
 * @param dir 待判定目录
 * @returns 是工作区根返回 true
 */
function isWorkspaceRoot(dir: string): boolean {
  return (
    existsSync(resolve(dir, WORKSPACE_MARKER)) &&
    existsSync(resolve(dir, PROJECT_MARKER))
  );
}

/**
 * @brief 解析工作区根目录（从 cwd 起逐级向上查找双标记）
 * @details 命中规则：从 cwd 开始逐级向上，首个同时含 .embedded 与
 *          package.json 的目录即为工作区根——覆盖"在项目根执行"与"在子
 *          目录执行"两类场景；直至盘符根仍未命中（如在无关目录执行）则
 *          兜底返回 cwd，落盘位置与旧行为一致。
 * @returns 工作区根目录绝对路径
 */
export function resolveWorkspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (isWorkspaceRoot(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

/**
 * @brief 解析工作区内相对路径的绝对路径
 * @param relPath 相对工作区根的路径（如 .embedded/cloudflared/state.json）
 * @returns 绝对路径
 */
export function resolveWorkspacePath(relPath: string): string {
  return resolve(resolveWorkspaceRoot(), relPath);
}
