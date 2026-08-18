/**
 * @file package-info.ts
 * @brief 统一的 package.json 信息读取（兼容 npm/源码运行与单文件 exe 两种模式）
 *
 * 两种运行环境的取值来源：
 *   - 单文件 exe（bun build --compile，见 scripts/build-exe.mjs）：打包时通过
 *     `--define:globalThis.__PACKAGE_JSON__=<JSON 字面量>` 注入，磁盘上没有
 *     对应的 package.json；
 *   - npm 安装 / 源码运行（node out/cli/index.js）：从本文件相对路径读取磁盘
 *     package.json（与原有行为一致）。
 *
 * 注入通道选用 globalThis 成员表达式而非裸标识符：define 语义下成员表达式被
 * 精确替换，node 运行时该属性自然为 undefined，无需依赖 typeof 折叠等打包器
 * 实现细节。
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/** package.json 中本工具关心的字段 */
export interface PackageInfo {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/**
 * @brief 加载 package.json 信息（模块加载时执行一次）
 *
 * @returns 解析后的包信息
 * @throws 未注入（npm/源码模式）且磁盘 package.json 缺失/损坏时抛出异常
 */
function loadPackageInfo(): PackageInfo {
  // exe 模式：打包期通过 --define 注入的字符串字面量
  const injected = (globalThis as Record<string, unknown>).__PACKAGE_JSON__;
  if (typeof injected === "string") {
    return JSON.parse(injected) as PackageInfo;
  }

  // npm/源码模式：out/shared/package-info.js → 仓库根 package.json
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return JSON.parse(
    readFileSync(resolve(__dirname, "../../package.json"), "utf-8")
  ) as PackageInfo;
}

/** 包信息单例（name / version / dependencies / devDependencies） */
export const pkg: PackageInfo = loadPackageInfo();
