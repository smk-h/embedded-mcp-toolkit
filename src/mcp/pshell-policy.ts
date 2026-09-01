/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : pshell-policy.ts
 * Author     : sumu
 * Date       : 2026/08/27
 * Version    : x.x.x
 * Description: 启动场景相关的 MCP 工具注册策略
 *
 *   power_shell_*：本地启动（Claude Code/ZCode/OpenCode 等客户端原生
 *   运行在本机，自带 shell 工具可直接执行 PowerShell）时不注册，
 *   避免 AI 经 MCP 绕行；远程 SSH 启动（客户端在 Linux，无法
 *   直接访问本机 PowerShell）时注册，是唯一执行通道。
 *   POWERSHELL_TOOLS 环境变量可强制覆盖自动判断。
 *
 *   ssh_build：与 power_shell_* 相反。远程 SSH 启动时客户端已运行在
 *   Linux 编译服务器上，自带 shell 可直接编译，不注册；本地启动
 *   （客户端与 MCP 同在 Windows 本机）时编译服务器不可直达，必须
 *   注册作为唯一编译通道。SSH_BUILD_TOOLS 环境变量可强制覆盖。
 * ======================================================
 */

/** 启动场景，取值与 resolveHostEndpoint 的 scenario 字段一致（该类型未导出，此处内联） */
type HostScenario = "local" | "remote-ssh";

/**
 * @brief 判断是否注册 power_shell_exec 工具到 MCP
 *
 * 优先级：POWERSHELL_TOOLS=1 强制注册 > =0 强制关闭 >
 * 未设置时按启动场景（remote-ssh 注册，local 不注册）。
 *
 * @param scenario 启动场景（resolveHostEndpoint().scenario）
 * @param env      环境变量（仅读取 POWERSHELL_TOOLS）
 * @returns 是否注册
 */
export function shouldRegisterPshellTools(
  scenario: HostScenario,
  env: { POWERSHELL_TOOLS?: string }
): boolean {
  if (env.POWERSHELL_TOOLS === "1") return true;
  if (env.POWERSHELL_TOOLS === "0") return false;
  return scenario === "remote-ssh";
}

/**
 * @brief 判断是否注册 ssh_build 工具到 MCP
 *
 * 与 power_shell_* 逻辑相反：远程 SSH 启动时 AI 客户端已运行在
 * Linux 编译服务器上，自带 shell 可直接执行 make 等编译命令，
 * 经 MCP 的 ssh_build 绕行是冗余，不注册；本地启动（客户端与
 * MCP 同在 Windows 本机）时编译服务器不可直达，必须注册。
 *
 * 优先级：SSH_BUILD_TOOLS=1 强制注册 > =0 强制关闭 >
 * 未设置时按启动场景（local 注册，remote-ssh 不注册）。
 *
 * @param scenario 启动场景（resolveHostEndpoint().scenario）
 * @param env      环境变量（仅读取 SSH_BUILD_TOOLS）
 * @returns 是否注册
 */
export function shouldRegisterSshBuildTools(
  scenario: HostScenario,
  env: { SSH_BUILD_TOOLS?: string }
): boolean {
  if (env.SSH_BUILD_TOOLS === "1") return true;
  if (env.SSH_BUILD_TOOLS === "0") return false;
  return scenario === "local";
}
