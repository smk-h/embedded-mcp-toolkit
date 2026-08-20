/**
 * @file src/cli/commands/remote-mcp-config/types.ts
 * @brief remote-mcp-config 命令的类型、接口与常量定义
 *
 * 集中本命令目录内跨文件共享的类型、接口、菜单枚举与路径常量，作为类型层供各子文件引用。
 */

// ============================================================
// 类型与常量
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

/** @brief 客户端类型 */
export type McpClient = "claude" | "zcode" | "opencode";

/** @brief Claude 配置范围 */
export type ClaudeScope = "global" | "project";

/**
 * @brief SSH 桥接 server 对象的逻辑定义（与客户端写法无关）
 * @details 纯逻辑表达：command 固定为 ssh，args 为专用密钥 + <user>@<ip> + bat 路径。
 *          具体写入目标文件时的对象形态（command+args 分体 / command 数组、
 *          type/enabled/timeout 等客户端差异）由 TargetFile.serverStyle / serverType 决定，
 *          在 status.ts 的 renderServerObject 中按落点渲染。
 */
export interface BridgeServer {
  command: string;
  args: string[];
}

/**
 * @brief 配置落点描述符（配置驱动，核心抽象）
 * @details 一个 TargetFile 完整描述"在远端哪个文件、哪个 JSON 路径下、如何读写
 *          embedded-board"。四类落点的所有差异都收敛为该结构的不同字段取值，
 *          读写逻辑对各落点完全通用。
 * @param remotePath       远端绝对路径
 * @param label            用户可见的落点描述（如 "Claude 全局"）
 * @param serverPath       server 容器的 JSON 路径（claude:["mcpServers"]，
 *                         zcode:["mcp","servers"]，opencode:["mcp"]）；
 *                         无 server 定义时留空（仅做使能数组操作的文件）
 * @param serverStyle      server 对象写法：split=command+args 分体（claude/zcode），
 *                         array=command 为数组（opencode）
 * @param serverType       带 type/enabled 时的 type 值（zcode:"stdio"，opencode:"local"）；
 *                         无则不写 type/enabled（claude）
 * @param rootSchema       顶层固定字段值（仅 opencode："$schema"）；写入时若缺失则补齐
 * @param enableArrayPath  使能数组的 JSON 路径（仅 claude 项目 settings.local.json）
 * @param enableValue      使能数组中追加/移除的值（"embedded-board"）
 */
export interface TargetFile {
  remotePath: string;
  label: string;
  serverPath: string[];
  serverStyle: "split" | "array";
  serverType?: string;
  rootSchema?: string;
  enableArrayPath?: string[];
  enableValue?: string;
}

/**
 * @brief 一个配置目标（对应一次用户选择的 client + scope/路径）
 * @param client 客户端类型
 * @param files  1~2 个落点文件（claude 项目 = 2 个，其余 = 1 个）
 */
export interface Target {
  client: McpClient;
  files: TargetFile[];
}

/** @brief 状态判定结果 */
export type ServerStatus = "absent" | "consistent" | "inconsistent" | "error";

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
