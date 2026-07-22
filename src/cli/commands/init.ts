/**
 * @file src/cli/commands/init.ts
 * @brief embedded-mcp-toolkit init 命令
 *
 * 在任意目录执行，从 npm 包安装目录拷贝模板文件，自动初始化 Claude Code / OpenCode 的 MCP 配置。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from "fs";
import { resolve, join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

// ============================================================
// 选项
// ============================================================

/**
 * @brief init 命令的选项
 * @details 由 Commander 在 src/index.ts 中解析命令行参数后传入。
 */
export interface InitOptions {
  target: string; // 目标目录（默认：当前工作目录）
  device: string; // 默认设备名
  claudeOnly: boolean; // 仅生成 Claude Code 配置
  opencodeOnly: boolean; // 仅生成 OpenCode 配置
  force: boolean; // 覆盖已存在的文件
}

/**
 * @brief uninstall 命令的选项
 * @details 由 Commander 在 src/index.ts 中解析命令行参数后传入。
 */
export interface UninstallOptions {
  target: string; // 目标目录（默认：当前工作目录）
  claudeOnly: boolean; // 仅清理 Claude Code 相关文件
  opencodeOnly: boolean; // 仅清理 OpenCode 相关文件
  force: boolean; // 跳过确认提示
}

// ============================================================
// 工具函数
// ============================================================

/**
 * @brief 确保目录存在，若不存在则递归创建
 * @param dirPath 目标目录路径
 * @returns `true` — 目录为新创建；`false` — 目录已存在
 */
