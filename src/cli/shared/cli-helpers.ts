/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : cli-helpers.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: 终端交互辅助与本机 OS 信息采集共享模块
 *
 * 提供 readline 问答、清屏、暂停、密码安全输入、stdin raw 模式锁定等终端交互能力，
 * 以及本机连接信息（用户名 + IPv4 地址）采集。供 sshd-config、cloudflared、
 * remote-mcp-config 等交互式命令共用，保证交互范式一致（清屏 + 菜单 + clack 组件）。
 *
 * 设计原则：函数实现与从 sshd-config.ts 迁出时保持逐字一致（仅补 export 与 JSDoc）。
 * ======================================================
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
 * @brief stdin 的 TTY 能力断言类型
 * @details setRawMode / isRaw 仅在 TTY 环境下可用，统一以可选成员描述，
 *          调用前必须判空；本模块所有终端交互函数共用。
 */
type TtyStdin = NodeJS.ReadStream & {
  isTTY?: boolean; // 是否为终端
  isRaw?: boolean; // 当前是否处于 raw 模式
  setRawMode?(mode: boolean): void; // 切换 raw / cooked 模式
};

/** 包装前的原始 setRawMode 实现（已绑定 stdin；null 表示未安装锁定） */
let rawModeOrig: ((mode: boolean) => void) | null = null;

/**
 * @brief 锁定 stdin raw 模式（菜单循环期间禁止任何组件切回 cooked 模式）
 * @details Windows ConPTY 下存在吞键 bug：clack 提示被 ESC 取消（或提交）后，
 *          组件 close() 内部 setRawMode(false) 会使后续 raw 读取失效——下一次 raw 读
 *          会话（再次进入 clack select 时 setRawMode(true)）重挂 libuv tty
 *          读循环失败，按键静默丢失、终端反而回显转义序列，约 20 秒后才自愈，
 *          表现为菜单"卡死"。规避方式：菜单循环期间包装 stdin.setRawMode，
 *          使任何组件（clack / readline / askPassword）切回 cooked 的尝试
 *          变为无操作，全程保持 raw；unlockStdinRaw 还原并恢复 cooked。
 *          非 TTY 环境（管道/CI）无 raw 概念，直接跳过。
 * @returns 是否成功安装锁定（非 TTY / 已处于锁定状态返回 false）
 */
export function lockStdinRaw(): boolean {
  const stdin = process.stdin as TtyStdin;
  if (!stdin.isTTY || !stdin.setRawMode || rawModeOrig) {
    return false;
  }

  rawModeOrig = stdin.setRawMode.bind(stdin) as (mode: boolean) => void;

  // 幂等包装：忽略传入的模式参数，锁定期间一律保持 raw
  (stdin as { setRawMode: (mode: boolean) => void }).setRawMode = (): void => {
    rawModeOrig?.(true);
  };
  rawModeOrig(true);
  return true;
}

/**
 * @brief 解除 stdin raw 模式锁定（菜单循环收尾时调用，恢复终端常规状态）
 * @details 还原包装前的原始 setRawMode 并切回 cooked 模式、暂停读取。
 *          未安装锁定（非 TTY 或未调用 lockStdinRaw）时为无操作；
 *          与 lockStdinRaw 配对使用，建议放在 try/finally 中保证异常路径也能还原。
 */
export function unlockStdinRaw(): void {
  const stdin = process.stdin as TtyStdin;
  if (!rawModeOrig || !stdin.setRawMode) {
    return;
  }

  (stdin as { setRawMode: (mode: boolean) => void }).setRawMode = rawModeOrig;
  rawModeOrig = null;

  // 此时 setRawMode 已还原为原始实现，恢复正常 cooked 模式
  stdin.setRawMode(false);
  stdin.pause();
}

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
 * @details 提示"按 Enter 回到菜单，按 q 退出"，TTY 下以 raw 模式逐键读取：
 *          - Enter（CR / LF）→ 返回 false，调用方清屏并重新显示菜单
 *          - q / Q          → 返回 true，调用方退出主循环
 *          - Ctrl+C         → 中止程序（raw 模式下无 SIGINT，需自行处理）
 *          - 其它输入       → 忽略，继续等待（含方向键等转义序列）
 *          刻意不走 readline.Interface：其 close() 会 setRawMode(false)，
 *          是 Windows ConPTY 吞键问题的触发源之一（见 lockStdinRaw）。
 *          非 TTY 环境（管道/CI）无 raw 概念，回退 readline 逐行读取。
 * @returns 用户是否选择退出（q → true，Enter → false）
 */
