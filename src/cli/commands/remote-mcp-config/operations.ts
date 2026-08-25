/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : operations.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: C4-后半. 配置 / 删除 / 诊断 业务流程
 *
 * 计算本次桥接定义所需的 Windows 端参数、单文件变异操作（备份→读→改写→写→失败回滚）、
 * 以及配置 / 删除 / 只读诊断三个业务流程。
 * ======================================================
 */

import { Client, type SFTPWrapper } from "ssh2";
import { select, isCancel, log, confirm } from "@clack/prompts";

import { type TargetFile, SERVER_KEY } from "./types.js";
import { sftpBackup, sftpReadText, sftpWriteText } from "./sftp.js";
import {
  setServerAtPath,
  getValueAtPath,
  ensureInArray,
  removeServerAtPath,
  removeFromArray,
} from "./json-mutate.js";
import {
  buildBridgeServer,
  renderServerObject,
  readStatus,
  checkExists,
} from "./status.js";
import { askTarget } from "./target.js";
import { collectConnectionInfo } from "../../shared/cli-helpers.js";

// ============================================================
// C4-后半. 配置 / 删除 / 诊断 业务流程
// ============================================================

/**
 * @brief 计算本次桥接定义所需的 Windows 端参数
 * @details 采集本机连接信息并确定主 IP：
 *          - 无可用 IP  → 返回 null（配置场景中止；诊断场景用占位端点）
 *          - 仅 1 个 IP → 直接采用，无需用户介入
 *          - 多个 IP    → 交互式让用户选择（多网卡时取首个不可靠，需用户确认）
 *          bat 路径取 cwd/remote-start-mcp.bat（转正斜杠，与 sshd-config 模板一致）。
 * @returns {sshUser, primaryIp, batPath} 或 null（无可用 IP / 多 IP 时用户取消选择）
 */
export async function resolveLocalEndpoint(): Promise<{
  sshUser: string;
  primaryIp: string;
  batPath: string;
} | null> {
  const { sshUser, ipList } = collectConnectionInfo();
  if (ipList.length === 0) {
    return null;
  }
  // 单个 IP 直接采用；多个 IP 让用户选择（多网卡场景无法可靠自动判定，取首个可能
  // 选到 Linux 路由不可达的网段，导致反向 SSH 连接失败）
  let primaryIp: string;
  if (ipList.length === 1) {
    primaryIp = ipList[0].ip;
  } else {
    const choice = await select<string>({
      message: "选择 Windows 主 IP（远程反连地址）",
      options: ipList.map((entry) => ({
        value: entry.ip,
        label: `${entry.ip}  (${entry.iface})`,
      })),
    });
    if (isCancel(choice)) {
      return null;
    }
    primaryIp = choice;
  }
  // cwd/remote-start-mcp.bat 转正斜杠（JSON 无需转义反斜杠，且 node/ssh 支持正斜杠）
  const batPath = (
    process.cwd().replace(/\\/g, "/") + "/remote-start-mcp.bat"
  ).replace(/\/+/g, "/");
  return { sshUser, primaryIp, batPath };
}

/**
 * @brief 单文件变异操作（配置/删除共用）
 * @details 统一"备份→读→本地改写→序列化→写→失败回滚"流程：
 *          1. 备份原文件为 .bak（已存在则跳过，保留首次备份）
 *          2. 读取原文件（不存在则当作空 JSON {}）
 *          3. JSON.parse
 *          4. 调用 mutate 在本地对象上做 set/remove + 使能数组增删
 *          5. 序列化（2 空格缩进 + 尾换行）
 *          6. 写回远端；写失败用 .bak 回滚
 * @param sftp    已打开的 SFTP 会话句柄
 * @param file    落点描述符
 * @param mutate  本地变异回调（原地修改 json 对象）；返回 false 表示无需改动
 * @returns 是否实际写入了文件
 * @throws 读/写/解析失败时抛出（已尝试回滚）
 */
