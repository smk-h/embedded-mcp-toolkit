/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : interactive-shell.ts
 * Author     : sumu
 * Date       : 2026/07/13
 * Version    : 1.0.0
 * Description: 交互式 Shell 的统一读写接口
 *
 *   抽象出 open / write / read / drain / close 五个方法，
 *   供 interactiveLoop（demo 终端循环）与 BaseShell（传输层基类）共用。
 *
 *   四个传输类（SSHShell / SerialShell / AdbShell / PowerShellShell）
 *   通过继承 BaseShell 间接实现本接口，形成编译期契约约束。
 * ======================================================
 */

/**
 * @brief 交互式 Shell 的读写接口
 *
 * 定义所有传输类对外暴露的统一方法签名。
 * write 的第三参 appendLineEnding 控制是否追加换行符，
 * false 时发送原始数据（如 "\x03" 即 Ctrl+C）。
 */
export interface InteractiveShell {
  /**
   * @brief 打开连接并启动交互式 shell
   * @returns shell 启动时的初始输出（banner / prompt）
   */
  open(): Promise<string>;

  /**
   * @brief 向 shell 发送数据
   * @param data              要发送的数据
   * @param clear             清空标志（1=清空后收集，0=追加收集）
   * @param appendLineEnding  是否追加换行符（false 时发送原始数据）
   */
  write(
    data: string,
    clear?: number,
    appendLineEnding?: boolean
  ): void;

  /**
   * @brief 读取缓冲区中的输出数据
   * @param clear 清空标志（1=读取后清空，0=保留缓冲区）
   * @returns 缓冲区中的文本内容
   */
  read(clear?: number): string;

  /**
   * @brief 排空缓冲区但不停止数据收集
   * @returns 缓冲区中的文本内容
   */
  drain(): string;

  /**
   * @brief 关闭连接并释放所有资源
   */
  close(): Promise<void>;
}
