/**
 * Subnet Check 工具 — 检查目标 IP 是否与主机在同一子网内（可达）
 *
 * 工作流程：
 *   1. 通过 PowerShell 获取主机的 IP 地址、子网掩码和默认网关
 *   2. 根据 IP 和子网掩码计算子网范围（网络地址、广播地址、可用主机范围）
 *   3. 判断目标 IP 是否在该子网内
 *   4. 返回详细的子网分析结果
 *
 * ── 子网计算示例 ──
 *
 * 给定：
 *   主机 IP：     192.168.16.1
 *   子网掩码：    255.255.255.240
 *   默认网关：    192.168.16.14
 *
 * 计算过程：
 *   1. 子网掩码 255.255.255.240 → 二进制 11111111.11111111.11111111.11110000
 *      → CIDR 前缀长度 = 28 (/28)
 *   2. 块大小 = 256 - 240 = 16
 *      → 子网以 16 为步长划分：
 *        192.168.16.0/28, 192.168.16.16/28, 192.168.16.32/28, ...
 *   3. 主机 IP 192.168.16.1 落在 192.168.16.0/28 子网内
 *      → 网络地址：     192.168.16.0
 *      → 广播地址：     192.168.16.15
 *      → 可用主机范围： 192.168.16.1 ~ 192.168.16.14
 *   4. 同一子网内的所有主机可通过二层直接通信
 *      → 可与本机 ping 通的 IP 共 14 个（含本机）：192.168.16.1 ~ 192.168.16.14
 *      → 排除本机后共 13 个：2 ~ 14
 *
 * ── 子网掩码改为 255.255.255.0 (/24) 对比 ──
 *
 * 给定：
 *   主机 IP：     192.168.16.1
 *   子网掩码：    255.255.255.0
 *   默认网关：    192.168.16.14
 *
 * 计算过程：
 *   1. 255.255.255.0 → 11111111.11111111.11111111.00000000 → /24
 *   2. 块大小 = 256 - 0 = 256
 *   3. 主机 IP 192.168.16.1 落在 192.168.16.0/24 子网内
 *      → 网络地址：     192.168.16.0
 *      → 广播地址：     192.168.16.255
 *      → 可用主机范围： 192.168.16.1 ~ 192.168.16.254
 *   4. 网关 192.168.16.14 仍在范围内，无需修改
 *   5. 同一子网内的所有主机可通过二层直接通信
 *      → 可与本机 ping 通的 IP 共 254 个（含本机）：192.168.16.1 ~ 192.168.16.254
 *      → 排除本机后共 253 个
 *
 * ── 关于网关 IP 的说明 ──
 *
 * 网关 IP 不是由 IP 段自动决定的，而是网络管理员手动配置的。
 * 它只需满足两个条件：
 *   1. 必须位于同一子网的可用主机范围内（不能是网络地址和广播地址）
 *   2. 必须是某个路由器或三层交换机接口上的 IP
 * 常见的习惯是把网关设在 .1 或 .254，但这并非规定。
 * 例如 192.168.16.14 作为 /28 子网的网关完全合法。
 *
 * ── 子网掩码对比总结 ──
 *
 *   /28  → 可用主机 14 个（1 ~ 14），网关 192.168.16.14 有效
 *   /24  → 可用主机 254 个（1 ~ 254），网关 192.168.16.14 有效
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { execPowerShell } from "../../../transport/powershell.js";

/** @brief Subnet Check 工具声明（MCP schema） */
export const subnetCheckConfig = {
  description:
    "Analyze subnet information for a target IP address. " +
    "Retrieves host IP, subnet mask, and gateway, calculates subnet range " +
    "(network address, broadcast address, usable host range, CIDR), " +
    "and determines whether the target IP falls within the same subnet as the host.",
  inputSchema: fromJsonSchema<{ target_ip: string }>({
    type: "object",
    properties: {
      target_ip: {
        type: "string",
        description: "The target IP address to check (e.g., 192.168.16.1)",
      },
    },
    required: ["target_ip"],
  }),
};

// ── 类型定义 ──

/**
 * @brief 网卡 IP 配置信息
 * @description 存储从 Win32_NetworkAdapterConfiguration 获取的单张网卡配置
 */
interface IPConfig {
  description: string;
  ipAddress: string;
  subnetMask: string;
  defaultGateway: string;
  dhcpEnabled: boolean;
  dnsServers: string;
}

/**
 * @brief 子网计算结果
 * @description 根据 IP 和掩码计算出的子网信息
 */