export async function mutateFile(
  sftp: SFTPWrapper,
  file: TargetFile,
  mutate: (json: Record<string, unknown>) => boolean
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

  // 4. 本地变异；返回 false 表示无需改动
  const changed = mutate(json);
  if (!changed) {
    return false;
  }

  // 5. 序列化（2 空格 + 尾换行，N4）
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

/**
 * @brief 配置 MCP（F5）
 * @details 采集本机端点 → 路由落点 → 展示状态 → 确认 → 写入 → 回显。
 * @param client 已连接的 ssh2 Client
 */
export async function doConfigure(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("配置 MCP 桥接 ...");

  // 采集本机端点（无可用 IP 或多 IP 用户取消则中止）
  const endpoint = await resolveLocalEndpoint();
  if (!endpoint) {
    log.message("    未检测到本机可用 IPv4 地址，无法生成桥接配置");
    log.message("    请确认网络连接正常后重试");
    return;
  }
  log.message(`    Windows 用户名: ${endpoint.sshUser}`);
  log.message(`    Windows 主 IP: ${endpoint.primaryIp}`);
  log.message(`    bat 路径:      ${endpoint.batPath}`);

  // 路由落点
  const target = await askTarget(client);
  if (!target) return;

  // 展示各落点当前状态（F4）
  log.info("当前状态");
  let hasError = false;
  for (const file of target.files) {
    const bridge = buildBridgeServer(
      endpoint.sshUser,
      endpoint.primaryIp,
      endpoint.batPath
    );
    try {
      const status = await readStatus(sftp, file, bridge);
      log.message(`    [${file.label}] ${status.detail}`);
      log.message(`        路径: ${file.remotePath}`);
      if (status.existing) {
        log.message(
          `        现有: ${JSON.stringify({ command: status.existing.command, args: status.existing.args })}`
        );
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 状态读取失败: ${err instanceof Error ? err.message : err}`
      );
      hasError = true;
    }
  }
  if (hasError) {
    log.message("    存在状态读取异常，已中止");
    return;
  }

  // 确认
  const ok = await confirm({
    message: "确认写入以上配置?",
    active: "确认写入",
    inactive: "取消",
    initialValue: true,
  });
  if (isCancel(ok) || !ok) {
    log.message("    已取消");
    return;
  }

  // 写入各落点
  log.info("写入配置 ...");
  for (const file of target.files) {
    const bridge = buildBridgeServer(
      endpoint.sshUser,
      endpoint.primaryIp,
      endpoint.batPath
    );
    try {
      const written = await mutateFile(sftp, file, (json) => {
        let changed = false;
        // 顶层固定字段（仅 opencode：$schema），缺失则补齐
        if (file.rootSchema && typeof json["$schema"] !== "string") {
          json["$schema"] = file.rootSchema;
          changed = true;
        }
        // server 定义（serverPath 非空）
        if (file.serverPath.length > 0) {
          setServerAtPath(
            json,
            file.serverPath,
            SERVER_KEY,
            renderServerObject(file, bridge)
          );
          changed = true;
        }
        // 使能数组（enableArrayPath 非空）
        if (file.enableArrayPath && file.enableValue) {
          // 取使能数组；不存在或非数组则创建为空数组
          let arr = getValueAtPath(json, file.enableArrayPath);
          if (!Array.isArray(arr)) {
            // 沿父路径建对象，末层设为空数组
            setServerAtPath(
              json,
              file.enableArrayPath.slice(0, -1),
              file.enableArrayPath[file.enableArrayPath.length - 1],
              []
            );
            arr = getValueAtPath(json, file.enableArrayPath);
          }
          if (Array.isArray(arr) && ensureInArray(arr, file.enableValue)) {
            changed = true;
          }
        }
        return changed;
      });
      if (written) {
        log.message(`    [${file.label}] 已写入: ${file.remotePath}`);
      } else {
        log.message(`    [${file.label}] 无需改动: ${file.remotePath}`);
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 写入失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // 回显最终关键字段
  log.info("写入的桥接定义");
  const finalBridge = buildBridgeServer(
    endpoint.sshUser,
    endpoint.primaryIp,
    endpoint.batPath
  );
  const finalObj = renderServerObject(target.files[0], finalBridge);
  log.message(`    ${JSON.stringify(finalObj)}`);
  log.success("配置完成");
  log.message("    需重启对应 client（claude/zcode/opencode）使配置生效");
}

/**
 * @brief 删除已配置的 MCP（F6）
 * @details 路由落点 → 展示状态 → 确认 → 从各文件移除 embedded-board → 回显。
 *          文件不存在或无该项时提示"无需删除"而非报错。
 * @param client 已连接的 ssh2 Client
 */
export async function doRemove(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("删除 MCP 桥接配置 ...");

  // 删除不依赖本机端点（不需要 bridge 比对，只按 key 名移除），但仍走落点路由
  const target = await askTarget(client);
  if (!target) return;

  // 展示状态：删除只关心"是否已配置"，不做一致性比对（比对是配置操作的语义，
  // 删除场景展示"将覆盖更新"会误导用户）。此处用专门的"存在性"展示。
  log.info("当前状态");
  for (const file of target.files) {
    try {
      const exists = await checkExists(sftp, file);
      log.message(
        `    [${file.label}] ${exists ? "已配置，可删除" : "未配置"}`
      );
      log.message(`        路径: ${file.remotePath}`);
    } catch (err) {
      log.message(
        `    [${file.label}] 状态读取失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // 确认
  const ok = await confirm({
    message: "确认删除 embedded-board 配置?",
    active: "确认删除",
    inactive: "取消",
    initialValue: false,
  });
  if (isCancel(ok) || !ok) {
    log.message("    已取消");
    return;
  }

  // 移除
  log.info("移除配置 ...");
  for (const file of target.files) {
    try {
      const changed = await mutateFile(sftp, file, (json) => {
        let changedFlag = false;
        if (file.serverPath.length > 0) {
          if (removeServerAtPath(json, file.serverPath, SERVER_KEY)) {
            changedFlag = true;
          }
        }
        if (file.enableArrayPath && file.enableValue) {
          const arr = getValueAtPath(json, file.enableArrayPath);
          if (Array.isArray(arr) && removeFromArray(arr, file.enableValue)) {
            changedFlag = true;
          }
        }
        return changedFlag;
      });
      if (changed) {
        log.message(`    [${file.label}] 已移除: ${file.remotePath}`);
      } else {
        log.message(
          `    [${file.label}] 无需删除（未配置）: ${file.remotePath}`
        );
      }
    } catch (err) {
      log.message(
        `    [${file.label}] 删除失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  log.success("删除完成");
}

/**
 * @brief 只读诊断：查看目标落点状态（F7）
 * @details 路由落点后只读取并展示状态，不修改任何文件。
 * @param client 已连接的 ssh2 Client
 */
export async function doCheckStatus(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("查看远端 MCP 配置状态（只读诊断）");

  const endpoint = await resolveLocalEndpoint();
  // 诊断允许无可用 IP（仅展示，不写入），用占位端点做比对
  const sshUser = endpoint?.sshUser ?? "(unknown)";
  const primaryIp = endpoint?.primaryIp ?? "(unknown)";
  const batPath = endpoint?.batPath ?? "(unknown)";

  const target = await askTarget(client);
  if (!target) return;

  for (const file of target.files) {
    const bridge = buildBridgeServer(sshUser, primaryIp, batPath);
    log.info(`[${file.label}]`);
    log.message(`    路径: ${file.remotePath}`);
    try {
      const status = await readStatus(sftp, file, bridge);
      log.message(`    状态: ${status.detail}`);
      if (status.existing) {
        log.message(
          `    现有: ${JSON.stringify({ command: status.existing.command, args: status.existing.args })}`
        );
      }
    } catch (err) {
      log.message(
        `    状态读取失败: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  log.message("    提示: 仅展示状态，未修改任何文件");
}
