/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : constants.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 命令的常量与菜单枚举
 *
 * 集中本命令目录内跨文件共享的**运行时常量**：菜单选项、子命令列表、
 * 路径、下载地址、域名提取正则与轮询参数。仅类型/接口定义见 types.ts。
 * ======================================================
 */

// ============================================================
// 菜单选项
// ============================================================

/** @brief 菜单选项：启动 Quick Tunnel（后台常驻） */
export const MENU_START = "1";
/** @brief 菜单选项：查看隧道状态与域名 */
export const MENU_STATUS = "2";
/** @brief 菜单选项：查看隧道日志尾部 */
export const MENU_LOG = "3";
/** @brief 菜单选项：停止隧道 */
export const MENU_STOP = "4";
/** @brief 菜单选项：安装 cloudflared（检测 / winget / 便携版） */
export const MENU_INSTALL = "5";
/** @brief 菜单选项：退出 */
export const MENU_EXIT = "0";

/**
 * @brief 主菜单可选 value 联合类型
 * @details 复用 MENU_* 常量，供 clack select 泛型约束，确保 switch 分支穷举。
 */
export type MenuChoice =
  | typeof MENU_START
  | typeof MENU_STATUS
  | typeof MENU_LOG
  | typeof MENU_STOP
  | typeof MENU_INSTALL
  | typeof MENU_EXIT;

// ============================================================
// 子命令直达
// ============================================================

/**
 * @brief 支持的子命令直达列表
 * @details `embedded-mcp-toolkit cloudflared <action>` 跳过菜单直接执行，
 *          与菜单项一一对应；便于脚本与 AI 客户端调用。
 *          install 内部含安装途径的交互选择，非交互环境下取消即返回。
 */
export const DIRECT_ACTIONS = [
  "start",
  "stop",
  "status",
  "log",
  "install",
] as const;

/** @brief 子命令直达的 action 联合类型 */
export type DirectAction = (typeof DIRECT_ACTIONS)[number];

// ============================================================
// 隧道参数与域名提取
// ============================================================

/**
 * @brief 隧道目标 URL 默认值（暴露本机 sshd 22 端口）
 * @details 必须写显式 IPv4 127.0.0.1，禁止 localhost——Windows 上 cloudflared
 *          把 localhost 解析为 IPv6 回环 ::1，导致 sshd 侧 SSH_CONNECTION 的
 *          server-ip 为 ::1，host-endpoint 的 IPv4 端点解析失败（实测结论，
 *          见 docs/MCP-CNB云环境访问Windows本地MCP方案.md 六、3）。
 */
export const DEFAULT_TUNNEL_URL = "ssh://127.0.0.1:22";

/**
 * @brief Quick Tunnel 域名提取正则
 * @details 捕获组 1 为**裸域名**（不含 https:// 前缀）——state.domain 与
 *          连接命令示例统一使用裸域名：cloudflared access 的 --hostname
 *          参数与 ssh 目标端点都要求不带协议前缀。
 */
export const DOMAIN_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/;

/**
 * @brief Quick Tunnel 僵尸签名（隧道已被 Cloudflare 回收）
 * @details Quick Tunnel 掉线超过宽限期后边缘侧删除其注册；本地进程重连时
 *          收到 "Unauthorized: Tunnel not found"，此后只会无限重试同一已
 *          删除的隧道 ID，永不自愈，唯一出路是停止后重新拉起换新域名。
 *          与域名 DNS 校验组成双信号，见 tunnel-health.ts。
 */
export const TUNNEL_DEAD_RE = /Unauthorized: Tunnel not found/;

/** @brief 健康校验中单次 DNS 解析的超时（毫秒），防系统解析器抖动卡死 CLI */
export const DNS_CHECK_TIMEOUT_MS = 5000;

/** @brief 域名轮询间隔（毫秒） */
export const DOMAIN_POLL_MS = 500;

/**
 * @brief 域名轮询超时（毫秒）
 * @details 实测 cloudflared 启动预检（DNS/UDP/TCP/API 六项）约 10 秒，
 *          20 秒覆盖冷启动余量。
 */
export const DOMAIN_TIMEOUT_MS = 20000;

// ============================================================
// 域名解析就绪等待与重试
// ============================================================

/**
 * @brief 域名未解析时的最大重试次数
 * @details 面向 Quick Tunnel 域名的 DNS 传播窗口（实测约 1 分钟）：
 *          每次重试前等待 DOMAIN_RETRY_WAIT_S 秒，12 次 × 5s ≈ 1 分钟，
 *          覆盖传播期而不至于把刚拉起、域名尚在生效中的健康隧道误判失败。
 */
export const DOMAIN_RETRY_MAX = 12;

/** @brief 每次重试前的等待秒数（倒计时在同一行内递减显示） */
export const DOMAIN_RETRY_WAIT_S = 5;

/**
 * @brief 域名解析优选的公共 DNS 服务器（国内可达）
 * @details 优先直查公共 DNS、失败回落系统解析器（见 tunnel-health.ts）：
 *          - 系统解析器（多为路由器 DNS）抖动或对首次未传播记录缓存了
 *            NXDOMAIN 时，公共 DNS 直查是绕开负缓存、拿到新鲜结果的途径；
 *          - 服务器必须是本机网络实际可达的节点：实测 1.1.1.1 / 8.8.8.8
 *            在国内网络常被拦截（UDP 53 超时），故选阿里 / 腾讯公共 DNS。
 */
export const DNS_PUBLIC_SERVERS = ["223.5.5.5", "119.29.29.29"];

// ============================================================
// 本地落盘路径（相对 cwd）
// ============================================================

/** @brief 隧道工作目录（状态文件与日志的父目录，相对 cwd） */
export const TUNNEL_DIR_REL = ".embedded/cloudflared";
/** @brief 隧道运行状态文件（相对 cwd） */
export const STATE_FILE_REL = ".embedded/cloudflared/state.json";
/** @brief 隧道日志文件（相对 cwd），每次启动重建 */
export const LOG_FILE_REL = ".embedded/cloudflared/tunnel.log";
/** @brief 便携版 cloudflared.exe 的落地路径（相对 cwd），随项目走不污染系统 */
export const PORTABLE_EXE_REL = ".embedded/bin/cloudflared.exe";

// ============================================================
// cloudflared 可执行文件探测与安装
// ============================================================

/**
 * @brief 系统安装路径候选（按优先级）
 * @details winget 安装的默认落点为 Program Files (x86)，MSI 安装可能在
 *          Program Files；均探测后再回落 where（PATH）。
 */
export const CLOUDFLARED_EXE_CANDIDATES = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

/** @brief 便携版下载地址（GitHub releases latest，支持 301/302 跟随） */
export const CLOUDFLARED_PORTABLE_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
