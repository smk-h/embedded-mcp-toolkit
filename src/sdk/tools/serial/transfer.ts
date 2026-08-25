/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : transfer.ts
 * Author     : sumu
 * Date       : 2026/07/24
 * Version    : x.x.x
 * Description: 在已建立的串口会话上，通过 ZMODEM 协议（依赖设备端 lrzsz 的 rz/sz）传输二进制文件。
 *
 * 复用同一条串口连接，传输全程不释放串口、会话保持不断。
 *   - serial_upload   发送端，设备端 rz 接收
 *   - serial_download 接收端，设备端 sz 发送
 *
 * 工具采用阻塞式调用（对齐 serial_exec 风格），传输过程中通过 logger 在 stderr 输出进度，
 * 完成或失败或超时后返回传输摘要（字节数/耗时/速率）。
 * ======================================================
 */

import { basename } from "node:path";
import { stat } from "node:fs/promises";

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../sdk/shared/logger.js";
import { formatTransferSummary } from "../../../sdk/shared/transfer-result.js";
import { serialStore } from "./sessions.js";
import { zmodemSend, zmodemReceive } from "../../../sdk/zmodem/index.js";

// ── 常量 ────────────────────────────────────────────────────

/** @brief 默认总时长超时（秒），作为防无限挂起的兜底，与文件大小无关 */
const DEFAULT_TIMEOUT_SEC = 300;

/** @brief 默认空闲超时（秒）：无数据流动超过此值即判定为真故障（链路/对端挂了），与文件大小无关 */
const DEFAULT_IDLE_TIMEOUT_SEC = 15;

/** @brief 空闲超时下限（秒），防止误设过小把正常慢传输误杀 */
const IDLE_TIMEOUT_MIN_SEC = 3;

/**
 * @brief 上传进度日志的字节增量阈值
 *
 * 上传侧本地文件流是突发读取，208KB 文件会在几百毫秒内把所有 8KiB 块通过
 * transfer.send 塞进 OS 发送缓冲，时间节流（即便 200ms）会让绝大多数 onProgress
 * 被吞掉，整段传输只打出 1 条日志，看起来像卡死。字节增量节流则保证每
 * LOG_PROGRESS_BYTES 字节稳定打一条，让日志真实反映"数据在持续交付给串口"。
 *
 * 取值 32KiB：对 512B 的上传块是 64 块一打点，常见文件大小（KB~MB 级）
 * 下能打出 3~N 条进度，既不刷屏也不至于静默。
 */
const LOG_PROGRESS_BYTES = 32 * 1024;

/**
 * @brief 下载进度日志的时间节流间隔（毫秒）
 *
 * 下载侧 on_input 由设备 sz 的数据帧到达触发，频率受串口实际速率限制（平滑，
 * 非突发），时间节流本就工作良好（115200 波特率下约每 700ms 一条 onProgress，
 * 1s 节流能稳定打出多条）。故下载侧沿用时间节流，不用字节增量——否则小文件
 * （如 50KB < 2×32KiB）会退化到只打 1 条。
 */
const PROGRESS_LOG_THROTTLE_MS = 1000;

/** @brief 关闭设备端 TTY 软件流控的命令（ZMODEM 前置：ixon/ixoff 会拦截 0x11/0x13 破坏协议帧） */
const STTY_DISABLE_FLOW_CTRL = "stty -ixon -ixoff";

/** @brief stty 命令执行后等待提示符返回的延时（毫秒） */
const STTY_SETTLE_MS = 500;

/** @brief ZMODEM 结束后恢复 shell 提示符的等待时间（毫秒） */
const SHELL_RECOVER_MS = 800;

/** @brief recoverShell 排空缓冲的最大轮次（防止无限循环） */
const SHELL_RECOVER_MAX_DRAINS = 5;

/** @brief recoverShell 每次排空间隔（毫秒） */
const SHELL_RECOVER_DRAIN_MS = 300;

// ── 内部辅助 ────────────────────────────────────────────────

