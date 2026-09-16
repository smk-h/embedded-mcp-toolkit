/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tunnel-process.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cloudflared 后台进程管理（启动 / 探活 / 停止 / 日志域名提取）
 *
 * 本命令的核心复杂点所在：cloudflared tunnel 是长驻进程，而 CLI 进程
 * 需要在启动后退出，因此采用 spawn detached + 日志文件重定向 + 状态文件
 * 记录 pid 的方式，让隧道生命周期与 CLI 进程完全解耦。
 * ======================================================
 */

import { spawn } from "child_process";
import { closeSync, existsSync, openSync } from "fs";
import { readFile } from "fs/promises";

import { runCmd } from "../../shared/exec.js";
import {
  DOMAIN_POLL_MS,
  DOMAIN_RE,
  TUNNEL_REGISTERED_RE,
} from "./constants.js";

// ============================================================
// 后台启动
// ============================================================

/**
 * @brief 以分离方式启动 cloudflared Quick Tunnel
 * @details detached + windowsHide 让子进程脱离当前控制台独立常驻（CLI 退出
 *          不影响隧道）；stdin 关闭，stdout/stderr 直接重定向到日志文件句柄
 *          （cloudflared 的域名打印在 stderr，重定向后由轮询线程从文件提取，
 *          无需在父进程维护管道监听）。句柄在 spawn 完成后立即关闭——子进程
 *          已持有自己的句柄副本，不受影响。
 * @param exePath cloudflared 可执行文件绝对路径
 * @param url     隧道目标 URL（如 ssh://127.0.0.1:22）
 * @param logFile 日志文件路径（每次启动以 "w" 截断重建）
 * @returns 子进程 PID
 * @throws spawn 同步失败（如路径非法）时抛出
 */
export function startDetached(
  exePath: string,
  url: string,
  logFile: string
): number {
  const logFd = openSync(logFile, "w");
  try {
    const child = spawn(exePath, ["tunnel", "--url", url], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
    // spawn 失败（ENOENT 等）以 error 事件异步通知；此处吞掉避免无人监听时
    // 变成未捕获异常——启动是否成功由调用方的存活探测与域名轮询判定。
    child.on("error", () => {});
    if (child.pid === undefined) {
      throw new Error("未能获取子进程 PID");
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

// ============================================================
// 存活探测与停止
// ============================================================

/**
 * @brief 探测指定 PID 的进程是否存活且为 cloudflared
 * @details 用 tasklist 按 PID 精确查询（不存在时输出 "INFO: No tasks..."），
 *          并校验进程镜像名含 cloudflared，避免 pid 被无关进程复用造成误判。
 * @param pid 进程 ID
 * @returns 存活且为 cloudflared 返回 true
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
  const result = await runCmd(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
    15000
  );
  if (!result.success) {
    return false;
  }
  return /cloudflared/i.test(result.stdout);
}

/**
 * @brief 停止 cloudflared 进程树
 * @details 必须用 taskkill /T /F——Node 的 proc.kill() 在 Windows 上只杀
 *          本体不杀子进程（与 src/sdk/tools/win/powershell.ts 的
 *          killProcessTree 同一结论）。
 * @param pid 进程 ID
 * @returns taskkill 执行成功返回 true（进程不存在也会失败，由调用方结合
 *          存活探测区分）
 */
export async function stopProcessTree(pid: number): Promise<boolean> {
  const result = await runCmd(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    15000
  );
  return result.success;
}

// ============================================================
// 日志域名提取
// ============================================================

/**
 * @brief 单次读取日志并提取 Quick Tunnel 域名
 * @details 日志文件可能尚未创建（启动瞬间）或被占用（cloudflared 持句柄写入，
 *          Windows 下共享读一般可用），读取失败一律返回 null 由轮询兜底。
 *          返回**裸域名**（不含 https:// 前缀），供 --hostname 与 ssh 端点直接使用。
 * @param logFile 日志文件路径
 * @returns 裸域名（如 xxx-yyy-zzz-www.trycloudflare.com）；未提取到为 null
 */
export async function extractDomainFromLog(
  logFile: string
): Promise<string | null> {
  if (!existsSync(logFile)) {
    return null;
  }
  try {
    const content = await readFile(logFile, "utf-8");
    const matched = content.match(DOMAIN_RE);
    return matched ? matched[1] : null;
  } catch {
    return null;
  }
}

/**
 * @brief 检测隧道日志中是否出现"边缘注册完成"签名
 * @details DNS 探测的门控信号（见 constants.ts TUNNEL_REGISTERED_RE）：
 *          注册完成前 DNS 记录不可查，此刻探测只会喂负缓存。容错口径与
 *          extractDomainFromLog 一致：文件不存在、被占用读取失败等一律
 *          返回 false，由调用方的重试循环下一轮再查。
 * @param logFile 隧道日志文件路径
 * @returns 出现 TUNNEL_REGISTERED_RE 签名返回 true
 */
export async function logHasRegistration(logFile: string): Promise<boolean> {
  try {
    return TUNNEL_REGISTERED_RE.test(await readFile(logFile, "utf-8"));
  } catch {
    return false;
  }
}

/**
 * @brief 轮询日志直至提取到域名或超时
 * @details Quick Tunnel 域名在 cloudflared 完成边缘注册后打印；实测预检
 *          （DNS/UDP/TCP/API 六项）约 10 秒，默认 20 秒上限覆盖冷启动。
 *          轮询期间同步监测进程：进程退出立即返回 null，避免空等满额超时。
 * @param logFile   日志文件路径
 * @param pid       隧道进程 PID（用于意外退出检测）
 * @param timeoutMs 超时毫秒数
 * @param pollMs    轮询间隔毫秒数
 * @returns 域名；超时或进程退出返回 null
 */
export async function pollDomainFromLog(
  logFile: string,
  pid: number,
  timeoutMs: number,
  pollMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (!(await isProcessAlive(pid))) {
      return null;
    }
    const domain = await extractDomainFromLog(logFile);
    if (domain) {
      return domain;
    }
  }
  return null;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * @brief 睡眠指定毫秒
 * @param ms 毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
