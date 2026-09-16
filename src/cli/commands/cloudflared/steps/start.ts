/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : start.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: 菜单 [1]: 启动 Quick Tunnel（后台常驻，确保域名解析就绪）
 *
 * 流程：探测 cloudflared → 防重复与健康预检（dead 停掉换新；域名可解析则
 * 幂等复用）→ spawn detached 后台进程 → 轮询日志提取 Quick Tunnel 域名 →
 * 等边缘注册完成（日志 Registered tunnel connection 门控，注册前禁止 DNS
 * 探测以避免喂负缓存）→ 域名解析就绪校验（公共 DNS 优先 + 系统解析器兜底）
 * → 未就绪则同屏倒计时 5s 后复验（最多 12 次，约 1 分钟，不重启进程）→
 * 写状态文件 → 展示摘要与跨机连接指引。域名可解析才算启动成功——Quick
 * Tunnel 的 DNS 记录与边缘注册同生共死，可解析即代表远端具备连接条件；
 * 刻意不做本机到边缘的 TCP 探测（只反映本机路径质量，误判会杀掉远端正常
 * 使用中的健康隧道）。
 * ======================================================
 */

import { mkdirSync } from "fs";

import { log } from "@clack/prompts";

import {
  DEFAULT_TUNNEL_URL,
  DOMAIN_POLL_MS,
  DOMAIN_RETRY_MAX,
  DOMAIN_RETRY_WAIT_S,
  DOMAIN_TIMEOUT_MS,
  LOG_FILE_REL,
  TUNNEL_DIR_REL,
} from "../constants.js";
import { findCloudflaredExe } from "../tunnel-detect.js";
import { checkTunnelHealth, isDomainResolvable } from "../tunnel-health.js";
import {
  isProcessAlive,
  logHasRegistration,
  pollDomainFromLog,
  startDetached,
  stopProcessTree,
} from "../tunnel-process.js";
import {
  clearTunnelState,
  readTunnelState,
  writeTunnelState,
} from "../tunnel-state.js";
import { type TunnelState } from "../types.js";
import { resolveWorkspacePath } from "../workspace-paths.js";
import {
  type RetryLine,
  createRetryLine,
} from "../../../shared/cli-helpers.js";
import { printTunnelSummary } from "./summary.js";

// ============================================================
// 菜单 [1]: 启动隧道
// ============================================================

/**
 * @brief 启动 cloudflared Quick Tunnel，直到域名解析就绪
 * @details 幂等设计：已运行且健康（域名可解析）时直接复用，不重复拉起进程；
 *          进程存活但健康判定为 dead（域名被 Cloudflare 回收的僵尸隧道，
 *          永不自愈）时自动停止后重新拉起换新域名。
 *
 *          "成功"的判定标准是**域名 DNS 可解析**，而非"日志里出现了域名"——
 *          Quick Tunnel 的域名记录与边缘注册同生共死，可解析即代表远端具备
 *          连接条件；域名刚分配时记录还需短暂传播，该窗口内视为未就绪并
 *          重试等待。
 *
 *          重试面向**域名解析就绪**而非进程启动：进程启动是一次性动作，失败
 *          即终止（属安装/环境问题，重试无意义）；域名未解析则等待
 *          DOMAIN_RETRY_WAIT_S 秒（同一行倒计时显示）后复验，最多
 *          DOMAIN_RETRY_MAX 次（约 1 分钟，覆盖 DNS 传播窗口）。复验沿用
 *          存活的进程与原域名，不重启隧道——重启会换域名并让传播进度归零，
 *          反而更难成功。
 *
 *          DNS 探测以**边缘注册完成**为前置门控（日志 Registered tunnel
 *          connection 签名，见 tryEstablish）：URL 打印（域名分配）到注册
 *          完成之间记录不可查，过早探测只会得到 NXDOMAIN 并把负缓存喂进
 *          各级递归解析器——TTL 远超重试预算，导致隧道随后已健康、重试却
 *          全败（实测：注册拖 14s 时 12 次全败，缓存过期后重跑即成功）。
 *          重试语义因此分三阶段：等待边缘注册 / 等 DNS 传播 / 注册未成功
 *          重新申请，进度行按阶段切换。
 *
 *          域名始终分配不出来（如 trycloudflare 注册 API 超时，cloudflared
 *          零内部重试直接退出）则不存在"等待生效"的对象：重试即重新拉起
 *          进程重新申请（换新域名），重试文案与 DNS 传播等待相区分。
 *
 *          重试耗尽后保留现场（进程 + 已分配域名）并落盘，提示用户稍后重跑
 *          本命令原地复验（无需 stop）；确认要换域名时再执行 stop。
 * @param url 隧道目标 URL（菜单/子命令未指定时由调用方传入 DEFAULT_TUNNEL_URL）
 * @returns 成功（含"已在运行且域名健康"的幂等成功）返回 true
 */