/**
 * @brief 关闭设备端 TTY 软件流控（ZMODEM 前置）
 *
 * 多数 Linux 终端默认开启 ixon/ixoff 软件流控，会拦截 XON(0x11)/XOFF(0x13) 字节，
 * 破坏 ZMODEM 协议帧（这些字节在 ZMODEM 数据流中是合法的）。
 * 发 rz/sz 前先关流控，是 ZMODEM over serial 的标准前置步骤。
 *
 * @param shell 已建立的串口会话
 */
async function disableFlowControl(shell: {
  write: (cmd: string, clear?: number) => void;
}): Promise<void> {
  shell.write(STTY_DISABLE_FLOW_CTRL, 1);
  await new Promise((r) => setTimeout(r, STTY_SETTLE_MS));
}

/**
 * @brief ZMODEM 传输结束后清理 shell 缓冲，恢复正常提示符
 *
 * 正常路径下（session.has_ended() 为真）rz/sz 已通过 ZFIN/OO 干净退出、
 * shell 回到提示符，本函数只是排空缓冲里残留的协议字节回显，属于轻量清理。
 * 失败路径下（超时/异常，finally 已发 abort 序列让 rz/sz 退出）shell 可能
 * 停在异常态，本函数发回车触发重新输出提示符 + 循环排空残留字节。
 *
 * @param shell 已建立的串口会话
 */
async function recoverShell(shell: {
  write: (cmd: string, clear?: number) => void;
  read: (clear?: number) => string;
}): Promise<void> {
  // 先丢弃缓冲区中可能残留的 ZMODEM 协议字节
  shell.read(1);
  // 发回车触发 shell 重新输出提示符
  shell.write("", 1);
  await new Promise((r) => setTimeout(r, SHELL_RECOVER_MS));
  // 循环排空：rz 退出后设备会持续吐出残留 ZMODEM 字节和回显，
  // 单次读不够，需循环读直到缓冲稳定（连续空读）或达到上限
  for (let i = 0; i < SHELL_RECOVER_MAX_DRAINS; i++) {
    const drained = shell.read(1);
    if (!drained) break;
    await new Promise((r) => setTimeout(r, SHELL_RECOVER_DRAIN_MS));
  }
}

// ── 超时控制辅助 ────────────────────────────────────────────

/**
 * @brief 中止原因，决定最终返回给用户的文案语义
 *
 *   - idle                : 空闲超时触发（无数据流动）→ 判定为真故障，终止并报错
 *   - overall-proceeding  : 总时长到点但传输仍在推进（idle 未触发）→ timeout 设得过小，给建议值
 *   - overall-stalled      : 总时长到点且传输已停滞（兜底，正常应由 idle 先触发）
 */
type AbortReason = "idle" | "overall-proceeding" | "overall-stalled";

/**
 * @brief 传输超时守卫：同时管理空闲超时与总时长超时
 *
 * 两个超时共用同一个 AbortController：无论哪个先到点都调 controller.abort()
 * 中止底层 zmodem 传输；用 abortReason 区分语义，供 handler 翻译成不同的返回文案。
 *
 *   - idleTimer：每收到一次进度（onProgress）或心跳（onHeartbeat）就 reset()；
 *                超过 idleTimeoutSec 未重置则判定真故障，置 abortReason="idle" 后 abort。
 *   - overallTimer：从启动到 timeoutSec 到点。触发时看最近一次进度时间戳判断
 *                传输是否仍在推进：仍在推进 → "overall-proceeding"（timeout 过小）；
 *                否则 → "overall-stalled"。
 *
 * 调用方在 onProgress 里调 touch(bytes)（数据帧）；在 onHeartbeat 里调 heartbeat()
 * （握手/关闭阶段，只刷新时间戳不增字节，避免 ZEOF/ZFIN 握手被误判为链路挂了）；
 * 在 finally 里调 clear() 注销定时器。
 *
 * @param controller    共享的 AbortController
 * @param timeoutSec    总时长秒数（overall）
 * @param idleTimeoutSec 空闲秒数（idle）
 * @return 守卫对象：reason() 取中止原因；touch(bytes) / heartbeat() 活动时调用；
 *         lastBytes() 取最后一次进度字节数；clear() 注销
 */
