import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { load } from "js-yaml";
import { logger } from "./logger.js";
import type { SSHShellConfig } from "../transports/ssh.js";
import type { SerialShellConfig } from "../transports/serial.js";
import type { KeyProviderConfig } from "../services/key-provider.js";

/** KeyProvider 配置片段（YAML 中可选项） */
interface KeyProviderYaml {
  mode?: "file" | "terminal";
  challengeFilePath?: string;
  keyFilePath?: string;
  pollInterval?: number;
  timeout?: number;
}

/**
 * @brief U-Boot 进入检测配置（serial.uboot 子段）
 *
 * 用于 serial_enter_uboot 工具的提示符识别与事后验证，全部字段可选。
 * 字符串字段直接写 JavaScript 正则源码，由 UbootDetector 用 new RegExp(source, flags) 构造。
 * 详见 docs/regex-guide.md。
 */
export interface UbootYaml {
  autobootPrompts?: string[]; // autoboot 提示字符串数组，按数组顺序匹配；含 "Ctrl+u" 字样的条目 → 发送 \x15，其余 → 发送换行
  prompt?: string; // 命令提示符字符串，命中即判成功（主层）
  verifyEnvKeys?: string[]; // 提示符未命中时发 printenv 验证的环境变量键名数组（纯字面量，不走正则转换）
}

interface DeviceConfig {
  promptPattern?: string; // exec 提示符检测正则，覆盖默认正则；留空用 PromptDetector.DEFAULT_PATTERN
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
    uboot?: UbootYaml; // U-Boot 进入检测配置（可选，留空用默认值）
  };
}

interface RootConfig {
  default?: string; // 默认设备名
  devices?: Record<string, DeviceConfig>; // 设备配置字典，key 为设备名
}

/** 配置加载布局类型（仅加载层内部使用，不对外导出） */
type LoadedLayout = "single" | "split" | "none";

let _cached: RootConfig | null = null;

/**
 * @brief 解析设备分文件目录的绝对路径
 *
 * 设备目录始终相对主配置文件（BOARD_CONFIG_PATH）所在目录，
 * 即与主 config.yaml 同级的 devices/ 子目录。
 *
 * @param configPath 主配置文件路径
 * @returns 设备目录绝对路径
 */
function resolveDevicesDir(configPath: string): string {
  return resolve(dirname(resolve(configPath)), "devices");
}

/**
 * @brief 扫描 devices/ 目录，加载分文件布局的设备配置
 *
 * 将目录下每个 .yaml/.yml 文件视为一台设备，文件名（去扩展名）作为设备名。
 * 单个文件解析失败时跳过并告警，不中断整体加载。
 *
 * @param devicesDir 设备目录绝对路径
 * @returns 设备配置字典；目录不存在或无 .yaml 文件时返回 null（视为回退单文件布局）
 */
