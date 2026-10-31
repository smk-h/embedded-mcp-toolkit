/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : file-ops.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: 怎么写 —— 本地 fs 版落点文件操作引擎：现状判定与事务提交
 *
 * 与 remote-mcp-config/file-ops.ts（SFTP 版）逻辑逐行对偶，差异只在三个
 * 文件原语换成 fs（读/写/备份），其余——五态判定、applyDesired 的期望应用、
 * "备份→读→应用→序列化→写回→失败回滚"事务——语义完全一致：
 *   - applyDesired 直接 import 远端实现（纯函数，零复制零漂移）
 *   - 现状判定 switch 与远端 readTargetStatus 保持镜像（改一处须同步另一处）
 *
 * 与远端的两个本地化差异：
 *   - 写文件前按需 mkdir 落点父目录（.claude/.zcode/.dsh 等在目标项目
 *     可能尚不存在，本地 fs 不会像 SFTP 那样自动递归建目录）
 *   - 备份用 copyFileSync（本地同盘，无传输语义）
 * ======================================================
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

import {
  type BridgeServer,
  type DesiredState,
  SERVER_KEY,
  type StatusResult,
  type TargetFile,
} from "../remote-mcp-config/types.js";
import { applyDesired } from "../remote-mcp-config/file-ops.js";
import {
  getContainerAtPath,
  getValueAtPath,
} from "../remote-mcp-config/json-mutate.js";

// ============================================================
// 现状判定（与 remote-mcp-config/file-ops.ts readTargetStatus 镜像）
// ============================================================

/**
 * @brief 读取单个落点的当前状态（五态）
 * @details 本地 fs 读文件并解析，按落点类型判定。五态语义与远端版一致：
 *          absent / present / consistent / inconsistent / error。
 * @param file   落点描述符
 * @param bridge 本次本地启动定义；null 表示只做存在性判定、不比对（删除场景）
 * @returns 状态读取结果（不抛出——本地读不存在即 absent）
 */
export async function readTargetStatus(
  file: TargetFile,
  bridge: BridgeServer | null
): Promise<StatusResult> {
  if (!existsSync(file.remotePath)) {
    return { status: "absent", detail: "文件不存在" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file.remotePath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { status: "error", detail: "JSON 解析失败" };
  }

  switch (file.kind) {
    case "server": {
      const container = getContainerAtPath(json, file.slot.path);
      if (!container || !(SERVER_KEY in container)) {
        return { status: "absent", detail: "未配置 embedded-board" };
      }
      const existing = container[SERVER_KEY] as Record<string, unknown>;
      if (!bridge) {
        return { status: "present", detail: "已配置", existing };
      }
      if (file.slot.matches(existing, bridge)) {
        return { status: "consistent", detail: "已配置且一致", existing };
      }
      return {
        status: "inconsistent",
        detail: "已配置但 command/args 与当前本地启动定义不一致（将覆盖更新）",
        existing,
      };
    }
    case "enable": {
      const arr = getValueAtPath(json, file.enable.path);
      if (Array.isArray(arr) && arr.includes(file.enable.value)) {
        return {
          status: "consistent",
          detail: `已使能（在 ${file.enable.path.join(".")} 中）`,
        };
      }
      return { status: "absent", detail: "未使能" };
    }
  }
}

// ============================================================
// 安全事务（与 remote-mcp-config/file-ops.ts commitTargetFile 镜像）
// ============================================================

/**
 * @brief 单文件写入事务（配置/删除共用）
 * @details 统一"备份→读→应用→序列化→建目录→写→失败回滚"流程：
 *          1. 备份原文件为 .bak（已存在 .bak 则跳过，保留首次备份）
 *          2. 读取原文件（不存在则当作空 JSON {}）
 *          3. JSON.parse（失败抛出，不建文件）
 *          4. 内存应用期望状态（applyDesired；无需改动则提前返回）
 *          5. 序列化（2 空格缩进 + 尾换行）并按需创建落点父目录
 *          6. 写回；写失败用 .bak 回滚
 * @param file    落点描述符
 * @param desired 期望状态
 * @returns 是否实际写入了文件
 * @throws 读/写/解析失败时抛出（已尝试回滚）
 */
export async function commitTargetFile(
  file: TargetFile,
  desired: DesiredState
): Promise<boolean> {
  const exists = existsSync(file.remotePath);

  // 1. 备份（原文件存在且尚无 .bak 时）
  if (exists && !existsSync(file.remotePath + ".bak")) {
    copyFileSync(file.remotePath, file.remotePath + ".bak");
  }

  // 2. 读取（不存在则当作空对象）
  const rawContent = exists ? readFileSync(file.remotePath, "utf-8") : "{}";

  // 3. 解析
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawContent) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `JSON 解析失败 ${file.remotePath}: ${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }

  // 4. 应用期望状态；返回 false 表示无需改动
  const changed = applyDesired(json, file, desired);
  if (!changed) {
    return false;
  }

  // 5. 序列化（2 空格 + 尾换行）；落点父目录不存在时创建
  const newContent = JSON.stringify(json, null, 2) + "\n";
  mkdirSync(dirname(file.remotePath), { recursive: true });

  // 6. 写回；失败用 .bak 回滚
  try {
    writeFileSync(file.remotePath, newContent, "utf-8");
  } catch (err) {
    try {
      if (exists) {
        writeFileSync(
          file.remotePath,
          readFileSync(file.remotePath + ".bak", "utf-8"),
          "utf-8"
        );
      }
    } catch {
      // 回滚失败不掩盖原始写入错误
    }
    throw new Error(
      `写入失败 ${file.remotePath}: ${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }
  return true;
}
