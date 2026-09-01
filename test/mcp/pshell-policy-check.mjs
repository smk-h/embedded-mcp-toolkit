#!/usr/bin/env node
/**
 * =====================================================
 * power_shell_* 工具注册策略健康检查
 *
 * 验证 pshell-policy 的策略矩阵与工具分组：
 *   1. 策略矩阵：场景 × POWERSHELL_TOOLS 的四种组合
 *   2. 策略矩阵：场景 × SSH_BUILD_TOOLS 的四种组合（与 power_shell_* 相反）
 *   3. 分组：win 域工具组 3 个，pshell 工具组 1 个（power_shell_exec），
 *      ssh_build 独立成组且不混入 SSH 工具组
 *
 * 全部断言通过输出 ALL PASS 并退出码 0，否则列出失败项。
 * ======================================================
 */
import {
  shouldRegisterPshellTools,
  shouldRegisterSshBuildTools,
} from "../../out/mcp/pshell-policy.js";
import {
  mcpWinTools,
  mcpPshellTools,
  mcpSshTools,
  mcpSshBuildTools,
} from "../../out/mcp/tools.js";

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

// ── 2. ssh_build 策略矩阵（与 power_shell_* 相反）──────────────
assert(
  shouldRegisterSshBuildTools("local", {}) === true,
  "local 且未设置环境变量：注册"
);
assert(
  shouldRegisterSshBuildTools("remote-ssh", {}) === false,
  "remote-ssh 且未设置环境变量：不注册"
);
assert(
  shouldRegisterSshBuildTools("remote-ssh", { SSH_BUILD_TOOLS: "1" }) === true,
  "SSH_BUILD_TOOLS=1：远程也强制注册"
);
assert(
  shouldRegisterSshBuildTools("local", { SSH_BUILD_TOOLS: "0" }) === false,
  "SSH_BUILD_TOOLS=0：本地也强制关闭"
);

// ── 3. 工具分组 ───────────────────────────────────────────
assert(mcpWinTools.length === 3, "win 域工具组 3 个");
assert(
  mcpWinTools.every((t) => !t.name.startsWith("power_shell_")),
  "win 域工具组不含 power_shell_*"
);
assert(mcpPshellTools.length === 1, "pshell 工具组 1 个");
assert(
  mcpPshellTools.every((t) => t.name.startsWith("power_shell_")),
  "pshell 组全部为 power_shell_*"
);
assert(
  mcpSshBuildTools.length === 1 && mcpSshBuildTools[0].name === "ssh_build",
  "ssh_build 独立成组"
);
assert(
  mcpSshTools.every((t) => t.name !== "ssh_build"),
  "SSH 工具组不含 ssh_build"
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
