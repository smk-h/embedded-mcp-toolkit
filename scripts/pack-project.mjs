/**
 * @file pack-project.mjs
 * @brief 生成与 CI release 产物一致的离线离线压缩包。
 *
 * 执行流程（复刻 .github/workflows/release.yml build job）：
 *   1. npm run build        — 编译 TypeScript 到 out/
 *   2. npm pack --dry-run    — 按 .npmignore 获取发布文件清单
 *   3. 复制清单文件           — 只打包 npm 发布的文件（不含源码等）
 *   4. 复制 package-lock.json — 供 npm prune 解析依赖树
 *   5. 复制完整 node_modules  →  npm prune --omit=dev   — 只保留生产依赖
 *   6. 打包为 zip
 *
 * 输出文件：embedded-mcp-toolkit-${VERSION}-offline.zip
 *
 * 依赖：adm-zip（纯 JS，零原生依赖）
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/* ────────── ESM 兼容：__dirname / require ────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

/* ────────── 路径常量 ────────── */
/** 项目根目录（本脚本的父目录） */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** 读取 package.json 获取版本号 */
const PKG = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

/** 离线包目录名（与 CI 一致） */
const PKG_DIR = `embedded-mcp-toolkit-${VERSION}-offline`;

/** 临时目录（项目内 .embedded/tmp） */
const TMP_DIR = path.join(PROJECT_ROOT, '.embedded', 'tmp');

/** 离线包中需要排除的文件（相对于项目根目录） */
const EXCLUDE_FILES = ['.claude/ccstatusline-settings.json', 'LICENSE', 'package-lock.json'];

/** 输出 zip 路径 */
const OUTPUT_FILE = path.join(PROJECT_ROOT, `${PKG_DIR}.zip`);

/* ────────── 配置 ────────── */
/** 遍历时跳过的目录（避免把 .git 和 node_modules 源文件混入发布内容） */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/* ────────── 辅助函数 ────────── */
/** 判断是否为压缩包自身（防止二次打包） */
function isGeneratedArchive(name) {
  return name.endsWith('.tgz') || name.endsWith('.zip');
}

/** 清理 MCP 配置文件中的指定服务器 */
function stripMcpServerConfig(bundleDir, relPaths, names) {
  for (const relPath of relPaths) {
    const filePath = path.join(bundleDir, relPath);
    if (!fs.existsSync(filePath)) continue;

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let modified = false;

    /* 从 mcpServers 中移除 */
    if (content.mcpServers) {
      for (const name of names) {
        if (content.mcpServers[name]) {
          delete content.mcpServers[name];
          modified = true;
        }
      }
    }

    /* 从 enabledMcpjsonServers 数组中移除 */
    if (content.enabledMcpjsonServers) {
      const orig = content.enabledMcpjsonServers;
      content.enabledMcpjsonServers = orig.filter(s => !names.includes(s));
      if (content.enabledMcpjsonServers.length !== orig.length) modified = true;
    }

    /* 移除顶层 statusLine */
    if (content.statusLine && names.includes('statusLine')) {
      delete content.statusLine;
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
      console.log(`  已清理 ${relPath}`);
    }
  }
}

/** 需要从 MCP 配置中移除的服务器名称 */
const STRIP_MCP_SERVERS = ['file_utils_remote', 'statusLine'];

/** 需要搜索的 MCP 配置文件 */
const MCP_CONFIG_FILES = [
  '.claude/settings.local.json',
  '.opencode/opencode.json',
  '.mcp.json',
];

