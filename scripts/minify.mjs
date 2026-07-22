/**
 * @file minify.mjs
 * @brief 用 esbuild 对 out/ 下编译产物逐文件 minify（非 bundle 模式）。
 *
 * 策略：
 * - bundle: false —— 不跟随 import，逐文件压缩，输出镜像 tsc 目录结构。
 * - 原地覆盖 out/ 下的 .js，相对 import 路径、native 依赖（serialport/ssh2）、
 *   import.meta.url 路径推算逻辑全部原样保留。
 * - 仅处理 .js，不动 .d.ts（tsconfig 已关闭 declaration，不再生成）。
 *
 * 用法：
 *   node scripts/minify.mjs          # 压缩 out/（需先 tsc）
 *   npm run build:minify
 *
 * @note 依赖 esbuild（devDependency）。仅构建期使用，不进生产依赖。
 */

import { readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const PROJECT_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(PROJECT_ROOT, "out");

/**
 * @brief 递归收集目录下所有 .js 文件的绝对路径
 *
 * 只向下遍历普通子目录，不跟随符号链接，避免越出 out/ 边界。
 *
 * @param {string} dir 起始目录绝对路径
 * @returns {string[]} .js 文件绝对路径列表
 */
function collectJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // 跳过符号链接，防止跨出 out/ 边界扫描到外部 node_modules
    if (entry.isSymbolicLink()) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * @brief 统计文件列表的总字节数
 * @param {string[]} files 绝对路径列表
 * @returns {number} 总字节数
 */
function totalBytes(files) {
  return files.reduce((sum, f) => sum + statSync(f).size, 0);
}

/**
 * @brief 把字节数格式化为 KB 字符串（保留 1 位小数）
 * @param {number} bytes
 * @returns {string}
 */
function kb(bytes) {
  return (bytes / 1024).toFixed(1) + " KB";
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const jsFiles = collectJsFiles(OUT_DIR);

if (jsFiles.length === 0) {
  console.error("[minify] out/ 下未找到 .js 文件，请先运行 tsc 编译。");
  process.exit(1);
}

const beforeSize = totalBytes(jsFiles);

await esbuild.build({
  entryPoints: jsFiles,
  outdir: OUT_DIR,
  outbase: OUT_DIR, // 镜像目录结构，输出路径与输入一致
  minify: true,
  format: "esm", // 与 tsconfig module: NodeNext 一致
  target: "es2022", // 与 tsconfig target 对齐
  platform: "node",
  logLevel: "warning",
  allowOverwrite: true, // 原地覆盖 tsc 产物
});

const afterSize = totalBytes(jsFiles);
const reduction = beforeSize > 0 ? ((1 - afterSize / beforeSize) * 100).toFixed(1) : "0";

console.log(
  `[minify] ${jsFiles.length} 个文件压缩完成：` +
    `${kb(beforeSize)} → ${kb(afterSize)} (-${reduction}%)`
);
