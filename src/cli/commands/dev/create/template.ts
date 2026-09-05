/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : template.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: create 命令模板引擎 — 设备模板读取、段级行替换、yaml 校验、
 *              无冲突命名与写盘（plan/ch19 模块 C）
 * ======================================================
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { load } from "js-yaml";

// ============================================================
// 类型
// ============================================================

/**
 * @brief 单个模板字段的替换目标描述
 * @details 交互问答结果被折叠为该列表，交由 applyFieldReplacements 执行。
 *          通道未启用时只生成禁用约定字段（如 serial.port="none"），
 *          凭据类字段不生成替换项以保留模板原值。
 */
export interface FieldReplacement {
  section: "adb" | "ssh" | "serial"; // 顶层段名，限定搜索范围避免跨段误替换
  field: string; // 段内 2 空格缩进的字段名，如 "port"、"serialNo"
  value: string; // 最终 YAML 值文本：字符串带双引号，数字不带
}

// ============================================================
// 模板读取
// ============================================================

/**
 * @brief 读取设备配置模板文本
 * @details 模板文件不存在时抛出带明确提示的错误，由命令入口统一转为用户提示。
 * @param templatePath 模板文件路径
 * @returns 模板文件全文文本
 * @throws 模板文件不存在或读取失败时抛出
 */
export function loadTemplateText(templatePath: string): string {
  if (!existsSync(templatePath)) {
    throw new Error(`模板文件不存在: ${templatePath}`);
  }
  return readFileSync(templatePath, "utf8");
}

// ============================================================
// 段级行替换与校验
// ============================================================

/** 顶层段行正则：0 缩进的 `xxx:` 行，供状态机追踪当前所处段 */
const TOP_LEVEL_SECTION_RE = /^([A-Za-z][A-Za-z0-9_]*):\s*$/;

/**
 * @brief 转义正则元字符
 * @param text 原始文本
 * @returns 可安全拼入正则的文本
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @brief 构造单个字段的行匹配正则
 * @details 匹配「恰好 2 空格缩进 + 字段名 + :」，捕获值区与行内注释区：
 *          - 值区（group 2）：冒号后到行内注释前的全部内容
 *          - 注释区（group 3）：含前导空白的 `#...` 部分，替换时原样保留
 *          4 空格缩进的嵌套字段（如 uboot 子段）与整行注释因锚点不命中而天然跳过。
 * @param field 字段名
 * @returns 对应字段行的正则
 */
function buildFieldLineRegex(field: string): RegExp {
  return new RegExp(`^ {2}${escapeRegExp(field)}:[ \\t]*(.*?)([ \\t]+#.*)?$`);
}

/**
 * @brief 应用字段替换，生成新模板文本
 * @details 逐行状态机：遇 0 缩进的 `section:` 行更新当前段；在目标段内命中字段行时
 *          重写为「2 空格缩进 + 字段名 + 新值」，原样保留行内注释与其它任何行。
 *          每个替换项统计命中次数，任一项 0 次命中即抛错——防止模板结构漂移时
 *          静默漏替换（plan/ch19 N2）。
 * @param templateText 模板全文
 * @param replacements 替换目标列表
 * @returns 替换后的完整文本
 * @throws 任一替换项在模板中未命中时抛出，消息指明缺失的 section.field
 */
export function applyFieldReplacements(
  templateText: string,
  replacements: FieldReplacement[]
): string {
  // 命中计数，key 为 `${section}.${field}`，用于事后完备性校验
  const hitCounts = new Map<string, number>();
  for (const rep of replacements) {
    hitCounts.set(`${rep.section}.${rep.field}`, 0);
  }

  // 为每个替换项预编译行正则，扫描时按当前段命中
  const compiled = replacements.map((rep) => ({
    rep,
    regex: buildFieldLineRegex(rep.field),
    key: `${rep.section}.${rep.field}`,
  }));

  let currentSection = "";
  const outLines = templateText.split("\n").map((line) => {
    // 0 缩进的 `xxx:` 行 → 仅更新当前段，不改写
    const sectionMatch = line.match(TOP_LEVEL_SECTION_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      return line;
    }

    for (const item of compiled) {
      if (item.rep.section !== currentSection) {
        continue;
      }
      const fieldMatch = line.match(item.regex);
      if (!fieldMatch) {
        continue;
      }
      hitCounts.set(item.key, (hitCounts.get(item.key) ?? 0) + 1);
      const comment = fieldMatch[2] ?? "";
      return `  ${item.rep.field}: ${item.rep.value}${comment}`;
    }
    return line;
  });

  // 完备性校验：任一替换项未命中即失败，不产出半替换内容
  const missing = [...hitCounts.entries()]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`模板中未找到目标字段: ${missing.join(", ")}`);
  }

  return outLines.join("\n");
}

/**
 * @brief 校验生成内容可被解析且结构完整
 * @details 用 js-yaml 解析；解析失败或缺 adb/ssh/serial 任一段均抛错，
 *          由入口保证不落盘（plan/ch19 N2）。
 * @param content 待校验的 yaml 文本
 * @throws 解析失败或段缺失时抛出
 */
export function validateYaml(content: string): void {
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch (err) {
    throw new Error(
      `生成的 yaml 无法解析: ${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("生成的 yaml 结构为空");
  }
  const root = parsed as Record<string, unknown>;
  for (const section of ["adb", "ssh", "serial"] as const) {
    if (!(section in root)) {
      throw new Error(`生成的 yaml 缺少 ${section} 段`);
    }
  }
}

// ============================================================
// 无冲突命名与写盘
// ============================================================

/** 同名递增探测的防御性上限，防止极端目录下无限循环 */
const MAX_NAME_PROBES = 9999;

/**
 * @brief 在设备目录内解析首个不冲突的目标文件路径
 * @details 依次探测 `<baseName>.yaml`、`<baseName>-2.yaml`、`<baseName>-3.yaml`…，
 *          返回首个不存在的绝对路径。供 -y 快速模式的固定名 `board-default` 使用，
 *          保证同名自动递增、绝不覆盖（plan/ch19 F10）。
 * @param devicesDir 设备目录
 * @param baseName 设备基础名（不含扩展名）
 * @returns 首个无冲突的文件绝对路径
 * @throws 超过探测上限仍未找到可用名称时抛出
 */
export function resolveNonConflictingPath(
  devicesDir: string,
  baseName: string
): string {
  for (let index = 1; index <= MAX_NAME_PROBES; index++) {
    const fileName =
      index === 1 ? `${baseName}.yaml` : `${baseName}-${index}.yaml`;
    const candidatePath = resolve(devicesDir, fileName);
    if (!existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error(
    `无法为 "${baseName}" 找到未占用的文件名（上限 ${MAX_NAME_PROBES}）`
  );
}

/**
 * @brief 写入设备配置文件
 * @details 内容先统一归一为 LF 换行，再以 utf8（无 BOM）写入，
 *          保证生成文件跨平台一致（plan/ch19 N3）。
 * @param filePath 目标文件绝对路径
 * @param content 待写入的 yaml 文本
 */
export function writeDeviceFile(filePath: string, content: string): void {
  const normalized = content.replace(/\r\n/g, "\n");
  writeFileSync(filePath, normalized, "utf8");
}
