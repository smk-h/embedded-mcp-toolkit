import { fromJsonSchema } from "@modelcontextprotocol/server";
import { getAllConfig, listDevices } from "../config.js";
import { text } from "../helper/mcp_helper.js";

// ── 声明 ──

export const deviceInfoConfig = {
  description: "Get current device configuration (SSH, Serial, KeyProvider)",
  inputSchema: fromJsonSchema<{ device?: string }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
    },
  }),
};

// ── 实现 ──

export async function deviceInfoHandler(args: { device?: string }) {
  const devices = listDevices();

  // 若传入了设备名，校验其是否存在
  if (args.device && !devices.includes(args.device)) {
    const available =
      devices.length > 0
        ? ` Available: ${devices.join(", ")}.`
        : " No devices configured.";
    throw new Error(`Device '${args.device}' not found.${available}`);
  }

  const cfg = getAllConfig(args.device);

  const lines = [
    `Device: ${cfg.deviceName}`,
    ...(devices.length > 0 ? [`Available: ${devices.join(", ")}`] : []),
    "",
    "[SSH]",
    JSON.stringify({ ...cfg.ssh, keyProvider: cfg.sshKeyProvider }, null, 2),
    "",
    "[Serial]",
    JSON.stringify(
      { ...cfg.serial, keyProvider: cfg.serialKeyProvider },
      null,
      2
    ),
  ];
  return { content: [text(lines.join("\n"))] };
}
