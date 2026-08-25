/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : run.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: C5. 主菜单与主入口
 *
 * 显示主菜单并等待用户选择、打印 banner，以及 remote-mcp-config 命令主入口：
 * 交互收集地址+密码 → SSH 连接 → 打开 SFTP 会话 → 交互式菜单循环。
 * ======================================================
 */

import { Client, type SFTPWrapper } from "ssh2";
import { select, isCancel, text, password } from "@clack/prompts";

import {
  type MenuChoice,
  MENU_CONFIGURE,
  MENU_CHECK,
  MENU_REMOVE,
  MENU_EXIT,
  type RemoteMcpConfigOptions,
} from "./types.js";
import { doConfigure, doRemove, doCheckStatus } from "./operations.js";
import { openSftpSession, closeSftpSession } from "./sftp.js";
import {
  parseServerAddress,
  sshConnect,
  sshDisconnect,
  type LinuxServerInfo,
} from "../../shared/ssh.js";
import { clearScreen, pauseForMenu } from "../../shared/cli-helpers.js";

// ============================================================
// C5. 主菜单与主入口
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择（F2）
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "远程 MCP 配置",
    options: [
      { value: MENU_CONFIGURE, label: `[${MENU_CONFIGURE}] 配置 MCP 桥接` },
      {
        value: MENU_CHECK,
        label: `[${MENU_CHECK}] 查看远端当前 MCP 配置状态（只读）`,
      },
      { value: MENU_REMOVE, label: `[${MENU_REMOVE}] 删除已配置的 MCP` },
      { value: MENU_EXIT, label: `[${MENU_EXIT}] 退出` },
    ],
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

/**
 * @brief 打印命令 banner
 */
function printBanner(): void {
  console.log("===================================");
  console.log("  embedded-mcp-toolkit remote-mcp-config");
  console.log("===================================");
}

/**
 * @brief remote-mcp-config 命令主入口
 * @details 执行流程：交互收集地址+密码 → SSH 连接（失败报错中止）→ 交互式菜单循环。
 *          本命令是 SSH 客户端角色，无 Windows 管理操作，不做管理员权限检查。
 * @param opts 命令选项（本期为空，预留扩展）
 */
export async function runRemoteMcpConfig(
  opts: RemoteMcpConfigOptions
): Promise<void> {
  void opts;

  // 1. 交互收集连接信息
  const addressRaw = await text({
    message: "远程 Linux 服务器地址",
    placeholder: "user@host[:port]，如 sumu@1.2.3.4 或 root@1.2.3.4:2222",
  });
  if (isCancel(addressRaw)) {
    console.log("[info] 已取消");
    return;
  }
  const addressInput = (addressRaw ?? "").trim();
  if (!addressInput) {
    console.log("[info] 已取消");
    return;
  }

  const parsed = parseServerAddress(addressInput);
  if (!parsed) {
    console.error(
      "[err] 地址格式错误，应为 user@host[:port]（如 root@1.2.3.4 或 root@1.2.3.4:2222）"
    );
    return;
  }

  const pwdRaw = await password({ message: "登录密码" });
  if (isCancel(pwdRaw)) {
    console.log("[info] 已取消");
    return;
  }

  const info: LinuxServerInfo = { ...parsed, password: pwdRaw };

  // 2. SSH 连接（失败报错中止，不进入菜单，F1）
  let client: Client;
  try {
    console.log(`[run] 连接 ${info.username}@${info.host}:${info.port} ...`);
    client = await sshConnect(info);
    console.log("[info] SSH 连接成功");
  } catch (err) {
    console.error(
      `[err] 无法连接远程服务器: ${err instanceof Error ? err.message : err}`
    );
    console.error("     请检查地址/端口/凭据，以及远端 sshd 是否可达");
    return;
  }

  // 2.5 打开 SFTP 会话（贯穿整个菜单循环复用，避免反复开 channel 触发远端限制）
  let sftp: SFTPWrapper;
  try {
    sftp = await openSftpSession(client);
  } catch (err) {
    console.error(
      `[err] 打开 SFTP 会话失败: ${err instanceof Error ? err.message : err}`
    );
    sshDisconnect(client);
    return;
  }

  // 3. 交互式菜单循环（F2）
  try {
    while (true) {
      clearScreen();
      printBanner();
      const choice = await mainMenu();

      if (choice === null || choice === MENU_EXIT) {
        console.log("[info] 再见");
        return;
      }

      switch (choice) {
        case MENU_CONFIGURE:
          await doConfigure(client, sftp);
          break;
        case MENU_CHECK:
          await doCheckStatus(client, sftp);
          break;
        case MENU_REMOVE:
          await doRemove(client, sftp);
          break;
        default:
          // clack select 只会返回已定义的 value，保留兜底分支防扩展遗漏
          break;
      }

      // step 执行完毕：按 Enter 回菜单，按 q 退出
      if (await pauseForMenu()) {
        console.log("[info] 再见");
        return;
      }
    }
  } finally {
    // 先关 SFTP 会话，再断开 SSH 连接
    closeSftpSession(sftp);
    sshDisconnect(client);
  }
}
