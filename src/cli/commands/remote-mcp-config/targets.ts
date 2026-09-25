/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : targets.ts
 * Author     : sumu
 * Date       : 2026/09/25
 * Version    : x.x.x
 * Description: 往哪写 —— 五类客户端 × 八类落点的唯一权威数据表
 *
 * 每个客户端是一份**纯数据**（无控制流）：支持哪些范围、每个范围写哪几个文件、
 * server 什么形态、菜单文案是什么，一屏可查。新增客户端 = 在 CLIENTS 加一项数据；
 * 新增 server 形态 = 在下方形态工厂加一个函数；读改写通用逻辑（file-ops.ts）零改动。
 *
 * 八类落点（固定 server key 名 "embedded-board"）：
 *   - Claude 全局   ：~/.claude.json 顶层 mcpServers（裸 { command, args }）
 *   - Claude 项目   ：{proj}/.mcp.json（mcpServers）
 *                    + {proj}/.claude/settings.local.json（enabledMcpjsonServers 使能数组）
 *   - CodeBuddy 全局：~/.codebuddy/mcp.json（mcpServers，含 type:"stdio"）
 *   - CodeBuddy 项目：{proj}/.mcp.json（与 Claude 项目级同文件、同形态，均不写 type）
 *   - ZCode 项目    ：{proj}/.zcode/config.json（mcp.servers，含 type/enabled）
 *   - DSH 项目      ：{proj}/.dsh/dshmm/mcp.json（mcpServers，含 type 与空 cwd）
 *   - opencode 全局 ：~/.config/opencode/opencode.json（mcp，command 为数组）
 *   - opencode 项目 ：{proj}/.opencode/opencode.json（mcp，command 为数组）
 *   （ZCode / DSH 全局本期不做，对应范围键缺省即不支持）
 *
 * 路径模板约定：`~` 开头 = 家目录相对（resolveTargets 经 ResolveCtx.getHome 展开）；
 * `{proj}` 开头 = 项目根相对（经 ResolveCtx.askProjectPath 展开，用户取消则整体取消）。
 * 快照测试 test/cli/remote-mcp-config-clients.mjs 锁定本表全部落点。
 * ======================================================
 */

import {
  SERVER_KEY,
  type EnableTargetFile,
  type McpClient,
  type ResolveCtx,
  type Scope,
  type ServerSlot,
  type ServerTargetFile,
  type TargetFile,
} from "./types.js";

// ============================================================
// 客户端落点数据表
// ============================================================

/** @brief opencode 配置文件根的 $schema 值（缺失时补齐） */
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/** @brief 单个客户端的落点声明（纯数据；缺省的范围键即不支持该范围） */
export interface ClientSpec {
  /** 客户端选择菜单中的展示名 */
  readonly label: string;
  /** global 范围在范围菜单中的文案；缺省用"全局" */
  readonly globalScopeLabel?: string;
  /** global 范围的落点文件（路径为模板）；缺省即不支持全局 */
  readonly global?: readonly TargetFile[];
  /** project 范围的落点文件（路径为模板）；缺省即不支持项目级 */
  readonly project?: readonly TargetFile[];
}

/**
 * 客户端落点总表。键类型为 McpClient：客户端联合类型新增取值而此处未补键
 * （或键名拼错）会编译报错；键的声明顺序即「选择客户端类型」菜单顺序。
 */
