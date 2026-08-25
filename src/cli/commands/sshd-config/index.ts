/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: embedded-mcp-toolkit sshd-config 命令（目录门面）
 *
 * 交互式引导完成"Windows 端 SSH 免密登录环境"搭建，用于让远端 Linux 编译服务器
 * 通过公钥免密登录 Windows 本地（MCP 服务所在机器）。
 *
 * 菜单功能：
 * [1] 一键完成全流程（安装→密钥→配置→模板）
 * [2] 安装 Windows OpenSSH Server（在线 / MSI 双途径）
 * [3] 登录 Linux 编译服务器，生成密钥对，SFTP 拉取公钥到本地
 * [4] 配置 Windows sshd（写 authorized_keys、改 sshd_config、禁用 administrators 分组）
 * [5] 检查 sshd 配置状态（只读诊断）
 *
 * SSH 操作基于 ssh2 库实现，传输层（sshConnect / sshExec / sshDownload /
 * sshUpload / sshDisconnect）与终端交互辅助（prompt / clearScreen / askPassword 等）
 * 已抽取至 src/cli/shared/ssh.ts 与 src/cli/shared/cli-helpers.ts，本目录直接 import
 * 复用，不复用 src/transports/ssh.ts 的 SSHShell（后者绑定 MCP 会话注册、
 * PSH 解锁等业务机制，不适合一次性运维命令）。
 *
 * 目录结构：
 *   - types.ts             类型/接口/常量/菜单枚举
 *   - platform.ts          平台与管理员权限
 *   - exec.ts              命令执行封装
 *   - download.ts          HTTP 下载
 *   - sshd-service.ts      sshd 服务辅助
 *   - sshd-config-edit.ts  sshd_config 文本处理
 *   - steps/               8 个菜单 step（install/generate-key/config-sshd/
 *                           check-status/uninstall/show-info/gen-template/one-click）
 *   - run.ts               主菜单 + 主入口
 * ======================================================
 */

export { runSshdConfig } from "./run.js";
export type { SshdConfigOptions } from "./types.js";
