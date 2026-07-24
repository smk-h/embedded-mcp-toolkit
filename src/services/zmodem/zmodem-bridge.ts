/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : zmodem-bridge.ts
 * Author     : sumu
 * Date       : 2026/07/24
 * Version    : 1.0.0
 * Description: ZMODEM 协议桥接层
 *
 *   封装 zmodem.js 库，把 SerialShell 的字节旁路 ←→ ZMODEM 会话粘合起来。
 *   对外暴露两个高阶函数：
 *     - zmodemSend    MCP 当发送端，设备端 rz 接收（上传）
 *     - zmodemReceive MCP 当接收端，设备端 sz 发送（下载）
 *
 *   数据流向（以上传为例，下载对称）：
 *     本地文件 → 流式分块 → Transfer.send → [zmodem.js 编码 ZDATA 帧]
 *       → set_sender 回调 → shell.rawWrite(Buffer) → 串口 → 设备 rz
 *     设备回执(ZRINIT/ZACK/ZEOF) → 串口 → attachRawReceiver
 *       → session.consume → [zmodem.js 解析]
 *
 *   依赖 zmodem.js@0.1.10 的实测 API：
 *     - Zmodem.Session.parse(octets)   从首帧判断建 Send/Receive 会话
 *     - session.set_sender(cb)         注册输出回调，cb 收 number[]
 *     - session.consume(octets)        喂入接收字节（number[]）
 *     - Zmodem.Validation.offer_parameters({name,size,mtime})  归一化 offer
 *     - Send: send_offer(params) → Promise<Transfer>；Transfer.send/end
 *     - Receive: on("offer", xfer=>xfer.accept({on_input:fn}))；on("session_end")
 * ======================================================
 */

import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";

import Zmodem, {
  type ZmodemSession,
  type SendSession,
  type Offer as ReceiveOffer,
  type Octets,
} from "zmodem.js";

import type { SerialShell } from "../../transports/serial.js";
import type { TransferResult } from "../../shared/transfer-result.js";
import { logger } from "../../shared/logger.js";

// ── 类型定义 ────────────────────────────────────────────────

/**
 * @brief ZMODEM 传输进度信息
 *
 * 由 zmodemSend / zmodemReceive 在传输过程中通过 onProgress 回调上报。
 * 上传时 total 已知（本地文件大小）；下载时 total 在收到 ZFILE offer 后才有值。
 */
export interface ZmodemProgress {
  /** 已传输字节数 */
  bytes: number;
  /** 文件总字节数（未知时为 undefined，如下载初期未收到 offer 时） */
  total?: number;
}

/**
 * @brief ZMODEM 传输的可选参数
 */
export interface ZmodemTransferOptions {
  /** 进度回调，传输过程中按块频率触发 */
  onProgress?: (p: ZmodemProgress) => void;
  /** 中止信号；abort 后立即停止 ZMODEM 会话并返回失败结果 */
  signal?: AbortSignal;
}

// ── 常量 ────────────────────────────────────────────────────

/** @brief ZMODEM 子包最大长度，对齐 zmodem.js 内部 MAX_CHUNK_LENGTH（lrzsz 允许 8KiB） */
const ZMODEM_CHUNK_SIZE = 8192;

/** @brief 等待设备端 rz/sz 发出首帧（ZRINIT/ZRQINIT）的轮询间隔 */
const HANDSHAKE_POLL_MS = 100;

/** @brief 等待设备端首帧的总超时（rz/sz 启动后应很快发首帧） */
const HANDSHAKE_TIMEOUT_MS = 5000;

/** @brief ZMODEM 标准中止序列：CAN(0x18)×5 + BS(0x08)×5，lrzsz 收到后会退出接收/发送态 */
const ZMODEM_ABORT_SEQUENCE = Buffer.from([
  0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08,
]);

/** @brief 发 abort 序列后等设备退出的延时（毫秒） */
const ABORT_SETTLE_MS = 500;

/** @brief 等 session_end 事件的超时（毫秒），ZFIN 握手通常很快，超时则不再阻塞 */
const SESSION_END_TIMEOUT_MS = 5000;

/**
 * @brief 调用 session.close() 完成 ZFIN 关闭握手（带超时兜底）
 *
 * session.close() 是 ZMODEM 发送端干净退出的必要步骤：发 ZFIN → 等对端 ZFIN →
 * 发 OO → 触发 session_end。不调则对端 rz 等不到 ZFIN，超时后发 CAN×10+BS×10
 * 中止会话，破坏终端模式导致后续 shell 命令无响应（实测根因）。
 *
 * 兜底：对端异常不回 ZFIN 时，close() 的 Promise 可能悬挂，故用 timeout 兜底，
 * 超时后由调用方的 finally 里 abortDeviceSession 强制中止。
 *
 * @param session Send 会话对象
 * @returns cleanEnded=true 表示 close() 正常 resolve（ZFIN/OO 握手完成）；
 *          false 表示超时兜底或 close 抛错，对端 rz 可能仍在等待，需 abort。
 */