export async function doStart(
  url: string = DEFAULT_TUNNEL_URL
): Promise<boolean> {
  log.info("启动 cloudflared Quick Tunnel");

  // (1) 探测可执行文件
  const detected = await findCloudflaredExe();
  if (!detected.exePath) {
    log.error("未检测到 cloudflared,请先执行菜单 [5] 安装");
    return false;
  }

  // (2) 防重复与健康预检
  // pending 承载"本轮现场"（进程与已分配域名），在重试之间传递：域名尚未
  // 解析生效时状态文件尚未落盘，若不显式传递，下一轮会误判为无隧道而重复
  // 拉起进程
  const existing = readTunnelState();
  let pending: TunnelState | null = null;
  if (existing && (await isProcessAlive(existing.pid))) {
    const health = await checkTunnelHealth(existing);
    if (health.status === "dead") {
      // 僵尸隧道：域名已被 Cloudflare 回收且永不自愈，只能停掉重新拉起换新域名
      log.warn(`隧道进程存活但已失效(${health.detail}),停止后重新拉起换新域名`);
      await stopProcessTree(existing.pid);
      clearTunnelState();
    } else if (health.status === "ok") {
      // 域名可解析：Quick Tunnel 的 DNS 记录与边缘注册同生共死,可解析即隧道
      // 有效,幂等复用(连通性以远端视角为准,本机不做边缘探测)
      log.warn(`隧道已在运行且域名健康(PID ${existing.pid}),不重复启动`);
      printTunnelSummary(existing);
      return true;
    } else {
      // pending（域名暂未解析生效）：既不判死也不当成功，复用现有进程进入
      // 重试循环等 DNS 传播——重启会换域名并让传播进度归零
      log.warn(
        `隧道进程存活但域名尚未生效(${health.detail}),复用该进程等待解析就绪`
      );
      pending = existing;
    }
  } else if (existing) {
    log.warn("发现残留状态文件(记录的进程已退出),清理后重新启动");
    clearTunnelState();
  }

  // (3) 域名解析就绪复验 + 重试（进程启动失败不重试）
  // 重试过程按阶段占用物理行：三种阶段语义（等待边缘注册 / 等 DNS 传播 /
  // 注册未成功重新申请）各自首次进入时打一条 clack 告警留档，阶段内进度
  // 原地刷新（第 n 次尝试未通过 + 倒计时），阶段切换时清旧行换新行，成功 /
  // 耗尽时清除过程行——卷屏里只留前后的正式日志
  const maxTries = DOMAIN_RETRY_MAX + 1;
  let retryLine: RetryLine | null = null;
  let retryPhase: RetryPhase | null = null;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const result = await tryEstablish(detected.exePath, url, pending);
    pending = result.pending;
    if (result.state) {
      retryLine?.finish();
      log.success("Quick Tunnel 已建立且域名已解析生效");
      printTunnelSummary(result.state);
      return true;
    }
    if (result.fatal) {
      retryLine?.finish();
      log.error(
        "cloudflared 进程未能启动,已中止重试(请先执行菜单 [5] 确认安装)"
      );
      break;
    }
    // 最后一次尝试失败后不再等待，直接进入失败收尾
    if (attempt < maxTries) {
      // 阶段切换（含首次进入重试）：清上一阶段过程行，打本阶段一次性告警。
      // 三种语义必须区分：registering 是"域名已分配、等边缘注册"（此阶段
      // 禁止 DNS 探测）；propagating 是"已注册、等 DNS 传播"（复验同一进程
      // 同一域名）；no-domain 是"注册未成功"（如 trycloudflare 注册 API
      // 超时，cloudflared 零内部重试直接退出，域名根本没分配出来），重试即
      // 重新拉起进程换新申请
      const phase = result.phase;
      if (retryPhase !== phase || retryLine === null) {
        retryLine?.finish();
        const meta = phaseMeta(phase, pending?.domain ?? null);
        log.warn(meta.warn);
        retryLine = createRetryLine(meta.label);
        retryPhase = phase;
      }
      await retryLine.update(attempt, maxTries, DOMAIN_RETRY_WAIT_S);
    }
  }
  retryLine?.finish();

  // 失败收尾：进程仍在运行时保留现场（进程与域名就绪判定未通过），状态文件
  // 落盘后重跑本命令即可原地复验；进程已不在则清理残留，避免留下指向已退出
  // 进程的状态记录
  if (pending && (await isProcessAlive(pending.pid))) {
    writeTunnelState(pending);
    log.error(
      `隧道在 ${maxTries} 次尝试后仍未就绪(${
        pending.domain ? "边缘注册未完成或 DNS 未传播" : "域名注册未成功"
      })`
    );
    log.warn(
      "稍后重跑本命令复验即可(进程与现场已保留,无需 stop);确认要换域名时再执行 cloudflared stop"
    );
  } else {
    clearTunnelState();
    log.error("隧道未能建立,详见日志(菜单 [3] 查看)");
  }
  return false;
}