/* ────────── 主流程 ────────── */
function main() {
  /* 1. 编译 TypeScript */
  /* 1a. 执行 build */
  console.log('编译 TypeScript...');
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  /* 1b. 执行 build:minify */
  console.log('\n执行 build:minify(skip)...');
  // execSync('npm run build:minify', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  /* 2. 解析 npm 发布清单（由 .npmignore 控制） */
  console.log('\n解析 npm 发布清单...');
  const packResult = execSync('npm pack --dry-run --json', { cwd: PROJECT_ROOT }).toString().trim();
  const packInfo = JSON.parse(packResult);
  /** 只应包含 npm publish 时发布的文件（不含 src/、test/、config 密钥等） */
  const packFiles = new Set(
    packInfo[0].files.map(f => f.path)
  );
  /* 排除离线包不需要的文件 */
  for (const f of EXCLUDE_FILES) packFiles.delete(f);

  /* 3. 在系统临时目录搭建离线包 */
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(TMP_DIR, 'embedded-mcp-'));
  try {
    const bundleDir = path.join(tmpDir, PKG_DIR);

    /* 3a. 复制发布清单中的文件 */
    console.log('\n复制发布文件...');
    const copied = copyPackFiles(PROJECT_ROOT, bundleDir, packFiles);
    console.log(`  共 ${copied} 个文件`);

    /* 3b. 复制 package-lock.json 供后续 npm prune 解析依赖树 */
    const lockSrc = path.join(PROJECT_ROOT, 'package-lock.json');
    if (fs.existsSync(lockSrc)) {
      fs.copyFileSync(lockSrc, path.join(bundleDir, 'package-lock.json'));
    }

    /* 3c. 复制完整 node_modules（含 devDependencies） */
    console.log('\n复制 node_modules...');
    const nmSrc = path.join(PROJECT_ROOT, 'node_modules');
    const nmDst = path.join(bundleDir, 'node_modules');
    if (fs.existsSync(nmSrc)) {
      fs.cpSync(nmSrc, nmDst, { recursive: true });
    }

    /* 3d. 清理 devDependencies，只保留生产依赖 */
    console.log('\n清理 devDependencies...');
    execSync('npm prune --omit=dev', { cwd: bundleDir, stdio: 'inherit' });

    /* 3e. 清理离线包不需要的文件（prune 用完后删除 package-lock.json） */
    const lockDst = path.join(bundleDir, 'package-lock.json');
    if (fs.existsSync(lockDst)) {
      fs.rmSync(lockDst);
    }

    /* 3f. 清理 MCP 配置中的敏感服务器 */
    console.log('\n清理 MCP 配置...');
    stripMcpServerConfig(bundleDir, MCP_CONFIG_FILES, STRIP_MCP_SERVERS);

    /* 4. 打包为 zip */
    console.log('\n创建 zip 压缩包...');
    const zip = new AdmZip();
    addDirToZip(bundleDir, bundleDir, zip);
    zip.writeZip(OUTPUT_FILE);

    const stat = fs.statSync(OUTPUT_FILE);
    console.log(`\n完成：${OUTPUT_FILE}（${stat.size} 字节 = ${(stat.size / 1024 / 1024).toFixed(2)} MB）`);
  } finally {
    /* 清理临时目录 */
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

/* ────────── 工具函数 ────────── */

/**
 * 按 npm pack 清单递归复制文件到目标目录。
 *
 * 只复制 packFiles 中存在的文件，跳过大目录（node_modules、.git）和已生成的压缩包。
 *
 * @param {string} srcDir   当前源目录
 * @param {string} dstDir   目标根目录（bundleDir）
 * @param {Set<string>} packFiles  npm pack 发布的文件路径集合（/ 分隔）
 * @returns {number} 复制的文件数
 */
function copyPackFiles(srcDir, dstDir, packFiles) {
  let count = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(srcDir, entry.name);
    /** 相对于项目根目录的路径 */
    const relPath = path.relative(PROJECT_ROOT, fullPath);
    /** 统一正斜杠，与 packFiles 的键匹配 */
    const normalizedRel = relPath.split(path.sep).join('/');

    if (isGeneratedArchive(normalizedRel)) continue;

    if (entry.isFile() && packFiles.has(normalizedRel)) {
      /* 确保目标子目录存在后复制文件 */
      const targetDir = path.join(dstDir, path.dirname(relPath));
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.copyFileSync(fullPath, path.join(dstDir, relPath));
      count++;
    } else if (entry.isDirectory()) {
      count += copyPackFiles(fullPath, dstDir, packFiles);
    }
  }
  return count;
}

/**
 * 递归将目录结构添加到 zip 对象。
 *
 * @param {string} dir      当前目录
 * @param {string} baseDir  基准目录（相对路径从此计算）
 * @param {object} zip      AdmZip 实例
 */
function addDirToZip(dir, baseDir, zip) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    /** 相对于基准目录的路径（zip 内路径） */
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      addDirToZip(fullPath, baseDir, zip);
    } else {
      zip.addLocalFile(fullPath, path.dirname(relPath));
    }
  }
}

main();
