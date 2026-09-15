/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : constants.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cnb 命令的常量定义
 *
 * 集中本命令目录内跨文件共享的**运行时常量**：CNB 入口、本地/远端落点路径、
 * 密钥名、隧道配置段标记与 MCP 桥接参数。仅类型/接口定义见 types.ts。
 * ======================================================
 */

// ============================================================
// CNB 云开发环境入口
// ============================================================

/**
 * @brief CNB 公网 SSH 入口域名
 * @details 平台为每个开发环境注入的固定入口（docs/MCP-CNB云环境访问Windows本地MCP方案.md
 *          一、3.4 节实测）：公网可达、仅 22 端口、none 认证——环境标识字符串本身
 *          即唯一凭证，无需密钥或密码。
 */
export const CNB_SSH_HOST = "cnb.space";

/** @brief CNB 公网 SSH 入口端口（实测仅 22 开放） */
export const CNB_SSH_PORT = 22;

// ============================================================
// 本地落盘路径（相对 cwd，位于 .gitignore 忽略的 .embedded 下）
// ============================================================

/** @brief 本地密钥存放目录（相对 cwd；.embedded/ssh 已被 .gitignore 忽略） */
export const LOCAL_KEY_DIR_REL = ".embedded/ssh";

/** @brief 本地密钥名（CNB 专用，与 sshd-config 的 id_mcp_server 区分） */
export const LOCAL_KEY_NAME = "id_mcp_cnb_server";

/** @brief 本地私钥相对路径（相对 cwd） */
export const LOCAL_KEY_REL = `${LOCAL_KEY_DIR_REL}/${LOCAL_KEY_NAME}`;

/** @brief 本地公钥相对路径（相对 cwd） */
export const LOCAL_PUBKEY_REL = `${LOCAL_KEY_REL}.pub`;

/** @brief MCP 桥接模板在本地的落地路径（相对 cwd），生成后供用户复核 */
export const MCP_TEMPLATE_REL = ".embedded/cnb/codebuddy-mcp.json";

// ============================================================
// 容器内落点
// ============================================================

/** @brief 容器内私钥名（ssh / scp 以 ~ 展开使用） */
export const REMOTE_KEY_NAME = LOCAL_KEY_NAME;

/** @brief 容器内 ssh config 相对家目录的路径 */
export const REMOTE_SSH_CONFIG = ".ssh/config";

/**
 * @brief 容器内 CodeBuddy 配置目录名（相对家目录）
 * @details MCP 配置落点的父目录。选用户级而非项目级：容器内"项目根"随用户实际
 *          打开的目录而变（/workspace 与 /workspace/<repo> 可能并存），写死在某一
 *          层极易打偏导致配置读不到；用户级与打开哪个项目无关。
 */
export const REMOTE_CONFIG_DIR_REL = ".codebuddy";

/**
 * @brief 容器内 MCP 配置文件名（用户级落点：<home>/.codebuddy/mcp.json）
 * @details 必须用**不带点**的 mcp.json。CodeBuddy IDE 的用户级 MCP 落点固定为
 *          `~/.codebuddy/mcp.json`（启动时读取，缺失则自动生成 `{"mcpServers":{}}`
 *          并挂上文件 watcher）；带点的 `.mcp.json` 只作**项目级**
 *          （<项目根>/.mcp.json）与**插件级**（插件根 .mcp.json）识别，
 *          放在用户级目录下不会被读取（实测：该路径下的 server 从未出现在
 *          MCP 加载日志中）。
 */
export const REMOTE_MCP_FILE_NAME = "mcp.json";

/** @brief 隧道代理指向的容器内端点（ssh config 的 Host 匹配项） */
export const TUNNEL_ENDPOINT = "127.0.0.1";

// ============================================================
// MCP 桥接
// ============================================================

/**
 * @brief MCP server 固定 key 名（Windows 侧桥接专用）
 * @details 刻意与项目 .mcp.json 中的本地 `embedded-board` 区分：CodeBuddy 同名
 *          server 的作用域优先级为 local > project > user，若沿用同名会被项目级
 *          配置覆盖，导致本命令写入的桥接定义不生效。
 */
export const SERVER_KEY = "win-embedded-board";

/** @brief Windows 侧 MCP 启动脚本名（位于项目根） */
export const START_SCRIPT_NAME = "remote-start-mcp.bat";

/** @brief MCP 配置的顶层 $schema（与项目 .mcp.json 保持同款） */
export const MCP_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

// ============================================================
// 容器内 ssh config 的隧道配置段标记
// ============================================================

/** @brief 隧道配置段起始标记（用于幂等替换，避免重复追加） */
export const TUNNEL_BEGIN = "# >>> embedded-mcp-toolkit cnb tunnel >>>";

/** @brief 隧道配置段结束标记 */
export const TUNNEL_END = "# <<< embedded-mcp-toolkit cnb tunnel <<<";

/** @brief 隧道配置段的 ServerAliveInterval 值（秒，长连接保活） */
export const SSH_KEEPALIVE_SECONDS = 30;