/**
 * @brief 各重试阶段的告警文案（一次性 clack 输出）与进度行前缀
 * @param phase  未就绪原因语义
 * @param domain 已分配的域名（no-domain 阶段为 null）
 */
function phaseMeta(
  phase: RetryPhase,
  domain: string | null
): { warn: string; label: string } {
  switch (phase) {
    case "no-domain":
      return {
        warn: "Quick Tunnel 注册未成功(未取得域名),进入重试等待(将重新拉起进程申请新域名)",
        label: "域名注册未成功,重新申请中",
      };
    case "registering":
      return {
        warn: `域名 ${domain ?? "(未分配)"} 已分配,等待边缘注册完成(Registered tunnel connection)`,
        label: "等待边缘注册",
      };
    case "propagating":
      return {
        warn: `域名 ${domain ?? "(未分配)"} 尚未解析生效(DNS 传播中),进入重试等待`,
        label: "域名尚未解析生效(DNS 传播中)",
      };
  }
}

/**
 * @brief 重试循环里单次尝试未就绪的原因语义（驱动进度行文案与阶段切换）
 * @details no-domain —— 域名没分配出来（注册 API 失败，cloudflared 零内部
 *          重试直接退出），重试即重新拉起进程重新申请；
 *          registering —— 域名已分配但边缘注册未完成，DNS 记录尚不可查，
 *          此阶段刻意不做 DNS 探测（过早查询只会喂负缓存）；
 *          propagating —— 注册已完成，等 DNS 记录传播生效。
 */
type RetryPhase = "no-domain" | "registering" | "propagating";

