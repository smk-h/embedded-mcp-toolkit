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
 * [6] 卸载 Windows OpenSSH Server（按安装方式卸载 + 清理公钥 + 还原配置）
 * [7] 查看本机连接信息（用户名 / IP）
 * [8] 生成 Linux 端 MCP 配置模板
 *
 * 通用能力（命令执行封装 runPowerShell / runCmd、平台与提权 isWindows / isAdmin /
 * relaunchAsAdmin、HTTPS 下载 downloadFile）已抽取至 src/cli/shared/ 供各命令复用；
 * SSH 传输层（sshConnect / sshExec / sshDownload / sshDisconnect）与终端交互辅助
 * （prompt / clearScreen / askPassword 等）同样位于 src/cli/shared/ssh.ts 与
 * src/cli/shared/cli-helpers.ts。不复用 src/sdk/transports/ssh.ts 的 SSHShell
 * （后者绑定 MCP 会话注册、PSH 解锁等业务机制，不适合一次性运维命令）。
 *
 * 目录结构：
 *   - types.ts             类型与接口
 *   - constants.ts         菜单枚举、路径、下载地址、正则等运行时常量
 *   - sshd-detect.ts       OpenSSH 安装与服务探测（只读）
 *   - sshd-service.ts      sshd 服务注册（变更操作）
 *   - sshd-config.ts       sshd_config 查找 / 修改 / 备份 / 恢复
 *   - authorized-keys.ts   authorized_keys 公钥写入 / 移除
 *   - steps/               8 个菜单 step，与菜单编号一一对应：
 *                          one-click [1] / install [2] / generate-key [3] /
 *                          configure-sshd [4] / check-status [5] / uninstall [6] /
 *                          show-info [7] / generate-template [8]
 *   - run.ts               主菜单 + 主入口
 * ======================================================
 */

export { runSshdConfig } from "./run.js";
export type { SshdConfigOptions } from "./types.js";
