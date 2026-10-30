/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : log-rotation.ts
 * Author     : sumu
 * Date       : 2026/10/30
 * Version    : x.x.x
 * Description: 日志文件按大小分段（滚动）工具
 *
 *   会话日志（FileLogger）与业务日志（Logger）都会在 MCP 进程存活期间
 *   持续追加同一个文件，长会话/长驻进程会把单文件涨到上百兆甚至上 G。
 *   本模块提供统一的分段策略：
 *     - 单文件上限由 LOG_MAX_SIZE_MB 控制（MB，可带小数；0/none/空=不限）
 *     - 首段沿用原始文件名（如 2026-10-30_155702.log）
 *     - 写满后自动切到 _001、_002… 后缀段（2026-10-30_155702_001.log）
 *     - LogRotator 只负责「路径 + 字节数」记账，流的打开/关闭与
 *       落盘方式（WriteStream / appendFileSync）仍由调用方掌握
 * ======================================================
 */

import { readdirSync } from "fs";
import { join, parse } from "path";

/** 单文件默认上限（MB）：未显式配置 LOG_MAX_SIZE_MB 时使用 */
const DEFAULT_MAX_SIZE_MB = 10;

/** 分段序号补零宽度（_001/_002…）；序号超过 999 时自然加宽为 _1000 */
const PART_PAD_WIDTH = 3;

/**
 * @brief 解析单文件大小上限（字节）
 *
 * 读取环境变量 LOG_MAX_SIZE_MB：
 *   - 未设置 / 空串 / "none" / "off" / "0" / 非法值 → 0（不限制）
 *   - 正数（可带小数，如 0.5 表示 512KB）→ 换算为字节
 *
 * 未设置时使用默认上限（DEFAULT_MAX_SIZE_MB）。非法值静默回落默认值：
 * 本模块不依赖 logger（logger 反向依赖本模块，引入会形成循环导入）。
 *
 * @returns 单文件字节上限；0 表示不限制
 */
export function resolveMaxLogBytes(): number {
  const raw = process.env.LOG_MAX_SIZE_MB;
  // 未配置 → 默认上限
  if (raw === undefined) {
    return Math.floor(DEFAULT_MAX_SIZE_MB * 1024 * 1024);
  }
  const trimmed = raw.trim();
  // 空串按未配置处理，保留默认上限（避免误配成"不限"导致日志再次失控）
  if (trimmed === "") {
    return Math.floor(DEFAULT_MAX_SIZE_MB * 1024 * 1024);
  }
  // 显式关闭分段
  if (/^(none|off|0)$/i.test(trimmed)) {
    return 0;
  }
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb <= 0) {
    return Math.floor(DEFAULT_MAX_SIZE_MB * 1024 * 1024);
  }
  return Math.floor(mb * 1024 * 1024);
}

/**
 * @brief 分段序号标签（补零到 3 位）
 *
 * @param part 分段序号，0 表示首段
 * @returns 如 "001"、"012"、"1000"
 */
export function formatPartSuffix(part: number): string {
  return String(part).padStart(PART_PAD_WIDTH, "0");
}

/**
 * @brief 由首段路径推导第 part 段的路径
 *
 * 分段规则：在扩展名前插入 _001/_002…，扩展名与目录保持不变。
 *   - part = 0 → 原路径（2026-10-30_155702.log）
 *   - part = 1 → 2026-10-30_155702_001.log
 *   - part = 2 → 2026-10-30_155702_002.log
 *
 * @param basePath 首段日志文件的完整路径
 * @param part     分段序号（0 = 首段）
 * @returns 该分段对应的完整路径
 */
export function segmentLogPath(basePath: string, part: number): string {
  if (part <= 0) return basePath;
  const { dir, name, ext } = parse(basePath);
  return join(dir, `${name}_${formatPartSuffix(part)}${ext}`);
}

/** 磁盘上某个日志前缀的分段快照 */
export interface LogSegments {
  /** 已存在的分段路径，按分段序号升序（首段在前） */
  paths: string[];
  /** 序号最大的分段（即最新的一段）；磁盘上无任何分段时为 null */
  latest: string | null;
  /** 已存在的分段数量（含首段） */
  count: number;
}

