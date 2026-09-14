/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 命令的类型与接口定义
 *
 * 仅承载类型/接口（编译期产物）；运行时常量、菜单枚举见 constants.ts。
 * ======================================================
 */

// ============================================================
// 类型与接口
// ============================================================

/**
 * @brief cloudflared 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 *          action 为子命令直达入口（start/stop/status/log），缺省进交互菜单；
 *          url 仅对 start 生效，缺省使用 DEFAULT_TUNNEL_URL。
 */
export interface CloudflaredOptions {
  action?: string;
  url?: string;
}

/**
 * @brief Quick Tunnel 运行状态（持久化于 .embedded/cloudflared/state.json）
 * @details 记录后台 cloudflared 进程的关键信息：CLI 进程退出后凭 pid 探测
 *          进程存活、凭 logFile 重扫域名、凭 url 复原隧道目标。
 */
export interface TunnelState {
  /** 后台 cloudflared 进程的 PID（spawn detached 产生） */
  pid: number;
  /** 隧道目标 URL（如 ssh://127.0.0.1:22） */
  url: string;
  /** Quick Tunnel 分配的 trycloudflare.com 域名（未提取到时为 null） */
  domain: string | null;
  /** 启动时间（ISO 8601） */
  startedAt: string;
  /** cloudflared 可执行文件路径 */
  exePath: string;
  /** 隧道日志文件的绝对路径 */
  logFile: string;
}

/**
 * @brief cloudflared 可执行文件探测结果
 * @param exePath 命中的可执行文件路径，未找到为 null
 * @param source  命中来源：embedded=项目内便携版 / installed=系统安装路径 / path=PATH 探测 / none=未找到
 */
export interface CloudflaredDetectResult {
  exePath: string | null;
  source: "embedded" | "installed" | "path" | "none";
}
