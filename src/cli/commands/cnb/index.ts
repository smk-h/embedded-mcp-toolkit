/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: embedded-mcp-toolkit cnb 命令（目录门面）
 *
 * 一键打通"CNB 云开发环境 → Windows 本地 MCP"的免密通道，把方案文档
 * （docs/MCP-CNB云环境访问Windows本地MCP方案.md）中需要手工执行的步骤
 * 固化为一条命令。核心价值在于**可重复执行**：CNB 容器每次重建都会丢密钥与
 * 配置，重跑本命令即可恢复，Windows 侧无需任何改动。
 *
 * 执行流程（线性，无主菜单）：
 *   [1] 输入 CNB 环境标识（<环境标识>@cnb.space）
 *   [2] 确保 Cloudflare Quick Tunnel 就绪，取得随机域名
 *   [3] Windows 本地生成 CNB 专用密钥对 id_mcp_cnb_server，公钥写入 authorized_keys
 *   [4] 以 none 认证登录容器（免密），推送私钥并写入隧道 ssh config
 *   [5] 生成 CodeBuddy MCP 配置并写入容器用户级 ~/.codebuddy/mcp.json（不带点）
 *   [6] 展示容器侧 ssh 命令（免密登录到 Windows）→ 按 q 退出
 *
 * 目录结构：
 *   - types.ts         类型与接口（CnbEnvInfo / LocalEndpoint / PushKeyResult 等）
 *   - constants.ts     入口、路径、密钥名、隧道标记等运行时常量
 *   - connect.ts       CNB 地址解析与 none 认证连接
 *   - steps/           线性流程的四个步骤：
 *                      tunnel（确保隧道）/ local-key（本地密钥）/
 *                      push-key（推送私钥+ssh config）/ mcp-config（MCP 配置）+
 *                      summary（结果展示）
 *   - run.ts           主入口与流程编排
 * ======================================================
 */

export { runCnb } from "./run.js";
