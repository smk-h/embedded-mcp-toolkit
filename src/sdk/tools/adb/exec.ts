/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exec.ts
 * Author     : sumu
 * Date       : 2026/05/31
 * Version    : x.x.x
 * Description: ADB 一次性命令执行与设备扫描 SDK 工具
 *
 *   提供 execAdb 通用函数执行非交互式 ADB 命令，
 *   以及 adb_device_list / adb_exec 两个工具（协议无关，
 *   MCP 注册见 src/mcp/tools.ts）。
 *
 *   与 shell.ts 互补：shell.ts 管理持久化交互式会话，
 *   exec.ts 负责一次性命令执行。
 * ======================================================
 */
import { spawnSync } from "child_process";

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";
import { resolveAdbSerial, resolveDeviceName } from "../../../shared/config.js";
import { resolveAdbDeviceName } from "./device-resolver.js";

// ── 通用 ADB 执行函数 ──────────────────────────────────────

/** ADB 命令默认超时（毫秒） */
const ADB_EXEC_TIMEOUT = 15000;

/**
 * @brief 将命令字符串按 shell 规则分词（识别引号，剥除包裹引号）
 *
 * 替代 command.split(/\s+/)。split(/\s+/) 不识别引号，会把带引号参数首尾的
 * 字面双引号一并塞进 token，导致 spawnSync 把 '"X:\\...\\foo.so"' 作为单个
 * argv 传给 adb —— adb 去找一个文件名带引号的文件，在 Windows 上报：
 *   cannot stat '"X:\\...\\foo.so"': No such file or directory
 *
 * 规则（针对 ADB 场景裁剪，刻意不把反斜杠当转义符，以保留 Windows 路径）：
 *   - 双引号/单引号成对包裹一段，作为一个 token，包裹引号被剥除；
 *   - 引号外的空白为分隔符；连续空白、首尾空白被忽略；
 *   - 反斜杠一律作为字面字符保留（Windows 路径如 X:\workspace 不被破坏）；
 *   - 未闭合的引号：从该引号到字符串末尾整体作为一个 token 并保留该开引号，
 *     不静默吞字符，便于从日志发现输入问题。
 *
 * @example
 *   tokenizeCommand('push "X:\\workspace\\foo.so" /system/lib64/')
 *     → ["push", "X:\\workspace\\foo.so", "/system/lib64/"]
 *   tokenizeCommand("shell ls 'my dir'") → ["shell", "ls", "my dir"]
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let hasToken = false; // current 是否已绑定到某个 token（区分连续空白与未开始）

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null; // 闭合：引号字符本身不入 token
      } else {
        current += ch; // 引号内一切照原样（含空格、反斜杠）
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasToken = true; // 即使引号内为空，也算开始了一个 token（支持空串参数）
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (inQuote) {
    // 未闭合：补回开引号，避免静默丢失字符
    tokens.push(inQuote + current);
  } else if (hasToken) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * @brief 执行一次性 ADB 命令并返回合并后的输出
 *
 * 直接调用 adb 可执行文件，不依赖 PowerShell 或持久化 shell 会话。
 * 适用于 adb devices、adb install、adb push 等一次性操作。
 *
 * 注意：adb 的 push/pull/install 等子命令会把进度信息和结果摘要
 * （如 "1 file pushed, 0 skipped."）写入 stderr 而非 stdout，
 * 因此这里同时捕获 stdout 和 stderr 并合并返回。
 *
 * 使用 spawnSync 而非 execSync：成功时也能拿到 stderr，且以数组形式
 * 传参，避免 args.join(" ") 的 shell 拼接与转义隐患。
 *
 * @param args     ADB 命令参数数组（不含 "adb" 前缀），如 ["-s", "serialNo", "shell", "ls"]
 * @param timeout  可选的自定义超时（默认 ADB_EXEC_TIMEOUT）
 * @returns 合并后的输出字符串；失败时返回空字符串并记录日志
 * @example
 *   execAdb(["devices"])
 *   execAdb(["-s", "43b1e5fe7b186666", "shell", "getprop ro.product.model"])
 */
