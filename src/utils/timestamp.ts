/**
 * @brief 时间戳工具函数
 *
 * 统一日志文件名和日志行内的时间戳格式（北京时间）。
 */

/** 当前北京时间各字段 */
function beijingFields() {
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
  };
}

/**
 * @brief 日志文件名用时间戳（不含空格/冒号）
 *
 * 格式: YYYY-MM-DD_HH-mm-ss
 */
export function fileTimestamp(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}-${f.mm}-${f.ss}`;
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
