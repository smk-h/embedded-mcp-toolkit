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

#### 2.1 Bun 兼容性：exe 使用 @dimava 分支绑定（仅影响 Windows exe）

serialport 官方 `@serialport/bindings-cpp` 的原生绑定在 Windows 下用 `uv_default_loop()` 注册读写异步回调。该回调在 Node 下正常工作，但 **Bun 下 `uv_default_loop()` 与 N-API 事件循环不是同一个**，导致串口打开成功、写入成功，却**永远收不到 `data` 事件**（表现：登录时探测无输出、exec 全部超时）。参考：

- [oven-sh/bun#23192](https://github.com/oven-sh/bun/issues/23192)：N-API 插件用 `uv_default_loop` 回调不触发，改用 `napi_get_uv_event_loop` 修复；
- [serialport/node-serialport#2707](https://github.com/serialport/node-serialport/issues/2707)：serialport 在 Bun 下"打开但不发 data"。

#### 2.2  怎么修复

官方包至今（13.0.1）未修复。修复方案：exe 打包时**绑定取自社区分支** `@dimava/serialport-bindings-cpp`（devDependency，仅构建期需要），其 C++ 把 `serialport_win.cpp` 的 `uv_async_init` 改为 `napi_get_uv_event_loop(env, &loop)`（失败回退 `uv_default_loop`），Node 与 Bun 下均正常。

该分支的出处与复现信息如下（`@dimava` 只是 npm 发布 scope，与仓库名不一致，直接按包名搜 GitHub 找不到源码）：

- npm 包：[@dimava/serialport-bindings-cpp](https://www.npmjs.com/package/@dimava/serialport-bindings-cpp)——只发布 `win32-x64` 预编译绑定；
- 源码仓库：[Dimava/node-serialport](https://github.com/Dimava/node-serialport)——官方 [serialport/node-serialport](https://github.com/serialport/node-serialport) 的个人 fork；
- 关键修复提交：[779d9dd](https://github.com/Dimava/node-serialport/commit/779d9dd48752555b20924c98e42251c2fd7f22be)——`serialport_win.cpp` 的 `uv_async_init` 改用 `napi_get_uv_event_loop`，失败回退 `uv_default_loop`；

改动本身很小，完整 diff 如下（写入 `Write` 与读取 `Read` 两处各一次，仓库不可用时可直接按此对官方源码打补丁）：

```diff
// src/serialport_win.cpp
@@ -424,7 +424,9 @@ Napi::Value Write(const Napi::CallbackInfo& info) {
   baton->complete = false;
 
   uv_async_t* async = new uv_async_t;
-  uv_async_init(uv_default_loop(), async, EIO_AfterWrite);
+  uv_loop_t* loop = uv_default_loop();
+  napi_status uvst = napi_get_uv_event_loop(env, &loop);
+  uv_async_init(loop, async, EIO_AfterWrite);
   async->data = baton;
   // WriteFileEx requires a thread that can block. Create a new thread to
   // run the write operation, saving the handle so it can be deallocated later.
@@ -611,7 +613,9 @@ Napi::Value Read(const Napi::CallbackInfo& info) {
   baton->complete = false;
 
   uv_async_t* async = new uv_async_t;
-  uv_async_init(uv_default_loop(), async, EIO_AfterRead);
+  uv_loop_t* loop = uv_default_loop();
+  napi_status uvst = napi_get_uv_event_loop(env, &loop);
+  uv_async_init(loop, async, EIO_AfterRead);
   async->data = baton;
  baton->hThread = CreateThread(NULL, 0, ReadThread, async, 0, NULL);
  // ReadFileEx requires a thread that can block. Create a new thread to
```

该仓库为社区个人维护，存在停止维护或删除的风险。若包或仓库不可用：按上述提交对官方源码打同一补丁，`npm run build` 自产 `.node` 后走同样的覆盖/拷贝流程即可复现；本地 `exe-out/prebuilds/win32-x64/` 已构建好的 `.node` 也可作临时备份。

- **node 模式不受影响**：依赖仍是官方 `@serialport/bindings-cpp`（全平台 prebuilds），dimava 包只是 devDependency，不进 npm 发布产物；
- **exe 模式（本地运行）**：exe 运行时 node-gyp-build 会优先加载磁盘 `node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/` 下的官方绑定（有 bug）。故 `scripts/build-exe.mjs` 额外用 `patchWinPrebuildBindings` 把 @dimava 的 `.node` **覆盖到该官方预编译位置**，exe 加载的即是修复版绑定；`npm ci` 重装后需重跑 `pack:exe` 才会再次生效。
- **exe 模式（分发运行，无 node_modules）**：node-gyp-build 兜底到 `exe-out/prebuilds/win32-x64/`（copyNativeBindings 从 `node_modules/@dimava/serialport-bindings-cpp/prebuilds` 拷贝，同样是 @dimava 绑定）。修复在原生层，与打进 exe 的官方 JS 包装层 API 完全兼容。

> ⚠️ **平台限制**：@dimava 分支只发布 `win32-x64` 预编译绑定。因此 exe 打包目标仅 Windows x64 支持串口；Linux/macOS 目标会因找不到 prebuilds 而串口不可用（构建脚本会给出警告）。

### 3. 产物结构

```text
exe-out/
├── embedded-mcp-toolkit.exe                  ← 主程序（约 96 MB）
└── prebuilds/win32-x64/
    └── @dimava+serialport-bindings-cpp.node  ← 串口原生绑定（约 230 KB）
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

- 打包串口绑定取自 `@dimava/serialport-bindings-cpp`（devDependency，见「二、2.1」，仅含 win32-x64）——`--win` 目标正常，其他平台会警告串口不可用；
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
- 内嵌的 `.opencode/opencode.json` 模板在生成时已剔除 `instructions` 字段（其指向的 `.claude/CLAUDE.md` 在 exe 模式下不再生成），npm 模式保留该字段；
- init 运行时优先使用磁盘模板（npm / 源码模式），仅磁盘模板缺失（exe 场景）时才走内嵌写出，两套流程共用同一份 patch 逻辑（[src/cli/commands/init.ts](../src/cli/commands/init.ts)）。

### 3. 配置与日志

配置与日志仍在 exe 的工作目录 `.embedded/` 下，与 npm 方式完全一致。

## 五、 与 npm 用法的关系

- npm 包发布内容不变（`out/`、`bin/`、模板等），`exe-out/` 已在 `.npmignore` / `.gitignore` 中排除；
- `src/` 层面的适配对 node 模式零影响：package.json 读取改为 `package-info`（node 下仍走磁盘）、serialport 改为首次使用时懒加载（行为等价）、init 优先走磁盘模板；
- 生成 exe 需要源码仓库（`scripts/` 不随 npm 包发布）。

## 六、 常见问题

### 1. exe 串口无法登录/使用（data 事件永不触发）

打包产物 `embedded-mcp-toolkit.exe` 串口功能异常，而 node 模式（`node bin/embedded-mcp-toolkit-cli.js`）一切正常。本文记录该问题的完整排查过程与最终方案，涉及**两层根因**：Bun 与官方串口绑定的事件循环不兼容，以及 exe 运行时加载绑定的优先级陷阱。方案原理部分见「二、2.1」。

#### 1.1 问题现象

- `serial_shell_login` 能成功打开 COM4 并返回 session（`Session serial_1 on COM4`），但探测阶段收不到任何回显；
- 随后 `serial_exec` 全部触发兜底超时：`fallback timeout after 5000ms (no prompt)`，命令无任何输出；
- node 模式跑同一套登录、执行流程完全正常（`echo` 命令约 400ms 即命中结束标记并返回输出）；
- 偶发 `Opening COM4: Access denied`，实为 COM4 被上一个进程占用（同一串口只能被一个进程独占），释放后即可正常打开，与本次 bug 无直接关系。

#### 1.2 排查过程

##### 1.2.1 第一步：锁定差异在串口读取回调

用同一份 raw JSON-RPC 测试脚本分别启动 node 与 exe，确认只有 exe 异常。随后在 [src/transports/serial.ts](../src/transports/serial.ts) 加 DEBUG_SERIAL 插桩，分别打印写入与读取事件：

- 写入事件（`[DBG write]`）：每次发送命令都触发；
- 读取事件（`[DBG data]`）：exe 下**一次都不触发**。

由此排除业务逻辑问题：串口已打开、写入也成功，但数据读回调永远不会被调用。

##### 1.2.2 第二步：定位到 Bun 事件循环兼容性问题

「打开成功、写入成功、但收不到 data」是已知问题，官方 issue 已有结论：

- [serialport/node-serialport#2707](https://github.com/serialport/node-serialport/issues/2707)：serialport 在 Bun 下「打开但不发 data」；
- [oven-sh/bun#23192](https://github.com/oven-sh/bun/issues/23192)：N-API 插件用 `uv_default_loop()` 注册的回调在 Bun 下不触发，应改用 `napi_get_uv_event_loop()`。

根因：官方 `@serialport/bindings-cpp` 在 Windows 下用 `uv_default_loop()` 注册读写异步回调。Node 的事件循环就是 default loop，所以正常；而 Bun 的 N-API 事件循环是独立创建的、不是 default loop，回调因此永远不触发。官方包至今（13.0.1）未修复。

##### 1.2.3 第三步：确认修复分支 @dimava

社区分支 `@dimava/serialport-bindings-cpp@13.0.2` 修复了该问题，其 `serialport_win.cpp` 把 `uv_async_init` 改为 `napi_get_uv_event_loop(env, &loop)`，失败时回退 `uv_default_loop()`，Node 与 Bun 下均正常。关键点：

- 该分支的 `dist/` JS 与官方包**逐字节一致**（逐一 diff 确认无差异），修复只在原生层，JS 接口完全兼容；
- 只发布 `win32-x64` 预编译绑定（`.node`），其他平台无预编译产物。

##### 1.2.4 第四步：overrides 方案踩坑

最初用 [package.json](../package.json) 的 `overrides` 把 `@serialport/bindings-cpp` 全局替换为 dimava 分支，重建 exe 后验证**通过**。但该方案有严重副作用：

- 顶层 `@serialport/bindings-cpp` 变为 dimava，官方**全平台** prebuilds（android-arm、linux-x64、darwin 等）全部丢失；
- node 模式在 Linux/macOS 上会因找不到绑定而串口不可用，npm 离线包同样回归；
- 为修 Windows exe 而牺牲 node 全平台，不可接受，因此放弃 overrides。

##### 1.2.5 第五步：devDependency 方案为何仍失败

改为正确拆法：官方 `@serialport/bindings-cpp@13.0.0` 保持顶层（全平台 prebuilds，node 用），`@dimava/serialport-bindings-cpp@13.0.2` 作为 devDependency（仅构建期用），[scripts/build-exe.mjs](../scripts/build-exe.mjs) 的 `BINDINGS_SRC` 指向 dimava。重建 exe 后验证**仍然失败**（data 事件依旧不触发），连续 3 次复现。

此时在 [src/shared/native-bootstrap.ts](../src/shared/native-bootstrap.ts) 与 [src/transports/serial.ts](../src/transports/serial.ts) 加插桩观察绑定解析路径：

- `hasNodeModulesBindings()` 返回 `false`：exe 内 `require.resolve('@serialport/bindings-cpp')` 在 `$bunfs` 虚拟路径下解析失败（报 `Cannot find module ... from 'B:\~BUN\root\...'`）；
- `hasNearbyPrebuilds()` 返回 `true`：`exe-out/prebuilds/win32-x64/` 存在。

按理 exe 应走 nearby 兜底加载 `exe-out` 里的 dimava 绑定，但现象不符，于是做对照实验。

##### 1.2.6 第六步：对照实验揪出磁盘预编译优先级

把磁盘 `node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node`（官方）临时改名移走，**不重新打包**直接重跑 exe：

- 结果恢复正常：exec 命中结束标记，约 407ms 返回输出；
- 恢复该文件后再跑，又复现失败。

结论：exe 运行时 node-gyp-build（Bun 的 `require.addon` 原生解析）**优先加载磁盘 node_modules 里的官方预编译绑定**，而非 exe 旁的 nearby 目录：

- 官方 `.node` 在场 → 加载有 bug 的官方绑定 → 收不到 data；
- 官方 `.node` 缺失 → 才兜底到 `exe-out/prebuilds/` 的 dimava 绑定 → 正常。

这也解释了为何「JS 相同、.node 相同、产物布局相同」的 overrides 方案却有效：overrides 把磁盘 `@serialport/bindings-cpp` 换成了 dimava，exe 从磁盘加载的本来就是修复版绑定。

#### 1.3 解决方案

##### 1.3.1 方案演进小结

| 方案 | 结果 | 问题 |
|------|------|------|
| overrides 全局替换 | exe 可用 | node 全平台 prebuilds 丢失，Linux/macOS 回归 |
| devDependency（仅拷贝 exe-out） | exe 仍失败 | exe 优先加载磁盘官方 .node |
| devDependency + 构建期覆盖 win32-x64 | exe、node 双端通过 | 无（`npm ci` 后需重跑打包） |

##### 1.3.2 最终方案：构建期覆盖 win32-x64 预编译

[scripts/build-exe.mjs](../scripts/build-exe.mjs) 新增 `patchWinPrebuildBindings()`，在打包最后一步把 dimava 分支的 `.node` 覆盖到官方 win32-x64 预编译位置：

```js
// scripts/build-exe.mjs（简化示意，完整实现见该函数）
cpSync(
  // 源：dimava 分支的修复版绑定（devDependency）
  "node_modules/@dimava/serialport-bindings-cpp/prebuilds/win32-x64/@dimava+serialport-bindings-cpp.node",
  // 目标：官方预编译位置（exe 运行时优先从磁盘加载的位置）
  "node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node"
);
```

- **本地运行**（node_modules 在场）：exe 从磁盘加载的即修复版绑定；
- **分发运行**（无 node_modules）：node-gyp-build 兜底 `exe-out/prebuilds/win32-x64/`，同样是 dimava 绑定（`copyNativeBindings()` 已拷贝）；
- **node 模式**：加载覆盖后的 dimava 绑定同样正常（该分支改进了事件循环获取方式，Node 下行为与官方一致），其余平台官方 prebuilds 原样保留；
- **幂等**：每次 `pack:exe` 都会重新覆盖；`npm ci` 重装后官方 .node 会恢复，需重跑 `npm run pack:exe` 才会再次生效。

##### 1.3.3 验证结果

- exe 与 node 双端各跑一遍 login → exec（`echo hello-from-exe` 返回 `hello-from-exe` 与 `[exit code: 0]`）→ close，全部通过；
- 三处 .node（node_modules 官方位、dimava 源、exe-out）SHA-256 完全一致；
- 分发场景（移走磁盘官方 .node 模拟无 node_modules）同样正常。

#### 1.4 注意事项

- exe 串口仅支持 Windows x64：@dimava 分支只发布 `win32-x64` 预编译绑定，其他打包目标会因找不到 prebuilds 而串口不可用；
- 重装依赖（`npm ci` / `npm install` 清空重建）后，必须重跑 `npm run pack:exe`，否则 exe 会再次加载官方（有 bug）绑定；
- 分发时必须把 `exe-out/prebuilds/` 与 exe 一起拷贝；
- 调试经验：单文件 exe 看似自包含，但原生绑定（.node）的实际解析优先级是「磁盘 node_modules 优先，exe 旁 prebuilds 兜底」，定位加载问题时须同时检查两处；
- 排查期间覆盖 .node 文件时，先结束占用它的进程（如运行中的 MCP server），否则 Windows 会报文件被占用。

---

*本文档由 markdowncli 技能辅助生成*