function createTransferTimeoutGuard(
  controller: AbortController,
  timeoutSec: number,
  idleTimeoutSec: number
): {
  reason: () => AbortReason | null;
  touch: (bytes: number) => void;
  heartbeat: () => void;
  lastBytes: () => number;
  clear: () => void;
} {
  let reason: AbortReason | null = null;
  let lastProgressAt = Date.now();
  let lastBytes = 0;

  // 空闲定时器：可重置。touch / heartbeat 都会重置它；到期 → 真故障
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        reason = "idle";
        controller.abort();
      }
    }, idleTimeoutSec * 1000);
  };

  // 总时长定时器：到点看是否仍在推进
  const overallTimer = setTimeout(() => {
    if (controller.signal.aborted) return;
    // 最近 idleTimeoutSec 内还有进度 → 仍在推进（timeout 设小了）
    const proceeding = Date.now() - lastProgressAt < idleTimeoutSec * 1000;
    reason = proceeding ? "overall-proceeding" : "overall-stalled";
    controller.abort();
  }, timeoutSec * 1000);

  // 启动时空闲计时器先 arm 一次，覆盖到首个数据/心跳之前的窗口
  armIdle();

  return {
    reason: () => reason,
    touch: (bytes: number): void => {
      lastProgressAt = Date.now();
      lastBytes = bytes;
      armIdle();
    },
    heartbeat: (): void => {
      // 仅刷新时间戳（重置 idle + 为 overall-proceeding 判定提供"仍在推进"依据），
      // 不增加字节数——握手/关闭阶段本就无数据帧，但协议确实在推进。
      lastProgressAt = Date.now();
      armIdle();
    },
    lastBytes: () => lastBytes,
    clear: (): void => {
      clearTimeout(overallTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

/**
 * @brief 规范化空闲超时秒数，强制不低于下限
 *
 * @param idle 用户传入的 idle_timeout
 * @return 不小于 IDLE_TIMEOUT_MIN_SEC 的秒数
 */
function resolveIdleTimeoutSec(idle: number | undefined): number {
  const v = idle ?? DEFAULT_IDLE_TIMEOUT_SEC;
  return v < IDLE_TIMEOUT_MIN_SEC ? IDLE_TIMEOUT_MIN_SEC : v;
}

/**
 * @brief 根据已传字节/耗时/总大小反推建议的总超时秒数
 *
 * overall-proceeding 场景下，用实测速率外推完整传输所需总时长，并留 30% 余量。
 *
 * @param bytes     已传输字节数
 * @param durationMs 已耗时（毫秒）
 * @param totalSize 文件总大小（字节）
 * @return 建议的总超时秒数（向上取整，至少 DEFAULT_TIMEOUT_SEC 兜底）
 */
function suggestTimeoutSec(
  bytes: number,
  durationMs: number,
  totalSize: number
): number {
  if (bytes <= 0 || durationMs <= 0 || totalSize <= 0) {
    return DEFAULT_TIMEOUT_SEC;
  }
  const ratePerMs = bytes / durationMs;
  if (ratePerMs <= 0) return DEFAULT_TIMEOUT_SEC;
  // 完整传输预估耗时（毫秒）= 总大小 / 速率，留 30% 余量
  const fullMs = (totalSize / ratePerMs) * 1.3;
  return Math.max(Math.ceil(fullMs / 1000), 1);
}

/**
 * @brief 根据中止原因生成面向用户的传输结果文本
 *
 *   - idle / overall-stalled：判定为真故障（链路/对端挂了），明确告知已终止、
 *     设备端 rz/sz 已被中止序列退出、shell 已恢复。
 *   - overall-proceeding：总时长到点但传输仍在推进，说明 timeout 设得过小；
 *     基于实测速率给出建议值，提示用户调大 timeout 重试。
 *
 * @param reason       中止原因
 * @param verb         "Upload" | "Download"
 * @param localPath    本地路径
 * @param remotePath   远端路径
 * @param result       底层返回的传输结果（取 bytes/durationMs）
 * @param timeoutSec   实际生效的总时长秒数
 * @param idleTimeoutSec 实际生效的空闲秒数
 * @param totalSize    文件总大小（字节）
 * @return 多行文本摘要
 */
function formatAbortedSummary(
  reason: AbortReason,
  verb: "Upload" | "Download",
  localPath: string,
  remotePath: string,
  result: { bytes: number; durationMs: number },
  timeoutSec: number,
  idleTimeoutSec: number,
  totalSize: number
): string {
  const lines = [`${verb} failed`];
  lines.push(`  local : ${localPath}`);
  lines.push(`  remote: ${remotePath}`);

  if (reason === "overall-proceeding") {
    const suggested = suggestTimeoutSec(
      result.bytes,
      result.durationMs,
      totalSize
    );
    const rate =
      result.durationMs > 0
        ? `${(((result.bytes / result.durationMs) * 1000) / 1024).toFixed(2)} KB/s`
        : "N/A";
    lines.push(
      `  error : Reached overall timeout (${timeoutSec}s) while transfer was still progressing (~${rate}).`
    );
    lines.push(
      `         The file is incomplete (${result.bytes}/${totalSize} bytes).`
    );
    lines.push(
      `         Retry with timeout >= ${suggested}s (or rely on the default ${DEFAULT_TIMEOUT_SEC}s).`
    );
    lines.push(
      `         Device-side rz/sz has been stopped and shell recovered.`
    );
  } else {
    // idle 或 overall-stalled：真故障
    lines.push(
      `  error : No data flow for ${idleTimeoutSec}s — likely a link or device failure.`
    );
    lines.push(
      `         Transfer aborted. Device-side rz/sz has been stopped and shell recovered.`
    );
  }
  return lines.join("\n");
}

// ── serial_upload ───────────────────────────────────────────

/**
 * @brief serial_upload 工具配置
 *
 * 将本地二进制文件上传到设备端，复用已有串口会话。
 * 设备端需安装 lrzsz（rz 命令）。
 *
 * @param session_id    由 serial_open 返回的会话 ID
 * @param local_path    本地源文件路径
 * @param remote_name   远端文件名（默认取 local_path basename）
 * @param recv_cmd      设备端接收命令（默认 "rz"，可传 "rz -e" 等）
 * @param idle_timeout  空闲超时秒数：无数据流动超过此值判真故障并终止（默认 15）
 * @param timeout       总时长超时秒数，兜底防无限挂起（默认 300）
 */
export const serialUploadConfig: SdkToolConfig = {
  description:
    "Upload a binary file to the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (rz command). " +
    "IMPORTANT: this tool triggers the device-side rz by itself (via recv_cmd); " +
    "do NOT manually run rz (or serial_exec/write rz) on the session beforehand — " +
    "a pre-started rz enters its own waiting state that breaks the tool's ZMODEM handshake. " +
    "Just call this tool and pass recv_cmd when a working directory change is needed " +
    '(e.g. "cd /home && rz"). ' +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr. " +
    "Two timeouts: idle_timeout aborts on stalled transfer (real failure); " +
    "timeout caps total duration and reports a suggested value if still progressing.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      local_path: {
        type: "string",
        description: "Local source file path",
      },
      remote_name: {
        type: "string",
        description:
          "Remote file name (default: basename of local_path). The device rz will name the file accordingly.",
      },
      recv_cmd: {
        type: "string",
        description:
          "Device receive command (default: 'rz'). The tool runs this command itself on the device " +
          "after disabling flow control — do NOT start rz manually beforehand. " +
          'Use it for directory changes or options, e.g. "cd /home && rz -e" to receive into /home, ' +
          "or 'rz -e' to escape control chars",
      },
      idle_timeout: {
        type: "number",
        description:
          "Idle timeout in seconds: if no data flows for this long, the transfer is treated as a real failure " +
          "(link/device stalled) and aborted. Independent of file size (default: 15, min: 3).",
      },
      timeout: {
        type: "number",
        description:
          "Overall timeout in seconds as a safety cap against indefinite hangs (default: 300). " +
          "If reached while the transfer is still progressing (no idle), reports the timeout as too small " +
          "with a suggested value instead of silently truncating.",
      },
    },
    required: ["session_id", "local_path"],
  },
};

