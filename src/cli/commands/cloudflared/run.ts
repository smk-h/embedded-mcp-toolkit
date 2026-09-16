/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : run.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 命令主入口（交互菜单 + 子命令直达分发）
 *
 * 两种入口形态：
 *   - 无参数：交互式菜单循环（clearScreen + clack select + pauseForMenu，
 *     与 sshd-config 同款交互骨架）；
 *   - 子命令直达：start / stop / status / log 跳过菜单直接执行，
 *     便于脚本与 AI 客户端调用。
 *
 * 本命令不需要管理员权限：隧道仅从本机回环出站连接 Cloudflare 边缘，
 * 不涉及服务安装与系统配置变更。
 * ======================================================
 */

import { select, isCancel } from "@clack/prompts";

import {
  type MenuChoice,
  DIRECT_ACTIONS,
  DEFAULT_TUNNEL_URL,
  MENU_LOG,
  MENU_START,
  MENU_STATUS,
  MENU_STOP,
  MENU_INSTALL,
  MENU_EXIT,
} from "./constants.js";
import { type CloudflaredOptions } from "./types.js";
import { isWindows } from "../../shared/platform.js";
import {
  clearScreen,
  pauseForMenu,
  lockStdinRaw,
  unlockStdinRaw,
} from "../../shared/cli-helpers.js";
import { doStart } from "./steps/start.js";
import { doStatus } from "./steps/status.js";
import { doLog } from "./steps/log.js";
import { doStop } from "./steps/stop.js";
import { doInstall } from "./steps/install.js";

// ============================================================
// 交互菜单
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择（clack select）
 * @details 基于 @clack/prompts 的 select 交互组件，方向键选择、Enter 确认。
 *          Ctrl+C 取消时返回 null，由调用方决定退出逻辑。
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "cloudflared Quick Tunnel 管理",
    options: [
      {
        value: MENU_START,
        label: `[${MENU_START}] 启动隧道(暴露本机 sshd,后台常驻)`,
      },
      {
        value: MENU_STATUS,
        label: `[${MENU_STATUS}] 查看隧道状态与域名`,
      },
      {
        value: MENU_LOG,
        label: `[${MENU_LOG}] 查看隧道日志尾部`,
      },
      {
        value: MENU_STOP,
        label: `[${MENU_STOP}] 停止隧道`,
      },
      {
        value: MENU_INSTALL,
        label: `[${MENU_INSTALL}] 安装 cloudflared(检测 / winget / 便携版)`,
      },
      { value: MENU_EXIT, label: `[${MENU_EXIT}] 退出` },
    ],
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

/**
 * @brief 打印命令 banner（标题分隔线）
 * @details 每次清屏后重新显示，作为菜单顶部固定的标题栏。
 */
function printBanner(): void {
  console.log("====================================");
  console.log("  embedded-mcp-toolkit cloudflared");
  console.log("====================================");
}

// ============================================================
// 主入口
// ============================================================

/**
 * @brief cloudflared 命令主入口（交互式菜单循环）
 * @details 执行流程：平台校验 → 交互式菜单循环。每轮清屏 + 打印 banner，
 *          菜单项分发到对应 step；step 执行完毕按 Enter 回菜单、按 q 退出。
 *          隧道目标 URL 取 opts.url（缺省 DEFAULT_TUNNEL_URL），仅 start 生效。
 * @param opts 命令选项（url 覆盖默认隧道目标）
 */
export async function runCloudflared(opts: CloudflaredOptions): Promise<void> {
  if (!isWindows()) {
    console.error("[err] 本命令仅支持 Windows");
    return;
  }

  // 锁定 stdin raw：规避 Windows ConPTY 下 clack 取消/提交后 setRawMode(false)
  // 破坏后续 raw 读取、导致下一轮菜单吞键卡死的 bug（详见 lockStdinRaw JSDoc）
  lockStdinRaw();
  try {
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
        case MENU_START:
          await doStart(opts.url ?? DEFAULT_TUNNEL_URL);
          break;
        case MENU_STATUS:
          await doStatus();
          break;
        case MENU_LOG:
          await doLog();
          break;
        case MENU_STOP:
          await doStop();
          break;
        case MENU_INSTALL:
          await doInstall();
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
  } finally {
    // 覆盖正常退出与 step 抛异常两条路径，确保终端恢复 cooked 模式
    unlockStdinRaw();
  }
}

/**
 * @brief 子命令直达入口（跳过交互菜单）
 * @details `embedded-mcp-toolkit cloudflared start|stop|status|log` 直接执行
 *          对应 step 后退出；未知 action 打印合法列表并置非零退出码。
 * @param action 子命令名
 * @param opts   命令选项（url 仅对 start 生效）
 */
export async function runCloudflaredAction(
  action: string,
  opts: CloudflaredOptions
): Promise<void> {
  if (!isWindows()) {
    console.error("[err] 本命令仅支持 Windows");
    return;
  }

  if (!(DIRECT_ACTIONS as readonly string[]).includes(action)) {
    console.error(
      `[err] 未知子命令 "${action}",支持: ${DIRECT_ACTIONS.join(" | ")}(无参数进入交互菜单)`
    );
    process.exitCode = 1;
    return;
  }

  switch (action) {
    case "start":
      await doStart(opts.url ?? DEFAULT_TUNNEL_URL);
      break;
    case "stop":
      await doStop();
      break;
    case "status":
      await doStatus();
      break;
    case "log":
      await doLog();
      break;
    case "install":
      await doInstall();
      break;
  }
}
