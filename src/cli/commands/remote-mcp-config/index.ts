/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: embedded-mcp-toolkit remote-mcp-config 命令（目录门面）
 *
 * 交互式引导完成"在远程 Linux 服务器上配置 claude/zcode/opencode/dsh/codebuddy 的 MCP 桥接"。
 * 与 sshd-config 命令（配 Windows 免密登录）形成对偶：
 *   - sshd-config        ：Windows 当 SSH 服务器，让 Linux 免密登录进来
 *   - remote-mcp-config  ：Windows 当 SSH 客户端，登录 Linux 后在其上写 MCP 配置
 *
 * 命令本质是"Windows 通过 SSH/SFTP 登录 Linux，读写 Linux 上几个 JSON 文件"。Linux 端
 * 不需安装 node、不需本工具包、不需设备配置——MCP 本体始终由 Windows 的
 * remote-start-mcp.bat 启动，Linux 只配一个 SSH 桥接 server（ssh -i ... <user>@<ip> <bat>）。
 *
 * 所有文件读写通过 SFTP 完成（整文件下载→本地 JSON 按字段改写→整文件上传），
 * 不通过 shell exec 改文件，规避 JSON 引号转义与远端编码问题。
 *
 * 目录结构按"写什么 → 往哪写 → 怎么写"一条线组织：
 *   - types.ts        领域模型与常量（BridgeServer / TargetFile / DesiredState / StatusResult）
 *   - bridge.ts       写什么：Windows 端点采集 + 本次桥接 server 构造
 *   - targets.ts      往哪写：五客户端 × 八落点的唯一权威数据表（CLIENTS）与模板展开
 *   - file-ops.ts     怎么写：现状判定（readTargetStatus）+ 期望应用（applyDesired）
 *                     + 事务提交（commitTargetFile：备份→读→改→写→失败回滚）
 *   - operations.ts   业务流程：落点路由交互（askTarget）+ 配置 / 删除 / 只读诊断
 *   - run.ts          主菜单 + 主入口
 *   - sftp.ts         SFTP 文件操作；json-mutate.ts JSON path 纯函数
 *
 * 新增客户端：在 targets.ts 的 CLIENTS 数据表加一项即可；新增 server 形态：在
 * targets.ts 的形态工厂加一个函数。快照测试 test/cli/remote-mcp-config-clients.mjs
 * 锁定全部落点的路径与形态，重构/扩展时先跑它。
 * ======================================================
 */

export { runRemoteMcpConfig } from "./run.js";
export type { RemoteMcpConfigOptions } from "./types.js";
