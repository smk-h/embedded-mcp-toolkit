/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : timestamp.ts
 * Author     : sumu
 * Date       : 2026/06/05
 * Version    : x.x.x
 * Description: 时间戳工具函数
 *
 * 统一日志目录名、日志文件名和日志行内的时间戳格式（北京时间）。
 * ======================================================
 */

/** 当前北京时间各字段 */
export function beijingFields() {
  const now = new Date();
  const bj = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  );
  return {
    y: bj.getFullYear(),
    m: String(bj.getMonth() + 1).padStart(2, "0"),
    d: String(bj.getDate()).padStart(2, "0"),
    hh: String(bj.getHours()).padStart(2, "0"),
    mm: String(bj.getMinutes()).padStart(2, "0"),
    ss: String(bj.getSeconds()).padStart(2, "0"),
    // 毫秒与时区无关，直接取当前瞬间的毫秒字段
    ms: String(now.getMilliseconds()).padStart(3, "0"),
  };
}

/**
 * @brief 日志目录用日期名（北京时间）
 *
 * 格式: YYYY-MM-DD
 * 作为按天分目录的一级名字，与文件名里的日期字段同源，避免跨天错位。
 */
export function dateDirName(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}`;
}

/**
 * @brief 会话日志文件名用时间戳（毫秒精度，北京时间）
 *
 * 格式: YYYY-MM-DD_HHMMSSsss
 * 日期进文件名（而非只靠上级日期目录），文件被单独拷走/发出去后
 * 仍能从名字看出属于哪一天；毫秒保证同一秒内多次建立会话
 * （如进程重启后 session 编号复用）不撞名。
 */
export function fileTimestampMs(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}${f.mm}${f.ss}${f.ms}`;
}

/**
 * @brief 日志文件名用时间戳（不含空格/冒号）
 *
 * 格式: YYYY-MM-DD_HHMMSS
 *   - 日期用 '-' 分隔，便于肉眼识别
 *   - 时分秒紧凑无分隔符，缩短文件名
 *   - 各字段从大到小且定宽，字典序等于时间序
 */
export function fileTimestamp(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}${f.mm}${f.ss}`;
}

/**
 * @brief 日志行内时间戳
 *
 * 格式: [YYYY-MM-DD HH:mm:ss]
 */
export function logTimestamp(): string {
  const f = beijingFields();
  return `[${f.y}-${f.m}-${f.d} ${f.hh}:${f.mm}:${f.ss}]`;
}

/**
 * @brief 将 UTC 时间转为北京时间(CST)显示
 *
 * 格式: YYYY-MM-DD HH:mm:ss
 */
export function formatBeijingTime(utc: string): string {
  const d = new Date(utc);
  const bj = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, "0");
  const day = String(bj.getDate()).padStart(2, "0");
  const h = String(bj.getHours()).padStart(2, "0");
  const min = String(bj.getMinutes()).padStart(2, "0");
  const s = String(bj.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}
