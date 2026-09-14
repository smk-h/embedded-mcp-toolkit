/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: embedded-mcp-toolkit cloudflared 命令（目录门面）
 *
 * 在 Windows 上启动和管理 cloudflared Quick Tunnel，把"暴露本机 sshd
 * 给公网侧 AI 客户端"的操作固化为单命令（方案背景见
 * docs/MCP-CNB云环境访问Windows本地MCP方案.md 三、四、五章）。
 *
 * 两种入口形态：
 *   - embedded-mcp-toolkit cloudflared           交互式菜单
 *   - embedded-mcp-toolkit cloudflared <action>  子命令直达
 *     start（后台启动隧道并提取域名）/ stop（杀进程树并清状态）/
 *     status（存活探测 + 域名展示，可从日志补录域名）/ log（日志尾部）
 *
 * 菜单功能：
 * [1] 启动隧道(后台常驻)   [2] 查看状态与域名   [3] 查看日志尾部
 * [4] 停止隧道             [5] 安装 cloudflared
 *
 * 实现要点：隧道进程 spawn detached 独立常驻，与 CLI 生命周期解耦；
 * pid/域名/日志路径持久化于 .embedded/cloudflared/state.json 供跨进程
 * 管控；域名从隧道日志按 trycloudflare 正则提取。不需要管理员权限。
 *
 * 目录结构：
 *   - types.ts         类型与接口（TunnelState / CloudflaredOptions）
 *   - constants.ts     菜单枚举、路径、域名正则、下载地址等运行时常量
 *   - tunnel-detect.ts cloudflared 可执行文件探测（只读）
 *   - tunnel-process.ts 后台进程管理（启动 / 存活探测 / 停止 / 域名提取）
 *   - tunnel-state.ts  状态文件持久化读写
 *   - steps/           5 个菜单 step，与菜单编号一一对应：
 *                      start [1] / status [2] / log [3] / stop [4] /
 *                      install [5]；summary.ts 为 start/status 共用的展示模块
 *   - run.ts           主菜单 + 主入口 + 子命令直达分发
 * ======================================================
 */

export { runCloudflared, runCloudflaredAction } from "./run.js";
export type { CloudflaredOptions, TunnelState } from "./types.js";
