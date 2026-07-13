/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : adb.ts
 * Author     : opencode
 * Date       : 2026/05/31
 * Version    : 1.0.0
 * Description: ADB Shell 交互式会话管理器
 *
 *   通过 child_process.spawn 启动持久化的 adb shell 进程，
 *   提供 open / write / read / close 四个核心方法。
 *
 *   与 PowerShellShell / SerialShell / SSHShell 保持相同的接口模式。
 *
 * ADB 原理简述：
 *   adb 由三部分协作完成通信，对上层调用者透明：
 *
 *     ┌────────────┐  socket    ┌────────────┐  USB/TCP  ┌──────┐
 *     │ adb client │ ────────→  │ adb server │ ────────→ │ adbd │
 *     │ (spawn)    │ tcp:5037   │ (后台常驻)  │           │(设备) │
 *     └────────────┘            └────────────┘           └──────┘
 *
 *   - adb client: 本模块 spawn 的进程，负责发送命令到 server
 *   - adb server:  PC 端 tcp:5037 后台守护，管理设备发现与路由
 *   - adbd:       设备端守护进程，接收命令后在设备上 fork shell 执行
 *
 *   上层只需调用 spawn("adb", ["shell"])，传输层由 adb server/adbd 自动协商。
 * ======================================================
 */
import { execSync, spawn, type ChildProcess } from "child_process";

import { BaseShell } from "./base-shell.js";
import { logger } from "../shared/logger.js";

// ── 配置 ────────────────────────────────────────────────────

/**
 * @brief ADB Shell 会话配置
 *
 * @param serialNo   ADB 设备序列号（可选，默认使用唯一连接的设备）
 * @param deviceName 设备别名或原始传入的标识（可选，用于会话列表展示）
 */
export interface AdbShellConfig {
  serialNo?: string;
  deviceName?: string;
}

// ── AdbShell 类 ────────────────────────────────────────────

/**
 * @brief ADB Shell 交互式会话管理器
 *
 * 通过 child_process.spawn 启动持久化的 adb shell 进程，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */
export class AdbShell extends BaseShell {
  #process: ChildProcess | null = null;
  #config: AdbShellConfig;

  /** @brief ADB/PowerShell 通道的 banner 采集等待时长 */
  protected bannerWaitMs = 800;

  /**
   * @brief 构造函数
   * @param config ADB Shell 配置
   */
  constructor(config: AdbShellConfig = {}) {
    super();
    this.#config = config;
  }

  /**
   * @brief 获取当前连接的设备序列号
   * @returns 设备序列号字符串，未指定时返回 "(auto)"
   */
  getSerialNo(): string {
    return this.#config.serialNo ?? "(auto)";
  }

  /**
   * @brief 获取传入的设备标识（别名或原始值）
   * @returns 用户传入的 device 参数，未指定时返回 "(auto)"
   */
  getDeviceName(): string {
    return this.#config.deviceName ?? "(auto)";
  }

