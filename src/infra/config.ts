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
  adb?: {
    serialNo?: string; // ADB 设备序列号，留空则自动发现
  };
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
    loginUsername?: string; // 串口登录用户名
    loginPassword?: string; // 串口登录密码
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
  logger.info(
    `Device resolved: ${deviceName} `,
    `(from ${process.env.DEVICE ? "env" : loadConfig().default ? "config.yaml" : "default value"})`
  );
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
    host: process.env.BOARD_HOST ?? yaml.host ?? "none",
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
    port: process.env.SERIAL_PORT ?? yaml.port ?? "none",
    baudRate: parseInt(
      process.env.SERIAL_BAUDRATE ?? String(yaml.baudRate ?? 115200),
      10
    ),
    dataBits: yaml.dataBits as 8 | 5 | 6 | 7 | undefined,
    stopBits: yaml.stopBits as 1 | 1.5 | 2 | undefined,
    parity: yaml.parity,
    lineEnding: yaml.lineEnding,
    loginUsername: yaml.loginUsername,
    loginPassword: yaml.loginPassword,
  };
}

/**
 * @brief ADB 设备配置
 */
export interface AdbDeviceConfig {
  serialNo?: string;
}

/**
 * @brief 获取 ADB 连接配置
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 */
export function getAdbConfig(name?: string): AdbDeviceConfig {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  const yaml = device.adb ?? {};
  return {
    serialNo: yaml.serialNo,
  };
}

/**
 * @brief 解析 config.yaml 中 adb.serialNo 字段值
 *
 * 约定：配置文件中的序列号以 "sn_" 为前缀，用于与用户直接传入的原始序列号区分。
 *
 * @param raw  配置中的原始值，如 "sn_43b1e5fe7b186666"、"sn_none"、""、undefined
 * @returns 解析后的序列号，无法解析时返回 undefined
 */
function parseSerialNo(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  // 以 sn_ 开头的视为配置文件定义的序列号
  if (raw.startsWith("sn_")) {
    const value = raw.slice(3);
    // sn_none：显式标记"未定义"，与空值等效
    if (value === "none" || value === "") {
      return undefined;
    }
    return value;
  }
  // 不以 sn_ 开头 → 无法解析，视为未定义（兼容旧配置格式）
  return undefined;
}

/**
 * @brief 解析 ADB 设备参数，将设备别名转换为序列号
 *
 * 三种输入模式：
 *   1. 传入设备别名（如 "board-a"）→ 查 config.yaml 获取 serialNo
 *   2. 传入序列号字符串（如 "43b1e5fe7b186666"）→ 直接使用
 *   3. 未传入 → 返回 undefined，由 adb 自动发现唯一设备
 *
 * @param device  设备标识（别名或序列号，可选）
 * @returns 序列号字符串，解析失败时返回 undefined
 */
export function resolveAdbSerial(device?: string): string | undefined {
  // 未传入任何标识 → 交由 adb 自动发现
  if (!device) {
    return undefined;
  }
  // 判断依据：检查 device 是否为 config.yaml 中 devices 下的某个键名
  //   - 命中（如 "board-a"）→ 作为设备别名，查 adb.serialNo 字段
  //       serialNo 值以 "sn_" 为前缀标记（如 "sn_43b1e5fe7b186666"），
  //       通过 parseSerialNo 去除前缀后得到真实序列号；
  //       "sn_none" 表示显式标记"未定义"
  //   - 未命中（如 "43b1e5fe7b186666"）→ 作为原始序列号直传，不查配置，这要求用户必须确保其正确性
  const devices = loadConfig().devices;
  if (devices && devices[device]) {
    const cfg = getAdbConfig(device);
    return parseSerialNo(cfg.serialNo);
  }
  return device;
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
  const deviceName = name ?? resolveDeviceName();
  const device = getDeviceConfig(deviceName);
  const yaml: KeyProviderYaml =
    scope === "ssh"
      ? (device.ssh?.keyProvider ?? {})
      : (device.serial?.keyProvider ?? {});
  const challengeFilePath =
    process.env.CHALLENGE_FILE ?? yaml.challengeFilePath ?? "challenge.txt";
  const keyFilePath =
    process.env.KEY_FILE ?? yaml.keyFilePath ?? "password_input.txt";

  logger.info(
    `[${deviceName}] [KeyProvider/${scope}] challenge file: ${resolve(challengeFilePath)}`
  );
  logger.info(
    `[${deviceName}] [KeyProvider/${scope}] key file:       ${resolve(keyFilePath)}`
  );

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
  adb: ReturnType<typeof getAdbConfig>;
  ssh: ReturnType<typeof getSSHConfig>;
  serial: ReturnType<typeof getSerialConfig>;
  sshKeyProvider: ReturnType<typeof getKeyProviderConfig>;
  serialKeyProvider: ReturnType<typeof getKeyProviderConfig>;
} {
  const deviceName = name ?? resolveDeviceName();
  return {
    deviceName,
    adb: getAdbConfig(deviceName),
    ssh: getSSHConfig(deviceName),
    serial: getSerialConfig(deviceName),
    sshKeyProvider: getKeyProviderConfig("ssh", deviceName),
    serialKeyProvider: getKeyProviderConfig("serial", deviceName),
  };
}

/**
 * @brief 列出所有可用设备名
 *     1. config.yaml 中 devices 字段下定义了三个设备：board-a、board-b、board-test。
 *     2. loadConfig() 解析 YAML 后，返回的对象中 devices 属性为
 *        { "board-a": {...}, "board-b": {...}, "board-test": {...} }。
 *     3. Object.keys(devices) 提取键名得到 ["board-a", "board-b", "board-test"]。
 *     4. devices 对象存在（truthy），走 Object.keys(devices) 分支而非 []。
 */
export function listDevices(): string[] {
  const devices = loadConfig().devices;
  return devices ? Object.keys(devices) : [];
}
