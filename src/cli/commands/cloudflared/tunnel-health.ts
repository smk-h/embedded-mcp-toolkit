/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tunnel-health.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: Quick Tunnel 健康校验（进程存活 ≠ 隧道有效）
 *
 * "进程活着"与"隧道在边缘仍然注册有效"是两回事：Quick Tunnel 掉线超过
 * 宽限期后会被 Cloudflare 回收，本地进程收到 "Unauthorized: Tunnel not
 * found" 后只会无限重试同一已删除的隧道 ID，永不自愈。本模块用
 * "域名 DNS 可解析 + 日志回收签名"双信号区分三类状态：
 *   ok      —— 域名可解析，可安全复用；
 *   pending —— 域名暂未解析但无回收签名（新域名 DNS 传播中/解析器抖动），
 *              给予宽限、不判死，避免把刚拉起的好隧道反复杀掉；
 *   dead    —— 域名解析不到且日志出现回收签名，进程已是僵尸，唯一出路
 *              是停止后重新拉起换新域名。
 * ======================================================
 */

import { readFile } from "fs/promises";
import { Resolver } from "dns/promises";

import {
  DNS_CHECK_TIMEOUT_MS,
  DNS_PUBLIC_SERVERS,
  TUNNEL_DEAD_RE,
} from "./constants.js";
import { type TunnelHealth, type TunnelState } from "./types.js";

// ============================================================
// 单项探测
// ============================================================

/**
 * @brief 校验域名当前能否解析出 A 记录（公共 DNS 优先，系统解析器兜底）
 * @details 判定信号是"Quick Tunnel 域名的 DNS 记录是否存在"——它与隧道
 *          在边缘的注册同生共死，是隧道健康性的直接代理指标。刻意**不做**
 *          到边缘的 TCP/HTTP 探测：边缘 443 承载海量域名，握手通不通只反
 *          映本机到该边缘 IP 的路径质量（国内网络对 Cloudflare 存在选择性
 *          干扰），与这条隧道的注册状态毫无关联，误判会杀掉远端正常使用
 *          中的健康隧道。解析路径：
 *          (a) 直查 DNS_PUBLIC_SERVERS——绕开系统解析器抖动与负缓存
 *              （首次查询落在记录生效前会缓存 NXDOMAIN 数十秒）；
 *          (b) 回落系统解析器——公共 DNS 不可达（53 端口被拦截）时兜底。
 *          全程带超时保护，不能把 CLI 卡死；超时与 NXDOMAIN 同样按"解析
 *          不到"处理，是否判死由调用方结合日志签名二次裁决。
 * @param domain    待校验域名（裸域名）
 * @param timeoutMs 单次解析的超时毫秒数，默认 DNS_CHECK_TIMEOUT_MS
 * @returns 解析到记录返回 true
 */
export async function isDomainResolvable(
  domain: string,
  timeoutMs: number = DNS_CHECK_TIMEOUT_MS
): Promise<boolean> {
  const viaPublic = await resolveVia(domain, DNS_PUBLIC_SERVERS, timeoutMs);
  if (viaPublic) {
    return true;
  }
  return await resolveVia(domain, null, timeoutMs);
}

/**
 * @brief 用指定 DNS 服务器解析域名（null 表示系统解析器）
 * @param domain    待解析域名
 * @param servers   DNS 服务器列表；null 走系统默认解析器
 * @param timeoutMs 超时毫秒数（超时取消查询，避免卡死 CLI）
 * @returns 解析出记录返回 true；出错 / 超时 / 无记录返回 false
 */
async function resolveVia(
  domain: string,
  servers: string[] | null,
  timeoutMs: number
): Promise<boolean> {
  const resolver = new Resolver(
    servers ? { timeout: timeoutMs, tries: 1 } : {}
  );
  if (servers) {
    resolver.setServers(servers);
  }
  const query = resolver.resolve(domain);
  const timer = setTimeout(() => resolver.cancel(), timeoutMs);
  try {
    await query;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @brief 检测隧道日志中是否出现"隧道已被回收"签名
 * @details 容错口径与 extractDomainFromLog 一致：文件不存在（尚未创建）、
 *          被进程占用读取失败等一律返回 false，由调用方兜底。
 * @param logFile 隧道日志文件路径
 * @returns 出现 TUNNEL_DEAD_RE 签名返回 true
 */
export async function logHasDeadSignature(logFile: string): Promise<boolean> {
  try {
    return TUNNEL_DEAD_RE.test(await readFile(logFile, "utf-8"));
  } catch {
    return false;
  }
}

// ============================================================
// 综合健康判定
// ============================================================

/**
 * @brief 综合判定隧道健康状态（只读，不改动任何进程/状态文件）
 * @details 判定顺序：
 *          1. 无域名记录（start 提取超时）→ ok 跳过，交由调用方原有流程处理；
 *          2. 域名可解析 → ok；
 *          3. 解析不到 + 日志回收签名 → dead（进程僵尸，需重启换新域名）；
 *          4. 解析不到 + 无签名 → pending（DNS 传播/解析器抖动，宽限不判死）。
 * @param state 隧道状态
 * @returns 健康判定结果
 */
export async function checkTunnelHealth(
  state: TunnelState
): Promise<TunnelHealth> {
  if (!state.domain) {
    return { status: "ok", detail: "无域名记录,跳过健康校验" };
  }
  if (await isDomainResolvable(state.domain)) {
    return { status: "ok", detail: "域名可解析" };
  }
  if (await logHasDeadSignature(state.logFile)) {
    return {
      status: "dead",
      detail:
        "域名无法解析且日志出现隧道回收签名(Tunnel not found),进程已是僵尸",
    };
  }
  return {
    status: "pending",
    detail: "域名暂未解析(可能 DNS 尚在传播或解析器抖动),暂不判死",
  };
}
