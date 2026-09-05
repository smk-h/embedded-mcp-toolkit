/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : list.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: dev list 命令 —— 设备列表与通道状态摘要
 *
 * 扫描 .embedded/configs/devices/ 下全部设备 yaml，按通道禁用约定
 * （port/host="none"、serialNo="sn_none"）判定各通道是否启用，以
 * 端口@波特率 / 用户名@主机 / 序列号形式展示连接参数（禁用显示 -），
 * 输出含模板/默认标注的对齐表格。纯只读命令。
 * ======================================================
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { load } from "js-yaml";

// ============================================================
// 常量
// ============================================================

const DEVICES_DIR = ".embedded/configs/devices"; // 设备目录（与 dev create 约定一致）
const CONFIG_PATH = ".embedded/configs/config.yaml"; // 读取 default 字段的主配置
const TEMPLATE_DEVICE_NAME = "board-example"; // dev create 的固定模板名

// ============================================================
// 类型
// ============================================================

/** 单台设备的列表行（三通道展示文本） */
interface DeviceRow {
  name: string; // 设备名（文件名去 .yaml/.yml 扩展名）
  serial: string; // SERIAL 列文本："端口@波特率"（如 COM3@115200），禁用为 "-"
  ssh: string; // SSH 列文本："用户名@主机"（如 root@10.0.0.2），禁用为 "-"
  adb: string; // ADB 列文本：序列号（如 sn_123456），禁用为 "-"
}

/** 扫描结果：设备行 + 解析失败的文件（告警来源） */
interface ScanResult {
  rows: DeviceRow[]; // 按设备名字典序排列
  invalidFiles: { file: string; reason: string }[]; // 解析失败的文件
}

// ============================================================
// 扫描与通道展示文本生成
// ============================================================

/**
 * @brief 判定通道字段值是否为禁用态
 * @details 值缺失（undefined/null）、空串或命中约定禁用值（"none"/"sn_none"）
 *          均视为禁用；通道段整体缺失时取值即 undefined，天然归入禁用。
 *          串口 port 的 tcp:// 端点形态不在禁用值之列，计为启用。
 *
 * @param value 字段原始值（可能为字符串/数字/缺失）
 * @param offValues 该通道的禁用约定值列表
 * @returns 禁用返回 true
 */
function isDisabled(value: unknown, offValues: string[]): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  return offValues.includes(String(value));
}

/**
 * @brief 判定字段值是否存在（非缺失、非空）
 * @details isDisabled 的反义便捷封装（禁用值表为空），用于波特率、
 *          用户名等"有则展示、缺则省略"的可选字段。
 *
 * @param value 字段原始值
 * @returns 存在且非空返回 true
 */
function hasValue(value: unknown): boolean {
  return !isDisabled(value, []);
}

/**
 * @brief 读取设备配置中指定通道段的指定字段值
 * @details 段缺失或非对象时返回 undefined，交由 isDisabled 归入禁用。
 *
 * @param cfg 解析后的设备配置根对象
 * @param section 顶层段名（serial/ssh/adb）
 * @param field 段内字段名（port/host/serialNo）
 * @returns 字段原始值；段/字段缺失时为 undefined
 */
function fieldOf(
  cfg: Record<string, unknown>,
  section: string,
  field: string
): unknown {
  const sec = cfg[section];
  if (sec === undefined || sec === null || typeof sec !== "object") {
    return undefined;
  }
  return (sec as Record<string, unknown>)[field];
}

/**
 * @brief 生成 SERIAL 列展示文本
 * @details 启用时为 "端口@波特率"，波特率缺失时仅显示端口；禁用时为 "-"。
 *          tcp:// 端点不在禁用值之列，原样展示。
 *
 * @param cfg 解析后的设备配置根对象
 * @returns 展示文本
 */
