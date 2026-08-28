/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : pshell-policy.ts
 * Author     : sumu
 * Date       : 2026/08/27
 * Version    : x.x.x
 * Description: power_shell_exec 工具的 MCP 注册策略
 *
 *   本地启动（Claude Code/ZCode/OpenCode 等客户端原生运行在本机，
 *   自带 shell 工具可直接执行 PowerShell）时不注册 power_shell_exec，
 *   避免 AI 经 MCP 绕行；远程 SSH 启动（客户端在 Linux，无法
 *   直接访问本机 PowerShell）时注册，是唯一执行通道。
 *   POWERSHELL_TOOLS 环境变量可强制覆盖自动判断。
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
