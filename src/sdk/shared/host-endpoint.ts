/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : host-endpoint.ts
 * Author     : embedded-mcp-toolkit
 * Date       : 2026/07/30
 * Version    : 1.0.0
 * Description: MCP 宿主端点解析模块
 *
 *   从本机 OS 信息与 SSH 会话环境变量解析宿主端点（username@ip），
 *   供跨机部署场景下 AI 客户端构造 scp 命令使用。
 *   仅当 MCP 经 SSH 远程启动（存在 SSH_CONNECTION）时才产出端点；
 *   本地启动返回 local 场景，不提供端点，保持原有行为不变。
 * ======================================================
 */

import { userInfo } from "os";

// ── 类型定义 ────────────────────────────────────────────────

/**
 * @brief 启动场景标志
 * @details local     = 本地启动（无 SSH_CONNECTION）；remote-ssh = 经 ssh 远程启动
 */
type HostScenario = "local" | "remote-ssh";

/**
 * @brief 端点来源说明（用于日志与 host_info 展示）
 * @details ssh_connection = 从 SSH_CONNECTION 第 3 字段解析成功；
 *          local          = 本地启动，无需端点；
 *          unavailable    = remote-ssh 场景但解析失败（SSH_CONNECTION 格式异常）
 */
type EndpointSource = "ssh_connection" | "local" | "unavailable";

/**
 * @brief 宿主端点解析结果
 */
export interface HostEndpoint {
  scenario: HostScenario; // 启动场景：local / remote-ssh
  username: string | null; // 本机登录用户名（已剥离 DOMAIN\ 前缀）；取不到为 null
  hostIp: string | null; // 宿主 IPv4（SSH_CONNECTION 第 3 字段）；非 remote 或解析失败为 null
  endpoint: string | null; // 拼好的 "user@ip"；username 与 hostIp 任一缺失为 null
  source: EndpointSource; // 端点来源说明
}

// ── 模块级缓存 ──────────────────────────────────────────────

/**
 * @brief 端点解析缓存
 * @details SSH_CONNECTION 与 userInfo 在进程生命周期内不变，重复解析无意义。
 *          server.ts 启动时与 host_info 运行时各取一次，缓存避免重复计算。
 */
let cached: HostEndpoint | null = null;

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * @brief 解析本机登录用户名（剥离 DOMAIN\ 前缀）
 * @details Windows 上 os.userInfo().username 可能是 "DOMAIN\user" 形式，
 *          ssh 只取反斜杠后的部分。剥离后空串视为取不到（返回 null）。
 * @returns 剥离后的用户名；取不到或为空返回 null
 */
function resolveUsername(): string | null {
  const raw = userInfo().username;
  if (!raw) {
    return null;
  }
  // 兼容 "DOMAIN\user" 形式：取最后一个反斜杠之后的部分
  const stripped = raw.includes("\\")
    ? raw.slice(raw.lastIndexOf("\\") + 1)
    : raw;
  return stripped.length > 0 ? stripped : null;
}

/**
 * @brief 从 SSH_CONNECTION 提取宿主 IP（第 3 字段）
 * @details SSH_CONNECTION 格式：<client-ip> <client-port> <server-ip> <server-port>，
 *          宿主 IP 是 server-ip，即索引 2。可选做点分十进制校验，不通过返回 null。
 * @param sshConn 原始 SSH_CONNECTION 字符串
 * @returns 宿主 IPv4；字段不足或非合法 IP 返回 null
 */
function resolveHostIp(sshConn: string): string | null {
  const fields = sshConn.split(/\s+/);
  // 字段不足 3 个，无法取 server-ip
  if (fields.length < 3) {
    return null;
  }
  const candidate = fields[2];
  // 简单点分十进制校验：4 段、每段 0-255
  if (!isValidIpv4(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * @brief 简单 IPv4 点分十进制校验
 * @param value 待校验字符串
 * @returns 合法返回 true
 */
function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const num = Number(part);
    if (num < 0 || num > 255) {
      return false;
    }
  }
  return true;
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * @brief 解析宿主端点（进程内缓存，首次调用后不再重复计算）
 * @details 解析逻辑：
 *          1. 读 SSH_CONNECTION 判定场景——存在且非 "(unset)" 字面量为 remote-ssh，否则 local
 *          2. local 场景直接返回（无端点，原有行为不变）
 *          3. remote-ssh 场景解析 username + hostIp，拼成 "user@ip"
 *          4. 解析失败降级为 endpoint:null、source:unavailable，不抛错（N2）
 * @returns HostEndpoint；同一进程内多次调用返回同一缓存对象
 */
export function resolveHostEndpoint(): HostEndpoint {
  // 命中缓存直接返回
  if (cached) {
    return cached;
  }

  const sshConn = process.env.SSH_CONNECTION;
  // 区分"未设置"与"设置为空"：非空字符串且非 "(unset)" 字面量才算 remote-ssh 启动
  const isRemote =
    typeof sshConn === "string" && sshConn.length > 0 && sshConn !== "(unset)";

  // 本地启动：不提供端点，保持原有行为不变
  if (!isRemote) {
    cached = {
      scenario: "local",
      username: null,
      hostIp: null,
      endpoint: null,
      source: "local",
    };
    return cached;
  }

  // 远程 SSH 启动：解析端点
  const username = resolveUsername();
  const hostIp = resolveHostIp(sshConn as string);

  // username 与 hostIp 任一缺失则端点不可用（降级，不抛错）
  const endpoint = username && hostIp ? `${username}@${hostIp}` : null;
  // 解析成功来源为 ssh_connection，否则为 unavailable
  const source = endpoint ? "ssh_connection" : "unavailable";

  cached = {
    scenario: "remote-ssh",
    username,
    hostIp,
    endpoint,
    source,
  };
  return cached;
}