function closeSessionWithTimeout(
  session: SendSession
): Promise<{ cleanEnded: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (clean: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ cleanEnded: clean });
    };
    const timer = setTimeout(() => finish(false), SESSION_END_TIMEOUT_MS);
    try {
      // close() resolve（非 reject）才算干净结束；reject 视为未完成
      session.close().then(
        () => finish(true),
        () => finish(false)
      );
    } catch {
      finish(false);
    }
  });
}

// ── 内部辅助 ────────────────────────────────────────────────

/**
 * @brief 在字节缓冲区中定位 ZMODEM 头的起始位置
 *
 * ZMODEM 头以 ZPAD/ZDLE 标志字节开头，有两种形态：
 *   - hex 头：  ZPAD ZPAD ZDLE  → 0x2a 0x2a 0x18
 *   - binary 头：ZPAD ZDLE       → 0x2a 0x18（后跟 ZBIN 'A' 或 ZBIN32 'C'）
 *
 * zmodem.js 的 Session.parse → parse_hex 不剥离前缀垃圾，直接假设输入从头开始。
 * 本函数先扫描掉 "rz\r\n"、"rz waiting to receive." 等命令回显，定位真正的头起始。
 *
 * @param bytes 字节缓冲区
 * @returns ZMODEM 头起始索引；未找到返回 -1
 */
