/**
 * @file pack-project.cjs
 * @brief 将项目文件打包为 zip 压缩包，排除指定的文件与目录。
 *
 * 排除项列表由 EXCLUDES 常量定义。
 *
 * 用法：
 * @code
 * node scripts/pack-project.cjs
 * @endcode
 *
 * @note 本脚本依赖 adm-zip（纯 JS 实现，零原生依赖）。
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

/** @brief 项目根目录（pack-project.cjs 的上层目录）。 */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** @brief 输出 zip 文件路径。 */
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'embedded-mcp-toolkit-project.zip');

/**
 * @brief 排除项集合。
 *
 * 支持两类条目：
 * - 顶层目录/文件名（如 `.cnb`、`LICENSE`），将排除整个目录或单文件。
 * - 嵌套相对路径（如 `.claude/start-claude.bat`），精确排除指定文件。
 *
 * 路径统一使用正斜杠 `/` 分隔。
 */
const EXCLUDES = new Set([
  '.cnb',
  '.git',
  '.roo',
  '.opencode',
  '.claude/.env',
  '.claude/start-claude.bat',
  '.claude/start-claude.ps1',
  '.cnb.yml',
  'node_modules',
  'my-psh',
  'test',
  'docs',
  'plan',
  'client',
  'out',
  'scripts',
  'configs/config.yaml',
  'LICENSE',
  '.npmrc',
  '.npmignore',
]);

/**
 * @brief 判断指定路径是否应被排除。
 *
 * 检查逻辑：
 * 1. 是否命中 EXCLUDES 静态集合。
 * 2. 是否为 .tgz 或 .zip 文件（避免二次打包自身）。
 *
 * @param[in] name 待检查的路径名（顶层名称或完整相对路径，使用 / 分隔）。
 * @returns {boolean} true 表示应排除。
 */
function shouldExclude(name) {
  if (EXCLUDES.has(name)) return true;

  /** 排除所有 .tgz / .zip 文件，避免将已生成的压缩包再次打包。 */
  if (name.endsWith('.tgz') || name.endsWith('.zip')) return true;

  return false;
}

/**
 * @brief 递归遍历目录树，将不被排除的文件添加至 zip 对象。
 *
 * 遍历策略：
 * - 按深度优先递归进入子目录。
 * - 每个条目先计算相对于项目根目录的路径，统一转换为 `/` 分隔符。
 * - 同时以"顶层名称"和"完整相对路径"两层维度检查排除规则：
 *   - 顶层名称匹配：用于排除整个目录（如 `node_modules`）或根级文件。
 *   - 完整路径匹配：用于排除嵌套文件（如 `.claude/start-claude.ps1`）。
 *
 * @param[in] dir     当前遍历的目录绝对路径。
 * @param[in] baseDir 项目根目录绝对路径，用于计算相对路径。
 * @param[in,out] zip AdmZip 实例，递归过程中向其追加文件。
 */
function walkDir(dir, baseDir, zip) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    /**
     * 统一将 Windows 反斜杠转换为正斜杠，
     * 确保与 EXCLUDES 集合中的条目写法一致，实现跨平台匹配。
     */
    const normalizedPath = relativePath.split(path.sep).join('/');
    const topName = normalizedPath.split('/')[0];

    if (shouldExclude(topName) || shouldExclude(normalizedPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, zip);
    } else if (entry.isFile()) {
      /** 将文件添加至 zip 压缩包，保持原有目录结构不变。 */
      zip.addLocalFile(fullPath, path.dirname(relativePath));
    }
  }
}

/** @brief 主流程入口。 */
(function main() {
  console.log('Packing project into zip...');

  const zip = new AdmZip();
  walkDir(PROJECT_ROOT, PROJECT_ROOT, zip);
  zip.writeZip(OUTPUT_FILE);

  const stat = fs.statSync(OUTPUT_FILE);
  console.log(`\nDone: ${OUTPUT_FILE} (${stat.size} bytes)`);
})();