/**
 * @brief 单次域名解析就绪复验：确保隧道进程在运行并取得已生效的域名
 * @details 复用优先：进程仍存活时沿用其 pid 与已分配的域名，只重新校验域名
 *          是否已解析生效（DNS 传播需要时间，重启会让域名更换、传播进度
 *          归零）；进程已退出或域名始终分配不出来时才重建进程。域名未生效
 *          但进程健康时不杀进程，把现场交回调用方留给下一轮复验。仅在完全
 *          成功时写入状态文件。
 *
 *          DNS 探测以**边缘注册完成**为前置门控（日志 Registered tunnel
 *          connection 签名）：注册完成前记录本就不存在，此刻查询只会得到
 *          NXDOMAIN 并把负缓存喂进各级递归解析器，TTL 远超重试预算，导致
 *          隧道随后变健康了重试也全败（t3 实测：注册拖 14s，12 次全败，
 *          几分钟后缓存过期重跑即成功）。
 * @param exePath cloudflared 可执行文件绝对路径
 * @param url     隧道目标 URL
 * @param pending 上一轮遗留的现场（进程 + 域名），首轮为 null
 * @returns state：成功时已落盘的状态对象，失败为 null；
 *          pending：供下一轮继续复用的现场，进程已被判定不可用时为 null；
 *          fatal：进程启动这类重试无意义的环境性失败（调用方应直接终止循环）；
 *          phase：未就绪的原因语义（供调用方渲染对应文案）
 */
async function tryEstablish(
  exePath: string,
  url: string,
  pending: TunnelState | null
): Promise<{
  state: TunnelState | null;
  pending: TunnelState | null;
  fatal: boolean;
  phase: RetryPhase;
}> {
  let current = pending;

  // 上一轮进程已退出 → 现场作废，本轮重新拉起
  if (current && !(await isProcessAlive(current.pid))) {
    log.warn(`上一轮隧道进程(PID ${current.pid})已退出,重新拉起`);
    current = null;
  }

  if (!current) {
    // 后台启动（日志重定向到固定文件，每次启动截断重建；路径锚定工作区根）
    mkdirSync(resolveWorkspacePath(TUNNEL_DIR_REL), { recursive: true });
    const logFile = resolveWorkspacePath(LOG_FILE_REL);
    let pid: number;
    try {
      pid = startDetached(exePath, url, logFile);
    } catch (error) {
      log.error(
        `cloudflared 启动失败: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        state: null,
        pending: null,
        fatal: true,
        phase: "no-domain",
      };
    }
    current = {
      pid,
      url,
      domain: null,
      startedAt: new Date().toISOString(),
      exePath,
      logFile,
    };
    log.message(`进程已启动(PID ${pid}),正在等待 Quick Tunnel 域名分配...`);
  }

  // 域名：已有则复用，缺失时轮询日志提取
  if (!current.domain) {
    current.domain = await pollDomainFromLog(
      current.logFile,
      current.pid,
      DOMAIN_TIMEOUT_MS,
      DOMAIN_POLL_MS
    );
  }
  const domain = current.domain;

  if (!domain) {
    // 域名始终分配不出来：进程多半已异常，杀掉让下一轮重新拉起
    if (await isProcessAlive(current.pid)) {
      await stopProcessTree(current.pid);
    }
    clearTunnelState();
    log.warn("未取得 Quick Tunnel 域名(进程可能已异常退出)");
    return { state: null, pending: null, fatal: false, phase: "no-domain" };
  }

  // 边缘注册门控：注册完成前 DNS 记录不可查，此阶段禁止探测（喂负缓存）
  if (!(await logHasRegistration(current.logFile))) {
    return {
      state: null,
      pending: current,
      fatal: false,
      phase: "registering",
    };
  }

  if (!(await isDomainResolvable(domain))) {
    // 注册已完成、DNS 尚未传播生效 → 保留进程等待复验
    // （进度展示由调用方的重试行统一负责，这里不逐次打日志）
    return {
      state: null,
      pending: current,
      fatal: false,
      phase: "propagating",
    };
  }

  const state: TunnelState = { ...current, domain };
  writeTunnelState(state);
  return { state, pending: current, fatal: false, phase: "propagating" };
}