function findZmodemHeaderStart(bytes: number[]): number {
  for (let i = 0; i < bytes.length - 1; i++) {
    // hex 头：0x2a 0x2a 0x18
    if (
      bytes[i] === 0x2a &&
      bytes[i + 1] === 0x2a &&
      i + 2 < bytes.length &&
      bytes[i + 2] === 0x18
    ) {
      return i;
    }
    // binary 头：0x2a 0x18（后跟 ZBIN 0x41 或 ZBIN32 0x43）
    if (
      bytes[i] === 0x2a &&
      bytes[i + 1] === 0x18 &&
      i + 2 < bytes.length &&
      (bytes[i + 2] === 0x41 || bytes[i + 2] === 0x43)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * @brief 向设备发 ZMODEM 标准中止序列，让卡住的 rz/sz 干净退出
 *
 * ZMODEM 接收/发送态下，普通 Ctrl+C(0x03) 被当作数据吞掉，无法中断。
 * 协议规定的中止方式是 CAN(0x18)×5 + BS(0x08)×5，lrzsz 识别后退出。
 * 用 rawWrite 发送原始字节以绕过文本态追加换行（换行会破坏序列语义）。
 *
 * 失败静默忽略：本函数在 finally 中调用，不应抛出掩盖原始错误。
 *
 * @param shell 已建立的串口会话
 */
async function abortDeviceSession(shell: SerialShell): Promise<void> {
  try {
    shell.rawWrite(ZMODEM_ABORT_SEQUENCE);
    await new Promise((r) => setTimeout(r, ABORT_SETTLE_MS));
  } catch {
    /* 串口可能已关闭，忽略 */
  }
}

// ── 内部辅助 ────────────────────────────────────────────────

/**
 * @brief 等待设备端 ZMODEM 首帧并据此建立会话
 *
 * 设备端 rz 启动后发 ZRINIT（→ 建 Send 会话），sz 启动后发 ZRQINIT（→ 建 Receive 会话）。
 * 本函数轮询消费 attachRawReceiver 收到的字节，直到 parse 出会话或超时。
 *
 * 挂载的字节旁路在会话建立后继续保留（session.consume 持续消费），
 * 返回 detach 句柄由调用方在传输结束后卸载。
 *
 * @param shell      已建立的串口会话
 * @param onOutput   会话输出回调（库要发的字节，写回串口）
 * @param timeoutMs  等待首帧超时（毫秒）
 * @param startCmd   可选：挂完字节旁路后立即发送的设备端命令（如 "rz" / "sz xxx"）。
 *                   必须在 rawReceiver 挂载后发，否则设备回的 ZRINIT/ZRQINIT 首帧
 *                   会进文本态 OutputBuffer 而非预缓冲区，导致 parse 失败。
 * @returns 建立成功的会话对象 + 卸载旁路的 detach 句柄
 * @throws 超时或建链失败时抛出
 */
async function establishSession(
  shell: SerialShell,
  onOutput: (octets: Octets) => void,
  timeoutMs: number,
  startCmd?: string
): Promise<{ session: ZmodemSession; detach: () => void }> {
  // 预缓冲区：在 parse 出会话前累积接收字节
  const preBuffer: number[] = [];
  let session: ZmodemSession | null = null;

  // 挂字节旁路：parse 前攒进 preBuffer，parse 后喂给 session.consume
  const detach = shell.attachRawReceiver((buf: Buffer) => {
    if (session) {
      session.consume(Array.from(buf.values()));
    } else {
      for (const b of buf.values()) preBuffer.push(b);
    }
  });

  // rawReceiver 挂载后再发启动命令，确保设备回的首帧进 preBuffer 而非文本态
  if (startCmd) {
    shell.write(startCmd, 1);
  }

  const deadline = Date.now() + timeoutMs;
  // 尝试用已有字节 parse；无果则轮询等待新字节到达后再试
  while (Date.now() < deadline) {
    if (preBuffer.length > 0) {
      // Session.parse → parse_hex 直接假设输入以 ZMODEM 头开头，不剥离前缀垃圾。
      // 但 rawReceiver 收到的字节含 "rz\r\n" / "rz waiting to receive." 等命令回显，
      // 必须先定位 ZMODEM 头起始标志 ZPAD ZPAD ZDLE (0x2a 0x2a 0x18)，从那里截取再 parse。
      // 同时传副本：parse_hex 内部会 splice 破坏传入数组。
      const headerStart = findZmodemHeaderStart(preBuffer);
      if (headerStart >= 0) {
        const parsed = Zmodem.Session.parse(preBuffer.slice(headerStart));
        if (parsed) {
          session = parsed;
          session.set_sender(onOutput);
          break;
        }
      }
    }
    await new Promise((r) => setTimeout(r, HANDSHAKE_POLL_MS));
  }

  if (!session) {
    // 建链失败必须卸载旁路，避免泄漏
    logger.warn(
      `[zmodem] handshake timeout: no first frame from device within ${timeoutMs}ms, preBuffer=${preBuffer.length}B`
    );
    detach();
    throw new Error(
      `ZMODEM handshake timeout: no first frame from device within ${timeoutMs}ms`
    );
  }
  return { session, detach };
}

// ── 对外接口：上传 ──────────────────────────────────────────

/**
 * @brief ZMODEM 上传：MCP 当发送端，设备端已跑 rz
 *
 * 流程：
 *   1. stat 本地文件拿大小（失败直接返回失败结果）
 *   2. 等待设备 rz 发 ZRINIT，建 Send 会话
 *   3. send_offer 发文件元信息，得到 Transfer 对象
 *   4. 流式读本地文件，分块 Transfer.send，全部发完后 Transfer.end
 *   5. 等 session_end，卸载字节旁路，返回结果
 *
 * @param shell      已建立的串口会话
 * @param localPath  本地源文件路径
 * @param remoteName 远端文件名（ZMODEM offer 携带，设备 rz 据此命名）
 * @param opts       进度回调 / 中止信号
 * @param recvCmd    设备端接收命令（默认 "rz"），由 establishSession 挂完旁路后发出
 * @returns 传输结果摘要
 */
export async function zmodemSend(
  shell: SerialShell,
  localPath: string,
  remoteName: string,
  opts?: ZmodemTransferOptions,
  recvCmd: string = "rz"
): Promise<TransferResult> {
  const start = Date.now();

  // 取本地文件大小（摘要用）
  let size: number;
  try {
    const st = await stat(localPath);
    size = st.size;
  } catch (err) {
    return {
      direction: "upload",
      localPath,
      remotePath: remoteName,
      bytes: 0,
      durationMs: Date.now() - start,
      success: false,
      error: `Cannot stat local file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let session: SendSession | null = null;
  // 卸载函数句柄，传输结束后调用
  let detach: (() => void) | null = null;
  // 会话是否经 ZFIN/OO 干净结束（close() 正常 resolve）。
  // 不能用 session.has_ended() 判断——本地 session.abort() 会置 _aborted，
  // 使 has_ended() 返回 true，从而漏发 abortDeviceSession 导致设备端 rz 卡死。
  let cleanEnded = false;

  try {
    // 建链：establishSession 挂完字节旁路后发出 recvCmd（rz），
    // 确保设备回的 ZRINIT 进 preBuffer 而非文本态 OutputBuffer
    const established = await establishSession(
      shell,
      (octets: Octets) => shell.rawWrite(Buffer.from(octets)),
      HANDSHAKE_TIMEOUT_MS,
      recvCmd
    );
    session = established.session as SendSession;
    detach = established.detach;

    // offer 参数归一化（mtime/size/serial 等由库补全）
    const offer = Zmodem.Validation.offer_parameters({
      name: remoteName,
      size,
    });

    // 发送 offer，得到 Transfer 对象（对端回 ZRPOS 表示准备接收）
    const transfer = await session.send_offer(offer);

    // 若对端回 ZSKIP（拒绝），transfer 为 undefined
    if (!transfer) {
      throw new Error("Device refused the file offer (ZSKIP received)");
    }

    // 流式读本地文件，分块发送
    let sent = 0;
    const stream = createReadStream(localPath, {
      highWaterMark: ZMODEM_CHUNK_SIZE,
    });

    for await (const chunk of stream as Readable) {
      // 中止检查：abort 后停止发送
      if (opts?.signal?.aborted) {
        throw new Error("Transfer aborted by signal");
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      transfer.send(Array.from(buf.values()));
      sent += buf.length;
      opts?.onProgress?.({ bytes: sent, total: size });
    }

    // 全部发完，等对端确认 ZEOF（end 返回 Promise，在 ZEOF 后 resolve）。
    // transfer.end 只完成单文件结束（发 ZEOF、等对端 ZRINIT），
    // 它不会发 ZFIN——若就此结束，对端 rz 会一直等 ZFIN，超时后发 CAN 中止会话，
    // 破坏终端模式、导致后续 shell 命令无响应（实测根因）。
    await transfer.end([]);

    // 关键：调 session.close() 发 ZFIN 关闭握手。
    // close() 内部：发 ZFIN → 等对端回 ZFIN → 发 OO（Over and Out）→ 触发 session_end。
    // 这是 ZMODEM 发送端干净退出的唯一方式；不调则对端必超时 abort。
    // 用 timeout 兜底：对端异常不回 ZFIN 时不再无限阻塞。
    // cleanEnded 仅在 close() 正常 resolve 时为 true（ZFIN/OO 握手完成）。
    const closeResult = await closeSessionWithTimeout(session);
    cleanEnded = closeResult.cleanEnded;

    return {
      direction: "upload",
      localPath,
      remotePath: remoteName,
      bytes: sent,
      durationMs: Date.now() - start,
      success: true,
    };
  } catch (err) {
    // 中止/失败时发 ZMODEM abort 序列通知设备
    try {
      session?.abort?.();
    } catch {
      /* ignore abort errors */
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[zmodemSend] failed: ${errMsg}`);
    return {
      direction: "upload",
      localPath,
      remotePath: remoteName,
      bytes: 0,
      durationMs: Date.now() - start,
      success: false,
      error: errMsg,
    };
  } finally {
    // 仅在会话未干净结束时（ZFIN/OO 未完成）发 abort：让卡在协议态的设备端 rz 退出。
    // 成功时 rz 已干净退出、shell 回到提示符，再发 CAN×5+BS×5 反而破坏终端模式。
    // 用 cleanEnded 而非 session.has_ended()——后者会被本地 session.abort() 置位，
    // 超时/异常场景下会误判为"已结束"而漏发设备 abort。
    if (!cleanEnded) {
      await abortDeviceSession(shell);
    }
    detach?.();
  }
}

// ── 对外接口：下载 ──────────────────────────────────────────

/**
 * @brief ZMODEM 下载：MCP 当接收端，设备端已跑 sz
 *
 * 流程：
 *   1. 等待设备 sz 发 ZRQINIT，建 Receive 会话
 *   2. on("offer") 时 accept，把每个 payload 流式写入本地文件
 *   3. on("session_end") 结束，卸载旁路，返回结果
 *   4. 失败时清理半写文件
 *
 * @param shell     已建立的串口会话
 * @param localPath 本地目标文件路径
 * @param opts      进度回调 / 中止信号
 * @param sendCmd   设备端发送命令（默认 "sz {remote}" 形式，由调用方替换占位符），
 *                  由 establishSession 挂完旁路后发出
 * @returns 传输结果摘要
 */
export async function zmodemReceive(
  shell: SerialShell,
  localPath: string,
  opts?: ZmodemTransferOptions,
  sendCmd?: string
): Promise<TransferResult> {
  const start = Date.now();

  let session: ZmodemSession | null = null;
  let detach: (() => void) | null = null;
  // session_end 的 Promise，用于 await 整个接收完成
  let resolveEnd: () => void;
  const sessionEnd = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  // 记录实际接收字节数与 offer 携带的文件大小
  let received = 0;
  let offerSize: number | undefined;
  // 会话是否经 OO 干净结束（session_end 事件触发）。
  // 不能用 session.has_ended() 判断——本地 session.abort() 会置 _aborted，
  // 使 has_ended() 返回 true，从而漏发 abortDeviceSession 导致设备端 sz 卡死。
  let cleanEnded = false;

  try {
    // 建链：establishSession 挂完字节旁路后发出 sendCmd（sz xxx），
    // 确保设备回的 ZRQINIT 进 preBuffer 而非文本态 OutputBuffer
    const established = await establishSession(
      shell,
      (octets: Octets) => shell.rawWrite(Buffer.from(octets)),
      HANDSHAKE_TIMEOUT_MS,
      sendCmd
    );
    session = established.session;
    detach = established.detach;

    // session_end：所有文件收完、ZFIN 握手后、对端发 OO 时触发。
    // 只有这条路径才是干净结束，置 cleanEnded 让 finally 不再发 abort。
    session.on("session_end", () => {
      cleanEnded = true;
      resolveEnd();
    });

    // 准备写入流（offer 到来时才真正写数据）
    let writeStream: ReturnType<typeof createWriteStream> | null = null;

    session.on("offer", (xfer: ReceiveOffer) => {
      const details = xfer.get_details();
      offerSize = typeof details.size === "number" ? details.size : undefined;
      writeStream = createWriteStream(localPath);
      // accept 时用 on_input 回调流式写盘，避免 spool 进内存（大文件友好）
      xfer.accept({
        on_input: (payload: Octets) => {
          const buf = Buffer.from(payload);
          writeStream?.write(buf);
          received += buf.length;
          opts?.onProgress?.({ bytes: received, total: offerSize });
        },
      });
    });

    // 中止信号监听：超时/外部 abort 时让 zmodem.js 进入 aborted 态并解除 sessionEnd 等待。
    // 注意此处不置 cleanEnded——abort 不是干净结束，finally 仍需发 abortDeviceSession
    // 让设备端 sz 退出（尽管 session.has_ended() 因 _aborted 已变 true，但那不代表 sz 退出）。
    const onAbort = (): void => {
      try {
        session?.abort?.();
      } catch {
        /* ignore */
      }
      resolveEnd();
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    // 关键：启动 Receive 会话状态机——发 ZRINIT 给对端 sz、arm ZFILE 处理器。
    // parse() 返回的 Receive 对象是惰性的，不调 start() 则永不发 ZRINIT、
    // offer 事件永不触发，对端 sz 收不到 ZRINIT 会超时发 CAN 中止（实测根因）。
    // 必须在 offer handler 注册之后调：start 发的 ZRINIT 会引来 sz 回 ZFILE，
    // ZFILE 触发 offer，handler 必须先就位。
    await session.start();

    // 等 session_end：所有文件收完、ZFIN 握手后触发。
    // 超时由调用方传的 AbortSignal 兜底（超时 → onAbort → resolveEnd），
    // 无需在此再包一层 setTimeout。
    await sessionEnd;
    opts?.signal?.removeEventListener("abort", onAbort);

    // 等写入流刷盘
    if (writeStream) {
      await new Promise<void>((resolve, reject) => {
        writeStream?.end(resolve);
        // end 异常理论上不触发 reject，但保留兜底
        writeStream?.on("error", reject);
      });
    }

    return {
      direction: "download",
      localPath,
      remotePath: "(via sz)",
      bytes: received,
      durationMs: Date.now() - start,
      success: true,
    };
  } catch (err) {
    try {
      session?.abort?.();
    } catch {
      /* ignore */
    }
    // 失败时清理半写文件（对齐 ssh downloadFile 做法）
    try {
      await unlink(localPath);
    } catch {
      /* 文件可能未创建，忽略 */
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[zmodemReceive] failed: ${errMsg}`);
    return {
      direction: "download",
      localPath,
      remotePath: "(via sz)",
      bytes: 0,
      durationMs: Date.now() - start,
      success: false,
      error: errMsg,
    };
  } finally {
    // 仅在会话未干净结束时（OO 未收到）发 abort：让卡在协议态的设备端 sz 退出。
    // 成功时 sz 已通过 ZFIN/OO 干净退出、shell 回到提示符，再发 CAN×5+BS×5 反而
    // 破坏终端模式。用 cleanEnded 而非 session.has_ended()——后者会被本地
    // session.abort() 置位，超时场景下会误判为"已结束"而漏发设备 abort。
    if (!cleanEnded) {
      await abortDeviceSession(shell);
    }
    detach?.();
  }
}
