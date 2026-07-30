/**
 * @file src/cli/shared/cli-helpers.ts
 * @brief 终端交互辅助与本机 OS 信息采集共享模块
 *
 * 提供 readline 问答、清屏、暂停、密码安全输入等终端交互能力，以及本机连接信息
 * （用户名 + IPv4 地址）采集。供 sshd-config 与 remote-mcp-config 两个交互式命令共用，
 * 保证两者的交互范式一致（清屏 + 菜单 + clack 组件）。
 *
 * 设计原则：函数实现与从 sshd-config.ts 迁出时保持逐字一致（仅补 export 与 JSDoc）。
 */

import { userInfo, networkInterfaces } from "os";
import { createInterface } from "readline";

// ============================================================
// 类型
// ============================================================

/**
 * @brief 单个可用 IPv4 地址及其所属网卡
 * @param ip    IPv4 地址
 * @param iface 网卡名（os.networkInterfaces() 的 key）
 */
export interface IpEntry {
  ip: string;
  iface: string;
}

/**
 * @brief 本机连接信息采集结果
 * @param sshUser  ssh 登录用户名（已剥离 DOMAIN\ 前缀）
 * @param ipList   可用 IPv4 地址列表（已过滤回环 / 链路本地 / 虚拟网卡），每项含网卡名
 */
export interface ConnectionInfo {
  sshUser: string;
  ipList: IpEntry[];
}

// ============================================================
// 终端交互
// ============================================================

/**
 * @brief 同步询问用户输入（明文）
 * @details 基于 readline 的单次问答，问完即关闭 rl。
 * @param questionText 提示文本
 * @returns 用户输入的字符串（已 trim）
 */
export function prompt(questionText: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * @brief 清空终端屏幕
 * @details 使用 ANSI 转义序列 \x1Bc（全屏重置）清屏并将光标移到左上角。
 *          非 TTY 环境（管道/重定向）跳过，避免向非终端输出写入控制字符。
 */
export function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  }
}

/**
 * @brief step 执行完毕后的暂停等待
 * @details 提示"按 Enter 回到菜单，按 q 退出"，阻塞等待用户按键：
 *          - Enter（空输入）→ 返回 false，调用方清屏并重新显示菜单
 *          - q / Q          → 返回 true，调用方退出主循环
 *          - 其它输入       → 继续等待，不响应（避免误触退出）
 * @returns 用户是否选择退出（q → true，Enter → false）
 */
export async function pauseForMenu(): Promise<boolean> {
  while (true) {
    const input = await prompt("\n按 Enter 回到菜单，按 q 退出: ");
    if (input.toLowerCase() === "q") {
      return true;
    }
    if (input === "") {
      return false;
    }
    // 其它输入忽略，循环重新提示
  }
}

/**
 * @brief 安全地读取密码（不回显明文）
 * @details 通过 stdin raw mode 逐字符读取，终端显示 `*` 占位。
 *          非 TTY 环境（如管道输入）回退为 readline 直接读取，此时密码可见，
 *          属已知限制。支持 Backspace 删除、Ctrl+C 退出。
 * @param questionText 提示文本
 * @returns 用户输入的密码字符串
 */
export async function askPassword(questionText: string): Promise<string> {
  process.stdout.write(questionText);

  // stdin 的类型断言：TTY 模式下拥有 setRawMode 方法
  type TtyStdin = NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode?(mode: boolean): void;
  };
  const stdin = process.stdin as TtyStdin;
  let password = "";
  let rawModeEnabled = false;

  // 尝试启用 raw mode（关闭回显）
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  stdin.resume();

  return new Promise<string>((resolve) => {
    /**
     * @brief 清理监听器并恢复终端状态
     */
    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.pause();
      if (rawModeEnabled && stdin.setRawMode) {
        stdin.setRawMode(false);
      }
    }

    /**
     * @brief 逐字符处理回调
     * @param ch 读到的字节
     */
    function onData(ch: Buffer): void {
      const char = ch.toString("utf8");

      // 回车（CR / LF）— 结束输入
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(password);
        return;
      }

      // Ctrl+C — 中止程序
      if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Backspace / Delete — 删除最后一个字符
      if (char === "\u007f" || char === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      // 普通字符 — 追加并显示占位符
      password += char;
      process.stdout.write("*");
    }

    stdin.on("data", onData);
  });
}

// ============================================================
// 本机连接信息采集
// ============================================================

/**
 * @brief 采集本机连接信息（用户名 + 可用 IPv4 地址）
 * @details 统一各命令的信息采集逻辑：
 *          (a) 当前 Windows 登录用户名（os.userInfo().username），剥离 DOMAIN\ 前缀
 *          (b) 本机所有 IPv4 地址，过滤回环（127.x）、链路本地（169.254）、虚拟网卡
 *          虚拟网卡过滤规则：名字含 virtual / vmware / hyper-v / vethernet / wsl / docker
 * @returns 连接信息对象
 */
export function collectConnectionInfo(): ConnectionInfo {
  // (a) 当前登录用户名（剥离 DOMAIN\ 前缀，ssh 只取反斜杠后的部分）
  const rawUser = userInfo().username;
  const sshUser = rawUser.includes("\\")
    ? rawUser.slice(rawUser.indexOf("\\") + 1)
    : rawUser;

  // (b) 枚举所有 IPv4 地址（排除回环 127.x、链路本地 169.254、虚拟网卡）
  const interfaces = networkInterfaces();
  const ipList: IpEntry[] = [];
  for (const [ifName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    // 跳过常见虚拟网卡（VirtualBox / VMware / Hyper-V / WSL），减少干扰
    if (/virtual|vmware|hyper-v|vethernet|wsl|docker/i.test(ifName)) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        // 跳过 169.254 链路本地地址（未正确获取 DHCP 时出现）
        if (addr.address.startsWith("169.254")) continue;
        ipList.push({ ip: addr.address, iface: ifName });
      }
    }
  }

  return { sshUser, ipList };
}