export const CLIENTS: Record<McpClient, ClientSpec> = {
  claude: {
    label: "Claude Code",
    globalScopeLabel: "全局（~/.claude.json，所有项目可用）",
    global: [
      serverFile(
        "~/.claude.json",
        "Claude 全局",
        stdioServerSlot(["mcpServers"])
      ),
    ],
    project: [
      serverFile(
        "{proj}/.mcp.json",
        "Claude 项目（.mcp.json server 定义）",
        stdioServerSlot(["mcpServers"])
      ),
      enableFile(
        "{proj}/.claude/settings.local.json",
        "Claude 项目（settings.local.json 使能）",
        ["enabledMcpjsonServers"]
      ),
    ],
  },

  zcode: {
    label: "ZCode",
    project: [
      serverFile(
        "{proj}/.zcode/config.json",
        "ZCode 项目",
        stdioServerSlot(["mcp", "servers"], { type: "stdio", enabled: true })
      ),
    ],
  },

  opencode: {
    label: "opencode",
    globalScopeLabel: "全局（~/.config/opencode/opencode.json，所有项目可用）",
    global: [
      opencodeFile(
        "~/.config/opencode/opencode.json",
        "opencode 全局（~/.config/opencode/opencode.json）"
      ),
    ],
    project: [
      opencodeFile(
        "{proj}/.opencode/opencode.json",
        "opencode 项目（.opencode/opencode.json）"
      ),
    ],
  },

  dsh: {
    label: "DSH (DeepSeek Harness)",
    project: [
      serverFile(
        "{proj}/.dsh/dshmm/mcp.json",
        "DSH 项目（.dsh/dshmm/mcp.json）",
        stdioServerSlot(["mcpServers"], { type: "stdio", cwd: "" })
      ),
    ],
  },

  codebuddy: {
    label: "CodeBuddy",
    globalScopeLabel: "全局（~/.codebuddy/mcp.json，所有项目可用）",
    // 全局固定写**不带点**的 mcp.json：官方 CLI 的用户级优先级是
    // ~/.codebuddy/.mcp.json > ~/.codebuddy/mcp.json > ~/.codebuddy.json（只读第一个
    // 存在的、不合并），但 CodeBuddy IDE 只认不带点的 ~/.codebuddy/mcp.json（实测结论
    // 见 src/cli/commands/cnb/constants.ts 的 REMOTE_MCP_FILE_NAME 注释），故不带点者
    // 是 IDE 与 CLI 两个宿主都生效的唯一路径。
    global: [
      serverFile(
        "~/.codebuddy/mcp.json",
        "CodeBuddy 全局（~/.codebuddy/mcp.json）",
        stdioServerSlot(["mcpServers"], { type: "stdio" })
      ),
    ],
    project: [
      // 与 Claude 项目级共用同一个 <proj>/.mcp.json、同一个 server key，故形态必须
      // 与 Claude 项目级逐字段一致（见文件头八类落点清单：均不写 type）。
      serverFile(
        "{proj}/.mcp.json",
        "CodeBuddy 项目（.mcp.json，与 Claude 共用）",
        stdioServerSlot(["mcpServers"])
      ),
    ],
  },
};

/** @brief 全部客户端的有序条目（id + 落点数据），声明顺序即客户端选择菜单顺序 */
export const CLIENT_ENTRIES = Object.entries(CLIENTS) as readonly (readonly [
  McpClient,
  ClientSpec,
])[];

/** @brief 取客户端支持的范围（声明顺序：global 在前）；单范围客户端不弹范围菜单 */
export function supportedScopes(spec: ClientSpec): Scope[] {
  const scopes: Scope[] = [];
  if (spec.global) scopes.push("global");
  if (spec.project) scopes.push("project");
  return scopes;
}

/**
 * @brief 把数据表中的模板落点展开为一次配置目标的实际落点
 * @details global 范围取远端家目录展开 `~`；project 范围询问项目绝对路径（用户取消
 *          或为空返回 null）并展开 `{proj}`。展开是浅拷贝替换，不改数据表本体。
 * @param ctx      落点解析上下文（家目录 / 项目路径的来源）
 * @param clientId 客户端类型
 * @param scope    配置范围
 * @returns 展开后的落点文件列表；范围不支持或用户取消返回 null
 * @throws 获取远端家目录失败时抛出
 */
export async function resolveTargets(
  ctx: ResolveCtx,
  clientId: McpClient,
  scope: Scope
): Promise<TargetFile[] | null> {
  const spec = CLIENTS[clientId];
  const templates = spec[scope];
  if (!templates) return null;

  if (scope === "global") {
    const home = await ctx.getHome();
    return templates.map((file) => expandHome(file, home));
  }

  const projectPath = await ctx.askProjectPath();
  if (!projectPath) return null;
  return templates.map((file) => expandProject(file, projectPath));
}

/** @brief 展开 `~` 前缀为家目录绝对路径（非 ~ 开头的模板按绝对路径原样保留） */
function expandHome(file: TargetFile, home: string): TargetFile {
  return { ...file, remotePath: file.remotePath.replace(/^~(?=\/|$)/, home) };
}