function ensureDir(dirPath: string): boolean {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

/**
 * @brief 递归复制目录
 * @param src    源目录路径
 * @param dest   目标目录路径
 * @param force  是否覆盖已存在的文件
 * @returns 实际复制的文件数量
 */
function copyDir(src: string, dest: string, force: boolean): number {
  if (!existsSync(src)) return 0;
  ensureDir(dest);
  let count = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      count += copyDir(srcPath, destPath, force);
    } else {
      if (!force && existsSync(destPath)) continue;
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/**
 * @brief 复制单个文件（带覆盖保护）
 * @param src    源文件路径
 * @param dest   目标文件路径
 * @param force  是否覆盖已存在的文件
 * @param log    是否输出日志（默认 true）
 * @returns `true` — 复制成功；`false` — 跳过或源文件不存在
 */
function copyFile(
  src: string,
  dest: string,
  force: boolean,
  log = true
): boolean {
  if (!existsSync(src)) {
    if (log) console.log(`  ⚠️  模板不存在: ${src}`);
    return false;
  }
  if (!force && existsSync(dest)) {
    if (log) console.log(`  ⏭  跳过（已存在）: ${dest}`);
    return false;
  }
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  if (log) console.log(`  ✅ 创建: ${dest}`);
  return true;
}

/**
 * @brief 判断 MCP server 配置项是否为 toolkit 自有 server
 * @details init 的 patch 目的：把模板里 toolkit server 的占位命令替换为实际安装路径。
 *          但模板可能同时携带其它 server（如 file_utils_remote 指向个人远程机），
 *          盲改会破坏它们。这里通过检测原始 command/args 是否含 "embedded-mcp-toolkit"
 *          来识别 toolkit 自有 server —— 模板里 toolkit server 的入口固定包含该字样，
 *          与 key 名解耦，即便重命名 key 也不受影响。
 *
 * @param cmdParts 模板中该 server 的原始命令片段（command + args 合并后的数组）
 * @returns `true` — 是 toolkit 自有 server，应执行 patch
 */
function isToolkitServer(cmdParts: unknown[]): boolean {
  return cmdParts.some(
    (p) => typeof p === "string" && p.includes("embedded-mcp-toolkit")
  );
}

/**
 * @brief 复制并修补 JSON 配置文件（.mcp.json / opencode.json）
 * @details 读取模板 JSON，将其中 **toolkit 自有 server** 的占位命令替换为实际二进制路径，
 *          同时注入 DEVICE 环境变量；模板中携带的其它 server（如 file_utils_remote）
 *          原样保留。自动适配 Claude Code（.mcp.json）和 OpenCode（opencode.json）两种格式。
 *
 * @param src        模板 JSON 文件路径
 * @param dest       目标 JSON 文件路径
 * @param force      是否覆盖已存在的文件
 * @param device     设备名称（写入 DEVICE 环境变量）
 * @param binCommand npm 二进制命令路径
 * @param binArgs    npm 二进制命令参数列表
 * @returns `true` — 复制并修补成功；`false` — 跳过或失败
 */
function copyAndPatchJson(
  src: string,
  dest: string,
  force: boolean,
  device: string,
  binCommand: string,
  binArgs: string[]
): boolean {
  if (!existsSync(src)) {
    console.log(`  ⚠️  模板不存在: ${src}`);
    return false;
  }
  if (!force && existsSync(dest)) {
    console.log(`  ⏭  跳过（已存在）: ${dest}`);
    return false;
  }

  const raw = readFileSync(src, "utf-8");
  const json = JSON.parse(raw);
  const isMcpJson = basename(dest) === ".mcp.json";

  if (isMcpJson) {
    const servers: Record<string, Record<string, unknown>> = ((
      json as Record<string, unknown>
    ).mcpServers as Record<string, Record<string, unknown>>) ?? {};
    for (const key of Object.keys(servers)) {
      const origCommand = (servers[key].command as unknown) ?? "";
      const origArgs = (servers[key].args as unknown[]) ?? [];
      // 仅 patch toolkit 自有 server，其它 server 原样保留
      if (!isToolkitServer([origCommand, ...origArgs])) continue;
      servers[key].command = binCommand;
      servers[key].args = binArgs;
      if (servers[key].env) {
        (servers[key].env as Record<string, string>).DEVICE = device;
      }
    }
  } else {
    const mcp: Record<string, Record<string, unknown>> = ((
      json as Record<string, unknown>
    ).mcp as Record<string, Record<string, unknown>>) ?? {};
    for (const key of Object.keys(mcp)) {
      const origCommandArr = (mcp[key].command as unknown[]) ?? [];
      // 仅 patch toolkit 自有 server，其它 server 原样保留
      if (!isToolkitServer(origCommandArr)) continue;
      mcp[key].command = [binCommand, ...binArgs];
      if (mcp[key].environment) {
        (mcp[key].environment as Record<string, string>).DEVICE = device;
      }
    }
  }

  ensureDir(dirname(dest));
  writeFileSync(dest, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log(`  ✅ 创建: ${dest}`);
  return true;
}

// ============================================================
// 拷贝任务配置
// ============================================================

/**
 * @brief 拷贝任务描述符
 * @details 统一的拷贝任务类型，支持文件、目录、JSON 修补、通配符匹配、
 *          YAML 配置等多种复制策略。
 *
 * | type         | 说明                           |
 * |-------------|-------------------------------|
 * | `"file"`    | 直接复制单个文件                  |
 * | `"dir"`     | 递归复制整个目录                  |
 * | `"json"`    | 复制 JSON 并嵌补命令路径和 DEVICE |
 * | `"pattern"` | 通配符匹配批量复制                 |
 * | `"configYaml"` | 复制 YAML 配置文件模板           |
 */
type CopyTask =
  | { type: "file"; src: string; dest: string }
  | { type: "dir"; src: string; dest: string; description?: string }
  | { type: "json"; src: string; dest: string }
  | {
      type: "pattern";
      srcDir: string;
      destDir: string;
      match: (entry: string) => boolean;
    }
  | { type: "configYaml"; src: string; dest: string };

/**
 * @brief 拷贝任务分组
 * @details 将一组 CopyTask 归入同一个 label，并带 condition 控制是否执行。
 */
interface TaskGroup {
  label: string; // 分组标签，用于日志输出
  condition: boolean; // 条件为 true 时才执行该组任务
  tasks: CopyTask[]; // 任务列表
}

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 执行 init 命令
 * @details 从 npm 包安装目录将模板文件复制到目标项目目录，
 *          自动初始化 Claude Code / OpenCode 的 MCP 配置。
 *          自动检测本地/全局安装模式并设置正确的二进制路径。
 *
 * @param opts 由 Commander 在 index.ts 中解析后传入的结构化选项。
 */
export function runInit(opts: InitOptions): void {
  logCommand("init", opts);

  const target = resolve(opts.target); // 解析为绝对路径
  const { force, claudeOnly, opencodeOnly, device } = opts; // 解构选项

  const doClaude = !opencodeOnly;
  const doOpencode = !claudeOnly;

  // 确定 npm 包根目录
  // out/cli/commands/init.js → ../../ → 包根目录
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const PKG_ROOT = resolve(__dirname, "..", "..", "..");

  /*
   * 根据实际执行命令判断本地安装 vs 全局安装
   * 判断依据：process.argv[1]（node 实际执行的 .js 路径）是否以目标目录的 node_modules 开头
   *
   *   process.argv[1]:
   *   本地:  E:\AI\aaa\node_modules\...\embedded-mcp-toolkit-cli.js
   *   全局:  D:\devSoftware\node_global\node_modules\...\embedded-mcp-toolkit-cli.js
   *
   *   join(target, "node_modules") → E:\AI\aaa\node_modules
   *
   *   startsWith("E:\AI\aaa\node_modules") 判断：
   *   本地路径以 "E:\AI\aaa\node_modules" 开头  → true  (本地安装)
   *   全局路径以 "D:\devSoftware\node_global" 开头 → false (全局安装)
   *
   * 虽然两者都包含 "node_modules" 子串，但 startsWith 做的是前缀精确匹配，
   * 只认目标项目目录下的 node_modules，全局路径的盘符和父目录都不同，必然不命中。
   */
  const invokedBy = resolve(process.argv[1] ?? "");
  const localInstall = invokedBy
    .toLowerCase()
    .startsWith(join(target, "node_modules").toLowerCase());
  let binCommand: string;
  let binArgs: string[];
  if (localInstall) {
    binCommand = "./node_modules/.bin/embedded-mcp-toolkit";
    binArgs = [];
  } else {
    binCommand = "embedded-mcp-toolkit";
    binArgs = [];
  }

  console.log(`
🚀 embedded-mcp-toolkit 初始化`);
  console.log(`   模板源: ${PKG_ROOT}`);
  console.log(`   目标目录: ${target}`);
  console.log(`   默认设备: ${device}`);
  console.log(
    `   安装方式: ${localInstall ? "本地 (node_modules)" : "全局"}\n`
  );

  ensureDir(target);

  // ---- 拷贝任务定义 ----
  const taskGroups: TaskGroup[] = [
    {
      label: "[Claude Code] 配置",
      condition: doClaude,
      tasks: [{ type: "json", src: ".mcp.json", dest: ".mcp.json" }],
    },
    {
      label: "[OpenCode] 配置",
      condition: doOpencode,
      tasks: [
        {
          type: "json",
          src: ".opencode/opencode.json",
          dest: ".opencode/opencode.json",
        },
      ],
    },
    {
      label: "[Claude Code] 项目文件",
      condition: doClaude,
      tasks: [
        {
          type: "file",
          src: ".claude/settings.local.json",
          dest: ".claude/settings.local.json",
        },
        { type: "file", src: ".claude/CLAUDE.md", dest: ".claude/CLAUDE.md" },
        {
          type: "pattern",
          srcDir: ".claude",
          destDir: ".claude",
          match: (e) => e.endsWith(".tmp"),
        },
        {
          type: "dir",
          src: ".claude/skills",
          dest: ".claude/skills",
          description: "技能文件",
        },
      ],
    },
    {
      label: "配置文件",
      condition: true,
      tasks: [
        {
          type: "file",
          src: ".embedded/configs/config.example.yaml",
          dest: ".embedded/configs/config.example.yaml",
        },
        {
          type: "pattern",
          srcDir: ".embedded/configs",
          destDir: ".embedded/configs",
          match: (e) => e.endsWith(".txt"),
        },
        // config.yaml 现只含 default 字段并随包发布，直接复制即可，无需由 example 生成。
        // 复用 copyFile 的覆盖保护：用户已编辑过的 config.yaml 在非 --force 下不会被覆盖。
        {
          type: "file",
          src: ".embedded/configs/config.yaml",
          dest: ".embedded/configs/config.yaml",
        },
        // 已停用（保留备用）：原先由 config.example.yaml 生成 config.yaml 的流程。
        // 后续若 config.yaml 需动态生成（如注入更多字段），可恢复此任务。
        // {
        //   type: "configYaml",
        //   src: ".embedded/configs/config.example.yaml",
        //   dest: ".embedded/configs/config.yaml",
        // },
        {
          type: "file",
          src: ".embedded/configs/devices/board-example.yaml",
          dest: ".embedded/configs/devices/board-example.yaml",
        },
        {
          type: "file",
          src: "remote-start-mcp.bat",
          dest: "remote-start-mcp.bat",
        },
      ],
    },
  ];

  // ---- 统一执行拷贝任务 ----
  for (const group of taskGroups) {
    if (!group.condition) continue;
    console.log(`📦 ${group.label}`);
    for (const task of group.tasks) {
      switch (task.type) {
        case "file": {
          copyFile(join(PKG_ROOT, task.src), join(target, task.dest), force);
          break;
        }
        case "dir": {
          const count = copyDir(
            join(PKG_ROOT, task.src),
            join(target, task.dest),
            force
          );
          if (count > 0 && task.description) {
            console.log(
              `  ✅ 复制 ${count} 个${task.description}到 ${task.dest}/`
            );
          }
          break;
        }
        case "json": {
          copyAndPatchJson(
            join(PKG_ROOT, task.src),
            join(target, task.dest),
            force,
            device,
            binCommand,
            binArgs
          );
          break;
        }
        case "pattern": {
          const srcDir = join(PKG_ROOT, task.srcDir);
          const destDir = join(target, task.destDir);
          for (const entry of readdirSync(srcDir)) {
            if (task.match(entry)) {
              copyFile(join(srcDir, entry), join(destDir, entry), force);
            }
          }
          break;
        }
        case "configYaml": {
          const destPath = join(target, task.dest);
          if (!force && existsSync(destPath)) {
            console.log(`  ⏭  跳过（已存在）: ${destPath}`);
          } else {
            copyFileSync(join(PKG_ROOT, task.src), destPath);
            console.log(`  ✅ 创建: ${destPath}（请编辑为实际设备信息）`);
          }
          break;
        }
      }
    }
  }

  // ---- log/ ----
  ensureDir(join(target, ".embedded/log"));
  console.log(`  ✅ 创建: ${join(target, ".embedded/log")}/`);

  // ---- 收尾 ----
  const lines: string[] = [];
  if (doClaude) {
    lines.push("  📄 .mcp.json");
    lines.push("  📁 .claude/");
  }
  if (doOpencode) {
    lines.push("  📄 .opencode/opencode.json");
  }
  lines.push("  📁 .embedded/configs/");
  lines.push("  📁 .embedded/configs/devices/ (示例设备文件)");
  lines.push("  📁 .embedded/log/");
  lines.push("  📄 remote-start-mcp.bat (MCP server 启动脚本，锁定 cwd 与环境变量)");

  console.log(`
✅ 初始化完成！已生成以下文件:

${lines.join("\n")}

下一步:
  1. 编辑 .embedded/configs/devices/board-example.yaml, 修改为你的实际设备信息
  2. 如需新增设备, 在 .embedded/configs/devices/ 下复制并修改 yaml 文件
  3. 在 Claude Code / OpenCode 中, MCP 服务器 "embedded-board" 将自动启用
  4. 开始使用！例如：让 AI 帮你 "查看板卡系统状态"
`);
}

// ============================================================
// uninstall 命令
// ============================================================

/**
 * @brief 执行 uninstall 命令
 * @details 删除 init 命令生成的所有文件和目录，还原目录到初始化前的状态。
 *          `--force` 跳过确认提示直接删除。
 *
 * @param opts 由 Commander 在 index.ts 中解析后传入的结构化选项。
 */
export async function runUninstall(opts: UninstallOptions): Promise<void> {
  logCommand("uninstall", opts);

  const target = resolve(opts.target);
  const { force, claudeOnly, opencodeOnly } = opts;

  const doClaude = !opencodeOnly;
  const doOpencode = !claudeOnly;
  const doEmbedded = !claudeOnly && !opencodeOnly;

  console.log(`
🧹 embedded-mcp-toolkit 卸载清理`);
  console.log(`   目标目录: ${target}\n`);

  if (!force) {
    console.log("⚠️  即将删除以下文件/目录:");
    if (doClaude) {
      console.log("  📄 .mcp.json");
      console.log("  📁 .claude/");
    }
    if (doOpencode) {
      console.log("  📁 .opencode/");
    }
    if (doEmbedded) {
      console.log("  📁 .embedded/");
    }

    const answer = await prompt("确认删除? (y/N): ");
    if (!/^[yY]/.test(answer)) {
      console.log("已取消");
      return;
    }
  }

  const cleanupPaths: string[] = [];

  if (doClaude) {
    cleanupPaths.push(".mcp.json");
    cleanupPaths.push(".claude");
  }
  if (doOpencode) {
    cleanupPaths.push(".opencode");
  }
  if (doEmbedded) {
    cleanupPaths.push(".embedded");
  }

  let removedCount = 0;
  for (const relPath of cleanupPaths) {
    const absPath = join(target, relPath);
    if (!existsSync(absPath)) {
      console.log(`  ⏭  跳过（不存在）: ${relPath}`);
      continue;
    }
    try {
      const isDir = statSync(absPath).isDirectory();
      rmSync(absPath, { recursive: isDir, force: true });
      console.log(`  ✅ 已删除: ${relPath}`);
      removedCount++;
    } catch (err) {
      console.error(
        `  ❌ 删除失败: ${relPath} — ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(`\n✅ 卸载完成，共清理 ${removedCount} 项\n`);
}

/**
 * @brief 同步询问用户确认
 * @param question 提示文本
 * @returns 用户输入的字符串
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * @brief 打印命令调用信息
 * @details 根据解析后的 opts 重新拼装命令字符串，而非直接使用 `process.argv.join(" ")`。
 *          因为 npm bin wrapper 会将 `embedded-mcp-toolkit init` 转换为
 *          `node.exe /full/path/to/bin/cli.js init`，process.argv 会暴露
 *          内部 node 路径和脚本路径，对用户无意义。
 *
 * @param cmd  子命令名（"init" / "uninstall"）
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
