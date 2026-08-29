/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : serial.ts
 * Author     : sumu
 * Date       : 2026/05/28
 * Version    : x.x.x
 * Description: SerialShell 串口传输层 — 串口连接与交互数据流
 *
 *   支持两种通道形态（由 config.port 前缀区分）：
 *     - 物理串口：COM3、/dev/ttyUSB0（npm serialport 库，波特率等参数生效）
 *     - TCP 串口服务：tcp://host:port（QEMU `-serial tcp:...`、串口服务器等，
 *       字节透明转发，物理层参数被忽略）
 * ======================================================
 */

import { Socket } from "net";

import type { SerialPort } from "serialport";

import { BaseShell } from "./base-shell.js";
import {
  ensureSerialNativeBindings,
  serialBindingsMissingMessage,
} from "../shared/native-bootstrap.js";

/** @brief TCP 传输的端口字段前缀（port 以此开头时走 TCP 通道而非物理串口） */
const TCP_PREFIX = "tcp://";

/** @brief TCP 连接建立超时（毫秒），防止防火墙黑洞地址导致 open 永久挂起 */
const TCP_CONNECT_TIMEOUT_MS = 5000;

/**
 * @brief 串口 Shell 连接配置
 *
 * @param port     串口设备路径（如 COM3、/dev/ttyUSB0）或 TCP 端点（tcp://host:port）
 * @param baudRate 波特率（默认 115200；TCP 通道忽略）
 * @param dataBits 数据位（5/6/7/8，默认 8；TCP 通道忽略）
 * @param stopBits 停止位（1/1.5/2，默认 1；TCP 通道忽略）
 * @param parity   校验位（none/even/odd，默认 none；TCP 通道忽略）
 * @param lineEnding 命令追加的换行符（\n, \r\n），默认 \n
 * @param loginUsername 串口登录用户名（serial_shell_login 用户登录流程使用）
 * @param loginPassword 串口登录密码（serial_shell_login 用户登录流程使用）
 * @param deviceName    设备别名（可选，用于会话注册和列表展示）
 */
export interface SerialShellConfig {
  port: string;
  baudRate?: number;
  dataBits?: 8 | 5 | 6 | 7;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd";
  /** 命令追加的换行符（\n, \r\n），默认 \n */
  lineEnding?: string;
  /** 串口登录用户名（serial_shell_login 用户登录流程使用） */
  loginUsername?: string;
  /** 串口登录密码（serial_shell_login 用户登录流程使用） */
  loginPassword?: string;
  /** 设备别名（可选，用于会话注册和列表展示） */
  deviceName?: string;
}

/**
 * @brief 解析 tcp://host:port 形式的端口字段为 TCP 端点
 *
 * 支持 IPv4/主机名（tcp://127.0.0.1:4444）与 IPv6（tcp://[::1]:4444）。
 *
 * @param port 以 tcp:// 开头的端口字段
 * @returns host 主机名/IP，tcpPort 数字端口
 * @throws 格式非法时抛错，附带期望格式说明
 */
export function parseTcpEndpoint(port: string): {
  host: string;
  tcpPort: number;
} {
  const rest = port.slice(TCP_PREFIX.length);
  // IPv6：方括号包裹地址，冒号分隔端口
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(rest);
  if (v6) {
    return { host: v6[1], tcpPort: Number(v6[2]) };
  }
  const idx = rest.lastIndexOf(":");
  if (idx <= 0 || !/^\d+$/.test(rest.slice(idx + 1))) {
    throw new Error(
      `Invalid TCP serial endpoint "${port}", expected tcp://host:port`
    );
  }
  return { host: rest.slice(0, idx), tcpPort: Number(rest.slice(idx + 1)) };
}

/**
 * @brief TCP 字节通道（net.Socket 适配）
 *
 * 把 net.Socket 适配成与 SerialPort 同构的读写面
 * （isOpen / write / drain / close / destroy / data·close·error 事件），
 * 让 SerialShell 的发送、排空、释放逻辑与物理串口共用一条路径。
 */
class TcpChannel {
  readonly #socket: Socket;
  #open = false;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("connect", () => {
      this.#open = true;
    });
    socket.on("close", () => {
      this.#open = false;
    });
    // 写错误等场景 socket 可能仍处于半开状态，主动销毁防止资源泄漏
    socket.on("error", () => {
      socket.destroy();
    });
  }

  get isOpen(): boolean {
    return this.#open;
  }

  write(payload: string | Buffer): void {
    this.#socket.write(payload);
  }

  /**
   * @brief TCP 无 OS 层 tcdrain 等价物
   *
   * write 返回即已交付内核发送缓冲，ZMODEM 中止序列等字节在 TCP 链路上
   * 视为即时送达，直接回调排空。
   */
  drain(cb: (err?: Error | null) => void): void {
    cb(null);
  }

  close(cb?: (err?: Error | null) => void): void {
    this.#socket.end(() => {
      // TCP 串口对端（QEMU/串口服务器）收到 FIN 后不会回 FIN（串口无挂断
      // 语义），本端会停在 FIN_WAIT_2 且 node 事件循环一直挂着句柄；
      // write 已全部交付（finish），主动销毁完成彻底关闭
      this.#socket.destroy();
      cb?.(null);
    });
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