interface SubnetInfo {
  networkAddress: string;
  broadcastAddress: string;
  firstHost: string;
  lastHost: string;
  totalHosts: number;
  usableHosts: number;
  cidr: number;
}

// ── IP 计算工具函数 ──

/**
 * @brief 将 IPv4 地址字符串转换为 32 位无符号整数
 * @param ip   IPv4 地址字符串
 * @returns    32 位无符号整数
 * @throws     格式无效时抛出
 * @example    ipToInt("192.168.16.1") → 0xC0A81001
 */
function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP address: "${ip}"`);
  }
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/**
 * @brief 将 32 位无符号整数转换为 IPv4 地址字符串
 * @param int  32 位无符号整数
 * @returns    IPv4 地址字符串
 * @example    intToIp(0xC0A81001) → "192.168.16.1"
 */
function intToIp(int: number): string {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join(".");
}

/**
 * @brief 根据子网掩码计算 CIDR 前缀长度
 * @param mask  子网掩码字符串
 * @returns     CIDR 前缀长度 (0-32)
 * @throws      掩码不连续或格式无效时抛出
 * @example     maskToCidr("255.255.255.240") → 28
 */
function maskToCidr(mask: string): number {
  const int = ipToInt(mask);
  if (int === 0) return 0;
  // 子网掩码必须是连续的 1 后接连续的 0
  const inverted = ~int >>> 0;
  if ((inverted & (inverted + 1)) !== 0) {
    throw new Error(`Invalid subnet mask: "${mask}" (non-contiguous bits)`);
  }
  return 32 - Math.clz32(inverted);
}

/**
 * @brief 计算子网信息
 * @param ip    主机 IP 地址
 * @param mask  子网掩码
 * @returns     子网信息（网络地址、广播地址、可用范围等）
 */
function calculateSubnet(ip: string, mask: string): SubnetInfo {
  const ipInt = ipToInt(ip);
  const maskInt = ipToInt(mask);
  const cidr = maskToCidr(mask);

  const networkInt = (ipInt & maskInt) >>> 0;
  // 广播地址 = 网络地址 | (反掩码)
  const invertedMask = ~maskInt >>> 0;
  const broadcastInt = (networkInt | invertedMask) >>> 0;

  const totalHosts = Math.pow(2, 32 - cidr);
  const usableHosts = totalHosts > 2 ? totalHosts - 2 : totalHosts;

  const firstHost =
    usableHosts > 0 ? intToIp(networkInt + 1) : intToIp(networkInt);
  const lastHost =
    totalHosts > 2 ? intToIp(broadcastInt - 1) : intToIp(broadcastInt);

  return {
    networkAddress: intToIp(networkInt),
    broadcastAddress: intToIp(broadcastInt),
    firstHost,
    lastHost,
    totalHosts,
    usableHosts,
    cidr,
  };
}

/**
 * @brief 判断目标 IP 是否在子网范围内（含网络地址和广播地址）
 * @param targetIp  目标 IP 地址
 * @param subnet    子网信息
 * @returns         是否在子网范围内
 */
function isInSubnet(targetIp: string, subnet: SubnetInfo): boolean {
  const targetInt = ipToInt(targetIp);
  const networkInt = ipToInt(subnet.networkAddress);
  const broadcastInt = ipToInt(subnet.broadcastAddress);
  return targetInt >= networkInt && targetInt <= broadcastInt;
}

// ── PowerShell 数据采集 ──

/**
 * @brief 通过 WMI 获取主机的 IP 配置信息
 * @details 使用 Win32_NetworkAdapterConfiguration 获取每个启用的网络适配器的：
 *          IPAddress, IPSubnet, DefaultIPGateway, DHCPEnabled, DNSServerSearchOrder
 * @returns   网卡 IP 配置列表（仅含已启用且有网关的适配器）
 */
function getHostIPConfigs(): IPConfig[] {
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration |",
    "  Where-Object { $_.IPEnabled -and $_.DefaultIPGateway -and $_.IPAddress } |",
    "  ForEach-Object {",
    "    $idx = -1",
    "    for ($i = 0; $i -lt $_.IPAddress.Count; $i++) {",
    "      if ($_.IPAddress[$i] -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$') {",
    "        $idx = $i; break",
    "      }",
    "    }",
    "    if ($idx -lt 0) { continue }",
    "    $ip    = $_.IPAddress[$idx]",
    "    $mask  = if ($_.IPSubnet -and $_.IPSubnet.Count -gt $idx) { $_.IPSubnet[$idx] } else { '' }",
    "    $gw    = ($_.DefaultIPGateway -join ', ')",
    "    $dns   = if ($_.DNSServerSearchOrder) { ($_.DNSServerSearchOrder -join ', ') } else { '' }",
    "    $dhcp  = $_.DHCPEnabled",
    '    "$($_.Description)|$ip|$mask|$gw|$dhcp|$dns"',
    "  }",
  ].join("\n");

  try {
    const raw = execPowerShell(psScript);
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const parts = line.split("|");
      return {
        description: parts[0] ?? "",
        ipAddress: parts[1] ?? "",
        subnetMask: parts[2] ?? "",
        defaultGateway: parts[3] ?? "",
        dhcpEnabled: parts[4]?.toLowerCase() === "true",
        dnsServers: parts[5] ?? "",
      };
    });
  } catch {
    logger.error("[subnet_check_tool] getHostIPConfigs failed");
    return [];
  }
}

// ── Handler ──

/**
 * @brief Subnet Check 工具入口
 * @param args  包含 target_ip 的对象
 * @returns     MCP 响应内容
 */
export async function subnetCheckHandler(args: unknown) {
  const { target_ip } = args as { target_ip: string };
  logger.info(`[subnet_check_tool] checking target IP: ${target_ip}`);

  if (process.platform !== "win32") {
    return {
      content: [text("This tool only works on Windows.")],
    };
  }

  // 验证目标 IP 格式
  try {
    ipToInt(target_ip);
  } catch {
    return {
      content: [
        text(
          `Invalid target IP address: "${target_ip}". Expected format: x.x.x.x`
        ),
      ],
    };
  }

  const configs = getHostIPConfigs();

  if (configs.length === 0) {
    return {
      content: [
        text(
          "No active network adapters with IP configuration found.\n" +
            "Ensure you are connected to a network and try again."
        ),
      ],
    };
  }

  const lines: string[] = [];
  lines.push(`=== Subnet Check for Target IP: ${target_ip} ===`);
  lines.push("");

  for (const cfg of configs) {
    let subnet: SubnetInfo;
    try {
      subnet = calculateSubnet(cfg.ipAddress, cfg.subnetMask);
    } catch (err) {
      lines.push(`Adapter: ${cfg.description}`);
      lines.push(`  IP:       ${cfg.ipAddress}`);
      lines.push(
        `  Error:    Failed to calculate subnet (${err instanceof Error ? err.message : err})`
      );
      lines.push("");
      continue;
    }

    const reachable = isInSubnet(target_ip, subnet);
    const targetInSubnet = target_ip === cfg.ipAddress;

    lines.push(`Adapter: ${cfg.description}`);
    lines.push(`  IP Address:       ${cfg.ipAddress}`);
    lines.push(`  Subnet Mask:      ${cfg.subnetMask} (/${subnet.cidr})`);
    lines.push(`  Default Gateway:  ${cfg.defaultGateway || "N/A"}`);
    lines.push(
      `  DHCP:             ${cfg.dhcpEnabled ? "Enabled" : "Disabled"}`
    );
    if (cfg.dnsServers) {
      lines.push(`  DNS Servers:      ${cfg.dnsServers}`);
    }
    lines.push("");
    lines.push(`  --- Subnet Analysis ---`);
    lines.push(`  Network Address:   ${subnet.networkAddress}`);
    lines.push(`  Broadcast Address: ${subnet.broadcastAddress}`);
    lines.push(`  Usable Host Range: ${subnet.firstHost} ~ ${subnet.lastHost}`);
    lines.push(`  Total Addresses:   ${subnet.totalHosts}`);
    lines.push(`  Usable Hosts:      ${subnet.usableHosts}`);
    lines.push("");

    if (targetInSubnet) {
      lines.push(`  ✅ Target IP ${target_ip} is the HOST ITSELF.`);
    } else if (reachable) {
      lines.push(
        `  ✅ Target IP ${target_ip} is REACHABLE (within same subnet).`
      );
      lines.push(`     You can ping this device directly.`);
    } else {
      lines.push(`  ❌ Target IP ${target_ip} is NOT in this subnet.`);
      lines.push(`     Direct L2 reachability is not possible.`);
      lines.push(
        `     Traffic must be routed through gateway: ${cfg.defaultGateway || "N/A"}`
      );
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return { content: [text(lines.join("\n"))] };
}
