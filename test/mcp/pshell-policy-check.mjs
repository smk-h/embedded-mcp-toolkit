#!/usr/bin/env node
/**
 * =====================================================
 * power_shell_* 工具注册策略健康检查
 *
 * 验证 pshell-policy 的策略矩阵与工具分组：
 *   1. 策略矩阵：场景 × POWERSHELL_TOOLS 的四种组合
 *   2. 分组：win 域工具组 3 个，pshell 会话工具组 5 个且全部 power_shell_*
 *
 * 全部断言通过输出 ALL PASS 并退出码 0，否则列出失败项。
 * ======================================================
 */
import { shouldRegisterPshellTools } from "../../out/mcp/pshell-policy.js";
import { mcpWinTools, mcpPshellTools } from "../../out/mcp/tools.js";

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  if (!cond) failed++;
};

// ── 1. 策略矩阵 ───────────────────────────────────────────
assert(
  shouldRegisterPshellTools("remote-ssh", {}) === true,
  "remote-ssh 且未设置环境变量：注册"
);
assert(
  shouldRegisterPshellTools("local", {}) === false,
  "local 且未设置环境变量：不注册"
);
assert(
  shouldRegisterPshellTools("local", { POWERSHELL_TOOLS: "1" }) === true,
  "POWERSHELL_TOOLS=1：本地也强制注册"
);
assert(
  shouldRegisterPshellTools("remote-ssh", { POWERSHELL_TOOLS: "0" }) === false,
  "POWERSHELL_TOOLS=0：远程也强制关闭"
);

// ── 2. 工具分组 ───────────────────────────────────────────
assert(mcpWinTools.length === 3, "win 域工具组 3 个");
assert(
  mcpWinTools.every((t) => !t.name.startsWith("power_shell_")),
  "win 域工具组不含 power_shell_*"
);
assert(mcpPshellTools.length === 5, "pshell 会话工具组 5 个");
assert(
  mcpPshellTools.every((t) => t.name.startsWith("power_shell_")),
  "pshell 组全部为 power_shell_*"
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