  /**
   * @brief 自动发现 ADB 设备（当 serialNo 未指定时调用）
   *
   * 执行 adb devices 获取设备列表：
   *   - 恰好 1 台 → 返回该设备序列号
   *   - 0 台 → 抛出错误
   *   - 多台 → 抛出错误并列出所有设备
   *
   * @returns 发现的唯一设备序列号
   * @throws 当设备数为 0 或 >1 时
   */
  #discoverDevice(): string {
    // 执行 adb devices 查询当前已连接设备
    const raw = execSync("adb devices", {
      encoding: "utf-8",
      timeout: 10000,
    });
    // 仅统计 status 为 "device"（已授权可操作）的设备
    const devices: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === "device") {
        devices.push(parts[0]);
      }
    }
    logger.info(
      `[adb] discoverDevice: raw output: ${raw
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .join("; ")}`
    );
    logger.info(
      `[adb] discoverDevice: ${devices.length} device(s) found: ${devices.length > 0 ? devices.join(", ") : "none"}`
    );
    // 0 台：无可用设备
    if (devices.length === 0) {
      const msg =
        "No ADB device found. Check USB connection and USB debugging.";
      logger.error(`[adb] discoverDevice failed: ${msg}`);
      throw new Error(msg);
    }
    // >1 台：无法自动选择，需用户指定
    if (devices.length > 1) {
      const msg = `Multiple ADB devices found: ${devices.join(", ")}. Please specify a device.`;
      logger.error(`[adb] discoverDevice failed: ${msg}`);
      throw new Error(msg);
    }
    return devices[0];
  }

  /**
   * @brief 启动持久化 adb shell 进程
   *
   * 模板方法 acquire：确定设备序列号，spawn 启动 adb shell 子进程，
   * 注册 stdout/stderr/close/error 监听。
   * 不负责 banner 采集（由基类 open 统一处理）。
   *
   * @throws 当 adb 不可用或设备不存在时启动失败
   */
  protected async acquire(): Promise<void> {
    // 阶段1: 确定目标设备序列号
    let serialNo = this.#config.serialNo;
    if (!serialNo) {
      // 未指定序列号 → 自动发现，失败时抛异常，调用方捕获后不会有进程残留
      serialNo = this.#discoverDevice();
      this.#config.serialNo = serialNo;
    }

    // 阶段2: 启动持久化 adb shell 子进程
    // spawn 是 Node.js child_process 模块的函数，用于创建长期运行的子进程
    // 与 execSync（一次性执行，阻塞等待退出）不同，spawn 返回的进程持续存活，
    // 通过管道 stdin/stdout/stderr 与父进程实时通信，适合交互式 shell 场景

    // 等价命令: adb -s <serialNo> shell
    // adb shell 不带参数时，adb 连接设备侧的 /system/bin/sh 并保持交互模式，
    // 设备侧 shell 等待 stdin 输入，不会自动退出，因此子进程可以长期存活。
    // 与之相对：adb shell ls → 等价于 sh -c "ls"，执行完立即退出（一次性）。
    const args = ["-s", serialNo, "shell"];

    // stdio: ["pipe", "pipe", "pipe"] 为 stdin/stdout/stderr 各创建一条管道
    //   [0] pipe → 通过 proc.stdin.write() 向子进程发送命令
    //   [1] pipe → 通过 proc.stdout.on("data") 读取子进程输出
    //   [2] pipe → 通过 proc.stderr.on("data") 读取子进程错误输出
    // 子进程保持运行，不随命令执行退出（持久化交互式 shell）
    const proc = spawn("adb", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#process = proc;

    // 阶段3: 注册 stdout/stderr 数据监听，写入内部缓冲区并写入文件日志
    proc.stdout?.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.appendData(data.toString());
    });
    // 子进程退出时清理引用，避免对已死进程写 stdin
    proc.on("close", () => {
      this.#process = null;
    });
    // 记录完整 adb 命令日志
    logger.info(`[adb] executing: adb -s ${serialNo} shell`);

    // 子进程启动失败时同样清理引用
    proc.on("error", () => {
      this.#process = null;
    });
  }

  /**
   * @brief 向 ADB shell 进程发送原始字节
   *
   * payload 已含换行处理，此处只校验进程是否存活并发送。
   *
   * @param payload 已拼接换行的完整发送内容
   * @throws 进程未启动或已退出时抛出 "ADB shell not open. Call open() first."
   */
  protected rawWrite(payload: string): void {
    if (!this.#process || this.#process.exitCode !== null) {
      throw new Error("ADB shell not open. Call open() first.");
    }
    this.#process.stdin!.write(payload);
  }

  /**
   * @brief 关闭 ADB shell 进程
   *
   * 发送 exit 命令并终止进程。
   * fileLogger.disable 与 output.reset 由基类 close 统一处理。
   */
  protected async release(): Promise<void> {
    if (this.#process) {
      const proc = this.#process;
      this.#process = null;
      try {
        proc.stdin?.write("exit\n");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }, 3000);
          proc.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
