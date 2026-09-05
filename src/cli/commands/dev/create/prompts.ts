/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : prompts.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: create 命令交互问答 — 六段问答、输入解析与 validate 内联
 *              校验原地重绘（plan/ch19 模块 B）
 * ======================================================
 */

import { existsSync } from "fs";
import { join } from "path";

import { cancel, isCancel, text } from "@clack/prompts";

// ============================================================
// 类型
// ============================================================

/**
 * @brief 串口连接信息问答结果
 */
export interface SerialConn {
  port: string; // 串口端口或 TCP 端点（如 COM3、/dev/ttyUSB0、tcp://host:port）
  baudRate: number; // 波特率（正整数）
}

/**
 * @brief 登录凭据问答结果
 */
export interface Credential {
  username: string; // 登录用户名
  password: string; // 登录密码（允许含 @）
}

/**
 * @brief SSH 连接信息问答结果
 */
export interface SshConn {
  host: string; // SSH 主机地址
  port: number; // SSH 端口（输入不带 @端口时默认 22）
}

// ============================================================
// 输入解析纯函数
// ============================================================

/** 端口@波特率 行解析结果：成功返回连接信息，失败返回错误描述 */
export type PortBaudResult = SerialConn | string;

/**
 * @brief 解析「端口@波特率」一行输入
 * @details 按第一个 @ 分割（端口不含 @，无歧义）；端口非空、波特率为正整数。
 * @param input 用户输入（已 trim）
 * @returns 成功返回 SerialConn，失败返回错误描述字符串
 */
export function parsePortBaud(input: string): PortBaudResult {
  const at = input.indexOf("@");
  if (at < 0) {
    return "格式应为 端口@波特率（如 COM3@115200）";
  }
  const port = input.slice(0, at).trim();
  const baudText = input.slice(at + 1).trim();
  if (!port) {
    return "端口号不能为空";
  }
  const baudRate = Number(baudText);
  if (!baudText || !Number.isInteger(baudRate) || baudRate <= 0) {
    return "波特率必须为正整数（如 115200）";
  }
  return { port, baudRate };
}

/** 用户名@密码 行解析结果：成功返回凭据，失败返回错误描述 */
export type UserPassResult = Credential | string;

/**
 * @brief 解析「用户名@密码」一行输入
 * @details 按第一个 @ 分割，用户名段与密码段均须非空；密码允许含 @。
 * @param input 用户输入（已 trim）
 * @returns 成功返回 Credential，失败返回错误描述字符串
 */
export function parseUserPass(input: string): UserPassResult {
  const at = input.indexOf("@");
  if (at < 0) {
    return "格式应为 用户名@密码（如 root@root）";
  }
  const username = input.slice(0, at).trim();
  const password = input.slice(at + 1).trim();
  if (!username) {
    return "用户名不能为空";
  }
  if (!password) {
    return "密码不能为空";
  }
  return { username, password };
}

/** IP@端口 行解析结果：成功返回连接信息，失败返回错误描述 */
export type IpPortResult = SshConn | string;

/** SSH 端口默认值：输入不带 @端口 时使用（spec F6） */
const DEFAULT_SSH_PORT = 22;

/**
 * @brief 解析「IP@端口」一行输入
 * @details 含 @端口 时端口须为正整数；不含时使用默认 22；IP 非空。
 * @param input 用户输入（已 trim）
 * @returns 成功返回 SshConn，失败返回错误描述字符串
 */
export function parseIpPort(input: string): IpPortResult {
  const at = input.indexOf("@");
  let host = input.trim();
  let port = DEFAULT_SSH_PORT;
  if (at >= 0) {
    host = input.slice(0, at).trim();
    const portText = input.slice(at + 1).trim();
    const parsedPort = Number(portText);
    if (!portText || !Number.isInteger(parsedPort) || parsedPort <= 0) {
      return "端口必须为正整数（如 22），或省略 @端口 使用默认 22";
    }
    port = parsedPort;
  }
  if (!host) {
    return "IP 地址不能为空";
  }
  return { host, port };
}

/**
 * @brief 归一 ADB 序列号为 sn_ 前缀约定
 * @details 输入已以 sn_ 开头时原样返回（避免 sn_sn_ 重复前缀），否则加 sn_ 前缀。
 * @param input 用户输入的序列号（已 trim，非空）
 * @returns 形如 sn_<序列号> 的落盘值
 */
export function normalizeSn(input: string): string {
  return input.startsWith("sn_") ? input : `sn_${input}`;
}

// ============================================================
// 交互问答循环
// ============================================================

/** 设备名合法性：仅允许字母、数字、点、下划线、连字符（spec F3） */
const DEVICE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @brief 用户取消时的统一退出
 * @details 打印取消标记后以 0 退出，保证不生成任何文件（plan/ch19 N1）。
 */
function exitOnCancel(): never {
  cancel("已取消");
  process.exit(0);
}

/**
 * @brief 校验通过后的二次解析：断言成功并返回结果
 * @details validate 回调已拦截非法输入，提交值必然可解析；此处兜底防御，
 *          理论上不可达。
 */
function unwrapPortBaud(input: string): SerialConn {
  const result = parsePortBaud(input);
  if (typeof result === "string") {
    throw new Error(result);
  }
  return result;
}

