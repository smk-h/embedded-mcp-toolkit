/**
 * embedded-mcp-toolkit init 命令
 *
 * 在任意目录执行，从 npm 包安装目录拷贝模板文件，自动初始化 Claude Code / OpenCode 的 MCP 配置。
 *
 * 用法:
 *   embedded-mcp-toolkit init [options]
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

interface InitOptions {
  /** 目标目录（默认：当前工作目录） */
  target: string;
  /** 默认设备名 */
  device: string;
  /** 仅生成 Claude Code 配置 */
  claudeOnly: boolean;
  /** 仅生成 OpenCode 配置 */
  opencodeOnly: boolean;
  /** 覆盖已存在的文件 */
  force: boolean;
}

// ============================================================
// 帮助
// ============================================================

function printHelp(): void {
  console.log(`
embedded-mcp-toolkit init — 初始化 MCP 配置文件

用法:
  embedded-mcp-toolkit init [options]

选项:
  --target <path>     目标目录（默认：当前工作目录）
  --device <name>     默认设备名（默认：board-b）
  --claude-only       仅生成 Claude Code 配置
  --opencode-only     仅生成 OpenCode 配置
  --force             覆盖已存在的文件
  --help              显示帮助

生成的目录结构:
  .mcp.json                    Claude Code MCP 配置
  .opencode/opencode.json       OpenCode MCP 配置
  .claude/
    settings.local.json         Claude Code 权限设置
    CLAUDE.md                   Claude Code 项目说明
    skills/                     Claude Code 快捷技能
  configs/
    config.example.yaml         设备配置模板
  log/                         日志目录
`);
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs(argv: string[]): InitOptions {
  const options: InitOptions = {
    target: process.cwd(),
    device: "board-b",
    claudeOnly: false,
    opencodeOnly: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--target":
        options.target = resolve(argv[++i] || options.target);
        break;
      case "--device":
        options.device = argv[++i] || options.device;
        break;
      case "--claude-only":
        options.claudeOnly = true;
        break;
      case "--opencode-only":
        options.opencodeOnly = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

// ============================================================
// 工具函数
// ============================================================

function ensureDir(dirPath: string): boolean {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

/** 递归复制目录，返回复制的文件数 */
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

/** 复制文件（带覆盖保护） */
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
 * 复制并修补 JSON 配置文件（.mcp.json / opencode.json）
 *
 * 自动检测本地/全局安装，将模板中的命令替换为对应二进制路径，
 * 并注入用户指定的 DEVICE 环境变量。
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
    const servers: Record<string, Record<string, unknown>> =
      (json as Record<string, unknown>).mcpServers as Record<
        string,
        Record<string, unknown>
      > ?? {};
    for (const key of Object.keys(servers)) {
      servers[key].command = binCommand;
      servers[key].args = binArgs;
      if (servers[key].env) {
        (servers[key].env as Record<string, string>).DEVICE = device;
      }
    }
  } else {
    const mcp: Record<string, Record<string, unknown>> =
      (json as Record<string, unknown>).mcp as Record<
        string,
        Record<string, unknown>
      > ?? {};
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

type CopyTask =
  | { type: "file"; src: string; dest: string }
  | { type: "dir"; src: string; dest: string; description?: string }
  | { type: "json"; src: string; dest: string }
  | { type: "pattern"; srcDir: string; destDir: string; match: (entry: string) => boolean }
  | { type: "configYaml"; src: string; dest: string };

interface TaskGroup {
  label: string;
  condition: boolean;
  tasks: CopyTask[];
}

// ============================================================
// 主流程
// ============================================================

export function runInit(rawArgs: string[]): void {
  const options = parseArgs(rawArgs);
  const { target, force, claudeOnly, opencodeOnly, device } = options;

  const doClaude = !opencodeOnly;
  const doOpencode = !claudeOnly;

  // 确定 npm 包根目录
  // out/command/init.js → ../../ → 包根目录
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const PKG_ROOT = resolve(__dirname, "..", "..");

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

  console.log(`\n🚀 embedded-mcp-toolkit 初始化`);
  console.log(`   模板源: ${PKG_ROOT}`);
  console.log(`   目标目录: ${target}`);
  console.log(`   默认设备: ${device}`);
  console.log(`   安装方式: ${localInstall ? "本地 (node_modules)" : "全局"}\n`);

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
        { type: "json", src: ".opencode/opencode.json", dest: ".opencode/opencode.json" },
      ],
    },
    {
      label: "[Claude Code] 项目文件",
      condition: doClaude,
      tasks: [
        { type: "file", src: ".claude/settings.local.json", dest: ".claude/settings.local.json" },
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
        { type: "file", src: "configs/config.example.yaml", dest: "configs/config.example.yaml" },
        {
          type: "pattern",
          srcDir: "configs",
          destDir: "configs",
          match: (e) => e.endsWith(".txt"),
        },
        { type: "configYaml", src: "configs/config.example.yaml", dest: "configs/config.yaml" },
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
            console.log(`  ✅ 复制 ${count} 个${task.description}到 ${task.dest}/`);
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
  1. 编辑 configs/config.yaml，修改为你的实际设备信息
  2. 在 Claude Code / OpenCode 中，MCP 服务器 "embedded-board" 将自动启用
  3. 开始使用！例如：让 AI 帮你 "查看板卡系统状态"
`);
}
