#!/usr/bin/env node
/**
 * @file gen-init-templates.mjs
 * @brief 生成 init 命令的内嵌模板文件 src/cli/commands/init-templates.ts
 *
 * 背景：
 *   单文件 exe（bun build --compile）内没有磁盘模板目录，init 改用运行时写出
 *   内嵌模板（见 init.ts 的 writeEmbeddedTemplates）。为保证内嵌内容与仓库
 *   真实模板永远一致，本脚本从仓库根目录读取模板文件，以字符串常量形式生成
 *   init-templates.ts（单一事实来源 = 仓库模板文件本身）。
 *
 * 用法：
 *   npm run gen:init-templates
 *
 * 何时需要重新生成：
 *   修改任何模板文件（.mcp.json / .claude/** / .embedded/configs/** /
 *   remote-start-mcp.bat 等）或调整 init.ts 的拷贝任务清单后执行一次。
 *
 * 清单与 init.ts 的 taskGroups 保持一致（新增模板时两处同步维护）：
 *   - json     : .mcp.json / .opencode/opencode.json（exe 模式写出时另行 patch 命令）
 *   - files    : 逐文件复制的模板
 *   - patterns : 目录内通配匹配（.claude/*.tmp、.embedded/configs/*.txt）
 *   - dirs     : 递归整目录（.claude/skills）
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

/** 输出文件 */
const OUT_FILE = join(
  PROJECT_ROOT,
  "src",
  "cli",
  "commands",
  "init-templates.ts"
);

/** 模板清单（与 init.ts 的 taskGroups 对应；dest 即相对目标目录的写出路径） */
const MANIFEST = {
  /** JSON 类模板：内容原样内嵌，exe 模式 init 写出时 patch 命令与 DEVICE */
  json: [".mcp.json", ".opencode/opencode.json"],
  /** 单文件模板 */
  files: [
    ".claude/settings.local.json",
    ".claude/CLAUDE.md",
    ".embedded/configs/config.example.yaml",
    ".embedded/configs/config.yaml",
    ".embedded/configs/devices/board-example.yaml",
    "remote-start-mcp.bat",
  ],
  /** 目录内通配匹配 */
  patterns: [
    { dir: ".claude", suffix: ".tmp" },
    { dir: ".embedded/configs", suffix: ".txt" },
  ],
  /** 递归整目录 */
  dirs: [".claude/skills"],
};

/** 递归收集目录下全部文件（相对路径） */
function walkDir(root, dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkDir(root, full));
    } else {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

/** 按清单收集 { dest, content } 列表 */
function collect() {
  const items = [];

  for (const dest of MANIFEST.json) {
    items.push({ dest, json: true });
  }
  for (const dest of MANIFEST.files) {
    items.push({ dest });
  }
  for (const { dir, suffix } of MANIFEST.patterns) {
    const absDir = join(PROJECT_ROOT, dir);
    if (!existsSync(absDir)) continue;
    for (const entry of readdirSync(absDir)) {
      const full = join(absDir, entry);
      if (statSync(full).isFile() && entry.endsWith(suffix)) {
        items.push({ dest: `${dir}/${entry}` });
      }
    }
  }
  for (const dir of MANIFEST.dirs) {
    const absDir = join(PROJECT_ROOT, dir);
    if (!existsSync(absDir)) continue;
    for (const rel of walkDir(PROJECT_ROOT, absDir)) {
      items.push({ dest: rel });
    }
  }

  // 读取内容；缺失的模板警告并跳过（与磁盘模式 init 的"模板不存在"提示行为对齐）
  const collected = [];
  for (const item of items) {
    const src = join(PROJECT_ROOT, item.dest);
    if (!existsSync(src)) {
      console.warn(`  ⚠ 模板不存在，跳过: ${item.dest}`);
      continue;
    }
    collected.push({ dest: item.dest, content: readFileSync(src, "utf8") });
  }
  return collected;
}

/** 生成 init-templates.ts 内容 */
function render(templates) {
  const lines = [];
  for (const t of templates) {
    lines.push(`  {`);
    lines.push(`    dest: ${JSON.stringify(t.dest)},`);
    lines.push(`    content: ${JSON.stringify(t.content)},`);
    lines.push(`  },`);
  }

  return `/**
 * @file init-templates.ts
 * @brief init 命令的内嵌模板（单文件 exe 模式的模板来源）
 *
 * ⚠️ 本文件由 scripts/gen-init-templates.mjs 自动生成，请勿手改。
 *    修改仓库模板后执行 npm run gen:init-templates 重新生成。
 *
 * 用途：打包成单文件 exe 后没有磁盘模板目录，init 改为运行时把这些内嵌
 * 模板写出（见 init.ts 的 writeEmbeddedTemplates）。内容与仓库根目录下的
 * 同名模板文件逐字节一致；.mcp.json / opencode.json / remote-start-mcp.bat
 * 在写出时会适配 exe 入口（命令替换为 embedded-mcp-toolkit.exe）。
 */

/** 内嵌模板条目：dest 为相对目标目录的写出路径，content 为文件内容 */
export interface EmbeddedTemplate {
  dest: string;
  content: string;
}

/** 全部内嵌模板（生成时间戳：${new Date().toISOString()}） */
export const EMBEDDED_TEMPLATES: EmbeddedTemplate[] = [
${lines.join("\n")}
];
`;
}

function main() {
  console.log("🛠  生成 init 内嵌模板...");
  const templates = collect();
  console.log(`  ✔ 收集 ${templates.length} 个模板文件`);
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, render(templates), "utf8");
  const size = (statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`  ✔ 写出 ${relative(PROJECT_ROOT, OUT_FILE)} (${size} KB)`);
  console.log("✅ 完成。模板文件变更后请重新执行 npm run gen:init-templates");
}

main();