export async function pauseForMenu(): Promise<boolean> {
  const stdin = process.stdin as TtyStdin;

  // 非 TTY（管道/CI）回退 readline 读取
  if (!stdin.isTTY || !stdin.setRawMode) {
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

  // TTY：raw 模式逐键读取（锁定期间 setRawMode(true) 为幂等操作）；
  // 记录进入前的模式，收尾时恢复，避免独立调用时泄漏 raw 状态
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  process.stdout.write("\n按 Enter 回到菜单，按 q 退出: ");
  return new Promise<boolean>((resolve) => {
    /**
     * @brief 清理监听器并恢复进入前的输入模式
     */
    function cleanup(): void {
      stdin.removeListener("data", onData);
      // 锁定期间该调用被包装为恒 raw(true)，不会破坏菜单循环的 raw 环境
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    }

    /**
     * @brief 逐键处理回调
     * @param ch 读到的字节
     */
    function onData(ch: Buffer): void {
      const char = ch.toString("utf8");

      // 回车（CR / LF）— 回到菜单
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(false);
        return;
      }

      // q / Q — 退出
      if (char === "q" || char === "Q") {
        cleanup();
        process.stdout.write("\n");
        resolve(true);
        return;
      }

      // Ctrl+C — 中止程序（raw 模式下不会产生 SIGINT）
      if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      // 其它键（含方向键转义序列）— 忽略
    }

    stdin.on("data", onData);
  });
}

/**
 * @brief 阻塞等待用户按 q 退出（无菜单场景的收尾交互）
 * @details 供"一次性线性流程"命令使用：流程执行完毕后提示用户按 q 退出，
 *          非 q 输入一律忽略并重新提示，避免误触导致信息未看清即退出。
 * @returns 用户按下 q / Q 后 resolve
 */
export async function waitForQuit(): Promise<void> {
  while (true) {
    const input = await prompt("按 q 退出: ");
    if (input.toLowerCase() === "q") {
      return;
    }
  }
}

// ============================================================
// 重试等待（原地单行刷新）
// ============================================================

/**
 * @brief 重试进度的原地单行刷新句柄
 * @param update 刷新一行进度（每次尝试失败后调用，同一物理行原地覆盖）
 * @param finish 结束刷新：TTY 下清除该行（过程行是瞬态的，不留在卷屏里），
 *               非 TTY 下为空操作（各行已按行落盘）
 */
export interface RetryLine {
  update(attempt: number, max: number, waitSeconds: number): Promise<void>;
  finish(): void;
}

/**
 * @brief 创建整个重试阶段共用的一行式进度刷新句柄
 * @details 一次重试流程（N 次尝试 + 每次前的倒计时）只占用**一个物理行**：
 *          每秒用 `\r` + 清行转义（ESC[0K）原地覆盖，重试次数递增、剩余秒数
 *          递减，跨复验不换行。成功 / 耗尽时由调用方 finish() 清掉过程行，
 *          只在卷屏里留下前后的正式日志。行首带 `│` 与 clack 的边框对齐。
 *          非 TTY 环境（管道/重定向）无法原地刷新，退化为每次复验打印一行
 *          纯文本，保证日志可读、不写控制字符。
 * @param label 进度行前缀文案（不含 attempt/倒计时等动态部分）
 * @returns 刷新句柄
 */
export function createRetryLine(label: string): RetryLine {
  if (!process.stdout.isTTY) {
    return {
      async update(attempt, max, waitSeconds): Promise<void> {
        console.log(`│  [${attempt}/${max}] ${label},${waitSeconds}s 后重试`);
        await sleep(waitSeconds * 1000);
      },
      finish(): void {},
    };
  }

  return {
    async update(attempt, max, waitSeconds): Promise<void> {
      for (let remain = waitSeconds; remain > 0; remain--) {
        // 行尾留白：剩余秒数位数变少时覆盖上一帧残留
        process.stdout.write(
          `\r\x1b[0K│  ▲ ${label} | 第 ${attempt}/${max} 次尝试未通过,${remain}s 后重试 `
        );
        await sleep(1000);
      }
    },
    finish(): void {
      process.stdout.write(`\r\x1b[0K`);
    },
  };
}

/**
 * @brief 睡眠指定毫秒
 * @param ms 毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

  // 复用模块级 TtyStdin 断言类型
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
