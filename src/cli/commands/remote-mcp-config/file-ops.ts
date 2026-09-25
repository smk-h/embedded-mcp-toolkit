/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : file-ops.ts
 * Author     : sumu
 * Date       : 2026/09/25
 * Version    : x.x.x
 * Description: 怎么写 —— 单个落点文件的操作引擎：现状判定、期望应用与事务提交
 *
 * 三个函数按流水线排列，对具体客户端零特例（形态差异都在 TargetFile 自带）：
 *   - readTargetStatus  读远端文件，判定 embedded-board 当前状态（五态，见 types.ts）
 *   - applyDesired      在内存 JSON 上应用期望状态（写入 / 移除），纯函数
 *   - commitTargetFile  事务提交：备份 → 读 → 应用 → 序列化 → 写回 → 失败回滚
 *
 * 配置与删除共用同一套逻辑：配置传 { present:true, bridge }，删除传
 * { present:false }，避免两份各自漂移的写入/移除实现。
 * ======================================================
 */

import { type SFTPWrapper } from "ssh2";

import {
  type BridgeServer,
  type DesiredState,
  SERVER_KEY,
  type StatusResult,
  type TargetFile,
} from "./types.js";
import { sftpBackup, sftpReadText, sftpWriteText } from "./sftp.js";
import {
  ensureArrayAtPath,
  ensureInArray,
  getContainerAtPath,
  getValueAtPath,
  removeServerAtPath,
  removeFromArray,
  setServerAtPath,
} from "./json-mutate.js";

// ============================================================
// 现状判定
// ============================================================

/**
 * @brief 读取单个落点的当前状态（五态）
 * @details 通过 SFTP 读取目标文件并解析，按落点类型判定：
 *          - 文件不存在                        → absent「文件不存在」
 *          - JSON 解析失败                     → error
 *          - server 型：server 容器无该 key    → absent「未配置」
 *                      有该 key 且提供 bridge  → consistent / inconsistent（比对）
 *                      有该 key 且未提供 bridge → present「已配置」（仅存在性，
 *                                                删除场景不做一致性比对）
 *          - enable 型：数组含 enable.value    → consistent「已使能」
 *                       数组不含               → absent「未使能」
 * @param sftp   已打开的 SFTP 会话句柄
 * @param file   落点描述符
 * @param bridge 本次桥接定义；null 表示只做存在性判定、不比对（删除场景）
 * @returns 状态读取结果（读文件本身的传输错误会抛出，由调用方处理）
 */
export async function readTargetStatus(
  sftp: SFTPWrapper,
  file: TargetFile,
  bridge: BridgeServer | null
): Promise<StatusResult> {
  const info = await sftpReadText(sftp, file.remotePath);
  if (!info.exists) {
    return { status: "absent", detail: "文件不存在" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(info.content ?? "{}") as Record<string, unknown>;
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
        detail: "已配置但 command/args 与当前桥接定义不一致（将覆盖更新）",
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
// 差异应用（纯函数，原地修改内存 JSON）
// ============================================================

/**
 * @brief 在内存 JSON 上应用期望状态
 * @details server 型：写入 = 容器内覆盖写 server 对象（顺带补 rootSchema），
 *          移除 = 从容器删 key；enable 型：写入 = 数组去重追加，移除 = 数组移除。
 *          "无需改动"判定：移除方向上目标不存在（key / 数组值缺失）、enable 型
 *          写入方向上数组已含该值时返回 false，且不产生任何写入；server 型写入
 *          总是重写（顺带把格式与漂移的开关字段修正为本次定义）。
 * @param json    解析后的远端 JSON（原地修改）
 * @param file    落点描述符
 * @param desired 期望状态
 * @returns 是否产生了实际改动
 */
export function applyDesired(
  json: Record<string, unknown>,
  file: TargetFile,
  desired: DesiredState
): boolean {
  let changed = false;

  switch (file.kind) {
    case "server": {
      if (desired.present) {
        // 顶层固定字段（仅 opencode：$schema），缺失则补齐
        if (file.rootSchema && typeof json["$schema"] !== "string") {
          json["$schema"] = file.rootSchema;
        }
        setServerAtPath(
          json,
          file.slot.path,
          SERVER_KEY,
          file.slot.render(desired.bridge)
        );
        changed = true;
      } else if (removeServerAtPath(json, file.slot.path, SERVER_KEY)) {
        changed = true;
      }
      break;
    }
    case "enable": {
      if (desired.present) {
        // 取使能数组；不存在或非数组则创建为空数组，再去重追加
        const arr = ensureArrayAtPath(json, file.enable.path);
        if (ensureInArray(arr, file.enable.value)) {
          changed = true;
        }
      } else {
        // 数组不存在时无东西可移除，保持文件不动（不能建出空数组）
        const arr = getValueAtPath(json, file.enable.path);
        if (Array.isArray(arr) && removeFromArray(arr, file.enable.value)) {
          changed = true;
        }
      }
      break;
    }
  }
  return changed;
}

// ============================================================
// 安全事务
// ============================================================

/**
 * @brief 单文件写入事务（配置/删除共用）
 * @details 统一"备份→读→应用→序列化→写→失败回滚"流程：
 *          1. 备份原文件为 .bak（已存在则跳过，保留首次备份）
 *          2. 读取原文件（不存在则当作空 JSON {}）
 *          3. JSON.parse
 *          4. 在内存对象上应用期望状态（applyDesired）
 *          5. 序列化（2 空格缩进 + 尾换行）
 *          6. 写回远端；写失败用 .bak 回滚
 * @param sftp    已打开的 SFTP 会话句柄
 * @param file    落点描述符
 * @param desired 期望状态
 * @returns 是否实际写入了文件
 * @throws 读/写/解析失败时抛出（已尝试回滚）
 */
export async function commitTargetFile(
  sftp: SFTPWrapper,
  file: TargetFile,
  desired: DesiredState
): Promise<boolean> {
  // 1. 备份
  await sftpBackup(sftp, file.remotePath);

  // 2. 读取（不存在则当作空对象）
  const info = await sftpReadText(sftp, file.remotePath);
  const rawContent = info.exists ? (info.content ?? "{}") : "{}";

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

  // 5. 序列化（2 空格 + 尾换行）
  const newContent = JSON.stringify(json, null, 2) + "\n";

  // 6. 写回；失败用 .bak 回滚
  try {
    await sftpWriteText(sftp, file.remotePath, newContent);
  } catch (err) {
    // 回滚：若备份存在，恢复原文件内容
    try {
      const bakInfo = await sftpReadText(sftp, file.remotePath + ".bak");
      if (bakInfo.exists && info.exists) {
        await sftpWriteText(sftp, file.remotePath, bakInfo.content ?? "");
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
