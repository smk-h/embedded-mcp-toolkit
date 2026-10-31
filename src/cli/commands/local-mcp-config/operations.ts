/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : operations.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: 业务流程 —— 落点路由交互与配置 / 删除 / 只读诊断三个菜单动作
 *
 * 与 remote-mcp-config/operations.ts 同构（交互骨架与文案风格保持一致），
 * 差异只在三处：
 *   - bridge = cmd /c <bat 绝对路径>（本地启动定义，bat 持有全部 env）
 *   - ResolveCtx 来源：getHome = os.homedir()（本机家目录，展开全局落点的 ~），
 *     askProjectPath = 本机项目目录交互输入（要求目录已存在）
 *   - 文件读写走本目录 file-ops.ts（本地 fs 版），不经 SFTP
 *
 * 落点数据表直接复用 remote-mcp-config/targets.ts 的 CLIENTS（八类落点的
 * 路径与 server 形态两端完全一致），ResolveCtx 驱动的 resolveTargets 天然通用。
 * ======================================================
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { confirm, isCancel, log, select, text } from "@clack/prompts";

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
import { buildLocalBridge } from "./bridge.js";
import {
  CLIENTS,
  CLIENT_ENTRIES,
  resolveTargets,
  supportedScopes,
  type ClientSpec,
} from "../remote-mcp-config/targets.js";
import { logDetail } from "../../shared/cli-helpers.js";

// ============================================================
// 落点路由交互
// ============================================================

/** @brief 项目范围在范围菜单中的固定文案 */
const PROJECT_SCOPE_LABEL = "项目（指定项目路径）";

/**
 * @brief 交互式输入本机项目目录
 * @details 要求目录已存在（AI 客户端将在该项目内运行）；不存在时提示后返回 null。
 * @returns 项目绝对路径；用户取消、为空或目录不存在返回 null
 */
async function askProjectPath(): Promise<string | null> {
  const projRaw = await text({
    message: "项目目录（本机 Windows，绝对路径）",
    placeholder: "如 E:\\works\\my-project",
  });
  if (isCancel(projRaw)) {
    logDetail("    已取消");
    return null;
  }
  const projectPath = resolve((projRaw ?? "").trim());
  if (!projectPath || projectPath === resolve(projectPath, "..")) {
    logDetail("    项目路径为空");
    return null;
  }
  if (!existsSync(projectPath)) {
    logDetail(`    目录不存在: ${projectPath}`);
    logDetail("    请先创建项目目录后重试");
    return null;
  }
  return projectPath;
}

/**
 * @brief 构造落点解析上下文（resolveTargets 的家目录/项目路径来源）
 * @details getHome = os.homedir()：全局落点的 ~ 展开为本机家目录。
 */
function makeResolveCtx(): ResolveCtx {
  return { getHome: async () => homedir(), askProjectPath };
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
 * @details 流程：选客户端 → 解析范围 → 展开落点模板（~ 取本机家目录）。
 *          各客户端的落点与 server 形态见 remote-mcp-config/targets.ts 的
 *          CLIENTS 数据表（两端共用同一张表）。
 * @returns 配置目标；用户取消返回 null
 */
export async function askTarget(): Promise<Target | null> {
  const picked = await selectClient();
  if (!picked) return null;
  const [clientId, spec] = picked;

  const scope = await selectScope(spec);
  if (!scope) return null;

  const files = await resolveTargets(makeResolveCtx(), clientId, scope);
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
 * @param files  落点列表
 * @param bridge 本地启动定义；null 表示只展示存在性、不比对（删除场景）
 * @returns 是否存在状态读取错误（配置流程据此中止）
 */
async function reportCurrentStatus(
  files: TargetFile[],
  bridge: BridgeServer | null
): Promise<boolean> {
  log.info("当前状态");
  let hasError = false;
  for (const file of files) {
    logDetail(`    [${file.label}]`);
    logDetail(`        路径: ${file.remotePath}`);
    try {
      const state = await readTargetStatus(file, bridge);
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
  files: TargetFile[],
  desired: DesiredState,
  verbs: CommitVerbs
): Promise<void> {
  for (const file of files) {
    try {
      const written = await commitTargetFile(file, desired);
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
 * @brief 配置本地 MCP（主菜单 1）
 * @details 展示 bat 路径 → 路由落点 → 展示状态 → 确认 → 写入 → 回显。
 * @param batPath remote-start-mcp.bat 绝对路径（run.ts 启动时已探测）
 */
export async function doConfigure(batPath: string): Promise<void> {
  log.info("配置本地 MCP ...");

  logDetail(`    bat 路径: ${batPath}`);
  logDetail("    启动方式: cmd /c <bat>（cwd 与环境变量由 bat 统一持有）");

  // 路由落点
  const target = await askTarget();
  if (!target) return;

  // 本次本地启动定义（与落点无关，构造一次供状态比对、写入与回显共用）
  const bridge = buildLocalBridge(batPath);

  // 展示各落点当前状态；任一落点读取异常则中止（避免对未知现状盲目覆盖）
  if (await reportCurrentStatus(target.files, bridge)) {
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
    target.files,
    { present: true, bridge },
    { ok: "已写入", skip: "无需改动", fail: "写入失败" }
  );

  // 回显最终关键字段
  log.info("写入的本地启动定义");
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
 * @brief 删除已配置的本地 MCP（主菜单 3）
 * @details 路由落点 → 展示存在性 → 确认 → 从各文件移除 embedded-board → 回显。
 *          删除只关心"是否已配置"（不传 bridge、不做一致性比对）；文件不存在或
 *          无该项时提示"无需删除"而非报错。
 */
export async function doRemove(): Promise<void> {
  log.info("删除本地 MCP 配置 ...");

  const target = await askTarget();
  if (!target) return;

  // 展示现状（bridge 传 null：仅存在性，不做一致性比对）
  await reportCurrentStatus(target.files, null);

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
    target.files,
    { present: false },
    { ok: "已移除", skip: "无需删除（未配置）", fail: "删除失败" }
  );
  log.success("删除完成");
}

/**
 * @brief 只读诊断：查看目标落点状态（主菜单 2）
 * @details 路由落点后只读取并展示状态，不修改任何文件。
 * @param batPath remote-start-mcp.bat 绝对路径
 */
export async function doCheckStatus(batPath: string): Promise<void> {
  log.info("查看本地 MCP 配置状态（只读诊断）");

  const bridge = buildLocalBridge(batPath);

  const target = await askTarget();
  if (!target) return;

  await reportCurrentStatus(target.files, bridge);
  logDetail("    提示: 仅展示状态，未修改任何文件");
}
