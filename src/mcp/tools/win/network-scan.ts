/**
 *  网络适配器: 计算机中负责网络通信的硬件设备，包括有线网卡、无线网卡、蓝牙等。
 *              查询网络适配器：Get-CimInstance -ClassName Win32_NetworkAdapter | Select-Object Name, DeviceID, Speed, NetConnectionStatus, MACAddress, Manufacturer | Format-Table -AutoSize
 *              查询网络适配器配置：Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled -eq $true } | Select-Object Description, IPAddress, MACAddress, DHCPEnabled | Format-Table -AutoSize
 */
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { execPowerShell } from "../../../transport/powershell.js";

// ── 声明 ──

export const networkScanConfig = {
  description:
    "Scan Windows network adapters and configurations (IP, MAC, status, speed)",
  inputSchema: fromJsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
  }),
};

// ── 常量 ──

/** Win32_NetworkAdapter.NetConnectionStatus 状态码 → 可读文本 */
const NET_STATUS_MAP: Record<string, string> = {
  "0": "Disconnected",
  "1": "Connecting",
  "2": "Connected",
  "3": "Disconnecting",
  "4": "Hardware not present",
  "5": "Hardware disabled",
  "6": "Hardware malfunction",
  "7": "Media disconnected",
  "8": "Authenticating",
  "9": "Authentication succeeded",
  "10": "Authentication failed",
  "11": "Invalid address",
  "12": "Credentials required",
};

// ── 实现 ──

interface NetAdapter {
  name: string;
  deviceId: string;
  speed: string;
  status: string;
  macAddress: string;
  manufacturer: string;
}

function scanNetworkAdapters(): NetAdapter[] {
  const psScript = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance -ClassName Win32_NetworkAdapter |",
    "  Where-Object { $_.PhysicalAdapter -or $_.AdapterTypeId -eq 0 } |",
    "  ForEach-Object {",
    '    "$($_.Name)|$($_.DeviceID)|$($_.Speed)|$($_.NetConnectionStatus)|$($_.MACAddress)|$($_.Manufacturer)"',
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
        name: parts[0] ?? "",
        deviceId: parts[1] ?? "",
        speed: parts[2] ?? "",
        status: parts[3] ?? "",
        macAddress: parts[4] ?? "",
        manufacturer: parts[5] ?? "",
      };
    });
  } catch {
    logger.error("[network_scan_tool] scanNetworkAdapters failed");
    return [];
  }
}

function getIPConfig(): string[] {
  const psScript = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration |",
    "  Where-Object { $_.IPEnabled -eq $true } |",
    "  ForEach-Object {",
    '    $ip = if ($_.IPAddress) { ($_.IPAddress -join ", ") } else { "" }',
    '    $dns = if ($_.DNSServerSearchOrder) { ($_.DNSServerSearchOrder -join ", ") } else { "" }',
    '    "$($_.Description)|$ip|$($_.MACAddress)|$($_.DHCPEnabled)|$dns"',
    "  }",
  ].join("\n");

  try {
    const raw = execPowerShell(psScript);
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    logger.error("[network_scan_tool] getIPConfig failed");
    return [];
  }
}

function statusText(code: string): string {
  return NET_STATUS_MAP[code] ?? `Unknown (${code})`;
}

function formatSpeed(speed: string): string {
  const n = parseInt(speed, 10);
  if (isNaN(n) || n === 0) return "N/A";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(0)} Gbps`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} Mbps`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} Kbps`;
  return `${n} bps`;
}

export async function networkScanHandler() {
  logger.info("[network_scan_tool] scanning Windows network adapters");

  if (process.platform !== "win32") {
    return {
      content: [text("This tool only works on Windows.")],
    };
  }

  const adapters = scanNetworkAdapters();
  const ipConfigs = getIPConfig();

  // Build IP lookup by description
  // PowerShell output field order: Description|IP|MACAddress|DHCPEnabled|DNS
  const ipMap = new Map<string, { ips: string; dhcp: string; dns: string }>();
  for (const line of ipConfigs) {
    const parts = line.split("|");
    const desc = parts[0] ?? "";
    ipMap.set(desc, {
      ips: parts[1] ?? "",
      dhcp: parts[3] ?? "",
      dns: parts[4] ?? "",
    });
  }

  const lines: string[] = [];

  if (adapters.length > 0) {
    lines.push("=== Network Adapters ===");
    for (const a of adapters) {
      const ipInfo = ipMap.get(a.name);
      lines.push(`  ${a.name}`);
      lines.push(`    DeviceID:     ${a.deviceId}`);
      lines.push(`    Status:       ${statusText(a.status)}`);
      lines.push(`    Speed:        ${formatSpeed(a.speed)}`);
      lines.push(`    MAC Address:  ${a.macAddress || "N/A"}`);
      lines.push(`    Manufacturer: ${a.manufacturer}`);
      if (ipInfo) {
        lines.push(`    IP Address:   ${ipInfo.ips}`);
        lines.push(
          `    DHCP:         ${ipInfo.dhcp === "True" ? "Enabled" : "Disabled"}`
        );
        if (ipInfo.dns) lines.push(`    DNS:          ${ipInfo.dns}`);
      }
      lines.push("");
    }
  } else {
    lines.push("No network adapters found.");
  }

  return { content: [text(lines.join("\n"))] };
}
