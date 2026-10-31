/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: local-mcp-config 命令目录门面
 *
 * 为本机（Windows）其它项目目录生成本地 MCP 配置：server 统一为
 * `cmd /c <remote-start-mcp.bat 绝对路径>`，bat 持有 cwd 与全部环境变量。
 * 各文件职责：
 *   - run.ts        主入口 + 菜单循环 + bat 探测交互
 *   - operations.ts 落点路由交互与配置/删除/只读诊断三个菜单动作
 *   - bridge.ts     本地启动定义构造与 bat 候选探测
 *   - file-ops.ts   本地 fs 版落点读写引擎（现状判定/事务提交）
 *   - types.ts      领域模型（re-export remote-mcp-config/types.js）
 * 落点数据表直接复用 ../remote-mcp-config/targets.ts 的 CLIENTS（两端同构）。
 * ======================================================
 */

export { runLocalMcpConfig } from "./run.js";
