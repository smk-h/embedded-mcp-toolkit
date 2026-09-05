/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: create 命令入口 — 交互式创建新设备配置文件的流程编排
 *
 * 读取 board-example.yaml 模板，交互采集设备名与串口/SSH/ADB 三通道连接参数，
 * 以段级行替换生成 <设备名>.yaml（保留模板全部注释与未涉及段）；支持 -y 快速
 * 模式免交互生成 board-default.yaml（同名自动递增后缀，绝不覆盖）。
 * ======================================================
 */

import { resolve } from "path";

import { log } from "@clack/prompts";

import {
  applyFieldReplacements,
  loadTemplateText,
  resolveNonConflictingPath,
  validateYaml,
  writeDeviceFile,
  type FieldReplacement,
} from "./template.js";
import {
  askAdbSerialNo,
  askCredential,
  askDeviceName,
  askSerialConnection,
  askSshConnection,
  type Credential,
  type SerialConn,
  type SshConn,
} from "./prompts.js";

// ============================================================
// 选项与常量
// ============================================================

/**
 * @brief create 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 */
export interface CreateOptions {
  yes: boolean; // -y 快速模式：免交互直接生成 board-default.yaml
}

/** 设备配置模板路径（spec 固定，不做自定义） */
const TEMPLATE_PATH = ".embedded/configs/devices/board-example.yaml";

/** 设备配置目录（生成文件与模板同目录） */
const DEVICES_DIR = ".embedded/configs/devices";

/** -y 快速模式的固定默认设备名（spec F10） */
const DEFAULT_DEVICE_NAME = "board-default";

// ============================================================
// 替换项折叠
// ============================================================

/**
 * @brief 为 YAML 字符串值包裹双引号
 * @details 模板中字符串字段均带双引号（如 host: "none"），数字字段不带，
 *          生成文件与模板风格同构。
 * @param value 原始字符串值
 * @returns 带双引号的 YAML 值文本
 */
function quote(value: string): string {
  return `"${value}"`;
}

/**
 * @brief 折叠串口问答结果为替换项列表
 * @details 未启用时仅生成 port="none" 禁用约定字段，baudRate 与凭据保留模板值；
 *          启用时凭据必答（可为空 → none）（spec F4/F5）。
 * @param conn 串口连接问答结果；null 表示未启用
 * @param cred 串口凭据问答结果；未启用通道时为 null
 * @returns 串口段替换项列表
 */
function buildSerialReplacements(
  conn: SerialConn | null,
  cred: Credential | null
): FieldReplacement[] {
  if (!conn) {
    return [{ section: "serial", field: "port", value: quote("none") }];
  }
  const login = cred ?? { username: "none", password: "none" };
  return [
    { section: "serial", field: "port", value: quote(conn.port) },
    { section: "serial", field: "baudRate", value: String(conn.baudRate) },
    { section: "serial", field: "loginUsername", value: quote(login.username) },
    { section: "serial", field: "loginPassword", value: quote(login.password) },
  ];
}

/**
 * @brief 折叠 SSH 问答结果为替换项列表
 * @details 未启用时仅生成 host="none" 禁用约定字段，port 与凭据保留模板值；
 *          启用时凭据必填非空（spec F6/F7）。
 * @param conn SSH 连接问答结果；null 表示未启用
 * @param cred SSH 凭据问答结果；未启用通道时为 null
 * @returns SSH 段替换项列表
 */
function buildSshReplacements(
  conn: SshConn | null,
  cred: Credential | null
): FieldReplacement[] {
  if (!conn) {
    return [{ section: "ssh", field: "host", value: quote("none") }];
  }
  return [
    { section: "ssh", field: "host", value: quote(conn.host) },
    { section: "ssh", field: "port", value: String(conn.port) },
    { section: "ssh", field: "username", value: quote(cred?.username ?? "") },
    { section: "ssh", field: "password", value: quote(cred?.password ?? "") },
  ];
}

// ============================================================
// 摘要输出
// ============================================================

/**
 * @brief 摘要输出的单行片段
 */
interface SummaryRow {
  label: string; // 通道名（串口/SSH/ADB）
  detail: string; // 启用状态与关键参数描述
}