/**
 * @brief 正则元字符转义（文件名可能含 . + ( ) 等字符）
 *
 * @param text 原始文本
 * @returns 可直接放进正则字面量的文本
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @brief 列出某个日志前缀在磁盘上已存在的所有分段
 *
 * 日志按大小滚动后，同一目录下会并存 base.log、base_001.log…
 * 本函数按分段序号升序返回，供上层告知客户端「共有几段、哪一段最新」，
 * 避免客户端只拿到首段（最旧）路径而读不到最新内容。
 *
 * 目录不存在或不可读时返回空结果——日志未启用或尚未落盘属正常情况，
 * 不抛异常、不打扰调用方。
 *
 * @param basePath 首段日志文件的完整路径
 * @returns 分段信息（升序路径、最新段、数量）
 */
export function listLogSegments(basePath: string): LogSegments {
  const { dir, name, ext } = parse(basePath);
  // 只匹配本前缀：base.log 或 base_001.log（序号至少 3 位，与命名规则对齐）
  const pattern = new RegExp(
    `^${escapeRegExp(name)}(?:_(\\d{3,}))?${escapeRegExp(ext)}$`
  );
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { paths: [], latest: null, count: 0 };
  }

  const found: Array<{ part: number; path: string }> = [];
  for (const entry of entries) {
    const matched = pattern.exec(entry);
    if (!matched) continue;
    found.push({
      part: matched[1] ? Number(matched[1]) : 0,
      path: join(dir, entry),
    });
  }
  found.sort((a, b) => a.part - b.part);
  return {
    paths: found.map((f) => f.path),
    latest: found.length > 0 ? found[found.length - 1].path : null,
    count: found.length,
  };
}

/**
 * @brief 日志分段记账器
 *
 * 只维护「当前是第几段」与「当前段已写多少字节」，不做任何 IO。
 * 调用方写入前问 shouldRotate()，需要滚动时调 rotate() 换段，
 * 写入后用 account() 累加实际写入的字节数。
 */
export class LogRotator {
  /** 首段日志路径（原始文件名，不含 _NNN 后缀） */
  readonly basePath: string;
  /** 单段字节上限，0 表示不限制 */
  readonly maxBytes: number;

  /** 当前分段序号，0 = 首段 */
  #part = 0;
  /** 当前分段已写入字节数 */
  #bytes = 0;

  /**
   * @param basePath 首段日志文件的完整路径
   * @param maxBytes 单段字节上限，缺省读 LOG_MAX_SIZE_MB
   */
  constructor(basePath: string, maxBytes: number = resolveMaxLogBytes()) {
    this.basePath = basePath;
    this.maxBytes = maxBytes;
  }

  /** 当前分段序号（0 = 首段） */
  get part(): number {
    return this.#part;
  }

  /** 当前分段的完整路径 */
  get currentPath(): string {
    return segmentLogPath(this.basePath, this.#part);
  }

  /** 当前分段已写入字节数 */
  get bytes(): number {
    return this.#bytes;
  }

  /** 是否关闭了分段（上限 <= 0） */
  get unlimited(): boolean {
    return this.maxBytes <= 0;
  }

  /**
   * @brief 续写既有文件时对齐已写字节数
   *
   * @param bytes 当前分段文件的实际大小（新文件传 0）
   */
  resetTo(bytes: number): void {
    this.#part = 0;
    this.#bytes = Math.max(0, bytes);
  }

  /**
   * @brief 判断再写入 n 字节前是否需要滚动到下一段
   *
   * 边界处理：当前段为空（已写 0 字节）时永不滚动——单行超过上限
   * （如设备一次性吐出超大块）也必须先落盘，否则会陷入"每写必滚、
   * 每段都空"的死循环。该行落盘后下一行自然会触发滚动。
   *
   * @param n 本次待写入的字节数
   * @returns true 表示应先 rotate() 再写
   */
  shouldRotate(n: number): boolean {
    if (this.maxBytes <= 0) return false;
    if (this.#bytes === 0) return false;
    return this.#bytes + n > this.maxBytes;
  }

  /**
   * @brief 滚动到下一分段并清零计数
   *
   * @returns 新分段的完整路径
   */
  rotate(): string {
    this.#part += 1;
    this.#bytes = 0;
    return this.currentPath;
  }

  /**
   * @brief 累加已写入字节数
   *
   * @param n 本次实际写入的字节数
   */
  account(n: number): void {
    this.#bytes += n;
  }
}
