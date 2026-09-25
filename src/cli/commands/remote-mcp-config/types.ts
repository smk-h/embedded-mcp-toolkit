/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/09/25
 * Version    : x.x.x
 * Description: remote-mcp-config 命令的领域模型与常量
 *
 * 领域模型按"写什么 → 往哪写 → 怎么改 → 现状如何"一条线组织：
 *   - BridgeServer  （写什么）本次桥接定义，由 bridge.ts 构造，全命令唯一事实来源
 *   - TargetFile    （往哪写）单个落点文件，判别联合：server 型写 server 对象、
 *                   enable 型操作使能数组；全部客户端的落点数据集中在 targets.ts
 *   - DesiredState  （怎么改）期望状态：写入 {present:true, bridge} 或移除
 *                   {present:false}，配置与删除共用同一套应用逻辑（files.ts）
 *   - StatusResult  （现状如何）单个落点当前与期望的比对结果（files.ts 判定）
 * ======================================================
 */

// ============================================================
// 命令选项与菜单常量
// ============================================================

/**
 * @brief remote-mcp-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。本期无命令行选项。
 */
export type RemoteMcpConfigOptions = Record<string, never>;

/** @brief MCP server 固定 key 名（与 sshd-config 模板、项目 .mcp.json 一致） */
export const SERVER_KEY = "embedded-board";

/** @brief SSH 专用密钥名（与 sshd-config 生成的密钥一致） */
export const SSH_KEY_PATH = "~/.ssh/id_mcp_server";

/** @brief 菜单选项：配置 MCP */
export const MENU_CONFIGURE = "1";
/** @brief 菜单选项：查看远端当前 MCP 配置状态（只读诊断） */
export const MENU_CHECK = "2";
/** @brief 菜单选项：删除已配置的 MCP */
export const MENU_REMOVE = "3";
/** @brief 菜单选项：退出 */
export const MENU_EXIT = "0";

/** @brief 主菜单可选 value 联合类型（供 clack select 泛型约束，switch 分支穷举） */
export type MenuChoice =
  | typeof MENU_CONFIGURE
  | typeof MENU_CHECK
  | typeof MENU_REMOVE
  | typeof MENU_EXIT;

// ============================================================
// 客户端与配置范围
// ============================================================

/**
 * @brief 客户端类型
 * @details claude / zcode / opencode / dsh / codebuddy。
 *          claude / opencode / codebuddy 支持全局与项目两级；
 *          zcode / dsh 本期仅项目级（dsh = DeepSeek Harness）。
 */
export type McpClient = "claude" | "zcode" | "opencode" | "dsh" | "codebuddy";

/** @brief 配置范围：global = 用户级文件（所有项目可用），project = 指定项目内文件 */
export type Scope = "global" | "project";

/**
 * @brief 落点解析上下文
 * @details 把 SSH 连接与终端交互收敛为落点解析需要的最小能力集，使 targets.ts 的
 *          resolveTarget 不必依赖 ssh2 的 Client，从而可被测试用替身驱动（见 test/cli/）。
 * @param getHome        取远端家目录绝对路径（global 落点用于展开 ~）
 * @param askProjectPath 询问远端项目绝对路径；用户取消或输入为空时返回 null
 */
export interface ResolveCtx {
  getHome(): Promise<string>;
  askProjectPath(): Promise<string | null>;
}

// ============================================================
// 写什么：桥接定义与期望状态
// ============================================================

/**
 * @brief SSH 桥接 server 对象的逻辑定义（与客户端写法无关）
 * @details 纯逻辑表达：command 固定为 ssh，args 为专用密钥 + <user>@<ip> + bat 路径。
 *          具体写入目标文件时的对象形态由 ServerSlot.render 按落点渲染。
 */
export interface BridgeServer {
  command: string;
  args: string[];
}

