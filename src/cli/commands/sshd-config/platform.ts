/**
 * @file src/cli/commands/sshd-config/platform.ts
 * @brief 平台与管理员权限
 *
 * 判断 Windows 平台、检测管理员权限、自动 UAC 提权重启当前命令。
 */

import { execFileSync } from "child_process";

// ============================================================
// 平台与管理员权限
// ============================================================

/**
 * @brief 判断当前是否在 Windows 平台
 * @returns Windows 平台返回 true
 */
export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * @brief 检测当前进程是否具备管理员权限
 * @details 优先用 `net session`（退出码 0 = 管理员），失败时回退到 PowerShell
 *          的 WindowsPrincipal.IsInRole 检测。两者皆失败返回 false。
 * @returns 具备管理员权限返回 true
 */
export function isAdmin(): boolean {
  // 方式 1：net session 仅管理员可成功执行
  try {
    execFileSync("net", ["session"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    // 非管理员或 net 不可用，继续尝试 PowerShell
  }

  // 方式 2：PowerShell WindowsPrincipal 检测
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 10000 }
    );
    return out.trim() === "True";
  } catch {
    return false;
  }
}

/**
 * @brief 自动 UAC 提权重启当前命令
 * @details 用 PowerShell `Start-Process -Verb RunAs` 启动一个新的管理员权限进程
 *          来重新执行 sshd-config 子命令（弹 UAC 确认），本进程随即退出。
 *          - UAC 确认（用户点"是"）：新管理员窗口启动，本进程 exit(0)
 *          - UAC 拒绝或提权失败：提示需要管理员权限并 exit(1)
 *
 *          Windows 无纯原生原地提权（Linux sudo 式）；此方案零依赖、对所有
 *          Windows 可用，代价是开新窗口。本命令为交互式菜单，新窗口从头开始可接受。
 *
 * @throws 不会抛出——内部捕获所有异常，失败时直接 process.exit(1)
 */
export function relaunchAsAdmin(): void {
  console.log("[run] 当前非管理员权限，正在请求提权（将弹出 UAC 确认窗口）...");

  // process.execPath = node.exe 全路径；process.argv[1] = cli.js 路径
  const nodeExe = process.execPath;
  const cliScript = process.argv[1];
  // Start-Process 的 -ArgumentList 用空格分隔，路径含空格需加引号
  const argsList = `"${cliScript}" sshd-config`;

  try {
    // Start-Process -Verb RunAs 触发 UAC；用户点"是"后返回，点"否"抛异常
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${nodeExe}' -ArgumentList '${argsList}' -Verb RunAs`,
      ],
      { stdio: "ignore", timeout: 60000 }
    );
    // 提权进程已启动（新窗口），本进程让位退出
    console.log("[info] 已启动管理员权限窗口，请在弹出的新窗口中继续操作");
    process.exit(0);
  } catch {
    // 用户拒绝 UAC 或其他失败
    console.error("[err] 需要管理员权限才能运行(UAC 被拒绝或提权失败)");
    console.error('     请以管理员身份手动运行，或在 UAC 弹窗中点击"是"');
    process.exit(1);
  }
}
