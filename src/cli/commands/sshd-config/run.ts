/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : run.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: 主菜单与命令主入口
 *
 * 显示主菜单并等待用户选择、打印 banner，以及 sshd-config 命令主入口：
 * 平台校验 → 管理员权限检查 → 交互式菜单循环。
 * ======================================================
 */

import { select, isCancel } from "@clack/prompts";

import {
  type MenuChoice,
  MENU_ONE_CLICK,
  MENU_INSTALL_SSH,
  MENU_GENERATE_KEY,
  MENU_CONFIG_SSHD,
  MENU_CHECK_STATUS,
  MENU_UNINSTALL_SSH,
  MENU_SHOW_INFO,
  MENU_GEN_TEMPLATE,
  MENU_EXIT,
  type SshdConfigOptions,
} from "./types.js";
import { isWindows, isAdmin, relaunchAsAdmin } from "./platform.js";
import { doOneClickFlow } from "./steps/one-click.js";
import { doInstallSsh } from "./steps/install.js";
import { doGenerateKey } from "./steps/generate-key.js";
import { doConfigSshd } from "./steps/config-sshd.js";
import { doCheckStatus } from "./steps/check-status.js";
import { doUninstallSsh } from "./steps/uninstall.js";
import { doShowConnectionInfo } from "./steps/show-info.js";
import { doGenerateTemplate } from "./steps/gen-template.js";
import { clearScreen, pauseForMenu } from "../../shared/cli-helpers.js";

// ============================================================
// 主菜单
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择（clack select）
 * @details 基于 @clack/prompts 的 select 交互组件，方向键选择、Enter 确认。
 *          Ctrl+C 取消时返回 null，由调用方决定退出逻辑。
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "Windows SSH 免密登录配置",
    options: [
      {
        value: MENU_ONE_CLICK,
        label: `[${MENU_ONE_CLICK}] 一键完成全流程（安装→密钥→配置→模板）`,
      },
      {
        value: MENU_INSTALL_SSH,
        label: `[${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`,
      },
      {
        value: MENU_GENERATE_KEY,
        label: `[${MENU_GENERATE_KEY}] 编译服务器生成密钥对`,
      },
      {
        value: MENU_CONFIG_SSHD,
        label: `[${MENU_CONFIG_SSHD}] 配置 Windows 中 sshd 服务`,
      },
      {
        value: MENU_CHECK_STATUS,
        label: `[${MENU_CHECK_STATUS}] 检查 sshd 配置状态（只读诊断）`,
      },
      {
        value: MENU_UNINSTALL_SSH,
        label: `[${MENU_UNINSTALL_SSH}] 卸载 Windows SSH 服务`,
      },
      {
        value: MENU_SHOW_INFO,
        label: `[${MENU_SHOW_INFO}] 查看本机连接信息（用户名/IP）`,
      },
      {
        value: MENU_GEN_TEMPLATE,
        label: `[${MENU_GEN_TEMPLATE}] 生成 Linux 端 MCP 配置模板`,
      },
      { value: MENU_EXIT, label: `[${MENU_EXIT}] 退出` },
    ],
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

// ============================================================
// 主入口
// ============================================================

/**
 * @brief 打印命令 banner（标题分隔线）
 * @details 每次清屏后重新显示，作为菜单顶部固定的标题栏。
 */
function printBanner(): void {
  console.log("===================================");
  console.log("  embedded-mcp-toolkit sshd-config");
  console.log("===================================");
}

/**
 * @brief sshd-config 命令主入口
 * @details 执行流程：平台校验 → 管理员权限检查 → 交互式菜单循环。
 *          非管理员或非 Windows 平台直接退出，不进入菜单。
 * @param opts 命令选项（本期为空，预留扩展）
 */
export async function runSshdConfig(opts: SshdConfigOptions): Promise<void> {
  // 显式标记预留参数本期不使用，后续扩展时移除此行
  void opts;
  // 平台校验
  if (!isWindows()) {
    console.error("[err] 本命令仅支持 Windows");
    return;
  }

  // 管理员权限检查：非管理员时自动 UAC 提权重启（本进程退出）
  if (!isAdmin()) {
    relaunchAsAdmin();
    return; // relaunchAsAdmin 内部会 exit，此行仅作类型安全兜底
  }

  // 交互式菜单循环（每轮清屏 + 打印 banner，clack select 渲染菜单）
  while (true) {
    clearScreen();
    printBanner();
    const choice = await mainMenu();

    // 用户在主菜单 Ctrl+C 取消，或选择退出
    if (choice === null || choice === MENU_EXIT) {
      console.log("[info] 再见");
      return;
    }

    switch (choice) {
      case MENU_ONE_CLICK:
        await doOneClickFlow();
        break;
      case MENU_INSTALL_SSH:
        await doInstallSsh();
        break;
      case MENU_GENERATE_KEY:
        await doGenerateKey();
        break;
      case MENU_CONFIG_SSHD:
        await doConfigSshd();
        break;
      case MENU_CHECK_STATUS:
        await doCheckStatus();
        break;
      case MENU_UNINSTALL_SSH:
        await doUninstallSsh();
        break;
      case MENU_SHOW_INFO:
        await doShowConnectionInfo();
        break;
      case MENU_GEN_TEMPLATE:
        await doGenerateTemplate();
        break;
      default:
        // clack select 只会返回已定义的 value，理论上不会进入 default；
        // 保留兜底分支以防后续扩展遗漏
        break;
    }

    // step 执行完毕：按 Enter 回到菜单（清屏），按 q 退出
    if (await pauseForMenu()) {
      console.log("[info] 再见");
      return;
    }
  }
}
