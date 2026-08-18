#!/usr/bin/env node
/**
 * @file build-exe.mjs
 * @brief 用 Bun 把 MCP Server 打包成免 Node 的单文件可执行程序（产物在 exe-out/）
 *
 * 原理：
 *   1. `npm run build` 先用 tsc 编译 src → out/（ESM，与 node 用法共用同一份产物）；
 *   2. `bun build --compile` 把 out/cli/index.js 连同全部 JS 依赖（含 serialport 的
 *      JS 部分）与 Bun 运行时打进单个原生可执行文件；
 *   3. 通过 `--define:globalThis.__PACKAGE_JSON__=...` 把 package.json 以字面量
 *      注入二进制（见 src/shared/package-info.ts），exe 内自带版本信息；
 *   4. serialport 的原生绑定（.node，C++ 编译产物）无法进入 Bun 的快照文件系统
 *      （$bunfs），单独拷到 exe 旁的 prebuilds/<平台>-<架构>/ 目录——node-gyp-build
 *      加载时会兜底探测 process.execPath 同目录的 prebuilds（nearby 分支），
 *      无需任何环境变量即可从真实磁盘加载。
 *
 * 产物（exe-out/ 目录，分发时 exe 与 prebuilds/ 缺一不可）：
 *   exe-out/
 *   ├── embedded-mcp-toolkit.exe              ← 主程序（内置全部 JS 依赖 + Bun 运行时）
 *   └── prebuilds/win32-x64/*.node            ← 串口原生绑定（随 exe 一起分发）
 *
 * 用法：
 *   node scripts/build-exe.mjs              # 按当前平台打包
 *   node scripts/build-exe.mjs --win        # 强制 Windows x64 目标（可在任意平台执行，
 *                                            #  prebuilds 按"目标平台"拷贝，与宿主无关）
 *
 * 注意：
 *   - 需要已安装 Bun（npm i -g bun 或 https://bun.sh）；
 *   - npm 包自带全平台 prebuilds（win32-x64/linux-x64/...），拷贝与宿主平台无关，
 *     因此在 Linux CI 上执行 --win 也能产出正确的 win32-x64 绑定目录；
 *     只是产出的 .exe 无法在 Linux 上本机验证运行。
 */

import { execSync, spawnSync } from "child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/* ────────── 路径与常量 ────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

/** 读取 package.json（版本号 + 打包期注入 exe 的字面量来源） */
const PKG = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")
);
const VERSION = PKG.version;

/** 产物输出目录（已在 .npmignore / .gitignore 中排除，不发布、不提交） */
const DIST_DIR = join(PROJECT_ROOT, "exe-out");

/** exe 文件名（与 native-bootstrap 的 nearby 判定约定的目录布局保持一致） */
const EXE_NAME = "embedded-mcp-toolkit.exe";

/** 串口原生绑定源目录（node_modules 内，npm 包自带全平台 prebuilds/） */
const BINDINGS_SRC = join(
  PROJECT_ROOT,
  "node_modules",
  "@serialport",
  "bindings-cpp",
  "prebuilds"
);

/** 是否强制 Windows x64 目标 */
const FORCE_WIN = process.argv.includes("--win");

/** 宿主平台（决定默认打包目标） */
const HOST_PLATFORM = process.platform;

/**
 * @brief 解析 Bun 打包目标（bun-windows-x64 / bun-linux-x64 / ...）
 *
 * 默认按宿主平台产出；--win 强制 Windows x64。Bun 支持跨平台 --compile，
 * 且 prebuilds 按目标平台拷贝（数据文件与宿主无关），故 --win 在 Linux 上同样有效。
 */
function resolveTarget() {
  if (FORCE_WIN) return "bun-windows-x64";
  switch (HOST_PLATFORM) {
    case "win32":
      return "bun-windows-x64";
    case "darwin":
      return "bun-darwin-x64";
    case "linux":
      return "bun-linux-x64";
    default:
      return "bun-linux-x64";
  }
}

/** 从打包目标推导 node-gyp-build 的 prebuild 平台目录名（如 win32-x64） */
function prebuildTuple(target) {
  const map = {
    "bun-windows-x64": "win32-x64",
    "bun-linux-x64": "linux-x64",
    "bun-darwin-x64": "darwin-x64+arm64",
    "bun-linux-arm64": "linux-arm64",
  };
  return map[target] ?? "win32-x64";
}

/**
 * @brief 修补纯类型包 @serialport/bindings-interface 的空实现（绕过 Bun 打包 bug）
 *
 * 该包只有类型声明：dist/index.js 仅一行 'use strict';（无任何导出）。
 * Bun 的打包器把"无导出的空 CJS 模块"整体消除时存在 bug——
 * bindings-cpp 源码中的 __exportStar(require("@serialport/bindings-interface"), exports)
 * 会被错误改写成 __exportStar(, exports)（实参被删空），产出非法语法，
 * 编译出的 exe 一启动就报 SyntaxError: Unexpected token ','。
 *
 * 补丁：给该模块追加一行 module.exports = {};（与原语义完全等价——require 它
 * 本来就得到空对象），使其不再被视为可消除的空模块。幂等，npm ci 后重跑自动恢复。
 */
function patchTypeOnlyModules() {
  const target = join(
    PROJECT_ROOT,
    "node_modules",
    "@serialport",
    "bindings-interface",
    "dist",
    "index.js"
  );
  if (!existsSync(target)) {
    console.warn("  ⚠ 未找到 @serialport/bindings-interface，跳过空模块补丁");
    return;
  }
  const content = readFileSync(target, "utf8");
  if (!content.includes("module.exports")) {
    appendFileSync(target, "\nmodule.exports = {};\n");
    console.log(
      "  ✔ 已修补 @serialport/bindings-interface（Bun 空模块打包 bug）"
    );
  }
}