/**
 * @brief 串口/TCP 交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过串口（或 tcp:// 端点）与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */

export class SerialShell extends BaseShell {
  /** @brief 底层通道：SerialPort（物理串口）或 TcpChannel（tcp:// 端点），未打开时为 null */
  #channel: SerialPort | TcpChannel | null = null;
  #config: SerialShellConfig;
  /** @brief 二进制旁路接收回调，默认 null（未启用时 data 监听仅走文本态路径） */
  #rawReceiver: ((b: Buffer) => void) | null = null;

  /** @brief SSH/Serial 通道的 banner 采集等待时长 */
  protected bannerWaitMs = 500;

  /**
   * @brief 写入时的换行符
   *
   * 覆盖基类默认值 "\n"，使用 config.lineEnding（默认仍为 "\n"）。
   */
  protected get lineEnding(): string {
    return this.#config.lineEnding ?? "\n";
  }

  /**
   * @brief 构造函数
   * @param config 串口连接配置
   */
  constructor(config: SerialShellConfig) {
    super();
    this.#config = config;
  }

  /** @brief 获取当前串口设备路径（或 tcp:// 端点字符串） */
  getPort(): string {
    return this.#config.port;
  }

  /**
   * @brief 人可读连接描述（会话注册 connectionInfo 用）
   *
   * TCP 端点无波特率概念，仅返回端点本身；物理串口返回 "port @ baud"。
   */
  getConnectionInfo(): string {
    if (this.#config.port.startsWith(TCP_PREFIX)) {
      return this.#config.port;
    }
    return `${this.#config.port} @ ${this.#config.baudRate ?? 115200}`;
  }

  /** @brief 获取设备别名，未配置时返回 "(unknown)" */
  getDeviceName(): string {
    return this.#config.deviceName ?? "(unknown)";
  }

