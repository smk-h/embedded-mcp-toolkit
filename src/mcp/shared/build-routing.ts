/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : build-routing.ts
 * Author     : embedded-mcp-toolkit
 * Date       : 2026/08/03
 * Version    : 1.0.0
 * Description: 编译路由指引文本模块
 *
 *   封装跨机部署（方式二：远程 SSH 启动）下"编译应优先用本机 cmdsift、
 *   而非经 ssh_build 让流量 Windows↔Linux 绕圈"的指引文本，供
 *   instructions / host_info / ssh_build 三处引用，避免硬编码漂移。
 *   - buildRoutingInstructions(): 单行文本，注入 MCP 握手 instructions 字段
 *   - buildRoutingHint():          多行文本，用于 host_info 返回与 ssh_build 软拦截前缀
 *   两段文本语义同步（都说"方式二下编译优先用 cmdsift"），措辞与长度针对各自载体定制。
 * ======================================================
 */

import { pkg } from "../../shared/package-info.js";

// ── 单行指引（instructions 用） ──────────────────────────────

/**
 * @brief 编译路由单行指引文本
 * @details 给 MCP 握手 instructions 字段用。与 ch17 的 scp 指引风格一致——
 *          单行、句间空格、无换行。内容覆盖：
 *          1) AI 已在 Linux 编译机，编译优先用本机 cmdsift
 *          2) 三类示例（make -j8 / -C 带工作目录 / ./build.sh）
 *          3) 全量日志落盘位置（log/YYYYMMDD_HHMMSS.log，可后续读取）
 *          4) 不要用 ssh_build（会让流量 Linux→Windows MCP→Linux 绕一圈）
 *          cmdsift 假定在 Linux PATH 中（部署方保证安装），文本只给用法。
 * @returns 单行指引字符串
 */
export function buildRoutingInstructions(): string {
  return [
    "When you need to build (make / gcc / ./build.sh, etc.), run cmdsift directly in your own Linux shell",
    "(e.g. cmdsift 'make -j8', cmdsift -C /path/to/src 'make', cmdsift './build.sh');",
    "cmdsift runs the build locally, returns only an error/warning summary, and writes the full build log to log/YYYYMMDD_HHMMSS.log (read it later if needed).",
    "Do NOT use the ssh_build tool here — it routes traffic Linux -> Windows MCP -> Linux and wastes a round trip.",
  ].join(" ");
}

// ── 多行指引（host_info / ssh_build 用） ─────────────────────

/**
 * @brief 编译路由多行指引文本
 * @details 给 host_info 工具返回与 ssh_build 软拦截前缀用。多行、带缩进，
 *          风格对齐 host_info 的 Usage 段。内容覆盖：
 *          1) 当前处于方式二（远程 SSH 启动）：AI 在 Linux、MCP 在 Windows
 *          2) 编译应优先用本机 cmdsift，而非 ssh_build（流量会绕圈）
 *          3) cmdsift 用法要点（三类示例 + 日志落盘说明）
 *          4) 本次 ssh_build 仍会照常执行（仅 ssh_build 软拦截语境）
 *          与 buildRoutingInstructions() 语义一致，仅展开为多行便于工具返回阅读。
 * @returns 多行指引字符串
 */
export function buildRoutingHint(): string {
  return [
    `Build routing notice: you are in deployment mode 2 (remote-ssh) — the AI client runs on Linux, the ${pkg.name} MCP server runs on Windows.`,
    "Build locally with cmdsift instead of ssh_build — ssh_build routes traffic Linux -> Windows MCP -> Linux (a wasteful round trip).",
    "Typical cmdsift usage:",
    "  - cmdsift 'make -j8'",
    "  - cmdsift -C /path/to/src 'make'",
    "  - cmdsift './build.sh'",
    "The full build log is saved to log/YYYYMMDD_HHMMSS.log (read it later if needed).",
    "This ssh_build call still runs normally, but consider cmdsift for subsequent builds.",
  ].join("\n");
}