/**
 * @brief 打印生成结果摘要
 * @param deviceName 设备名
 * @param targetPath 生成文件的展示路径
 * @param rows 各通道摘要行
 */
function printSummary(
  deviceName: string,
  targetPath: string,
  rows: SummaryRow[]
): void {
  console.log(`
✅ 设备配置已生成: ${targetPath}`);
  console.log(`   设备名: ${deviceName}`);
  for (const row of rows) {
    console.log(`   ${row.label}: ${row.detail}`);
  }
  console.log("");
}

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 执行 create 命令
 * @details 流程编排（plan/ch19 模块 A）：模板加载 → -y 快速路径或交互问答 →
 *          内存替换与校验 → 一次性写盘 → 摘要输出。任一环节失败即中断，
 *          不落盘、不留半成品。
 *
 * @param opts 由 Commander 解析后传入的选项对象
 */
export async function runCreate(opts: CreateOptions): Promise<void> {
  logCommand("create", opts);

  console.log(`
🛠  embedded-mcp-toolkit 设备配置创建`);
  console.log(`   模板: ${TEMPLATE_PATH}`);
  console.log(
    `   模式: ${opts.yes ? "快速模式（-y，免交互生成 board-default）" : "交互模式"}\n`
  );

  // 模板加载（F2）：模板不存在即报错退出，不生成文件
  let templateText: string;
  try {
    templateText = loadTemplateText(TEMPLATE_PATH);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  // -y 快速模式（F10）：固定名 board-default + 同名递增，模板原文直落
  if (opts.yes) {
    const targetPath = resolveNonConflictingPath(
      DEVICES_DIR,
      DEFAULT_DEVICE_NAME
    );
    try {
      validateYaml(templateText);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    writeDeviceFile(targetPath, templateText);
    printSummary(DEFAULT_DEVICE_NAME, targetPath, [
      { label: "串口", detail: "模板原值（可后续手改）" },
      { label: "SSH ", detail: "模板原值（可后续手改）" },
      { label: "ADB ", detail: "模板原值（可后续手改）" },
    ]);
    return;
  }

  // 交互问答（F3-F8）
  const deviceName = await askDeviceName(DEVICES_DIR);
  const serialConn = await askSerialConnection();
  const serialCred = serialConn
    ? await askCredential("串口登录 用户名@密码", false)
    : null;
  const sshConn = await askSshConnection();
  const sshCred = sshConn
    ? await askCredential("SSH 登录 用户名@密码", true)
    : null;
  const adbSerialNo = await askAdbSerialNo();

  // 折叠替换项 → 段级行替换 → 解析校验（F9/N2），全部在内存完成后写盘（N4）
  const replacements: FieldReplacement[] = [
    ...buildSerialReplacements(serialConn, serialCred),
    ...buildSshReplacements(sshConn, sshCred),
    { section: "adb", field: "serialNo", value: quote(adbSerialNo) },
  ];
  let content: string;
  try {
    content = applyFieldReplacements(templateText, replacements);
    validateYaml(content);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return;
  }
  const targetPath = resolve(DEVICES_DIR, `${deviceName}.yaml`);
  writeDeviceFile(targetPath, content);

  // 摘要输出
  const serialEnabled = serialConn !== null;
  const sshEnabled = sshConn !== null;
  printSummary(deviceName, targetPath, [
    {
      label: "串口",
      detail: serialEnabled
        ? `✅ 启用  ${serialConn.port}@${serialConn.baudRate}  登录 ${serialCred?.username ?? "none"}`
        : "⛔ 禁用（port=none）",
    },
    {
      label: "SSH ",
      detail: sshEnabled
        ? `✅ 启用  ${sshConn.host}:${sshConn.port}  登录 ${sshCred?.username ?? ""}`
        : "⛔ 禁用（host=none）",
    },
    { label: "ADB ", detail: adbSerialNo },
  ]);
}

/**
 * @brief 打印命令调用信息
 * @details 与 split.ts 的 logCommand 风格一致，便于排查命令行参数解析。
 *
 * @param cmd  子命令名（"create"）
 * @param opts 由 Commander 解析后的选项对象
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
