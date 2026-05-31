/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exec.ts
 * Author     : opencode
 * Date       : 2026/05/31
 * Version    : 1.0.0
 * Description: ADB 一次性命令执行与设备扫描 MCP 工具
 *
 *   提供 execAdb 通用函数执行非交互式 ADB 命令，
 *   以及 adb_device_list / adb_exec 两个 MCP 工具。
 *
 *   与 shell.ts 互补：shell.ts 管理持久化交互式会话，
 *   exec.ts 负责一次性命令执行。
 * ======================================================
 */
import { execSync } from "child_process";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { resolveAdbSerial, resolveDeviceName } from "../../../infra/config.js";

// ── 通用 ADB 执行函数 ──────────────────────────────────────

/** ADB 命令默认超时（毫秒） */
const ADB_EXEC_TIMEOUT = 15000;

/**
 * @brief 执行一次性 ADB 命令并返回 stdout
 *
 * 直接调用 adb 可执行文件，不依赖 PowerShell 或持久化 shell 会话。
 * 适用于 adb devices、adb install、adb push 等一次性操作。
 *
 * @param args     ADB 命令参数数组（不含 "adb" 前缀），如 ["-s", "serialNo", "shell", "ls"]
 * @param timeout  可选的自定义超时（默认 ADB_EXEC_TIMEOUT）
 * @returns stdout 字符串，出错时返回空字符串并记录日志
 * @example
 *   execAdb(["devices"])
 *   execAdb(["-s", "43b1e5fe7b186666", "shell", "getprop ro.product.model"])
 */
export function execAdb(args: string[], timeout?: number): string {
  try {
    return execSync(`adb ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: timeout ?? ADB_EXEC_TIMEOUT,
      stdio: ["pipe", "pipe", "ignore"],
    }) as string;
  } catch (err) {
    logger.error(`[adb] execAdb failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// ── 接口 ──

/**
 * @brief ADB 设备信息
 */
interface AdbDeviceInfo {
  serialNo: string;
  status: string;
}

// ── adb_device_list 工具 ───────────────────────────────────

/**
 * @brief adb_device_list 工具配置
 *
 * 列出当前所有通过 USB 或 TCP/IP 连接的 ADB 设备及其状态。
 */
export const adbDeviceListConfig = {
  description:
    "List all connected ADB devices and their status (device, offline, unauthorized, etc.)",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

/**
 * @brief 解析 adb devices 输出为设备信息数组
 */
function parseAdbDevices(raw: string): AdbDeviceInfo[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const devices: AdbDeviceInfo[] = [];
  for (const line of lines) {
    if (line === "List of devices attached") {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      devices.push({ serialNo: parts[0], status: parts[1] });
    }
  }
  return devices;
}

/**
 * @brief adb_device_list 处理函数
 */
export async function adbDeviceListHandler() {
  logger.info("[adb_device_list] listing ADB devices");

  const raw = execAdb(["devices"]);
  const devices = parseAdbDevices(raw);

  if (devices.length === 0) {
    return {
      content: [
        text(
          "No ADB devices found.\n" +
          "(Check USB connection, enable USB debugging, and ensure adb is in PATH)"
        ),
      ],
    };
  }

  const lines: string[] = [
    `Found ${devices.length} device(s):`,
    "",
  ];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    lines.push(`  [${i + 1}] SerialNo: ${d.serialNo}`);
    lines.push(`  Status: ${d.status}`);
    if (i < devices.length - 1) {
      lines.push("");
    }
  }

  return { content: [text(lines.join("\n"))] };
}

// ── adb_exec 工具 ──────────────────────────────────────────

/**
 * @brief adb_exec 工具配置
 *
 * 执行一次性 ADB 命令，不建立持久会话。
 * 适用于 adb install、adb push、adb shell getprop 等场景。
 *
 * @param device  目标设备（可选，默认使用唯一连接的设备）
 * @param command ADB 命令及参数（不含 "adb" 前缀），如 "devices"、"shell ls /sdcard"
 */
export const adbExecConfig = {
  description:
    "Execute a one-shot ADB command without a persistent session. " +
    "Use for adb devices, install, push, or short shell commands.",
  inputSchema: fromJsonSchema<{
    command: string;
    device?: string;
  }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description:
          "Target device serial number (optional, defaults to the unique connected device)",
      },
      command: {
        type: "string",
        description:
          "ADB command and arguments (without 'adb' prefix), e.g. 'devices', 'shell ls /sdcard'",
      },
    },
    required: ["command"],
  }),
};

/**
 * @brief adb_exec 处理函数
 */
export async function adbExecHandler(args: {
  command: string;
  device?: string;
}) {
  const deviceName = args.device ?? resolveDeviceName();
  const serialNo = resolveAdbSerial(deviceName);
  const cmdArgs: string[] = [];
  if (serialNo) {
    cmdArgs.push("-s", serialNo);
  }
  cmdArgs.push(...args.command.split(/\s+/));

  logger.info(`[adb_exec] command=${args.command} device=${deviceName} serialNo=${serialNo ?? "(auto)"}`);

  const output = execAdb(cmdArgs);

  return { content: [text(output || "(no output)")] };
}