/** @brief 展开 `{proj}` 前缀为项目绝对路径（输入带尾斜杠时规范化） */
function expandProject(file: TargetFile, projectPath: string): TargetFile {
  const base = projectPath.replace(/\/+$/, "");
  return { ...file, remotePath: file.remotePath.replace(/^\{proj\}/, base) };
}

// ============================================================
// server 形态工厂（跨客户端复用，形态实现只此一份）
// ============================================================

/** @brief stdio 形态（command + args 分体）的形态开关 */
interface StdioServerOptions {
  /** 写入的 type 值；省略则不写 type */
  type?: string;
  /** 是否写 enabled:true；省略即不写（正语义，无需负向标志抑制） */
  enabled?: boolean;
  /** cwd 字段值；省略则不写（仅 DSH 按约定写空串） */
  cwd?: string;
}

/**
 * @brief 构造 stdio 形态的 server 写入槽（command + args 分体）
 * @details 字段写入顺序固定为 command → args → type → enabled → cwd。
 * @param path    server 容器的 JSON 路径
 * @param options 形态开关
 */
function stdioServerSlot(
  path: string[],
  options: StdioServerOptions = {}
): ServerSlot {
  return {
    path,
    render: (bridge) => {
      const server: Record<string, unknown> = {
        command: bridge.command,
        args: bridge.args,
      };
      if (options.type) {
        server.type = options.type;
      }
      if (options.enabled) {
        server.enabled = true;
      }
      if (options.cwd !== undefined) {
        server.cwd = options.cwd;
      }
      return server;
    },
    matches: (existing, bridge) => {
      if (
        typeof existing.command !== "string" ||
        existing.command !== bridge.command
      ) {
        return false;
      }
      const args = existing.args;
      if (!Array.isArray(args) || args.length !== bridge.args.length) {
        return false;
      }
      return bridge.args.every((value, index) => args[index] === value);
    },
  };
}

/** @brief array 形态（command 为数组）的形态开关 */
interface ArrayServerOptions {
  /** 写入的 type 值（opencode 为 "local"） */
  type: string;
  /** 写入的 timeout（毫秒）；省略则不写 */
  timeout?: number;
}

/**
 * @brief 构造 array 形态的 server 写入槽（command 为数组，元素为 command + args 展平）
 * @details 字段写入顺序固定为 type → command → enabled → timeout。本形态一律写
 *          enabled:true（当前仅 opencode 使用）。
 */
function arrayServerSlot(
  path: string[],
  options: ArrayServerOptions
): ServerSlot {
  return {
    path,
    render: (bridge) => {
      const server: Record<string, unknown> = {
        type: options.type,
        command: [bridge.command, ...bridge.args],
        enabled: true,
      };
      if (options.timeout !== undefined) {
        server.timeout = options.timeout;
      }
      return server;
    },
    matches: (existing, bridge) => {
      const command = existing.command;
      if (!Array.isArray(command)) {
        return false;
      }
      const expected = [bridge.command, ...bridge.args];
      if (command.length !== expected.length) {
        return false;
      }
      return expected.every((value, index) => command[index] === value);
    },
  };
}

// ============================================================
// 落点构造器
// ============================================================

/** @brief server 型落点：指定路径 + 指定 server 槽 */
function serverFile(
  remotePath: string,
  label: string,
  slot: ServerSlot
): ServerTargetFile {
  return { kind: "server", remotePath, label, slot };
}

/** @brief enable 型落点：只操作使能数组（数组值固定为 SERVER_KEY） */
function enableFile(
  remotePath: string,
  label: string,
  path: string[]
): EnableTargetFile {
  return {
    kind: "enable",
    remotePath,
    label,
    enable: { path, value: SERVER_KEY },
  };
}

/**
 * @brief 构造 opencode 落点（全局与项目形态相同，仅路径与文案不同）
 * @details mcp 槽下写 opencode 风格 server（command 为数组、type:"local"、
 *          enabled:true、timeout:600000），文件缺 $schema 时由 file-ops.ts 按
 *          rootSchema 补齐。另注：opencode 的全局与项目配置是合并关系，非覆盖。
 */
function opencodeFile(remotePath: string, label: string): ServerTargetFile {
  return {
    kind: "server",
    remotePath,
    label,
    slot: arrayServerSlot(["mcp"], { type: "local", timeout: 600000 }),
    rootSchema: OPENCODE_SCHEMA,
  };
}
