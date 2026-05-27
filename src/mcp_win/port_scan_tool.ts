/**
 *  USB端口: 通用串行总线（Universal Serial Bus）接口，是现代计算机最常用的外部设备连接标准。
 *              查询USB控制器：Get-CimInstance -ClassName Win32_USBController | Select-Object Name, DeviceID, Status | Format-Table -AutoSize
 *              查询USB集线器：Get-CimInstance -ClassName Win32_USBHub | Select-Object Name, DeviceID, Status | Format-Table -AutoSize
 *  COM端口: 串行通信端口（Communications Port的缩写），也称为RS-232串口或串行端口。
 *              可以查到USB转串口 Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $_.Name -match 'COM\d+' -or $_.PNPClass -eq 'Ports' } | Select-Object Name, DeviceID, Status, Manufacturer | Format-Table -AutoSize
 *                                                              ^ 查询得到的是 Windows系统中所有即插即用（Plug and Play）设备 的详细信息。
 *              只能查找到串口    Get-CimInstance -ClassName Win32_SerialPort | Select-Object Name, DeviceID, Description
 *  LPT端口: 并行端口（Line Printer Terminal的缩写），也称为打印机端口或Centronics接口，逐渐已经被USB代替了，没怎么见过，所以下面只扫描USB口了
 */
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../helper/mcp_helper.js";
import { logger } from "../common/logger.js";
import { execPowerShell } from "../powershell.js";

// ── 声明 ──

export const portScanConfig = {
	description:
		"Scan Windows Device Manager for available COM (serial) and LPT (parallel) ports",
	inputSchema: fromJsonSchema<Record<string, never>>({
		type: "object",
		properties: {},
	}),
};

// ── 实现 ──

interface PortInfo {
	name: string;
	deviceId: string;
	status: string;
	manufacturer: string;
	pnpClass: string;
}

function scanPnPEntity(): PortInfo[] {
	const psScript = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$ErrorActionPreference = 'Stop'",
		"Get-CimInstance -ClassName Win32_PnPEntity |",
		"  Where-Object { $_.Name -match 'COM\\d+' -or $_.PNPClass -eq 'Ports' } |",
		"  ForEach-Object {",
		'    "$($_.Name)|$($_.DeviceID)|$($_.Status)|$($_.Manufacturer)|$($_.PNPClass)"',
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
				status: parts[2] ?? "",
				manufacturer: parts[3] ?? "",
				pnpClass: parts[4] ?? "",
			};
		});
	} catch {
		logger.error("[port_scan_tool] scanPnPEntity failed");
		return [];
	}
}

export async function portScanHandler() {
	logger.info("[port_scan_tool] scanning Windows Device Manager ports");

	if (process.platform !== "win32") {
		return {
			content: [text("This tool only works on Windows.")],
		};
	}

	const ports = scanPnPEntity();

	if (ports.length === 0) {
		return {
			content: [
				text(
					"No COM/LPT ports found.\n(Try running as Administrator if ports are expected)"
				),
			],
		};
	}

	const comPorts = ports.filter((p) => /COM\d+/.test(p.name));
	const lptPorts = ports.filter((p) => /LPT\d+/.test(p.name));
	const otherPorts = ports.filter(
		(p) => !/COM\d+/.test(p.name) && !/LPT\d+/.test(p.name)
	);

	const lines: string[] = [];

	if (comPorts.length > 0) {
		lines.push("=== COM Ports (Serial) ===");
		for (const p of comPorts) {
			lines.push(`  ${p.name}`);
			lines.push(`    DeviceID:     ${p.deviceId}`);
			lines.push(`    Status:       ${p.status}`);
			lines.push(`    Manufacturer: ${p.manufacturer}`);
		}
	}

	if (lptPorts.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("=== LPT Ports (Parallel) ===");
		for (const p of lptPorts) {
			lines.push(`  ${p.name}`);
			lines.push(`    DeviceID:     ${p.deviceId}`);
			lines.push(`    Status:       ${p.status}`);
			lines.push(`    Manufacturer: ${p.manufacturer}`);
		}
	}

	if (otherPorts.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("=== Other Port Devices ===");
		for (const p of otherPorts) {
			lines.push(`  ${p.name}`);
			lines.push(`    DeviceID:     ${p.deviceId}`);
			lines.push(`    Status:       ${p.status}`);
			lines.push(`    Manufacturer: ${p.manufacturer}`);
			lines.push(`    PNPClass:     ${p.pnpClass}`);
		}
	}

	return { content: [text(lines.join("\n"))] };
}
