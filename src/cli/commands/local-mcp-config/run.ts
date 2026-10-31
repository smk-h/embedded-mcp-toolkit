/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : run.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: 主菜单与主入口
 *
 * local-mcp-config 命令主入口：探测 remote-start-mcp.bat 绝对路径 →
 * 交互式菜单循环（配置 / 查看 / 删除 / 退出）。各菜单项的业务动作见
 * operations.ts。与 remote-mcp-config/run.ts（SSH + SFTP）对偶：本命令
 * 全程本机文件操作，无网络环节。
 * ======================================================
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { select, isCancel, text } from "@clack/prompts";

import {
  type LocalMcpConfigOptions,
  MENU_CHECK,
  MENU_CONFIGURE,
  MENU_EXIT,
  MENU_REMOVE,
  type MenuChoice,
} from "./types.js";
import { doCheckStatus, doConfigure, doRemove } from "./operations.js";
import { detectBatCandidates } from "./bridge.js";
import {
  clearScreen,
  lockStdinRaw,
  logDetail,
  pauseForMenu,
  unlockStdinRaw,
} from "../../shared/cli-helpers.js";

// ============================================================
// bat 探测
// ============================================================

/**
 * @brief 探测并确定 remote-start-mcp.bat 的绝对路径
 * @details 多个候选时让用户选择；无候选时允许手输路径（校验存在），并提示
 *          先在工具包项目运行 init 生成。
 * @returns bat 绝对路径；用户取消或始终未确定返回 null
 */
async function detectBatPath(): Promise<string | null> {
  const candidates = detectBatCandidates(process.argv[1], process.cwd());

  if (candidates.length === 1) {
    logDetail(`    已定位 remote-start-mcp.bat: ${candidates[0]}`);
    return candidates[0];
  }

  if (candidates.length > 1) {
    const picked = await select<string>({
      message: "发现多个 remote-start-mcp.bat，选择要使用的脚本",
      options: candidates.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(picked)) {
      logDetail("    已取消");
      return null;
    }
    return picked;
  }

  // 无候选：允许手输（校验存在），或放弃
  logDetail("    未自动找到 remote-start-mcp.bat");
  const manual = await text({
    message: "手动输入 remote-start-mcp.bat 绝对路径（留空放弃）",
    placeholder: "如 E:\\AI\\embedded-mcp-toolkit\\remote-start-mcp.bat",
  });
  if (isCancel(manual)) {
    logDetail("    已取消");
    return null;
  }
  const input = (manual ?? "").trim();
  if (!input) {
    logDetail("    未提供 bat 路径，放弃");
    return null;
  }
  const abs = resolve(input);
  if (!existsSync(abs)) {
    logDetail(`    文件不存在: ${abs}`);
    logDetail(
      "    提示: 请先在工具包项目运行 init（或 npm run cmd:init）生成 remote-start-mcp.bat"
    );
    return null;
  }
  return abs;
}

// ============================================================
// 主菜单与主入口
// ============================================================

/**
 * @brief 显示主菜单并等待用户选择
 * @returns 选中的菜单 value；用户取消（Ctrl+C）返回 null
 */
async function mainMenu(): Promise<MenuChoice | null> {
  const choice = await select<MenuChoice>({
    message: "本地 MCP 配置",
    options: [
      { value: MENU_CONFIGURE, label: `[${MENU_CONFIGURE}] 配置本地 MCP` },
      {
        value: MENU_CHECK,
        label: `[${MENU_CHECK}] 查看本地当前 MCP 配置状态（只读）`,
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
  console.log("==================================");
  console.log("  embedded-mcp-toolkit local-mcp-config");
  console.log("==================================");
}

/**
 * @brief local-mcp-config 命令主入口
 * @details 执行流程：探测 remote-start-mcp.bat 绝对路径（启动失败即中止）→
 *          交互式菜单循环。本命令全程本机文件操作，无网络环节；server 统一为
 *          `cmd /c <bat 绝对路径>`，cwd 与环境变量由 bat 持有（env 单一事实来源）。
 * @param opts 命令选项（本期为空，预留扩展）
 */
export async function runLocalMcpConfig(
  opts: LocalMcpConfigOptions
): Promise<void> {
  void opts;

  printBanner();

  // 1. 探测 bat（找不到且用户未手输有效路径则中止）
  const batPath = await detectBatPath();
  if (!batPath) {
    return;
  }

  // 2. 交互式菜单循环（F2）
  // 锁定 stdin raw：规避 Windows ConPTY 下 clack 取消/提交后 setRawMode(false)
  // 破坏后续 raw 读取、导致下一轮菜单吞键卡死的 bug（详见 lockStdinRaw JSDoc）
  lockStdinRaw();
  try {
    while (true) {
      clearScreen();
      printBanner();
      logDetail(`    bat: ${resolve(batPath)}`);
      const choice = await mainMenu();

      if (choice === null || choice === MENU_EXIT) {
        logDetail("    再见");
        return;
      }

      switch (choice) {
        case MENU_CONFIGURE:
          await doConfigure(batPath);
          break;
        case MENU_CHECK:
          await doCheckStatus(batPath);
          break;
        case MENU_REMOVE:
          await doRemove();
          break;
        default:
          // clack select 只会返回已定义的 value，保留兜底分支防扩展遗漏
          break;
      }

      // step 执行完毕：按 Enter 回菜单，按 q 退出
      if (await pauseForMenu()) {
        logDetail("    再见");
        return;
      }
    }
  } finally {
    // 恢复终端 cooked 模式
    unlockStdinRaw();
  }
}
