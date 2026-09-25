/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : operations.ts
 * Author     : sumu
 * Date       : 2026/09/25
 * Version    : x.x.x
 * Description: 业务流程 —— 落点路由交互与配置 / 删除 / 只读诊断三个菜单动作
 *
 * askTarget 负责交互式路由（选客户端 → 选范围 → 解析落点，落点数据来自
 * targets.ts）；三个动作共用同一骨架：采集输入 → 展示现状 → 确认 → 应用 → 回显，
 * 差异只在期望状态：
 *   - 配置：{ present: true, bridge }，写入前做一致性比对，读取异常即中止
 *   - 删除：{ present: false }，不做一致性比对（只按 key 名移除），不依赖本机端点
 *   - 诊断：只展示现状，不应用任何改动
 * ======================================================
 */

import { type Client, type SFTPWrapper } from "ssh2";
import { select, isCancel, log, confirm, text } from "@clack/prompts";

import {
  type BridgeServer,
  type DesiredState,
  type McpClient,
  type ResolveCtx,
  type Scope,
  type Target,
  type TargetFile,
} from "./types.js";
import { commitTargetFile, readTargetStatus } from "./file-ops.js";
import {
  CLIENTS,
  CLIENT_ENTRIES,
  resolveTargets,
  supportedScopes,
  type ClientSpec,
} from "./targets.js";
import { buildBridgeServer, collectWindowsEndpoint } from "./bridge.js";
import { logDetail } from "../../shared/cli-helpers.js";
import { sshExec } from "../../shared/ssh.js";

// ============================================================
// 落点路由交互
// ============================================================

/** @brief 项目范围在范围菜单中的固定文案 */
const PROJECT_SCOPE_LABEL = "项目（指定项目路径）";

/**
 * @brief 获取远端家目录绝对路径（展开 ~）
 * @details SFTP 不识别 ~，需先通过 ssh exec 取远端 $HOME。结果去空白。
 * @param client 已连接的 ssh2 Client
 * @throws 获取失败时抛出
 */
async function getRemoteHome(client: Client): Promise<string> {
  const home = await sshExec(client, "echo $HOME");
  return home.replace(/\s+/g, "");
}

/**
 * @brief 交互式输入远端项目绝对路径
 * @returns 项目绝对路径；用户取消或为空返回 null
 */
async function askProjectPath(): Promise<string | null> {
  const projRaw = await text({
    message: "项目绝对路径（远端 Linux）",
    placeholder: "如 /home/sumu/my-project",
  });
  if (isCancel(projRaw)) {
    logDetail("    已取消");
    return null;
  }
  const projectPath = projRaw.trim();
  if (!projectPath) {
    logDetail("    项目路径为空");
    return null;
  }
  return projectPath;
}

/**
 * @brief 构造落点解析上下文（targets.resolveTarget 的家目录/项目路径来源）
 */
function makeResolveCtx(client: Client): ResolveCtx {
  return { getHome: () => getRemoteHome(client), askProjectPath };
}

/**
 * @brief 交互式选择客户端类型
 * @returns 客户端 id 与其落点数据；用户取消返回 null
 */
async function selectClient(): Promise<[McpClient, ClientSpec] | null> {
  const clientId = await select<McpClient>({
    message: "选择客户端类型",
    options: CLIENT_ENTRIES.map(([id, spec]) => ({
      value: id,
      label: spec.label,
    })),
  });
  if (isCancel(clientId)) {
    logDetail("    已取消");
    return null;
  }
  return [clientId, CLIENTS[clientId]];
}

/**
 * @brief 交互式解析配置范围
 * @details 单范围客户端（如 zcode / dsh）不询问，直接采用该范围。
 * @returns 选中的范围；用户取消返回 null
 */
async function selectScope(spec: ClientSpec): Promise<Scope | null> {
  const scopes = supportedScopes(spec);
  if (scopes.length === 1) {
    return scopes[0];
  }
  const scope = await select<Scope>({
    message: "选择配置范围",
    options: scopes.map((value) => ({
      value,
      label:
        value === "global"
          ? (spec.globalScopeLabel ?? "全局")
          : PROJECT_SCOPE_LABEL,
    })),
  });
  if (isCancel(scope)) {
    logDetail("    已取消");
    return null;
  }
  return scope;
}

/**
 * @brief 交互式选择客户端类型与配置范围，解析出本次要写的落点
 * @details 流程：选客户端 → 解析范围 → 展开落点模板。
 *          各客户端的落点与 server 形态见 targets.ts 的 CLIENTS 数据表。
 * @param client 已连接的 ssh2 Client（用于展开 ~）
 * @returns 配置目标；用户取消返回 null
 * @throws 获取远端家目录失败时抛出
 */
export async function askTarget(client: Client): Promise<Target | null> {
  const picked = await selectClient();
  if (!picked) return null;
  const [clientId, spec] = picked;

  const scope = await selectScope(spec);
  if (!scope) return null;

  const files = await resolveTargets(makeResolveCtx(client), clientId, scope);
  if (!files) return null;

  return { client: clientId, files };
}

// ============================================================
// 共用展示与应用骨架
// ============================================================

/** @brief 统一的错误消息文本 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** @brief 压缩展示现有 server 对象的关键字段（command + args） */
function compactServer(existing: Record<string, unknown>): string {
  return JSON.stringify({ command: existing.command, args: existing.args });
}

/**
 * @brief 逐落点展示当前状态
 * @param sftp   已打开的 SFTP 会话句柄
 * @param files  落点列表
 * @param bridge 桥接定义；null 表示只展示存在性、不比对（删除场景）
 * @returns 是否存在状态读取错误（配置流程据此中止）
 */
