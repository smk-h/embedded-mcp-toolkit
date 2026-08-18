<!-- more -->

## 一、 概述

用 `npm run pack:exe` 把 MCP Server 打包成免 Node 的单文件 `embedded-mcp-toolkit.exe`，面向「Linux 通过 SSH 远程调用 Windows 上的 MCP」等不便预装 Node.js 的场景。

产物统一输出到 `exe-out/` 目录：不进 npm 包（`.npmignore` 已排除）、不进 git（`.gitignore` 已排除）。

## 二、 方案原理

整体采用 Bun `bun build --compile`，打包脚本位于 [scripts/build-exe.mjs](../scripts/build-exe.mjs)。

### 1. JS 全量内联与版本注入

- `out/cli/index.js`（tsc 产物）连同全部 JS 依赖（含 serialport 的 JS 部分）与 Bun 运行时打进单个 exe，运行时不依赖磁盘上的 node_modules；
- 打包时通过 `--define:globalThis.__PACKAGE_JSON__=...` 把包信息以字面量注入（见 [src/shared/package-info.ts](../src/shared/package-info.ts)），exe 内 `--version`、MCP 握手版本号均不依赖磁盘文件。

### 2. 串口原生绑定外置

`@serialport/bindings-cpp` 的 `.node`（C++ 编译产物）无法进入 Bun 的快照文件系统（$bunfs），单独放在 exe 旁的 `prebuilds/<平台>-<架构>/` 目录：

- node-gyp-build 加载时会兜底探测 `process.execPath` 同目录的 `prebuilds/`（nearby 机制），无需任何环境变量即可从真实磁盘加载；
- 引导与报错指引见 [src/shared/native-bootstrap.ts](../src/shared/native-bootstrap.ts)——缺少绑定时串口命令会给出中文修复提示。

### 3. 产物结构

```text
exe-out/
├── embedded-mcp-toolkit.exe                  ← 主程序（约 96 MB）
└── prebuilds/win32-x64/
    └── @serialport+bindings-cpp.node         ← 串口原生绑定（约 230 KB）
```

> ⚠️ **分发时 exe 与 prebuilds/ 必须一起拷贝**。缺少 prebuilds 时纯 JS 功能（ssh2 / adb / MCP）不受影响，仅串口功能不可用。

## 三、 打包操作

### 1. 前置条件

- 已安装 Node.js 与 Bun（`npm i -g bun`）；
- 项目根目录已执行 `npm install`。

### 2. 打包命令

```bash
npm run pack:exe        # 按当前平台打包（Windows 上产出 .exe）
npm run pack:exe:win    # 强制 Windows x64 目标
```

### 3. 关键细节

- npm 包自带全平台 prebuilds（win32-x64 / linux-x64 / …），拷贝按目标平台进行、与宿主无关，因此 Linux CI 上执行 `--win` 也能产出正确的绑定目录（只是 .exe 无法在 Linux 上本机验证运行）；
- Windows 下 `npm i -g bun` 装出的是 bun.cmd 垫片，脚本会自动解析到 `<npm 全局目录>/node_modules/bun/bin/bun.exe` 真实二进制；
- 打包前会自动修补 `@serialport/bindings-interface` 空模块（纯类型包），绕过 Bun 的空模块消除 bug（详见脚本内注释）；
- 打包第①步会自动刷新 init 内嵌模板（见「四、2. 内嵌模板机制」），若刷新后 git 出现差异，说明模板变更后未重新生成，请一并提交。

## 四、 exe 使用方法

### 1. 初始化与启动

1. `embedded-mcp-toolkit.exe` 与 `prebuilds/` 放入目标目录；
2. 执行 `embedded-mcp-toolkit.exe init`，一键生成 `.embedded/` 数据目录、`.mcp.json` / `.opencode/opencode.json`、`.claude/settings.local.json` 与 `remote-start-mcp.bat`；
3. 生成的 `.mcp.json` / bat 中 MCP 命令已自动适配为 `./embedded-mcp-toolkit.exe`，免 Node 启动 MCP 服务器。

### 2. 内嵌模板机制

- 单文件 exe 使用内嵌模板（[src/cli/commands/init-templates.ts](../src/cli/commands/init-templates.ts)），由 [scripts/gen-init-templates.mjs](../scripts/gen-init-templates.mjs) 从仓库模板自动生成（`npm run gen:init-templates`），与仓库文件保持单一事实来源；
- 内嵌清单刻意收窄：exe 模式下 `.claude/` 目录仅写出 `settings.local.json`，CLAUDE.md、skills/、*.tmp 启动脚本不内嵌（避免把仓库个人工作流文件扩散到目标目录），npm 模式的磁盘模板不受影响；
- init 运行时优先使用磁盘模板（npm / 源码模式），仅磁盘模板缺失（exe 场景）时才走内嵌写出，两套流程共用同一份 patch 逻辑（[src/cli/commands/init.ts](../src/cli/commands/init.ts)）。

### 3. 配置与日志

配置与日志仍在 exe 的工作目录 `.embedded/` 下，与 npm 方式完全一致。

## 五、 与 npm 用法的关系

- npm 包发布内容不变（`out/`、`bin/`、模板等），`exe-out/` 已在 `.npmignore` / `.gitignore` 中排除；
- `src/` 层面的适配对 node 模式零影响：package.json 读取改为 `package-info`（node 下仍走磁盘）、serialport 改为首次使用时懒加载（行为等价）、init 优先走磁盘模板；
- 生成 exe 需要源码仓库（`scripts/` 不随 npm 包发布）。

---

*本文档由 markdowncli 技能辅助生成*