/** @brief 同 unwrapPortBaud，用于 SSH 的「IP@端口」 */
function unwrapIpPort(input: string): SshConn {
  const result = parseIpPort(input);
  if (typeof result === "string") {
    throw new Error(result);
  }
  return result;
}

/** @brief 同 unwrapPortBaud，用于「用户名@密码」 */
function unwrapUserPass(input: string): Credential {
  const result = parseUserPass(input);
  if (typeof result === "string") {
    throw new Error(result);
  }
  return result;
}

/**
 * @brief 交互输入设备名
 * @details 经 validate 内联校验：仅允许字母/数字/点/下划线/连字符；同名设备
 *          文件已存在时提示冲突并原地重绘要求重新输入，绝不覆盖（spec F3）。
 * @param devicesDir 设备目录，用于同名冲突检查
 * @returns 合法且无冲突的设备名
 */
export async function askDeviceName(devicesDir: string): Promise<string> {
  const raw = await text({
    message: "设备名（用作配置文件名）",
    placeholder: "如 myboard",
    validate: (value) => {
      const name = (value ?? "").trim();
      if (!DEVICE_NAME_RE.test(name)) {
        return "设备名仅允许字母、数字、点、下划线、连字符";
      }
      if (existsSync(join(devicesDir, `${name}.yaml`))) {
        return `设备 "${name}" 已存在，请换一个名字`;
      }
    },
  });
  if (isCancel(raw)) {
    exitOnCancel();
  }
  return raw.trim();
}

/**
 * @brief 交互输入串口连接信息
 * @details 一次输入「端口@波特率」；直接回车返回 null 表示禁用串口；
 *          格式不合法经 validate 内联提示并原地重绘（spec F4）。
 * @returns 串口连接信息；未启用返回 null
 */
export async function askSerialConnection(): Promise<SerialConn | null> {
  const raw = await text({
    message: "串口连接 端口@波特率（直接回车禁用串口）",
    placeholder: "如 COM3@115200",
    validate: (value) => {
      const input = (value ?? "").trim();
      if (!input) {
        return; // 空输入合法：禁用串口
      }
      const result = parsePortBaud(input);
      if (typeof result === "string") {
        return result;
      }
    },
  });
  if (isCancel(raw)) {
    exitOnCancel();
  }
  const input = raw.trim();
  return input ? unwrapPortBaud(input) : null;
}

/**
 * @brief 交互输入 SSH 连接信息
 * @details 一次输入「IP@端口」，不带 @端口 时默认 22；直接回车返回 null 表示
 *          禁用 SSH；格式不合法经 validate 内联提示并原地重绘（spec F6）。
 * @returns SSH 连接信息；未启用返回 null
 */
export async function askSshConnection(): Promise<SshConn | null> {
  const raw = await text({
    message: "SSH 连接 IP@端口（直接回车禁用 SSH）",
    placeholder: "如 192.168.1.10@22（不带 @端口默认 22）",
    validate: (value) => {
      const input = (value ?? "").trim();
      if (!input) {
        return; // 空输入合法：禁用 SSH
      }
      const result = parseIpPort(input);
      if (typeof result === "string") {
        return result;
      }
    },
  });
  if (isCancel(raw)) {
    exitOnCancel();
  }
  const input = raw.trim();
  return input ? unwrapIpPort(input) : null;
}

/**
 * @brief 交互输入登录凭据（用户名@密码）
 * @details required=true（SSH 凭据，spec F7）时空输入经 validate 内联提示；
 *          required=false（串口凭据，spec F5）时空输入返回 null，
 *          由调用方落盘为 none。格式不合法经 validate 内联提示并原地重绘。
 * @param message 提示文本
 * @param required 凭据是否必填
 * @returns 登录凭据；允许为空且用户直接回车时返回 null
 */
export async function askCredential(
  message: string,
  required: boolean
): Promise<Credential | null> {
  const raw = await text({
    message,
    placeholder: required
      ? "如 root@root（必填）"
      : "如 root@root（直接回车填 none）",
    validate: (value) => {
      const input = (value ?? "").trim();
      if (!input) {
        if (!required) {
          return; // 空输入合法：落盘 none
        }
        return "该通道已启用，登录用户名和密码为必填项";
      }
      const result = parseUserPass(input);
      if (typeof result === "string") {
        return result;
      }
    },
  });
  if (isCancel(raw)) {
    exitOnCancel();
  }
  const input = raw.trim();
  return input ? unwrapUserPass(input) : null;
}

/**
 * @brief 交互输入 ADB 序列号
 * @details 直接回车返回 sn_none（spec F8 的禁用约定值）；非空输入经
 *          normalizeSn 归一为 sn_ 前缀格式。
 * @returns 形如 sn_<序列号> 或 sn_none 的落盘值
 */
export async function askAdbSerialNo(): Promise<string> {
  const raw = await text({
    message: "ADB 序列号（直接回车填 sn_none）",
    placeholder: "如 123456",
  });
  if (isCancel(raw)) {
    exitOnCancel();
  }
  const input = raw.trim();
  return input ? normalizeSn(input) : "sn_none";
}
