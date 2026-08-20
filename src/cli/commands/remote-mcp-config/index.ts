/**
 * @file src/cli/commands/remote-mcp-config/index.ts
 * @brief embedded-mcp-toolkit remote-mcp-config 命令（目录门面）
 *
 * 交互式引导完成"在远程 Linux 服务器上配置 claude/zcode/opencode 的 MCP 桥接"。
 * 与 sshd-config 命令（ch14 之前，配 Windows 免密登录）形成对偶：
 *   - sshd-config        ：Windows 当 SSH 服务器，让 Linux 免密登录进来
 *   - remote-mcp-config  ：Windows 当 SSH 客户端，登录 Linux 后在其上写 MCP 配置
 *
 * 命令本质是"Windows 通过 SSH/SFTP 登录 Linux，读写 Linux 上几个 JSON 文件"。Linux 端
 * 不需安装 node、不需本工具包、不需设备配置——MCP 本体始终由 Windows 的
 * remote-start-mcp.bat 启动，Linux 只配一个 SSH 桥接 server（ssh -i ... <user>@<ip> <bat>）。
 *
 * 五类落点（固定 server key 名 "embedded-board"）：
 *   - Claude 全局 ：Linux ~/.claude.json 顶层 mcpServers
 *   - Claude 项目 ：Linux <proj>/.mcp.json（mcpServers）+ .claude/settings.local.json（enabledMcpjsonServers）
 *   - ZCode  项目 ：Linux <proj>/.zcode/config.json（mcp.servers，含 type/enabled）
 *   - opencode 全局：Linux ~/.config/opencode/opencode.json（mcp，command 为数组）
 *   - opencode 项目：Linux <proj>/.opencode/opencode.json（mcp，command 为数组）
 *   （ZCode 全局本期不做）
 *
 * 所有文件读写通过 SFTP 完成（整文件下载→本地 JSON 按字段改写→整文件上传），
 * 不通过 shell exec 改文件，规避 JSON 引号转义与远端编码问题。
 *
 * 目录结构：
 *   - types.ts        类型/接口/常量/菜单枚举
 *   - sftp.ts         C1 SFTP 文件操作
 *   - json-mutate.ts  C2 JSON path 操作纯函数
 *   - status.ts       C3 状态判定与 bridge 构造
 *   - target.ts       C4前 落点路由
 *   - operations.ts   C4后 配置/删除/诊断业务流程
 *   - run.ts          C5 主菜单 + 主入口
 */

export { runRemoteMcpConfig } from "./run.js";
export type { RemoteMcpConfigOptions } from "./types.js";