async function reportCurrentStatus(
  sftp: SFTPWrapper,
  files: TargetFile[],
  bridge: BridgeServer | null
): Promise<boolean> {
  log.info("当前状态");
  let hasError = false;
  for (const file of files) {
    logDetail(`    [${file.label}]`);
    logDetail(`        路径: ${file.remotePath}`);
    try {
      const state = await readTargetStatus(sftp, file, bridge);
      logDetail(`        状态: ${state.detail}`);
      if (state.existing) {
        logDetail(`        现有: ${compactServer(state.existing)}`);
      }
    } catch (err) {
      logDetail(`        状态读取失败: ${errText(err)}`);
      hasError = true;
    }
  }
  return hasError;
}

/** @brief 提交阶段的三段文案（写入/删除共用，仅措辞不同） */
interface CommitVerbs {
  ok: string;
  skip: string;
  fail: string;
}

/**
 * @brief 逐落点提交期望状态并回显结果
 * @details 单落点失败不中断其余落点（多个落点部分成功时保留成功部分）。
 */
async function commitAndReport(
  sftp: SFTPWrapper,
  files: TargetFile[],
  desired: DesiredState,
  verbs: CommitVerbs
): Promise<void> {
  for (const file of files) {
    try {
      const written = await commitTargetFile(sftp, file, desired);
      logDetail(
        `    [${file.label}] ${written ? verbs.ok : verbs.skip}: ${file.remotePath}`
      );
    } catch (err) {
      logDetail(`    [${file.label}] ${verbs.fail}: ${errText(err)}`);
    }
  }
}

// ============================================================
// 三个菜单动作
// ============================================================

/**
 * @brief 配置 MCP（主菜单 1）
 * @details 采集本机端点 → 路由落点 → 展示状态 → 确认 → 写入 → 回显。
 * @param client 已连接的 ssh2 Client
 */
export async function doConfigure(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("配置 MCP 桥接 ...");

  // 采集本机端点（无可用 IP 或多 IP 用户取消则中止）
  const endpoint = await collectWindowsEndpoint();
  if (!endpoint) {
    logDetail("    未检测到本机可用 IPv4 地址，无法生成桥接配置");
    logDetail("    请确认网络连接正常后重试");
    return;
  }
  logDetail(`    Windows 用户名: ${endpoint.sshUser}`);
  logDetail(`    Windows 主 IP: ${endpoint.primaryIp}`);
  logDetail(`    bat 路径:      ${endpoint.batPath}`);

  // 路由落点
  const target = await askTarget(client);
  if (!target) return;

  // 本次桥接定义（与落点无关，构造一次供状态比对、写入与回显共用）
  const bridge = buildBridgeServer(
    endpoint.sshUser,
    endpoint.primaryIp,
    endpoint.batPath
  );

  // 展示各落点当前状态；任一落点读取异常则中止（避免对未知现状盲目覆盖）
  if (await reportCurrentStatus(sftp, target.files, bridge)) {
    logDetail("    存在状态读取异常，已中止");
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
    logDetail("    已取消");
    return;
  }

  // 写入各落点
  log.info("写入配置 ...");
  await commitAndReport(
    sftp,
    target.files,
    { present: true, bridge },
    { ok: "已写入", skip: "无需改动", fail: "写入失败" }
  );

  // 回显最终关键字段
  log.info("写入的桥接定义");
  const firstServer = target.files.find((file) => file.kind === "server");
  if (firstServer) {
    logDetail(`    ${JSON.stringify(firstServer.slot.render(bridge))}`);
  }
  log.success("配置完成");
  logDetail(
    "    需重启对应 client（claude/zcode/opencode/dsh/codebuddy）使配置生效"
  );
}

/**
 * @brief 删除已配置的 MCP（主菜单 3）
 * @details 路由落点 → 展示存在性 → 确认 → 从各文件移除 embedded-board → 回显。
 *          删除只关心"是否已配置"（不传 bridge、不做一致性比对）；文件不存在或
 *          无该项时提示"无需删除"而非报错。
 * @param client 已连接的 ssh2 Client
 */
export async function doRemove(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("删除 MCP 桥接配置 ...");

  const target = await askTarget(client);
  if (!target) return;

  // 展示现状（bridge 传 null：仅存在性，不做一致性比对）
  await reportCurrentStatus(sftp, target.files, null);

  // 确认（默认不删，防误触）
  const ok = await confirm({
    message: "确认删除 embedded-board 配置?",
    active: "确认删除",
    inactive: "取消",
    initialValue: false,
  });
  if (isCancel(ok) || !ok) {
    logDetail("    已取消");
    return;
  }

  log.info("移除配置 ...");
  await commitAndReport(
    sftp,
    target.files,
    { present: false },
    { ok: "已移除", skip: "无需删除（未配置）", fail: "删除失败" }
  );
  log.success("删除完成");
}

/**
 * @brief 只读诊断：查看目标落点状态（主菜单 2）
 * @details 路由落点后只读取并展示状态，不修改任何文件。诊断允许无可用 IP
 *          （仅展示不写入），用占位端点构造桥接定义，比对结果自然为不一致。
 * @param client 已连接的 ssh2 Client
 */
export async function doCheckStatus(
  client: Client,
  sftp: SFTPWrapper
): Promise<void> {
  log.info("查看远端 MCP 配置状态（只读诊断）");

  const endpoint = await collectWindowsEndpoint();
  const bridge = buildBridgeServer(
    endpoint?.sshUser ?? "(unknown)",
    endpoint?.primaryIp ?? "(unknown)",
    endpoint?.batPath ?? "(unknown)"
  );

  const target = await askTarget(client);
  if (!target) return;

  await reportCurrentStatus(sftp, target.files, bridge);
  logDetail("    提示: 仅展示状态，未修改任何文件");
}