/**
 * @brief 对一个落点的期望状态（配置与删除的统一表达）
 * @details 配置 = { present: true, bridge }（写入本次桥接定义）；
 *          删除 = { present: false }（移除 embedded-board，不关心内容长什么样）。
 *          判别联合保证"要写入就必须给出桥接定义"。
 */
export type DesiredState =
  { present: true; bridge: BridgeServer } | { present: false };

// ============================================================
// 往哪写：落点文件（判别联合，只有两种合法形态）
// ============================================================

/**
 * @brief server 写入槽（往哪写 + 怎么写）
 * @details 把"server 容器在哪"与"server 对象长什么样"绑成一个不可分的整体：
 *          形态差异（是否写 type / enabled / cwd，command 是字符串还是数组）由本槽自带
 *          的 render / matches 决定。新增客户端若引入新形态，只需在 targets.ts 的
 *          形态工厂里给出一份实现，无需改动读写通用逻辑。
 * @param path    server 容器的 JSON 路径（claude:["mcpServers"]，
 *                zcode:["mcp","servers"]，opencode:["mcp"]）
 * @param render  渲染写入目标文件的 server 对象
 * @param matches 判断文件中现有的 server 对象是否与桥接定义一致；一致性基准只比
 *                command（+args），不比 type / enabled 等开关字段
 */
export interface ServerSlot {
  path: string[];
  render(bridge: BridgeServer): Record<string, unknown>;
  matches(existing: Record<string, unknown>, bridge: BridgeServer): boolean;
}

/**
 * @brief 使能数组槽（仅 Claude 项目的 settings.local.json 使用）
 * @param path  使能数组的 JSON 路径（如 ["enabledMcpjsonServers"]）
 * @param value 数组中追加/移除的值（"embedded-board"）
 */
export interface EnableSlot {
  path: string[];
  value: string;
}

/**
 * @brief server 型落点：在 remotePath 里写一个 server 对象
 * @param remotePath 远端绝对路径（targets.ts 的数据表中为含 ~ / {proj} 的模板）
 * @param label      用户可见的落点描述（如 "Claude 全局"）
 * @param slot       server 写入槽
 * @param rootSchema 顶层固定字段值（仅 opencode："$schema"）；写入时若缺失则补齐
 */
export interface ServerTargetFile {
  kind: "server";
  remotePath: string;
  label: string;
  slot: ServerSlot;
  rootSchema?: string;
}

/**
 * @brief enable 型落点：只操作 remotePath 里的使能数组，不写 server 对象
 * @details 当前仅 Claude 项目的 .claude/settings.local.json（enabledMcpjsonServers）。
 */
export interface EnableTargetFile {
  kind: "enable";
  remotePath: string;
  label: string;
  enable: EnableSlot;
}

/** @brief 一个落点文件：server 型或 enable 型，二者必有其一且只有其一 */
export type TargetFile = ServerTargetFile | EnableTargetFile;

/**
 * @brief 一个配置目标（对应一次用户选择的 client + scope/路径）
 * @param client 客户端类型
 * @param files  1~2 个落点文件（claude 项目 = 2 个，其余 = 1 个）
 */
export interface Target {
  client: McpClient;
  files: TargetFile[];
}

// ============================================================
// 现状如何：状态判定结果
// ============================================================

/**
 * @brief 单个落点的状态枚举
 * @details absent   ：文件不存在，或其中没有 embedded-board
 *          present  ：存在 embedded-board，但本次未提供桥接定义、不做一致性比对
 *                    （删除场景只关心"是否已配置"）
 *          consistent / inconsistent：提供了桥接定义且已完成比对
 *          error    ：文件存在但 JSON 解析失败
 */
export type ServerStatus =
  "absent" | "present" | "consistent" | "inconsistent" | "error";

/**
 * @brief 单个落点的状态读取结果
 * @param status    状态枚举
 * @param detail    给用户看的状态说明
 * @param existing  现有 server 对象（展示用；absent/error 时为 undefined）
 */
export interface StatusResult {
  status: ServerStatus;
  detail: string;
  existing?: Record<string, unknown>;
}
