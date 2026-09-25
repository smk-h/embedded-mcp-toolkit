/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : bridge.ts
 * Author     : sumu
 * Date       : 2026/09/25
 * Version    : x.x.x
 * Description: 写什么 —— Windows 端点采集与桥接 server 构造
 *
 * 回答"本次要写入的桥接定义从哪来"：
 *   - collectWindowsEndpoint 采集 Windows 侧参数（用户名 / 主 IP / bat 路径），多网卡
 *     时交互式让用户选主 IP（自动取首个可能选到 Linux 路由不可达的网段）
 *   - buildBridgeServer      把端点参数构造成 BridgeServer（ssh + 专用密钥 + 保活选项
 *     + <user>@<ip> + bat 路径，保活选项见 shared/ssh-bridge.ts，全部落点共用同一份）
 *
 * 具体写入目标文件时的对象形态（是否带 type/enabled/cwd 等）与本文件无关，
 * 由各落点自带的 ServerSlot.render 决定（见 targets.ts）。
 * ======================================================
 */

import { select, isCancel } from "@clack/prompts";

import { type BridgeServer, SSH_KEY_PATH } from "./types.js";
import { buildSshBridgeArgs } from "../../shared/ssh-bridge.js";
import { collectConnectionInfo } from "../../shared/cli-helpers.js";

// ============================================================
// Windows 端点
// ============================================================

/** @brief 本次桥接依赖的 Windows 侧参数 */
export interface WindowsEndpoint {
  /** Windows ssh 用户名（来自 collectConnectionInfo） */
  sshUser: string;
  /** Windows 主 IP（反向 SSH 的连回地址） */
  primaryIp: string;
  /** remote-start-mcp.bat 绝对路径（正斜杠） */
  batPath: string;
}

// ============================================================
// 桥接定义构造
// ============================================================

/**
 * @brief 构造本次的 SSH 桥接 server 对象（逻辑定义，与客户端写法无关）
 * @param sshUser   Windows ssh 用户名（来自 collectWindowsEndpoint）
 * @param primaryIp Windows 主 IP（来自 collectWindowsEndpoint）
 * @param batPath   remote-start-mcp.bat 绝对路径（正斜杠）
 * @returns 桥接 server 对象
 */
export function buildBridgeServer(
  sshUser: string,
  primaryIp: string,
  batPath: string
): BridgeServer {
  return {
    command: "ssh",
    args: buildSshBridgeArgs(SSH_KEY_PATH, `${sshUser}@${primaryIp}`, batPath),
  };
}

/**
 * @brief 采集本次桥接所需的 Windows 端点参数
 * @details 采集本机连接信息并确定主 IP：
 *          - 无可用 IP  → 返回 null（配置场景中止；诊断场景可用占位端点兜底）
 *          - 仅 1 个 IP → 直接采用，无需用户介入
 *          - 多个 IP    → 交互式让用户选择
 *          bat 路径取 cwd/remote-start-mcp.bat（转正斜杠，与 sshd-config 模板一致）。
 * @returns 端点参数；无可用 IP 或多 IP 时用户取消选择返回 null
 */
export async function collectWindowsEndpoint(): Promise<WindowsEndpoint | null> {
  const { sshUser, ipList } = collectConnectionInfo();
  if (ipList.length === 0) {
    return null;
  }
  let primaryIp: string;
  if (ipList.length === 1) {
    primaryIp = ipList[0].ip;
  } else {
    const choice = await select<string>({
      message: "选择 Windows 主 IP（远程反连地址）",
      options: ipList.map((entry) => ({
        value: entry.ip,
        label: `${entry.ip}  (${entry.iface})`,
      })),
    });
    if (isCancel(choice)) {
      return null;
    }
    primaryIp = choice;
  }
  // cwd/remote-start-mcp.bat 转正斜杠（JSON 无需转义反斜杠，且 node/ssh 支持正斜杠）
  const batPath = (
    process.cwd().replace(/\\/g, "/") + "/remote-start-mcp.bat"
  ).replace(/\/+/g, "/");
  return { sshUser, primaryIp, batPath };
}