function formatSerial(cfg: Record<string, unknown>): string {
  const port = fieldOf(cfg, "serial", "port");
  if (isDisabled(port, ["none"])) {
    return "-";
  }
  const baud = fieldOf(cfg, "serial", "baudRate");
  return hasValue(baud) ? `${String(port)}@${String(baud)}` : String(port);
}

/**
 * @brief 生成 SSH 列展示文本
 * @details 启用时为 "用户名@主机"，用户名缺失时仅显示主机；禁用时为 "-"。
 *
 * @param cfg 解析后的设备配置根对象
 * @returns 展示文本
 */
function formatSsh(cfg: Record<string, unknown>): string {
  const host = fieldOf(cfg, "ssh", "host");
  if (isDisabled(host, ["none"])) {
    return "-";
  }
  const user = fieldOf(cfg, "ssh", "username");
  return hasValue(user) ? `${String(user)}@${String(host)}` : String(host);
}

/**
 * @brief 生成 ADB 列展示文本（序列号原样，禁用时为 "-"）
 *
 * @param cfg 解析后的设备配置根对象
 * @returns 展示文本
 */
function formatAdb(cfg: Record<string, unknown>): string {
  const sn = fieldOf(cfg, "adb", "serialNo");
  return isDisabled(sn, ["sn_none"]) ? "-" : String(sn);
}

/**
 * @brief 扫描设备目录，解析每台设备并生成三通道展示文本
 * @details 仅识别 .yaml/.yml 文件，文件名（去扩展名）作为设备名。
 *          单个文件解析失败时计入 invalidFiles 并跳过，不中断整体
 *          （对齐 sdk loadSplitDevices 的容错约定）。结果按设备名字典序排列。
 *
 * @param devicesDir 设备目录路径
 * @returns 扫描结果（设备行 + 坏文件列表）
 */