/**
 * @brief 拷贝目标平台的串口原生绑定到 exe-out/prebuilds/<平台>/
 *
 * 布局对齐 node-gyp-build 的 nearby 兜底：其加载串口绑定时会探测
 * process.execPath 同目录的 prebuilds/<platform>-<arch>/，命中即从真实磁盘加载。
 */
function copyNativeBindings(tuple) {
  const srcTuple = join(BINDINGS_SRC, tuple);
  if (!existsSync(srcTuple)) {
    console.warn(
      `  ⚠ 未找到 ${BINDINGS_SRC}${tuple}，串口原生绑定缺失（exe 的串口功能将不可用）`
    );
    return;
  }

  const dst = join(DIST_DIR, "prebuilds", tuple);
  rmSync(dst, { recursive: true, force: true });
  cpSync(srcTuple, dst, { recursive: true });

  const nodeFiles = readdirSync(dst).filter((f) => f.endsWith(".node"));
  console.log(
    `  ✔ 串口原生绑定: prebuilds/${tuple}/ 下 ${nodeFiles.length} 个 .node`
  );
}

/**
 * @brief 解析可执行的 Bun 命令（返回绝对路径或 "bun"）
 *
 * Windows 下 `npm i -g bun` 装出的是 bun.cmd 垫片，Node 的 spawn 不允许直接
 * 执行 .cmd（CVE-2024-27980 后强制），需要定位真实 bun.exe。候选顺序：
 *   1. PATH 上直接可执行的 bun（Unix / Windows 原生安装）；
 *   2. 官方安装器落点：$BUN_INSTALL/bin/bun.exe、~/.bun/bin/bun.exe；
 *   3. npm 全局包内的真实二进制：<npm root -g>/bun/bin/bun.exe。
 *
 * @returns {string} bun 可执行路径；找不到时退出进程
 */
function resolveBunBin() {
  const direct = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (direct.status === 0) return "bun";

  const candidates = [];
  if (process.platform === "win32") {
    if (process.env.BUN_INSTALL) {
      candidates.push(join(process.env.BUN_INSTALL, "bin", "bun.exe"));
    }
    candidates.push(join(homedir(), ".bun", "bin", "bun.exe"));
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      candidates.push(join(globalRoot, "bun", "bin", "bun.exe"));
    } catch {
      /* npm 不在 PATH，跳过该候选 */
    }
  }
  for (const exe of candidates) {
    if (existsSync(exe)) return exe;
  }

  console.error(
    "❌ 未检测到 Bun。请先安装：npm i -g bun（或参考 https://bun.sh）"
  );
  process.exit(1);
}

/* ────────── 主流程 ────────── */
function main() {
  // 0. 前置检查：Bun 是否可用
  const bunBin = resolveBunBin();
  const bunCheck = spawnSync(bunBin, ["--version"], { encoding: "utf8" });
  if (bunCheck.status !== 0) {
    console.error("❌ Bun 无法执行，请检查安装：npm i -g bun");
    process.exit(1);
  }

  const target = resolveTarget();
  const tuple = prebuildTuple(target);
  console.log(`\n📦 embedded-mcp-toolkit v${VERSION} → 单文件可执行打包`);
  console.log(`  Bun: ${bunCheck.stdout.trim()}   目标平台: ${target}`);

  // 1. 编译 TypeScript（与 node 用法共用 out/）
  console.log("\n① 编译 TypeScript...");
  execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });

  // 1.5 修补 Bun 空模块打包 bug（详见 patchTypeOnlyModules 注释）
  patchTypeOnlyModules();

  // 2. 准备输出目录
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

  // 3. Bun 打包单文件可执行
  //    - serialport 的 JS 全部打进 exe（不加 --external），避免运行时从磁盘
  //      解析 node_modules 的不确定性；
  //    - package.json 通过 define 注入（globalThis 成员表达式，node 下自然为
  //      undefined 并走磁盘读取分支，见 src/shared/package-info.ts）。
  console.log("\n② Bun 打包单文件可执行...");
  const define = `globalThis.__PACKAGE_JSON__=${JSON.stringify(JSON.stringify(PKG))}`;
  const exeOut = join(DIST_DIR, EXE_NAME);
  const args = [
    "build",
    "out/cli/index.js",
    `--target=${target}`,
    "--compile",
    `--define=${define}`,
    `--outfile=${exeOut}`,
  ];
  const res = spawnSync(bunBin, args, { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("\n❌ bun build 失败");
    process.exit(res.status ?? 1);
  }

  // 4. 拷贝串口原生绑定
  console.log("\n③ 拷贝串口原生绑定...");
  copyNativeBindings(tuple);

  // 5. 汇总产物
  console.log("\n④ 产物清单：");
  if (existsSync(exeOut)) {
    const exeSize = (statSync(exeOut).size / 1024 / 1024).toFixed(1);
    console.log(`  ✔ ${EXE_NAME}  (${exeSize} MB)`);
  }
  if (existsSync(join(DIST_DIR, "prebuilds", tuple))) {
    console.log(`  ✔ prebuilds/${tuple}/  (串口原生绑定)`);
  }
  console.log(`\n✅ 完成。目录：${DIST_DIR}`);
  console.log(
    `   分发时请把 exe 与 prebuilds/ 子目录一起拷贝（串口功能依赖它）。\n`
  );
}

main();
