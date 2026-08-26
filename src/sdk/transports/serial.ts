/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : serial.ts
 * Author     : sumu
 * Date       : 2026/05/28
 * Version    : x.x.x
 * Description: SerialShell 串口传输层 — 串口连接与交互数据流
 * ======================================================
 */

import type { SerialPort } from "serialport";

import { BaseShell } from "./base-shell.js";
import {
  ensureSerialNativeBindings,
  serialBindingsMissingMessage,
} from "../shared/native-bootstrap.js";

/**
 * @brief 串口 Shell 连接配置
 *
 * @param port     串口设备路径（如 COM3、/dev/ttyUSB0）
 * @param baudRate 波特率（默认 115200）
 * @param dataBits 数据位（5/6/7/8，默认 8）
 * @param stopBits 停止位（1/1.5/2，默认 1）
 * @param parity   校验位（none/even/odd，默认 none）
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
 * @brief 串口交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过串口与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */

export class SerialShell extends BaseShell {
  #serialPort: SerialPort | null = null;
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

  /** @brief 获取当前串口设备路径 */
  getPort(): string {
    return this.#config.port;
  }

  /** @brief 获取设备别名，未配置时返回 "(unknown)" */
  getDeviceName(): string {
    return this.#config.deviceName ?? "(unknown)";
  }

  /**
   * @brief 向串口发送原始数据（不追加换行、不碰文本态缓冲）
   *
   * 既是基类模板方法 write() 的发送子步骤（payload 为已拼换行的 string），
   * 也供 ZMODEM 等二进制协议直接写字节（payload 为 Buffer）。
   * serialport.write 本就接受 string | Buffer，两种形态共用一条出口。
   *
   * 注：相对基类的 protected 抽象方法，此处提为 public，
   * 让 zmodem 层能直接发送 ZMODEM 帧，无需另造 public 别名。
   *
   * @param payload 已拼换行的文本，或原始字节 Buffer
   * @throws 串口未打开时抛出 "Serial not open. Call open() first."
   */
  rawWrite(payload: string | Buffer): void {
    if (!this.#serialPort || !this.#serialPort.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    this.#serialPort.write(payload);
  }

  /**
   * @brief 等待串口发送缓冲区排空（OS 层 drain）
   *
   * 与基类 drain()（排空文本态 OutputBuffer，返回 string）不同，本方法操作
   * 底层 serialport 的 OS 发送缓冲。serialport.write() 是异步的：字节先进 OS
   * 发送缓冲，未必立即上线。ZMODEM 中止序列（CAN×5+BS×5）必须在设备还活着
   * 时尽快送达，否则设备端 rz/sz 卡死、shell 无响应。本方法确保字节真正发出。
   *
   * @return Promise，resolve 表示发送缓冲已排空（或串口已关/不支持 drain）
   */
  drainPort(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#serialPort || !this.#serialPort.isOpen) {
        resolve();
        return;
      }
      this.#serialPort.drain((err) => {
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
   * 挂载后（cb 非空），串口 data 事件改为"双写"：
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
   * @brief 打开串口连接，注册数据监听
   *
   * 模板方法 acquire：打开串口设备，注册 data/close/error 监听。
   * 不负责 banner 采集（由基类 open 统一处理）。
   * https://serialport.io/docs/guide-usage
   */
  protected async acquire(): Promise<void> {
    // 懒加载 serialport：先确认原生绑定（.node）可被 node-gyp-build 找到，
    // 再动态 import（serialport 模块顶层会立即加载原生绑定）。这样：
    //   - npm/源码模式行为不变（首次使用串口时才加载，而非进程启动时）；
    //   - 单文件 exe 模式下绑定缺失时能给出明确的中文指引
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

    this.#serialPort = serialPort;
    // 监听串口数据接收事件：双写策略
    //   - #rawReceiver 非空时，原始 Buffer 喂给二进制旁路（ZMODEM 等协议消费）
    //   - 始终按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
    // #rawReceiver 默认 null，此时与改动前逐字一致（只走 appendData 路径）
    serialPort.on("data", (data: Buffer) => {
      if (this.#rawReceiver) this.#rawReceiver(data);
      this.appendData(data.toString());
    });
    // 关闭事件：串口被物理断开或系统关闭时触发，清空句柄防止野指针
    serialPort.on("close", () => {
      this.#serialPort = null;
    });
    // 错误事件：串口通信出错时触发，清空句柄
    serialPort.on("error", () => {
      this.#serialPort = null;
    });
  }

  /**
   * @brief 发送原始数据到串口（不追加换行符）
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
   * @brief 关闭串口连接
   *
   * 含 2s 超时 + destroy 兜底，防止串口关闭卡住。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
    // 释放时清理二进制旁路回调，防止野指针（ZMODEM 会话结束后回调不应再触发）
    this.#rawReceiver = null;
    if (this.#serialPort) {
      const port = this.#serialPort;
      this.#serialPort = null;
      await new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          try {
            port.destroy();
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        port.close((err) => {
          clearTimeout(timeout);
          if (err) console.error("Serial close error:", err.message);
          resolve();
        });
      });
    }
  }
}