function scanDevices(devicesDir: string): ScanResult {
  const yamlFiles = readdirSync(devicesDir).filter(
    (entry) => entry.endsWith(".yaml") || entry.endsWith(".yml")
  );
  const rows: DeviceRow[] = [];
  const invalidFiles: { file: string; reason: string }[] = [];

  for (const entry of yamlFiles) {
    const deviceName = entry.replace(/\.(ya?ml)$/, "");
    try {
      const cfg = load(readFileSync(join(devicesDir, entry), "utf8")) as Record<
        string,
        unknown
      >;
      rows.push({
        name: deviceName,
        serial: formatSerial(cfg),
        ssh: formatSsh(cfg),
        adb: formatAdb(cfg),
      });
    } catch (err) {
      invalidFiles.push({
        file: entry,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, invalidFiles };
}

// ============================================================
// 标注解析与表格输出
// ============================================================

/**
 * @brief 读取主配置中的默认设备名
 * @details config.yaml 不存在、解析失败或 default 非非空字符串时一律返回
 *          null（静默降级，不报错不标注，spec F5）。
 *
 * @param configPath 主配置文件路径
 * @returns 默认设备名；无法确定时为 null
 */
function resolveDefaultDevice(configPath: string): string | null {
  try {
    if (!existsSync(configPath)) {
      return null;
    }
    const root = load(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const def = root.default;
    return typeof def === "string" && def !== "" ? def : null;
  } catch {
    // 主配置缺失/损坏时静默降级为无默认标注（spec F5 约定，不中断列表）
    return null;
  }
}

/**
 * @brief 计算字符串的终端显示宽度
 * @details 东亚全宽字符（如"模板"）按 2 列计，其余按 1 列计；
 *          String.padEnd 按字符数填充，直接用于含中文的列会导致错位。
 *
 * @param text 待测量字符串
 * @returns 终端显示宽度（列数）
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return width;
}

/**
 * @brief 按显示宽度右填充空格至指定列宽
 *
 * @param text 原字符串
 * @param width 目标列宽（显示宽度）
 * @returns 填充后的字符串
 */
function padEndByWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * @brief 渲染设备列表表格
 * @details NAME 列 = 设备名 + 标注（模板/默认）；四列宽度均按终端显示宽度
 *          自适应（东亚全宽字符按 2 列计），列间 2 空格分隔；
 *          末尾输出总数、图例与坏文件告警。
 *
 * @param result 扫描结果
 * @param defaultDevice 默认设备名；null 表示不标注
 */
function renderList(result: ScanResult, defaultDevice: string | null): void {
  // 名称列内容 = 设备名 + 标注（模板/默认），一次映射完成
  const lines = result.rows.map((row) => {
    const tags: string[] = [];
    if (row.name === TEMPLATE_DEVICE_NAME) {
      tags.push("(模板)");
    }
    if (defaultDevice !== null && row.name === defaultDevice) {
      tags.push("(默认)");
    }
    return {
      ...row,
      display: tags.length > 0 ? `${row.name} ${tags.join(" ")}` : row.name,
    };
  });

  // 四列单元格矩阵（含表头），逐列取最大显示宽度作为列宽
  const headers = ["NAME", "SERIAL", "SSH", "ADB"];
  const cells = lines.map((line) => [
    line.display,
    line.serial,
    line.ssh,
    line.adb,
  ]);
  const widths = headers.map((header, col) =>
    Math.max(
      displayWidth(header),
      ...cells.map((row) => displayWidth(row[col]))
    )
  );

  const renderRow = (row: string[]): string =>
    `  ${row
      .map((cell, col) => padEndByWidth(cell, widths[col]))
      .join("  ")
      .trimEnd()}`;

  console.log(renderRow(headers));
  for (const row of cells) {
    console.log(renderRow(row));
  }
  console.log(`\n  共 ${lines.length} 台设备`);
  console.log("  - 表示通道禁用/未配置");
  for (const bad of result.invalidFiles) {
    console.log(`  ⚠️ 跳过无效配置: ${bad.file} — ${bad.reason}`);
  }
}

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 打印命令行参数日志
 * @details 与 create/split 的同名助手逐字同风格，便于排查命令行参数解析。
 *
 * @param cmd 命令名
 * @param opts 解析后的选项对象
 */
function logCommand(cmd: string, opts: object): void {
  const parts: string[] = [`embedded-mcp-toolkit ${cmd}`];
  for (const [key, value] of Object.entries(opts)) {
    if (value === false || value === undefined) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    if (value === true) {
      parts.push(flag);
    } else {
      parts.push(`${flag} ${value}`);
    }
  }
  const cmdLine = parts.join(" ");
  console.log(`[${cmd}] 命令: ${cmdLine}`);
  console.log(`[${cmd}] 参数个数: ${process.argv.slice(2).length}`);
  console.log(`[${cmd}] 解析后参数:`, JSON.stringify(opts, null, 2));
}

/**
 * @brief 执行 dev list 命令
 * @details 流程编排（plan/ch20 模块 A）：banner → 目录存在性检查 →
 *          扫描与状态判定 → 默认设备解析 → 表格渲染。
 *          目录缺失或无设备 yaml 时打印引导提示并正常返回（spec F2）。
 *          全程只读，不写入任何文件（spec N1）。
 */
export function runList(): void {
  logCommand("list", {});

  console.log("\n📋 embedded-mcp-toolkit 设备列表");
  console.log(`   目录: ${DEVICES_DIR}\n`);

  if (!existsSync(DEVICES_DIR)) {
    console.log("⚠️  设备目录不存在");
    console.log("   可先运行 dev create 创建设备配置\n");
    return;
  }

  const result = scanDevices(DEVICES_DIR);
  if (result.rows.length === 0) {
    console.log("⚠️  未发现任何设备 yaml");
    console.log("   可先运行 dev create 创建设备配置\n");
    return;
  }

  const defaultDevice = resolveDefaultDevice(CONFIG_PATH);
  renderList(result, defaultDevice);
}