/**
 * @brief serial_upload 处理函数
 *
 * 流程：
 *   1. 查会话；本地文件存在性校验
 *   2. 触发设备端 rz（recv_cmd 可覆盖）
 *   3. 短延时让设备进 ZMODEM 等待态
 *   4. 构造 AbortController，按 timeout 设超时
 *   5. 调 zmodemSend，进度回调节流输出 logger
 *   6. 收 shell 提示符确认会话活着，返回摘要
 *
 * @param args 工具参数
 * @return MCP 响应，含传输摘要文本
 */
export async function serialUploadHandler(args: {
  session_id: string;
  local_path: string;
  remote_name?: string;
  recv_cmd?: string;
  idle_timeout?: number;
  timeout?: number;
}): Promise<string> {
  const timeoutSec = args.timeout ?? DEFAULT_TIMEOUT_SEC;
  const idleTimeoutSec = resolveIdleTimeoutSec(args.idle_timeout);
  logger.info(
    `[serial_upload] session_id=${args.session_id} local=${args.local_path} remote_name=${args.remote_name ?? "(auto)"} recv_cmd=${args.recv_cmd ?? "(default rz)"} timeout=${timeoutSec} idle_timeout=${idleTimeoutSec}`
  );

  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  // 本地文件存在性校验（桥接层 zmodemSend 还会再 stat 一次拿 offer size，
  // 此处仅为快速失败；总大小由 onProgress 的 p.total 带回，不再重复 stat）
  let offerTotalSize = 0;
  try {
    await stat(args.local_path);
  } catch (err) {
    const msg = `Local file not found: ${args.local_path} (${err instanceof Error ? err.message : String(err)})`;
    logger.warn(`[serial_upload] ${msg}`);
    return msg;
  }

  const remoteName = args.remote_name ?? basename(args.local_path);
  const recvCmd = args.recv_cmd ?? "rz";

  // 整个传输过程（含 ZMODEM 前置流控关闭 + 传输 + 恢复 shell）都在 session 锁保护内，
  // 避免并发 exec/write 注入命令破坏 ZMODEM 协议帧或污染 buffer
  return serialStore.withLock(args.session_id, async () => {
    // ZMODEM 前置：关闭设备端软件流控，避免 XON/XOFF 拦截协议字节
    await disableFlowControl(shell);

    // 超时控制：空闲超时（真故障）+ 总时长超时（兜底），共用 AbortController
    const controller = new AbortController();
    const guard = createTransferTimeoutGuard(
      controller,
      timeoutSec,
      idleTimeoutSec
    );

    // 进度节流：按字节增量打印，避免本地突发读取下时间节流吞掉绝大部分日志
    let lastLoggedBytes = 0;
    try {
      // recvCmd 由 zmodemSend→establishSession 挂完字节旁路后发出，
      // 确保设备 rz 回的 ZRINIT 进预缓冲区而非文本态
      const result = await zmodemSend(
        shell,
        args.local_path,
        remoteName,
        {
          onProgress: (p) => {
            guard.touch(p.bytes); // 每次数据流动重置空闲计时
            if (typeof p.total === "number" && p.total > 0) {
              offerTotalSize = p.total;
            }
            if (p.bytes - lastLoggedBytes >= LOG_PROGRESS_BYTES) {
              logger.info(
                `[serial_upload] progress ${p.bytes}/${p.total ?? "?"} bytes`
              );
              lastLoggedBytes = p.bytes;
            }
          },
          // 心跳：握手/关闭阶段（transfer.end / session.close）无数据帧，
          // 但协议在推进，靠此回调刷新 idle 时间戳，避免被误判为链路挂了。
          onHeartbeat: () => guard.heartbeat(),
          signal: controller.signal,
        },
        recvCmd
      );

      logger.info(
        `[serial_upload] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
      );

      // 若是被超时守卫中止的，按中止原因生成面向用户的文案（区分真故障/timeout过小）
      const reason = guard.reason();
      if (!result.success && reason) {
        return formatAbortedSummary(
          reason,
          "Upload",
          args.local_path,
          remoteName,
          { bytes: result.bytes, durationMs: result.durationMs },
          timeoutSec,
          idleTimeoutSec,
          offerTotalSize
        );
      }
      return formatTransferSummary(result);
    } finally {
      guard.clear();
      // ZMODEM 结束后恢复 shell 到正常提示符状态（rz 退出后 shell 可能停在异常终端态）。
      // 超时/异常时底层 finally 已发 CAN×5+BS×5 让设备端 rz 退出，此处排空缓冲恢复提示符。
      await recoverShell(shell);
    }
  });
}

// ── serial_download ─────────────────────────────────────────

/**
 * @brief serial_download 工具配置
 *
 * 将远端文件从设备下载到本地，复用已有串口会话。
 * 设备端需安装 lrzsz（sz 命令）。
 *
 * @param session_id    由 serial_open 返回的会话 ID
 * @param remote_path   远端源文件路径
 * @param local_path    本地目标文件路径
 * @param send_cmd      设备端发送命令模板（默认 "sz {remote}"，{remote} 替换为 remote_path）
 * @param idle_timeout  空闲超时秒数：无数据流动超过此值判真故障并终止（默认 15）
 * @param timeout       总时长超时秒数，兜底防无限挂起（默认 300）
 */
export const serialDownloadConfig: SdkToolConfig = {
  description:
    "Download a binary file from the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (sz command). " +
    "IMPORTANT: this tool triggers the device-side sz by itself (via send_cmd); " +
    "do NOT manually run sz (or serial_exec/write sz) on the session beforehand — " +
    "a pre-started sz enters its own sending state that breaks the tool's ZMODEM handshake. " +
    "Just call this tool and pass send_cmd when a directory change is needed " +
    '(e.g. "cd /home && sz {remote}"). ' +
    "remote_path resolves on the device relative to the shell's current working directory — " +
    "prefer an absolute path, or combine send_cmd with a cd to pin the directory. " +
    "If the remote file does not exist or is unreadable, sz errors out and the transfer fails " +
    "(a partial local file, if any, is removed on failure). " +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr. " +
    "Two timeouts: idle_timeout aborts on stalled transfer (real failure); " +
    "timeout caps total duration and reports a suggested value if still progressing.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by serial_open",
      },
      remote_path: {
        type: "string",
        description:
          "Remote source file path on the device. Resolved relative to the shell's current working " +
          "directory — prefer an absolute path, or pin the directory via send_cmd (e.g. " +
          '"cd /home && sz {remote}"). The file must exist and be readable; otherwise sz errors ' +
          "out and the transfer fails.",
      },
      local_path: {
        type: "string",
        description: "Local destination file path",
      },
      send_cmd: {
        type: "string",
        description:
          "Device send command template (default: 'sz {remote}'). {remote} is replaced by remote_path. " +
          "The tool runs this command itself on the device — do NOT start sz manually beforehand. " +
          'Use it for directory changes, e.g. "cd /home && sz {remote}"',
      },
      idle_timeout: {
        type: "number",
        description:
          "Idle timeout in seconds: if no data flows for this long, the transfer is treated as a real failure " +
          "(link/device stalled) and aborted. Independent of file size (default: 15, min: 3).",
      },
      timeout: {
        type: "number",
        description:
          "Overall timeout in seconds as a safety cap against indefinite hangs (default: 300). " +
          "If reached while the transfer is still progressing (no idle), reports the timeout as too small " +
          "with a suggested value instead of silently truncating.",
      },
    },
    required: ["session_id", "remote_path", "local_path"],
  },
};

/**
 * @brief serial_download 处理函数
 *
 * 流程与 serial_upload 对称：
 *   1. 查会话
 *   2. 触发设备端 sz（send_cmd 模板，{remote} 占位符替换）
 *   3. 调 zmodemReceive，进度节流输出 logger
 *   4. 收 shell 提示符，返回摘要
 *
 * @param args 工具参数
 * @return MCP 响应，含传输摘要文本
 */
export async function serialDownloadHandler(args: {
  session_id: string;
  remote_path: string;
  local_path: string;
  send_cmd?: string;
  idle_timeout?: number;
  timeout?: number;
}): Promise<string> {
  const timeoutSec = args.timeout ?? DEFAULT_TIMEOUT_SEC;
  const idleTimeoutSec = resolveIdleTimeoutSec(args.idle_timeout);
  logger.info(
    `[serial_download] session_id=${args.session_id} remote=${args.remote_path} local=${args.local_path} send_cmd=${args.send_cmd ?? "(default sz)"} timeout=${timeoutSec} idle_timeout=${idleTimeoutSec}`
  );

  const shell = serialStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  // 触发设备端 sz（{remote} 占位符替换为远端路径）
  const sendCmd = (args.send_cmd ?? "sz {remote}").replace(
    "{remote}",
    args.remote_path
  );

  // 整个传输过程（含 ZMODEM 前置流控关闭 + 传输 + 恢复 shell）都在 session 锁保护内
  return serialStore.withLock(args.session_id, async () => {
    // ZMODEM 前置：关闭设备端软件流控，避免 XON/XOFF 拦截协议字节
    await disableFlowControl(shell);

    // 超时控制：空闲超时（真故障）+ 总时长超时（兜底），共用 AbortController
    const controller = new AbortController();
    const guard = createTransferTimeoutGuard(
      controller,
      timeoutSec,
      idleTimeoutSec
    );

    // 记录 offer 携带的总大小（来自设备 sz），供 overall-proceeding 给建议值
    let offerTotalSize = 0;
    // 进度节流：下载侧 on_input 受串口速率限制（平滑非突发），时间节流本就工作良好
    let lastLogAt = 0;
    try {
      // sendCmd 由 zmodemReceive→establishSession 挂完字节旁路后发出
      const result = await zmodemReceive(
        shell,
        args.local_path,
        {
          onProgress: (p) => {
            if (typeof p.total === "number" && p.total > 0) {
              offerTotalSize = p.total;
            }
            guard.touch(p.bytes); // 每次数据流动重置空闲计时
            const now = Date.now();
            if (now - lastLogAt >= PROGRESS_LOG_THROTTLE_MS) {
              logger.info(
                `[serial_download] progress ${p.bytes}/${p.total ?? "?"} bytes`
              );
              lastLogAt = now;
            }
          },
          // 心跳：握手/关闭阶段（session.start→offer 间隙、ZFIN 握手）无数据帧，
          // 但协议在推进，靠此回调刷新 idle 时间戳，避免被误判为链路挂了。
          onHeartbeat: () => guard.heartbeat(),
          signal: controller.signal,
        },
        sendCmd
      );

      logger.info(
        `[serial_download] ${result.success ? "ok" : "fail"} bytes=${result.bytes} ms=${result.durationMs}`
      );

      // 若是被超时守卫中止的，按中止原因生成面向用户的文案（区分真故障/timeout过小）。
      // 注意：底层 zmodemReceive 在 abort 时已删除残缺本地文件，此处只负责文案。
      const reason = guard.reason();
      if (!result.success && reason) {
        return formatAbortedSummary(
          reason,
          "Download",
          args.local_path,
          args.remote_path,
          { bytes: result.bytes, durationMs: result.durationMs },
          timeoutSec,
          idleTimeoutSec,
          offerTotalSize
        );
      }
      return formatTransferSummary(result);
    } finally {
      guard.clear();
      // ZMODEM 结束后恢复 shell 到正常提示符状态。
      // 超时/异常时底层 finally 已发 CAN×5+BS×5 让设备端 sz 退出，此处排空缓冲恢复提示符。
      await recoverShell(shell);
    }
  });
}
