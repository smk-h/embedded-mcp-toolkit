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
} from "fs";
import { resolve, join, dirname, basename } from "path";
import { fileURLToPath } from "url";

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
 * @brief 复制并修补 JSON 配置文件（.mcp.json / opencode.json）
 * @details 读取模板 JSON，将其中的占位命令替换为实际二进制路径，
 *          同时注入 DEVICE 环境变量。自动适配 Claude Code（.mcp.json）
 *          和 OpenCode（opencode.json）两种格式。
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
  /** 分组标签，用于日志输出 */
  label: string;
  /** 条件为 true 时才执行该组任务 */
  condition: boolean;
  /** 任务列表 */
  tasks: CopyTask[];
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
  console.log("[init] 接收到的参数:", JSON.stringify(opts, null, 2));

  const target = resolve(opts.target); // 解析为绝对路径
  const { force, claudeOnly, opencodeOnly, device } = opts; // 解构选项

  const doClaude = !opencodeOnly;
  const doOpencode = !claudeOnly;

  // 确定 npm 包根目录
  // out/cli/commands/init.js → ../../ → 包根目录
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const PKG_ROOT = resolve(__dirname, "..", "..", "..");

  // 根据实际执行命令判断本地安装 vs 全局安装
  // 判断依据：process.argv[1] 是否在目标目录的 node_modules 下
  //   本地:  E:\AI\aaa\node_modules\.bin\embedded-mcp-toolkit
  //   全局:  C:\Users\xxx\AppData\Roaming\npm\embedded-mcp-toolkit (PATH 直调)
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
        {
          type: "configYaml",
          src: ".embedded/configs/config.example.yaml",
          dest: ".embedded/configs/config.yaml",
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
  ensureDir(join(target, "log"));
  console.log(`  ✅ 创建: ${join(target, "log")}/`);

  // ---- 收尾 ----
  const lines: string[] = [];
  if (doClaude) {
    lines.push("  📄 .mcp.json");
    lines.push("  📁 .claude/");
  }
  if (doOpencode) {
    lines.push("  📄 .opencode/opencode.json");
  }
  lines.push("  📁 configs/");
  lines.push("  📁 log/");

  console.log(`
✅ 初始化完成！已生成以下文件:

${lines.join("\n")}

下一步:
  1. 编辑 configs/config.yaml, 修改为你的实际设备信息
  2. 在 Claude Code / OpenCode 中, MCP 服务器 "embedded-board" 将自动启用
  3. 开始使用！例如：让 AI 帮你 "查看板卡系统状态"
`);
}
