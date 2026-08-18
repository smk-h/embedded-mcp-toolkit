/**
 * @file native-bootstrap.ts
 * @brief 串口原生绑定（.node）加载前置检查与引导
 *
 * 背景：
 *   serialport 的原生绑定 @serialport/bindings-cpp 是 C++ 编译产物（.node 文件），
 *   由 node-gyp-build 在运行时从磁盘探测加载。两种运行环境的加载路径不同：
 *
 *   - npm 安装 / 源码运行：绑定包就在 node_modules 里，node-gyp-build 按
 *     __dirname 常规解析，天然可用；
 *   - 单文件 exe（bun build --compile，见 scripts/build-exe.mjs）：全部 JS 已打进
 *     二进制的虚拟文件系统（$bunfs），node-gyp-build 在虚拟路径下探测不到
 *     prebuilds。node-gyp-build 自带 nearby 兜底——会自动查找
 *     process.execPath 同目录下的 prebuilds/<platform>-<arch>/*.node——因此打包时
 *     把 win32-x64 的 .node 拷到 exe 旁的 prebuilds/ 目录即可被自动加载。
 *
 *   本模块不修改任何环境变量（node-gyp-build 的 <包名>_PREBUILD 覆盖变量名含
 *   "@" 与 "/"，在 Windows 下设置不可靠），只做两件事：
 *     1. 串口使用前确认绑定可被找到（exe 布局或 node_modules）；
 *     2. 找不到时给出明确的中文错误指引，替代 node-gyp-build 的晦涩报错。
 */

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { createRequire } from "module";

/** exe 旁随附的原生绑定目录名（与 scripts/build-exe.mjs 的产物布局一致） */
const EXE_PREBUILDS_DIR = "prebuilds";

/** node-gyp-build 的 prebuild 平台目录名（如 win32-x64 / linux-x64） */
function platformTuple(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * @brief exe 布局检查：exe 同目录是否存在 prebuilds/<platform>-<arch>
 *
 * node-gyp-build 加载绑定时会兜底探测 process.execPath 同目录的
 * prebuilds/<platform>-<arch>/（其 load.resolve 的 nearby 分支），
 * 命中后直接从真实磁盘 dlopen，无需任何额外配置。
 *
 * @returns 目录存在返回 true
 */
function hasNearbyPrebuilds(): boolean {
  const nearby = join(
    dirname(process.execPath),
    EXE_PREBUILDS_DIR,
    platformTuple()
  );
  return existsSync(nearby);
}

/**
 * @brief node_modules 布局检查：能否从本模块解析到 @serialport/bindings-cpp
 *
 * 覆盖 npm 安装 / 源码运行 / `bun run` 开发三种场景：绑定包在
 * node_modules 中就位，node-gyp-build 常规解析即可。
 *
 * @returns 解析到的绑定包目录存在 prebuilds（或 build 产物）时返回 true
 */
function hasNodeModulesBindings(): boolean {
  try {
    // bindings-cpp 无 exports 限制，可解析其入口再回溯包根目录；
    // 单文件 exe 中 import.meta.url 指向 $bunfs 虚拟路径，此处解析
    // 必然失败走 catch，不影响 exe 布局的 nearby 判定
    const req = createRequire(import.meta.url);
    const entry = req.resolve("@serialport/bindings-cpp");
    const pkgDir = resolve(dirname(entry), "..");
    return (
      existsSync(join(pkgDir, "prebuilds")) ||
      existsSync(join(pkgDir, "build", "Release"))
    );
  } catch {
    return false;
  }
}

/**
 * @brief 确认串口原生绑定可用（幂等，串口首次使用前调用一次）
 *
 * 在动态 import("serialport") 之前调用：serialport 顶层会执行
 * node-gyp-build 加载 .node，绑定缺失时抛出难以理解的底层错误；
 * 本函数先给出明确的业务侧报错。
 *
 * @returns 绑定可用返回 true；返回 false 时调用方应中止并提示用户
 */
export function ensureSerialNativeBindings(): boolean {
  return hasNearbyPrebuilds() || hasNodeModulesBindings();
}

/**
 * @brief 绑定缺失时的用户可读错误信息
 *
 * @returns 中文错误文案（含两种场景的修复指引）
 */
export function serialBindingsMissingMessage(): string {
  const tuple = platformTuple();
  const nearby = join(dirname(process.execPath), EXE_PREBUILDS_DIR, tuple);
  return [
    "串口功能不可用：找不到 serialport 的原生绑定（.node）。",
    "若以单文件 exe 方式运行，请勿单独拷贝 exe——必须把 exe 与同目录的",
    `${EXE_PREBUILDS_DIR}/ 子目录一起分发（期望路径：${nearby}）。`,
    "若以 npm / 源码方式运行，请在项目根目录重新执行 npm install。",
  ].join("\n");
}
