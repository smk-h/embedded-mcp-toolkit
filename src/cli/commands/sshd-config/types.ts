/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: sshd-config 命令的类型、接口与常量定义
 *
 * 集中本命令目录内跨文件共享的类型、接口、菜单枚举与路径常量，作为类型层供各子文件引用。
 * ======================================================
 */

// ============================================================
// 类型与常量
// ============================================================

/**
 * @brief sshd-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 *          本期无命令行选项，保留接口与与 init/split 一致；后续扩展时改为
 *          具名 interface 即可。
 */
export type SshdConfigOptions = Record<string, never>;

/**
 * @brief 外部命令执行结果
 * @details 统一封装 PowerShell / msiexec 等外部命令的退出码与输出。
 */
export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * @brief OpenSSH 安装方式检测结果
 * @param method    安装方式枚举
 * @param methodLabel 给用户展示的中文标签
 * @param exePath   sshd.exe 的实际路径（已安装时），未找到为 null
 * @param detail    附加说明（如检测到但服务未注册等）
 */
export interface OpenSshInstallInfo {
  method: OpenSshInstallMethod;
  methodLabel: string;
  exePath: string | null;
  detail: string;
}

/**
 * @brief OpenSSH 安装方式枚举
 * @details 通过三信号（Capability State / 服务 ImagePath / exe 路径探测）综合判定。
 */
export type OpenSshInstallMethod = "msi" | "capability" | "unknown";

/** @brief Capability 安装方式下 sshd.exe 的标准路径（由 Windows 组件管理） */
export const CAPABILITY_SSHD_EXE = "C:\\Windows\\System32\\OpenSSH\\sshd.exe";
/** @brief MSI 安装方式下 sshd.exe 的标准路径（由 MSI 安装器释放） */
export const MSI_SSHD_EXE = "C:\\Program Files\\OpenSSH\\sshd.exe";

/** @brief 菜单选项：一键完成全流程（安装→密钥→配置→模板） */
export const MENU_ONE_CLICK = "1";
/** @brief 菜单选项：安装 Windows SSH 服务 */
export const MENU_INSTALL_SSH = "2";
/** @brief 菜单选项：编译服务器生成密钥对 */
export const MENU_GENERATE_KEY = "3";
/** @brief 菜单选项：配置 Windows 中 sshd 服务 */
export const MENU_CONFIG_SSHD = "4";
/** @brief 菜单选项：检查 sshd 配置状态（只读诊断） */
export const MENU_CHECK_STATUS = "5";
/** @brief 菜单选项：卸载 Windows SSH 服务 */
export const MENU_UNINSTALL_SSH = "6";
/** @brief 菜单选项：查看 Windows 连接信息（用户名/IP） */
export const MENU_SHOW_INFO = "7";
/** @brief 菜单选项：生成 Linux 端 MCP 配置模板 */
export const MENU_GEN_TEMPLATE = "8";
/** @brief 菜单选项：退出 */
export const MENU_EXIT = "0";

/**
 * @brief 主菜单可选 value 联合类型
 * @details 复用 MENU_* 常量，供 clack select 泛型约束，确保 switch 分支穷举。
 */
export type MenuChoice =
  | typeof MENU_ONE_CLICK
  | typeof MENU_INSTALL_SSH
  | typeof MENU_GENERATE_KEY
  | typeof MENU_CONFIG_SSHD
  | typeof MENU_CHECK_STATUS
  | typeof MENU_UNINSTALL_SSH
  | typeof MENU_SHOW_INFO
  | typeof MENU_GEN_TEMPLATE
  | typeof MENU_EXIT;

/** @brief OpenSSH Server 的 Windows Capability 名称（在线安装用） */
export const OPENSSH_CAPABILITY_NAME = "OpenSSH.Server~~~~0.0.1.0";

/** @brief OpenSSH MSI 离线安装包下载地址（GitHub releases） */
export const OPENSSH_MSI_URL =
  "https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi";

/** @brief sshd_config 文件路径（Windows OpenSSH 安装后的标准位置） */
export const SSHD_CONFIG_PATH = "C:\\ProgramData\\ssh\\sshd_config";

/** @brief 公钥在本地的落地路径（相对 cwd），专用密钥名避免覆盖用户通用密钥 */
export const LOCAL_PUBKEY_REL = ".embedded/ssh/id_mcp_server.pub";

/** @brief MSI 安装包在本地的缓存路径（相对 cwd），step1 下载、step5 卸载复用 */
export const LOCAL_MSI_REL = ".embedded/ssh/OpenSSH-Win64.msi";

/** @brief Linux 端 .mcp.json 模板输出路径（相对 cwd），自动填充 IP/用户名/路径 */
export const REMOTE_MCP_TEMPLATE_REL = ".embedded/ssh/mcp-remote-template.json";

/** @brief sshd.exe 候选路径（按优先级：MSI 安装目录 → Windows 自带目录） */
export const SSHD_EXE_CANDIDATES = [MSI_SSHD_EXE, CAPABILITY_SSHD_EXE];

/** @brief 公钥行匹配正则（ssh-rsa / ssh-ed25519 / ecdsa- / sk- 开头） */
export const PUBKEY_LINE_RE = /^\s*(ssh-rsa|ssh-ed25519|ecdsa-|sk-)/;
