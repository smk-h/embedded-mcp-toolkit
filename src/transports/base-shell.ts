/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : base-shell.ts
 * Author     : sumu
 * Date       : 2026/07/13
 * Version    : 1.0.0
 * Description: 传输层抽象基类（模板方法模式）
 *
 *   统一四个传输类（SSHShell / SerialShell / AdbShell / PowerShellShell）的
 *   公共逻辑：缓冲区管理、文件日志挂载、banner 采集、方法实现。
 *
 *   子类只需实现三个差异化的受保护方法：
 *     - acquire()   : 建立连接、注册 data 监听（监听内调 appendData）
 *     - rawWrite()  : 发送原始字节（已含换行处理，子类只管发送与"是否已打开"校验）
 *     - release()   : 关闭连接/进程，释放通道资源
 *
 *   模板方法 open/write/read/drain/close 由基类统一实现，子类不可覆盖。
 *   #output 设为私有，子类通过 appendData() 间接写入数据监听，
 *   防止绕过 OutputBuffer 的溢出策略。
 * ======================================================
 */

import { OutputBuffer } from "./output-buffer.js";
import { FileLogger } from "../shared/file-logger.js";
import type { InteractiveShell } from "./interactive-shell.js";

/**
 * @brief 传输层抽象基类
 *
 * 通过模板方法模式统一四个传输类的公共逻辑。
 * 持有 OutputBuffer（缓冲区）和 FileLogger（文件日志），
 * 子类继承后只需实现三个差异化的抽象方法。
 */
export abstract class BaseShell implements InteractiveShell {
  /** @brief 输出缓冲区，私有防止子类绕过溢出策略 */
  readonly #output = new OutputBuffer();

  /** @brief 文件日志记录器，tools 层通过 enableFromEnv 控制启停 */
  readonly fileLogger = new FileLogger();

  // —— 子类提供的配置项 ——

  /**
   * @brief banner 采集等待时长（毫秒）
   *
   * 各通道启动后等待设备返回初始 banner 的时长：
   *   - SSH / Serial : 500ms
   *   - ADB / PowerShell : 800ms
   *
   * 子类必须显式声明此值，避免被误统一。
   */
  protected abstract bannerWaitMs: number;

  /**
   * @brief 写入时的换行符
   *
   * 默认为 "\n"，SerialShell 覆盖为 config.lineEnding ?? "\n"。
   *
   * @returns 换行符字符串
   */
  protected get lineEnding(): string {
    return "\n";
  }

  // —— 模板方法（基类实现，final 语义） ——

  /**
   * @brief 打开连接并启动交互式 shell
   *
   * 模板方法流程：
   *   1. 调用子类 acquire() 建立连接、注册数据监听
   *   2. 开启输出采集
   *   3. 等待 bannerWaitMs 毫秒，收集初始输出
   *   4. 读取并返回 banner
   *
   * @returns shell 启动时的初始输出（banner / prompt）
   */
  async open(): Promise<string> {
    await this.acquire();
    this.#output.startCollecting();
    await new Promise((r) => setTimeout(r, this.bannerWaitMs));
    return this.#output.read(1);
  }

  /**
   * @brief 向 shell 发送数据
   *
   * 统一处理缓冲区准备与换行拼接，发送动作委托给子类 rawWrite。
   * 注意：本方法不检查 shell 是否已打开——该检查由子类 rawWrite 负责，
   * 以保持各通道现有的异常抛出行为（如 "Shell not open. Call open() first."）。
   *
   * @param data              要发送的数据
   * @param clear             清空标志（1=清空后收集，0=追加收集）
   * @param appendLineEnding  是否追加换行符（false 时发送原始数据）
   */
  write(
    data: string,
    clear: number = 1,
    appendLineEnding: boolean = true
  ): void {
    this.#output.prepareWrite(clear);
    const payload = appendLineEnding ? `${data}${this.lineEnding}` : data;
    this.rawWrite(payload);
  }

  /**
   * @brief 读取缓冲区中的输出数据
   *
   * @param clear 清空标志（1=读取后清空并停止收集，0=保留缓冲区）
   * @returns 缓冲区中的文本内容
   */
  read(clear: number = 1): string {
    return this.#output.read(clear);
  }

  /**
   * @brief 排空缓冲区但不停止数据收集
   *
   * 返回当前缓冲区内容并清空，保持 collecting 状态不变。
   * 用于长时间命令执行期间持续接收输出数据。
   *
   * @returns 缓冲区中的文本内容
   */
  drain(): string {
    return this.#output.drain();
  }

  /**
   * @brief 关闭连接并释放所有资源
   *
   * 模板方法流程：
   *   1. 关闭文件日志（未启用时 disable 无副作用）
   *   2. 调用子类 release() 关闭连接/进程
   *   3. 重置输出缓冲区
   *
   * 释放顺序与重构前 SSH/Serial 的 close 一致。
   */
  async close(): Promise<void> {
    this.fileLogger.disable();
    await this.release();
    this.#output.reset();
  }

  // —— 子类必须实现的三个差异点 ——

  /**
   * @brief 建立连接并注册数据监听
   *
   * 子类在此完成通道特有的连接建立（SSH 握手 / 串口打开 / spawn 子进程），
   * 并注册 data 监听回调，回调内调用 this.appendData() 写入数据。
   * 不负责 banner 采集（由基类 open 统一处理）。
   */
  protected abstract acquire(): Promise<void>;

  /**
   * @brief 发送原始字节
   *
   * payload 已含换行处理，子类只负责校验"是否已打开"并写入通道。
   * 校验失败时抛出与各通道现状一致的错误。
   *
   * @param payload 已拼接换行的完整发送内容
   */
  protected abstract rawWrite(payload: string): void;

  /**
   * @brief 关闭连接/进程，释放通道资源
   *
   * 子类只负责释放通道特有资源（SSH 的 sftp/stream/client、
   * Serial 的 port、ADB/PS 的子进程）。不负责 fileLogger 和 output
   * （由基类 close 统一处理）。
   */
  protected abstract release(): Promise<void>;

  // —— 供子类 data 监听调用的工具方法 ——

  /**
   * @brief 将收到的文本追加到缓冲区并写入文件日志
   *
   * 供子类的 data 监听回调调用，语义等价于：
   *   this.#output.append(text); this.fileLogger.write(text);
   * 当 fileLogger 未启用时，write() 无副作用（见 FileLogger.write 实现）。
   *
   * @param text 接收到的原始数据文本
   */
  protected appendData(text: string): void {
    this.#output.append(text);
    this.fileLogger.write(text);
  }
}
