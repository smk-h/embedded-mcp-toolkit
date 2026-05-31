import { fromJsonSchema } from "@modelcontextprotocol/server";
import { getAllConfig, listDevices } from "../../../infra/config.js";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";

// ── 声明 ──

export const deviceInfoConfig = {
  description:
    "Get device configuration. Uses the default device when no name is given; returns all devices when 'all' is specified.",
  inputSchema: fromJsonSchema<{ device?: string }>({
    type: "object",
    properties: {
      device: {
        type: "string",
        description:
          "Device name (optional). Omit to use the default device; pass 'all' to list every configured device.",
      },
    },
  }),
};

// ── 辅助函数 ──

/**
 * @brief 将设备配置格式化为可展示的文本行数组
 * @param cfg 设备配置（由 getAllConfig 返回）
 * @param compact 紧凑模式：省略节标题前的空行，适用于批量列举场景
 * @returns 格式化后的文本行数组
 */
function formatDeviceBlock(
  cfg: ReturnType<typeof getAllConfig>,
  compact = false
): string[] {
  const sshJson = JSON.stringify(
    { ...cfg.ssh, keyProvider: cfg.sshKeyProvider },
    null,
    2
  );
  const serialJson = JSON.stringify(
    { ...cfg.serial, keyProvider: cfg.serialKeyProvider },
    null,
    2
  );

  if (compact) {
    return [
      `Device: ${cfg.deviceName}`,
      "[SSH]",
      sshJson,
      "[Serial]",
      serialJson,
    ];
  }
  return [
    `Device: ${cfg.deviceName}`,
    "",
    "[SSH]",
    sshJson,
    "",
    "[Serial]",
    serialJson,
  ];
}

// ── 实现 ──

export async function deviceInfoHandler(args: { device?: string }) {
  const isAll = args.device === "all"; // 为保证获取所有设备信息，要保证没有设备名叫 all
  logger.info(
    `[device_info_tool] device=${args.device ?? "(default)"}${isAll ? " (all device info)" : ""}`
  );
  const devices = listDevices(); // 获取 config.yaml 中device下的第一层所有设备名： board-a board-b这些

  // 未指定设备名 → 使用默认设备
  if (!args.device) {
    const cfg = getAllConfig();
    return { content: [text(formatDeviceBlock(cfg).join("\n"))] };
  }

  // 指定了 "all" → 返回所有设备
  if (isAll) {
    const sections: string[] = [];
    if (devices.length === 0) {
      sections.push("No devices configured.");
    } else {
      for (const deviceName of devices) {
        const cfg = getAllConfig(deviceName);
        const block = formatDeviceBlock(cfg, true);
        block[0] = `--- ${block[0]} ---`; // 批量模式下添加分隔前缀
        sections.push(...block, "");
      }
    }
    return { content: [text(sections.join("\n"))] };
  }

  // 指定了具体设备名 → 校验存在性后返回该设备
  if (!devices.includes(args.device)) {
    const available =
      devices.length > 0
        ? ` Available: ${devices.join(", ")}.`
        : " No devices configured.";
    const errMsg = `Device '${args.device}' not found.${available}`;
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  const cfg = getAllConfig(args.device);
  return { content: [text(formatDeviceBlock(cfg).join("\n"))] };
}
