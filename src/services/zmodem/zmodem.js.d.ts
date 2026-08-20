/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : zmodem.js.d.ts
 * Author     : sumu
 * Date       : 2026/07/24
 * Version    : 1.0.0
 * Description: zmodem.js 第三方包的类型声明
 *
 *   zmodem.js@0.1.10 是纯 JS 实现且无官方类型定义，
 *   此处提供最小可用声明，覆盖 services/zmodem/zmodem-bridge.ts 用到的 API。
 *   运行时对象的具体形态由 bridge 内部的 ZmodemNS（any）承接，
 *   本声明只解决 tsc 的 "implicitly has any" 报错。
 * ======================================================
 */

declare module "zmodem.js" {
  /** 文件 offer 详情（get_details 返回） */
  export interface FileDetails {
    name: string;
    size: number | null;
    serial: null;
    mtime: number | null;
    mode: number | null;
    files_remaining: number | null;
    bytes_remaining: number | null;
  }

  /** offer 参数（offer_parameters 输入） */
  export interface OfferParams {
    name: string;
    size: number;
    mtime?: number | Date | null;
    mode?: number | null;
  }

  /** 会话输出回调收到的字节类型 */
  export type Octets = number[] | Uint8Array;

  /** Validation 命名空间 */
  export interface Validation {
    /** 校验并归一化 offer 参数（补全 serial/mtime 等字段） */
    offer_parameters(params: OfferParams): FileDetails;
  }

  /** 发送端的 Transfer 对象（send_offer resolve 得到） */
  export interface Transfer {
    send(array_like: Octets): void;
    end(array_like?: Octets): Promise<unknown>;
  }

  /** 接收端的 Offer 对象（offer 事件回调参数） */
  export interface Offer {
    get_details(): FileDetails;
    accept(opts?: {
      on_input?:
        "spool_uint8array" | "spool_array" | ((payload: Octets) => void);
      offset?: number;
    }): Promise<unknown>;
    skip(...args: unknown[]): unknown;
  }

  /** ZMODEM 帧头对象（_next_header_handler 处理器收到的参数） */
  export interface ZmodemHeader {
    get_offset(): number;
  }

  /** 事件驱动接口（Session.Send / Receive 共有） */
  export interface ZmodemSession {
    set_sender(sender_func: (octets: Octets) => void): this;
    consume(octets: Octets): void;
    on(eventName: "offer", cb: (xfer: Offer) => void): void;
    on(eventName: "session_end", cb: () => void): void;
    has_ended(): boolean;
    aborted(): boolean;
    abort(): void;
    /**
     * 下一帧头的处理器表（内部字段，协议态机用）。
     * RetransmitController / 下载 CRC 恢复会覆写/还原其分支。
     */
    _next_header_handler: Record<string, (hdr: ZmodemHeader) => void> | null;
    /**
     * 启动 Receive 会话的状态机：发 ZRINIT 给对端、arm ZFILE 处理器。
     * 仅 Receive 会话需要调用——parse() 返回的 Receive 对象是惰性的，
     * 不调 start() 则永不发 ZRINIT、offer 事件永不触发，对端 sz 会超时中止。
     * Send 会话不需调（send_offer 内部自行驱动）。
     */
    start(): Promise<unknown>;
  }

  /** Send 会话：send_offer 返回 Transfer */
  export interface SendSession extends ZmodemSession {
    send_offer(params: FileDetails): Promise<Transfer | undefined>;
    /**
     * 发送 ZFIN 关闭握手，等对端回 ZFIN 后发 OO（Over and Out）。
     * resolve 时 session_end 已触发、_sent_OO 已置位。
     * 不调用本方法，对端 rz/sz 会等不到 ZFIN，超时后发 CAN 中止，
     * 导致终端模式被破坏、后续命令无响应。
     */
    close(): Promise<unknown>;
    /** 是否已发过 ZDATA 头（内部字段）。复位为 false 可让下次 send 重新发 ZDATA */
    _sent_ZDATA?: boolean;
    /** 当前文件发送偏移（内部字段，ZDATA 头携带）。可按对端 ZRPOS 要求复位 */
    _file_offset?: number;
  }

  /**
   * Receive 会话的内部状态接口（下载 CRC 恢复用，对应 zsession.js 的 Receive 类）。
   * 子包 CRC 校验失败时 zmodem.js 直接抛 Zmodem.Error("crc") 且不主动发 ZRPOS，
   * 桥接层在 consume 抛错后按 _file_offset 主动发 ZRPOS 请求对端 sz 续传，
   * 并还原 accept 阶段保存的 ZDATA 处理器以重新同步协议态机。
   */
  export interface ReceiveSession extends ZmodemSession {
    /** 当前文件接收偏移（内部字段）：已成功接收的字节数，ZRPOS 请求续传的起点 */
    _file_offset: number;
    /** 输入缓冲区（内部字段）：恢复时清空，丢弃被污染的字节 */
    _input_buffer: number[];
    /** 数据子包处理器（内部字段）：接收态下指向 _consume_ZDATA_data */
    _next_subpacket_handler: ((subpacket: unknown) => void) | null;
    /** 是否已接受当前 offer（内部字段） */
    _accepted_offer: boolean;
    /** 当前 ZDATA 头 offset 是否与本地对齐（内部字段） */
    _offset_ok: boolean;
    /** 发送指定名称的帧头（内部方法，ZRPOS 恢复用） */
    _send_header(name: string, value?: number): void;
    /** 处理 ZDATA 头（校验 offset 对齐，内部方法） */
    _consume_ZDATA(hdr: ZmodemHeader): void;
    /** 处理 ZDATA 数据子包（内部方法，累加 _file_offset、派发 on_input） */
    _consume_ZDATA_data(subpacket: unknown): void;
    /** 处理 ZEOF 头（校验 offset、触发 file_end，内部方法） */
    _consume_ZEOF(hdr: ZmodemHeader): void;
    /** 进入"文件之间"态：arm 下一个 ZFILE/ZFIN 的处理器（内部方法） */
    _make_promise_for_between_files(): Promise<unknown>;
    /** 发送 ZRINIT 给对端（内部方法，文件结束后握手） */
    _send_ZRINIT(): void;
  }

  /** Session 命名空间（含 Send/Receive 子类 + parse 静态方法） */
  export interface SessionNS {
    Send: new (hdr?: unknown) => SendSession;
    Receive: new () => ReceiveSession;
    parse(octets: number[]): ZmodemSession | null;
  }

  /** zmodem.js 默认导出（运行时对象） */
  const Zmodem: {
    Session: SessionNS;
    Validation: Validation;
    Error: ErrorConstructor & {
      new (type: string, ...args: unknown[]): Error & { type: string };
    };
    DEBUG: boolean;
  };

  export default Zmodem;
}
