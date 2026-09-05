/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: dev del 命令 —— 交互式删除设备配置文件
 *
 * 扫描 .embedded/configs/devices/ 下全部设备 yaml 作为候选（模板
 * board-example 禁止删除，扫描阶段即剔除），经 autocompleteMultiselect
 * 关键词过滤 + Tab 勾选（单选/多选）后，confirm 二次确认（默认 No）
 * 才执行批量删除。文件级操作，不解析 yaml 内容。删除不可恢复。
 * ======================================================
 */

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

import {
  autocompleteMultiselect,
  cancel,
  confirm,
  isCancel,
  log,
} from "@clack/prompts";

// ============================================================
// 常量与类型
// ============================================================

const DEVICES_DIR = ".embedded/configs/devices"; // 设备目录（与 create/list 约定一致）
const TEMPLATE_DEVICE_NAME = "board-example"; // dev create 的固定模板名，禁止删除

/** 删除候选（文件级，不解析内容） */
interface DeviceCandidate {
  name: string; // 设备名（文件名去 .yaml/.yml 扩展名）
  filePath: string; // 文件路径（join(DEVICES_DIR, 文件名)）
}

// ============================================================
// 候选扫描与匹配
// ============================================================

/**
 * @brief 扫描设备目录，生成删除候选列表
 * @details 仅识别 .yaml/.yml 文件，文件名（去扩展名）作为设备名。
 *          模板 board-example 在此直接剔除，从源头杜绝模板进入
 *          候选列表（spec F2，用户明确要求禁止删除模板）。
 *          不解析文件内容——删除是文件级操作，坏 yaml 同样可删。
 *          结果按设备名字典序排列。
 *
 * @param devicesDir 设备目录路径
 * @returns 候选列表（不含模板）
 */
function scanCandidates(devicesDir: string): DeviceCandidate[] {
  const yamlFiles = readdirSync(devicesDir).filter(
    (entry) => entry.endsWith(".yaml") || entry.endsWith(".yml")
  );
  return yamlFiles
    .filter((entry) => entry.replace(/\.(ya?ml)$/, "") !== TEMPLATE_DEVICE_NAME)
    .map((entry) => ({
      name: entry.replace(/\.(ya?ml)$/, ""),
      filePath: join(devicesDir, entry),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @brief 判断设备名是否命中搜索关键词
 * @details 大小写不敏感的子串匹配，作为 autocomplete 的自定义 filter
 *          （spec F3）；显式自定义避免依赖库默认匹配行为的不确定性。
 *
 * @param search 用户输入的搜索关键词
 * @param label 候选项展示文本（即设备名）
 * @returns 命中返回 true
 */
function matchName(search: string, label: string): boolean {
  return label.toLowerCase().includes(search.toLowerCase());
}

/**
 * @brief 以灰色（ANSI Bright Black）包装文本
 * @details 用于弱化交互提示中的辅助说明文字；ANSI 输出能力由 clack
 *          依赖自身启用（VT100 兼容终端 / Windows Terminal）。
 *
 * @param text 待包装文本
 * @returns 带灰色前后缀的文本
 */
function gray(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 打印命令行参数日志
 * @details 与 create/list 的同名助手逐字同风格，便于排查命令行参数解析。
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
 * @brief 取消场景的统一退出
 * @details 与 create 命令同款约定：打印取消提示后以 0 退出，
 *          保证不删除任何文件（spec F5/N1）。
 */
function exitOnCancel(): never {
  cancel("已取消");
  process.exit(0);
}

/**
 * @brief 执行 dev del 命令
 * @details 流程编排（plan/ch21 模块 A）：banner → 目录存在性检查 →
 *          候选扫描（剔除模板，空则提示返回）→ autocompleteMultiselect
 *          过滤多选（Tab 勾选，空选视为取消）→ confirm 二次确认（默认 No）→
 *          逐个 unlink 与汇总反馈。任一环节取消或拒绝都不删除任何
 *          文件（spec F5）。
 */
export async function runDel(): Promise<void> {
  logCommand("del", {});

  console.log("\n🗑️  embedded-mcp-toolkit 设备删除");
  console.log(`   目录: ${DEVICES_DIR}\n`);

  if (!existsSync(DEVICES_DIR)) {
    log.warning("设备目录不存在");
    log.info("可先运行 dev create 创建设备配置");
    return;
  }

  const candidates = scanCandidates(DEVICES_DIR);
  if (candidates.length === 0) {
    log.warning("无可删除的设备配置（模板 board-example 不可删除）");
    log.info("可先运行 dev create 创建设备配置");
    return;
  }

  // 过滤多选：输入框实时过滤 + 上下键移动 + Tab 勾选（可多选）+ 回车提交（spec F3；clack 的勾选键为 Tab，空格输入到搜索框）
  // 括号内的操作提示为辅助说明，以灰色弱化显示
  const selected: string[] | symbol = await autocompleteMultiselect({
    message: `选择要删除的设备${gray("（输入关键词过滤，Tab 勾选可多选，回车提交）")}`,
    options: candidates.map((candidate) => ({
      value: candidate.name,
      label: candidate.name,
      hint: `${candidate.name}.yaml`,
    })),
    filter: (search, option) =>
      matchName(search, String(option.label ?? option.value)),
    maxItems: 8,
  });
  if (isCancel(selected)) {
    exitOnCancel();
  }
  if (selected.length === 0) {
    // required 默认 false：空选提交视为取消，不进入确认（spec F3）
    log.info("未选择任何设备，已取消");
    return;
  }

  // 回填选中候选，删除/确认文案使用扫描所得真实路径（兼容 .yml 扩展名）
  const targets = selected
    .map((name) => candidates.find((c) => c.name === name))
    .filter((c): c is DeviceCandidate => c !== undefined);
  if (targets.length === 0) {
    log.error("内部错误：选中的设备不在候选列表中");
    return;
  }

  // 二次确认：默认 No，回车直落即不删（spec F4，保守默认）
  const names = targets.map((t) => t.name).join("、");
  const confirmed: boolean | symbol = await confirm({
    message: `确定删除 ${targets.length} 台设备：${names}？对应文件将被删除且不可恢复`,
    initialValue: false,
  });
  if (isCancel(confirmed)) {
    exitOnCancel();
  }
  if (!confirmed) {
    log.info("已取消，未删除任何文件");
    return;
  }

  // 批量删除执行：路径来自候选扫描所得（设备目录内，spec N2）；
  // 单个失败不影响其余目标，最后汇总成功与失败明细（spec F5）
  const deleted: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const target of targets) {
    try {
      unlinkSync(target.filePath);
      deleted.push(target.name);
    } catch (err) {
      // 文件被外部删除/占用/权限不足等极端场景：记录后继续处理其余目标
      failed.push({
        name: target.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (deleted.length > 0) {
    log.success(`已删除 ${deleted.length} 台设备: ${deleted.join("、")}`);
  }
  for (const item of failed) {
    log.error(`删除失败 ${item.name}: ${item.reason}`);
  }
  if (failed.length === 0) {
    log.info("可运行 dev list 查看剩余设备");
  }
}