  /**
   * @brief 向通道发送原始数据（不追加换行、不碰文本态缓冲）
   *
   * 既是基类模板方法 write() 的发送子步骤（payload 为已拼换行的 string），
   * 也供 ZMODEM 等二进制协议直接写字节（payload 为 Buffer）。
   * SerialPort.write 与 Socket.write 均直接接受 string | Buffer，两种形态共用一条出口。
   *
   * 注：相对基类的 protected 抽象方法，此处提为 public，
   * 让 zmodem 层能直接发送 ZMODEM 帧，无需另造 public 别名。
   *
   * @param payload 已拼换行的文本，或原始字节 Buffer
   * @throws 通道未打开时抛出 "Serial not open. Call open() first."
   */
  rawWrite(payload: string | Buffer): void {
    if (!this.#channel || !this.#channel.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    this.#channel.write(payload);
  }

  /**
   * @brief 等待通道发送缓冲区排空（OS 层 drain）
   *
   * 与基类 drain()（排空文本态 OutputBuffer，返回 string）不同，本方法操作
   * 底层通道的 OS 发送缓冲。serialport.write() 是异步的：字节先进 OS
   * 发送缓冲，未必立即上线。ZMODEM 中止序列（CAN×5+BS×5）必须在设备还活着
   * 时尽快送达，否则设备端 rz/sz 卡死、shell 无响应。本方法确保字节真正发出。
   * TCP 通道无 tcdrain 语义，由 TcpChannel.drain 直接回调。
   *
   * @return Promise，resolve 表示发送缓冲已排空（或通道已关/不支持 drain）
   */
  drainPort(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#channel || !this.#channel.isOpen) {
        resolve();
        return;
      }
      this.#channel.drain((err) => {
        // drain 失败不阻断中止流程（finally 里调用，不应抛错）
        if (err) {
          /* 忽略 drain 错误 */
        }
        resolve();
      });
    });
  }

  /**
   * @brief 挂载 / 卸载原始字节接收回调
   *
   * 挂载后（cb 非空），通道 data 事件改为"双写"：
   *   - 原始 Buffer 喂给 cb（ZMODEM 协议层消费）
   *   - 仍按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
   * 卸载（cb=null 或调用返回的卸载函数）后恢复纯文本态。
   *
   * @param cb 字节接收回调；传 null 卸载
   * @returns 卸载函数，调用后移除回调
   */
  attachRawReceiver(cb: ((b: Buffer) => void) | null): () => void {
    this.#rawReceiver = cb;
    return () => {
      if (this.#rawReceiver === cb) this.#rawReceiver = null;
    };
  }

  /**
   * @brief 打开通道连接，注册数据监听
   *
   * 模板方法 acquire：按 config.port 前缀选择物理串口或 TCP 通道，
   * 两个分支各自建立连接并注册 data/close/error 监听。
   * 不负责 banner 采集（由基类 open 统一处理）。
   */
  protected async acquire(): Promise<void> {
    if (this.#config.port.startsWith(TCP_PREFIX)) {
      await this.#acquireTcp();
    } else {
      await this.#acquireSerialPort();
    }
  }

  /**
   * @brief data 事件处理：双写策略
   *   - #rawReceiver 非空时，原始 Buffer 喂给二进制旁路（ZMODEM 等协议消费）
   *   - 始终按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
   * #rawReceiver 默认 null，此时只走 appendData 路径
   */
  #onChannelData(data: Buffer): void {
    if (this.#rawReceiver) this.#rawReceiver(data);
    this.appendData(data.toString());
  }

  /**
   * @brief close/error 事件处理：清空句柄防止野指针
   *
   * 物理串口被拔出、TCP 对端断连或通道出错时触发。
   */
  #onChannelClosed(): void {
    this.#channel = null;
  }

  /**
   * @brief 建立物理串口通道
   *
   * 懒加载 serialport：先确认原生绑定（.node）可被 node-gyp-build 找到，
   * 再动态 import（serialport 模块顶层会立即加载原生绑定）。这样：
   *   - npm/源码模式行为不变（首次使用串口时才加载，而非进程启动时）；
   *   - 单文件 exe 模式下绑定缺失时能给出明确的中文指引
   * https://serialport.io/docs/guide-usage
   */
  async #acquireSerialPort(): Promise<void> {
    if (!ensureSerialNativeBindings()) {
      throw new Error(serialBindingsMissingMessage());
    }
    const { SerialPort } = await import("serialport");
    const serialPort = new SerialPort({
      path: this.#config.port,
      baudRate: this.#config.baudRate ?? 115200,
      dataBits: (this.#config.dataBits ?? 8) as 8 | 5 | 6 | 7,
      stopBits: (this.#config.stopBits ?? 1) as 1 | 1.5 | 2,
      parity: (this.#config.parity ?? "none") as "none" | "even" | "odd",
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      serialPort.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this.#channel = serialPort;
    // 监听串口数据接收事件：双写策略
    //   - #rawReceiver 非空时，原始 Buffer 喂给二进制旁路（ZMODEM 等协议消费）
    //   - 始终按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
    // #rawReceiver 默认 null，此时只走 appendData 路径
    serialPort.on("data", (data: Buffer) => this.#onChannelData(data));
    // 关闭事件：串口被物理断开或系统关闭时触发，清空句柄防止野指针
    serialPort.on("close", () => this.#onChannelClosed());
    // 错误事件：串口通信出错时触发，清空句柄
    serialPort.on("error", () => this.#onChannelClosed());
  }

  /**
   * @brief 建立 TCP 通道（tcp://host:port）
   *
   * 客户端主动连接外部串口服务（QEMU `-serial tcp:host:port,server,nowait`
   * 为服务端，监听等待接入）。带建连超时，防止黑洞地址挂死 open。
   */
  async #acquireTcp(): Promise<void> {
    const { host, tcpPort } = parseTcpEndpoint(this.#config.port);
    const socket = new Socket();
    const channel = new TcpChannel(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(
          new Error(
            `TCP connect timeout (${host}:${tcpPort}, ${TCP_CONNECT_TIMEOUT_MS}ms)`
          )
        );
      }, TCP_CONNECT_TIMEOUT_MS);
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.connect({ host, port: tcpPort });
    });

    this.#channel = channel;
    // 监听 TCP 通道数据接收事件：双写策略（与串口路径一致，见 #onChannelData）
    socket.on("data", (data: Buffer) => this.#onChannelData(data));
    // 关闭事件：TCP 对端断连或系统关闭时触发，清空句柄防止野指针
    socket.on("close", () => this.#onChannelClosed());
    // 错误事件：通道通信出错时触发，清空句柄
    socket.on("error", () => this.#onChannelClosed());
  }

  /**
   * @brief 发送原始数据到通道（不追加换行符）
   *
   * 调用继承的 write(data, clear, false)，等价于不追加换行。
   * 用于发送控制字符等场景，如 "\x15"（Ctrl+u）、"\x03"（Ctrl+C）等。
   *
   * @param data  要发送的原始字符串
   * @param clear 清空标志（同 write），默认 1
   */
  sendRaw(data: string, clear: number = 1): void {
    this.write(data, clear, false);
  }

  /**
   * @brief 关闭通道连接
   *
   * 含 2s 超时 + destroy 兜底，防止通道关闭卡住。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
    // 释放时清理二进制旁路回调，防止野指针（ZMODEM 会话结束后回调不应再触发）
    this.#rawReceiver = null;
    if (this.#channel) {
      const channel = this.#channel;
      this.#channel = null;
      await new Promise<void>((resolve) => {
        if (!channel.isOpen) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          try {
            channel.destroy();
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        channel.close((err) => {
          clearTimeout(timeout);
          if (err) console.error("Serial close error:", err.message);
          resolve();
        });
      });
    }
  }
}