function loadSplitDevices(
  devicesDir: string
): Record<string, DeviceConfig> | null {
  if (!existsSync(devicesDir)) {
    return null;
  }
  // 仅识别 .yaml/.yml 文件，忽略目录与其它类型文件
  const yamlFiles = readdirSync(devicesDir).filter(
    (entry) => entry.endsWith(".yaml") || entry.endsWith(".yml")
  );
  if (yamlFiles.length === 0) {
    return null;
  }

  const devices: Record<string, DeviceConfig> = {};
  for (const entry of yamlFiles) {
    const filePath = resolve(devicesDir, entry);
    try {
      // 文件名（去扩展名）作为设备名
      const deviceName = entry.replace(/\.(ya?ml)$/, "");
      devices[deviceName] = load(
        readFileSync(filePath, "utf8")
      ) as DeviceConfig;
    } catch (err) {
      logger.warn(
        `Device config skipped (invalid): ${filePath} — ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }
  return devices;
}

function loadConfig(): RootConfig {
  if (_cached) return _cached;
  const configPath = process.env.BOARD_CONFIG_PATH ?? "config.yaml";
  const absPath = resolve(configPath);
  let root: RootConfig;
  let layout: LoadedLayout;
  try {
    root = load(readFileSync(absPath, "utf8")) as RootConfig;
    logger.info(`Config loaded: ${absPath}`);
  } catch {
    // 主配置文件不存在或解析失败：沿用原有兜底，返回空配置
    _cached = {};
    logger.warn(`Config not found or invalid: ${absPath}`);
    return _cached;
  }

  // 布局自动判定：devices/ 目录存在且含 .yaml 文件 → 分文件布局
  const splitDevices = loadSplitDevices(resolveDevicesDir(configPath));
  if (splitDevices !== null) {
    root.devices = splitDevices;
    layout = "split";
  } else {
    layout = "single";
  }
  logger.info(`Config layout: ${layout}`);
  _cached = root;
  return _cached;
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
 * @brief 获取设备的 exec 提示符检测正则
 *
 * 用于交互式 shell exec（adb_shell_exec / ssh_shell_exec / serial_exec）的
 * 命令结束判定。设备级配置，三个通道共享同一正则。
 *
 * 配置优先级：config.yaml 中 devices.<name>.promptPattern > 无（返回 undefined，
 * 由调用方使用 PromptDetector.DEFAULT_PATTERN 兜底）。
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 * @returns 提示符正则字符串，未配置时返回 undefined
 */
export function getPromptPattern(name?: string): string | undefined {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  return device.promptPattern;
}

/**
 * @brief 获取设备的 U-Boot 进入检测配置
 *
 * 用于 serial_enter_uboot 工具的提示符识别与事后验证。
 * 不做环境变量覆盖——U-Boot 配置仅从 yaml 读取（无对应环境变量的现实需求）。
 * 空对象 {} 由 UbootDetector 构造时回退到默认值。
 *
 * @param name 设备名（可选，默认使用 resolveDeviceName() 解析）
 * @returns U-Boot 配置片段，未配置 serial.uboot 时返回空对象
 */
export function getUbootConfig(name?: string): UbootYaml {
  const device = getDeviceConfig(name ?? resolveDeviceName());
  return device.serial?.uboot ?? {};
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
 * @brief 判定 adb 序列号（serialNo）字符串是否有效
 *
 * 无效形态（任一命中即视为无效，返回 false）：
 *   - undefined / null：调用方未拿到 serialNo
 *   - 空串或纯空白：trim 后为空
 *   - 全 "?" 字符（如 "????????????"）：硬件无序列号时 adb 的标准占位输出
 *   - "(auto)"：AdbShell.getSerialNo() 在未指定 serialNo 时的占位返回值
 *
 * 注意：本函数判定的是 "adb 序列号"，与 "串口（serial port）" 无关。
 *
 * @param serialNo 待判定的 serialNo 字符串
 * @returns true 表示有效，可参与反查或直接用作目录名；false 表示无效，调用方应走占位符降级
 */
export function isValidSerialNo(serialNo: string | undefined | null): boolean {
  // null/undefined 直接判无效
  if (serialNo == null) {
    return false;
  }
  // 空串或纯空白判无效
  if (serialNo.trim() === "") {
    return false;
  }
  // 全 ? 字符（硬件无序列号时 adb 的占位输出）判无效
  if (/^\?+$/.test(serialNo)) {
    return false;
  }
  // AdbShell.getSerialNo() 在未指定时的占位返回值，判无效
  if (serialNo === "(auto)") {
    return false;
  }
  return true;
}

/**
 * @brief 根据真实 adb serialNo 反查设备别名
 *
 * 遍历 config.yaml 的 devices 配置，对每个设备解析其 adb.serialNo
 * （去掉 sn_ 前缀，复用私有 parseSerialNo），与入参 serialNo 字面相等即命中。
 *
 * 多设备绑定同一 serialNo 的边界处理：
 *   - 返回**配置文件中先定义的那个**别名（JavaScript 保证 YAML 字符串键按插入顺序遍历）
 *   - 同时记录 WARNING 日志，提示用户配置可能存在重复绑定
 *
 * 注意：本函数处理的是 "adb 序列号"，与 "串口（serial port）" 无关。
 *
 * @param serialNo 真实 serialNo（建议先经 isValidSerialNo 判定为有效再传入）
 * @returns 命中的设备别名；未命中返回 undefined（由调用方决定降级策略）
 */
export function resolveDeviceNameBySerialNo(
  serialNo: string
): string | undefined {
  const devices = loadConfig().devices;
  // 无设备配置直接返回 undefined（loadConfig 失败时已降级为空对象）
  if (!devices) {
    return undefined;
  }
  // 遍历所有设备，收集所有匹配的别名（YAML 字符串键按插入顺序遍历）
  const matchedNames: string[] = [];
  for (const [name, cfg] of Object.entries(devices)) {
    const cfgSerialNo = parseSerialNo(cfg.adb?.serialNo);
    if (cfgSerialNo !== undefined && cfgSerialNo === serialNo) {
      matchedNames.push(name);
    }
  }
  // 多设备命中：返回先定义的别名，同时记录 WARNING 提示配置可能有误
  if (matchedNames.length > 1) {
    logger.warn(
      `[config] serialNo "${serialNo}" 绑定到多个设备别名：${matchedNames.join(", ")}；将使用先定义的 "${matchedNames[0]}"`
    );
  }
  // 返回首个命中的别名；未命中时 matchedNames[0] 为 undefined
  return matchedNames[0];
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