export function execAdb(args: string[], timeout?: number): string {
  const result = spawnSync("adb", args, {
    encoding: "utf-8",
    timeout: timeout ?? ADB_EXEC_TIMEOUT,
    windowsHide: true,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.status !== 0) {
    // 进程级异常（命令不存在、被信号杀死等）：status 为 null
    const reason =
      result.status === null
        ? (result.error?.message ?? "process error (no exit code)")
        : `exit code ${result.status}`;
    logger.error(
      `[adb] execAdb failed: adb ${args.join(" ")} → ${reason}` +
        (stderr ? `\n[adb] stderr: ${stderr}` : "")
    );
    return "";
  }

  // 成功时合并 stdout 与 stderr：adb push/pull/install 的结果摘要
  // 写在 stderr，stdout 可能为空。
  return [stdout, stderr].filter(Boolean).join("\n").trim();
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
export const adbDeviceListConfig: SdkToolConfig = {
  description:
    "List all connected ADB devices and their status (device, offline, unauthorized, etc.)",
  inputSchema: {
    type: "object",
    properties: {},
  },
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
 * @brief 现场扫描 adb devices，返回第一台可用设备的 serialNo
 *
 * 用于 adb_exec 在自动发现场景下拿到真实 serialNo 参与 deviceName 降级。
 * 与 transports/adb.ts 的 #discoverDevice() 不同：本函数不抛错，无设备/多设备
 * 时均返回 undefined（由调用方走降级链）。
 *
 * @returns 第一台状态为 "device" 的设备 serialNo；无可用设备返回 undefined
 */
function scanFirstAdbDeviceSerialNo(): string | undefined {
  const raw = execAdb(["devices"]);
  const devices = parseAdbDevices(raw);
  const first = devices.find((d) => d.status === "device");
  return first?.serialNo;
}

/**
 * @brief adb_device_list 处理函数
 */
export async function adbDeviceListHandler() {
  logger.info("[adb_device_list] listing ADB devices");

  const raw = execAdb(["devices"]);
  const devices = parseAdbDevices(raw);

  if (devices.length === 0) {
    return (
      "No ADB devices found.\n" +
      "(Check USB connection, enable USB debugging, and ensure adb is in PATH)"
    );
  }

  const lines: string[] = [`Found ${devices.length} device(s):`, ""];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    lines.push(`  [${i + 1}] SerialNo: ${d.serialNo}`);
    lines.push(`  Status: ${d.status}`);
    if (i < devices.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── adb_exec 工具 ──────────────────────────────────────────

/**
 * @brief adb_exec 工具配置
 *
 * 执行一次性 ADB 命令，不建立持久会话。
 * 适用于 adb install、adb push、adb shell getprop 等场景。
 *
 * @param device  目标设备别名（推荐传入，如 "board-lubancat"）。传入即直接使用 config
 *                中该设备绑定的 serialNo，不触发探测、日志目录更准确；不传时才由
 *                adb 自动发现唯一连接的设备
 * @param command ADB 命令及参数（不含 "adb" 前缀），如 "devices"、"shell ls /sdcard"
 */
export const adbExecConfig: SdkToolConfig = {
  description:
    "Execute a one-shot ADB command without a persistent session. " +
    "Use for adb devices, install, push, or short shell commands.",
  inputSchema: {
    type: "object",
    properties: {
      device: {
        type: "string",
        description:
          'Target device alias, e.g. "board-lubancat". ' +
          "PREFER passing the alias when you know the target device: " +
          "it reads the serialNo bound in config and runs the command directly without device probing, " +
          "and logging follows the alias. " +
          "Passing a raw serial number is also accepted — " +
          "it is auto-resolved back to the alias when bound. " +
          "Omit only when no specific device is intended; " +
          "the program then auto-discovers the single connected device " +
          "(errors out if 0 or >1 devices). " +
          "There is NO need to call adb_device_list first.",
      },
      command: {
        type: "string",
        description:
          "ADB command and arguments (without 'adb' prefix), e.g. 'devices', 'shell ls /sdcard'",
      },
    },
    required: ["command"],
  },
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

  let serialSource: string;
  if (args.device) {
    if (serialNo !== deviceName) {
      serialSource = `user argument → config.yaml devices.${deviceName}.adb.serialNo`;
    } else {
      serialSource = `user argument (raw serial)`;
    }
  } else if (serialNo) {
    serialSource = `config.yaml devices.${deviceName}.adb.serialNo`;
  } else {
    serialSource = `adb devices auto-discovery`;
  }

  const cmdArgs: string[] = [];
  if (serialNo) {
    cmdArgs.push("-s", serialNo);
  }
  cmdArgs.push(...tokenizeCommand(args.command));

  // 确定 finalDeviceName（仅用于日志归档与 deviceName 归位，不影响 execAdb 的 serialNo）
  // 三分支：显式传参用 args.device；config 绑定用 serialNo；自动发现现场扫一次 adb devices
  let realSerialNo: string;
  if (args.device) {
    // 显式传参：信任调用方，realSerialNo 取 config 解析出的 serialNo（若有）或 args.device 本身
    realSerialNo = serialNo ?? args.device;
  } else if (serialNo) {
    // config 绑定了 serialNo：realSerialNo 即 config 解析出的值
    realSerialNo = serialNo;
  } else {
    // 自动发现：现场扫一次 adb devices 拿真实 serialNo（无设备则用占位符走降级）
    realSerialNo = scanFirstAdbDeviceSerialNo() ?? "(auto)";
  }
  const finalDeviceName = resolveAdbDeviceName(
    args.device,
    realSerialNo,
    deviceName
  );

  logger.info(
    `[adb_exec] command=${args.command} device=${finalDeviceName} preliminary=${deviceName} serialNo=${serialNo ?? "(auto)"} source=${serialSource}`
  );

  const output = execAdb(cmdArgs);

  return output || "(no output)";
}
