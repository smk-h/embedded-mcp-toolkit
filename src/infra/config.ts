import { readFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";
import { logger } from "./logger.js";
import type { SSHShellConfig } from "../transport/ssh.js";
import type { SerialShellConfig } from "../transport/serial.js";
import type { KeyProviderConfig } from "../utils/key-provider.js";

/** KeyProvider 配置片段（YAML 中可选项） */
interface KeyProviderYaml {
  mode?: "file" | "terminal";
  challengeFilePath?: string;
  keyFilePath?: string;
  pollInterval?: number;
  timeout?: number;
}

interface DeviceConfig {
  ssh?: {
    host?: string; // SSH 主机地址
    port?: number; // SSH 端口，默认 22
    username?: string; // SSH 登录用户名
    password?: string; // 密码认证（与 privateKey 二选一）
    privateKey?: string; // 密钥认证（与 password 二选一）
    passphrase?: string; // 密钥解密口令
    keyProvider?: KeyProviderYaml; // SSH 侧密钥提供配置
  };
  serial?: {
    port?: string; // 串口设备路径（如 COM3、/dev/ttyUSB0）
    baudRate?: number; // 波特率，默认 115200
    dataBits?: number; // 数据位（5/6/7/8），默认 8
    stopBits?: number; // 停止位（1/1.5/2），默认 1
    parity?: "none" | "even" | "odd"; // 校验位，默认 none
    lineEnding?: string; // 命令追加的换行符（\n, \r\n），默认 \n
    keyProvider?: KeyProviderYaml; // 串口侧密钥提供配置
  };
}

interface RootConfig {
  default?: string; // 默认设备名
  devices?: Record<string, DeviceConfig>; // 设备配置字典，key 为设备名
}

let _cached: RootConfig | null = null;

function loadConfig(): RootConfig {
  if (_cached) return _cached;
  const configPath = process.env.BOARD_CONFIG_PATH ?? "config.yaml";
  const absPath = resolve(configPath);
  try {
    _cached = load(readFileSync(absPath, "utf8")) as RootConfig;
    logger.info(`Config loaded: ${absPath}`);
  } catch {
    _cached = {};
    logger.warn(`Config not found or invalid: ${absPath}`);
  }
  return _cached!;
}

/**
 * @brief 解析当前设备名
 *
 * 配置优先级: 环境变量 > config.yaml > 硬编码兜底
 *
 * 可通过命令行传入，如:
 *   DEVICE=board-b node out/main.js ssh
 */
export function resolveDeviceName(): string {
  const deviceName = process.env.DEVICE ?? loadConfig().default ?? "board-a";
  logger.info(`Device resolved: ${deviceName}`);
  return deviceName;
}

/**
 * @brief 根据设备名获取设备配置
 *
 * @param name 设备名
 */
function getDeviceConfig(name: string): DeviceConfig {
  return loadConfig().devices?.[name] ?? {};
}

/**
 * @brief 获取 SSH 连接配置
 *
 * 配置优先级: 环境变量 > config.yaml > 硬编码兜底
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 */
export function getSSHConfig(name?: string): SSHShellConfig {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  const yaml = device.ssh ?? {};
  return {
    host: process.env.BOARD_HOST ?? yaml.host ?? "0.0.0.0",
    port: parseInt(process.env.BOARD_PORT ?? String(yaml.port ?? 22), 10),
    username: process.env.BOARD_USERNAME ?? yaml.username ?? "root",
    password: process.env.BOARD_PASSWORD ?? yaml.password ?? "root",
  };
}

/**
 * @brief 获取串口连接配置
 *
 * 配置优先级: 环境变量 > config.yaml > 硬编码兜底
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 */
export function getSerialConfig(name?: string): SerialShellConfig {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  const yaml = device.serial ?? {};
  return {
    port: process.env.SERIAL_PORT ?? yaml.port ?? "COM0",
    baudRate: parseInt(
      process.env.SERIAL_BAUDRATE ?? String(yaml.baudRate ?? 115200),
      10
    ),
    dataBits: yaml.dataBits as 8 | 5 | 6 | 7 | undefined,
    stopBits: yaml.stopBits as 1 | 1.5 | 2 | undefined,
    parity: yaml.parity,
    lineEnding: yaml.lineEnding,
  };
}

/**
 * @brief 获取 KeyProvider 配置
 *
 * SSH 侧和串口侧各自独立配置，互不影响。
 * 配置优先级: 环境变量 > config.yaml > 硬编码兜底
 *
 * @param scope "ssh" 或 "serial"，选择从哪个配置段读取
 * @param name  设备名（可选，默认使用 resolveDeviceName() 解析）
 */
export function getKeyProviderConfig(
  scope: "ssh" | "serial",
  name?: string
): KeyProviderConfig {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  const yaml: KeyProviderYaml =
    scope === "ssh"
      ? (device.ssh?.keyProvider ?? {})
      : (device.serial?.keyProvider ?? {});
  const challengeFilePath =
    process.env.CHALLENGE_FILE ?? yaml.challengeFilePath ?? "challenge.txt";
  const keyFilePath =
    process.env.KEY_FILE ?? yaml.keyFilePath ?? "password_input.txt";

  logger.info(
    `[KeyProvider/${scope}] challenge file: ${resolve(challengeFilePath)}`
  );
  logger.info(`[KeyProvider/${scope}] key file:       ${resolve(keyFilePath)}`);

  return {
    mode:
      (process.env.KEY_PROVIDER as "file" | "terminal") ??
      yaml.mode ??
      "terminal",
    challengeFilePath,
    keyFilePath,
    pollInterval: yaml.pollInterval,
    timeout: yaml.timeout,
  };
}

/**
 * @brief 获取设备的全部配置信息（SSH + 串口 + 各自 KeyProvider）
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 * @returns 包含设备名、SSH、串口及各自 KeyProvider 配置的对象
 */
export function getAllConfig(name?: string): {
  deviceName: string;
  ssh: ReturnType<typeof getSSHConfig>;
  serial: ReturnType<typeof getSerialConfig>;
  sshKeyProvider: ReturnType<typeof getKeyProviderConfig>;
  serialKeyProvider: ReturnType<typeof getKeyProviderConfig>;
} {
  const deviceName = name ?? resolveDeviceName();
  return {
    deviceName,
    ssh: getSSHConfig(deviceName),
    serial: getSerialConfig(deviceName),
    sshKeyProvider: getKeyProviderConfig("ssh", deviceName),
    serialKeyProvider: getKeyProviderConfig("serial", deviceName),
  };
}

/**
 * @brief 列出所有可用设备名
 */
export function listDevices(): string[] {
  const devices = loadConfig().devices;
  return devices ? Object.keys(devices) : [];
}
