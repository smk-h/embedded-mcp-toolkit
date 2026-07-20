# ADB 日志目录设备名错位修复 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 命名约定：本文档中 `serialNo` 指 adb 序列号（device serial number），与"串口（serial port）"无关。

## 实现完整性

- [ ] `isValidSerialNo()` 已实现并被调用（验证：`npm run build` 编译通过；`grep -r "isValidSerialNo" src/` 出现定义和至少一处调用）
- [ ] `resolveDeviceNameBySerialNo()` 已实现并被调用（验证：`npm run build` 编译通过；`grep -r "resolveDeviceNameBySerialNo" src/` 出现定义和 device-resolver.ts 的调用）
- [ ] `resolveAdbDeviceName()` 已实现于 `src/mcp/tools/adb/device-resolver.ts`（验证：文件存在；`grep -r "resolveAdbDeviceName" src/` 出现定义 + shell.ts + exec.ts 三处引用）
- [ ] `adbShellOpenHandler` 中 `enableFromEnv` 调用位于 `shell.open()` 之后（验证：阅读 `src/mcp/tools/adb/shell.ts`，确认 `enableFromEnv` 在 `await shell.open()` 成功之后才被调用）
- [ ] `adbExecHandler` 中 `finalDeviceName` 通过 `resolveAdbDeviceName` 计算（验证：阅读 `src/mcp/tools/adb/exec.ts`，确认 deviceName 解析走降级函数而非纯 `resolveDeviceName()`）

## 功能验证（对应 spec AC1~AC11）

> 功能验证采用 `scripts/verify-ch11.mjs` 临时脚本跑纯函数断言（项目无单测框架）。端到端场景依赖真实设备，标注「手动」的项需接板子验证。

### AC1：args.device 传别名时原样使用

- [ ] `resolveAdbDeviceName(argDevice="board-b", realSerialNo="任意值", fallback="任意值")` 直接返回 `"board-b"`，不触发反查（验证：verify-ch11.mjs 断言；INFO 日志含 `from args.device`）
- [ ] `resolveAdbDeviceName(argDevice="board-lubancat", realSerialNo="43b1e5fe7b186666", ...)` 返回 `"board-lubancat"`（别名原样使用，不反查）

### AC2：serialNo 反查命中别名

- [ ] `resolveDeviceNameBySerialNo("43b1e5fe7b186666")` 在项目现有 config（`board-lubancat` 绑定 `sn_43b1e5fe7b186666`）下返回 `"board-lubancat"`（验证：verify-ch11.mjs 断言）
- [ ] `resolveAdbDeviceName(argDevice=undefined, realSerialNo="43b1e5fe7b186666", ...)` 返回 `"board-lubancat"`（验证：verify-ch11.mjs 断言）
- [ ] **手动**：`process.env.DEVICE=board-b` 环境下，实际连接 serialNo 为 `43b1e5fe7b186666` 的设备，不传 `device` 调用 `adb_shell_open`，观察日志路径为 `.embedded/log/board-lubancat/`

### AC3：serialNo 有效但 config 未绑定 → 用 serialNo 本身

- [ ] `resolveDeviceNameBySerialNo("deadbeef")` 返回 `undefined`（验证：verify-ch11.mjs 断言）
- [ ] `resolveAdbDeviceName(argDevice=undefined, realSerialNo="deadbeef", ...)` 返回 `"deadbeef"`（验证：verify-ch11.mjs 断言；INFO 日志含 `from raw serialNo`）

### AC4：调试设备无序列号 → 用固定占位符

- [ ] `isValidSerialNo("????????????")` 返回 `false`（验证：verify-ch11.mjs 断言）
- [ ] `resolveAdbDeviceName(argDevice=undefined, realSerialNo="????????????"`, ...) 返回 `"adb-unknown"`（验证：verify-ch11.mjs 断言；INFO 日志含 `from placeholder`）

### AC5：会话表 deviceName 与日志目录一致

- [ ] `adbStore.create()` 存入 `SessionMeta` 的 `deviceName` 与 `enableFromEnv` 第二参数**完全相同**（验证：阅读 shell.ts 改动，确认两处都用 `finalDeviceName` 变量）
- [ ] **手动**：调用 `adb_shell_open` 后查 `adb_session_list`，返回的 `deviceName` 字段与磁盘日志目录名一致

### AC6：adb_exec 同步修复

- [ ] `adbExecHandler` 和 `adbShellOpenHandler` 都调用 `resolveAdbDeviceName`（验证：`grep -r "resolveAdbDeviceName" src/mcp/tools/adb/` 至少 3 处：1 定义 + 2 调用）
- [ ] `adb_exec` 的 INFO 日志 `device=` 字段反映 `finalDeviceName` 而非 `resolveDeviceName()` 的静态猜测（验证：阅读 exec.ts 改动，确认日志字段已替换；可额外检查是否追加了 `preliminary=` 便于对照）

### AC7：Serial/SSH 通道行为不变

- [ ] `src/mcp/tools/serial/shell.ts` 和 `src/mcp/tools/ssh/shell.ts` 的 git diff 为空或仅涉及无关改动（验证：`git diff src/mcp/tools/serial/ src/mcp/tools/ssh/` 确认未触及 deviceName 解析逻辑）
- [ ] **手动**：运行 Serial/SSH 工具，日志目录与改动前一致（仍走 `args.device ?? process.env.DEVICE ?? "default"`）

### AC8：多设备重复绑定 warning

- [ ] config 中两个别名绑定同一 serialNo 时，`resolveDeviceNameBySerialNo` 返回先定义的别名，并记录 WARNING 日志（验证：verify-ch11.mjs 构造临时 config 或 mock；**手动**可用真实 config 复制一份绑定验证）

### AC9：serialNo 有效性判定覆盖所有边界

- [ ] `isValidSerialNo` 对以下输入返回 false：`undefined`、`null`、`""`、`"   "`、`"????????????"`、`"(auto)"`（验证：verify-ch11.mjs 6 个断言）
- [ ] `isValidSerialNo` 对以下输入返回 true：`"43b1e5fe7b186666"`、`"emulator-5554"`、`"192.168.1.100:5555"`（验证：verify-ch11.mjs 3 个断言）

### AC10：schema description 更新

- [ ] `src/mcp/tools/adb/shell.ts` 的 `device` 参数 description 含三点说明：①推荐传别名（措辞含 `Device alias`，**不提 config.yaml**）；②不传也安全（措辞含 `NO need to call adb_device_list first`）；③误传 serialNo 会自动反查（验证：阅读 description 字段）
- [ ] `src/mcp/tools/adb/exec.ts` 的 `device` 参数 description 同样含上述三点（验证：阅读 description 字段）

### AC11：args.device 误传 serialNo 时自动反查为别名（新增）

- [ ] `resolveAdbDeviceName(argDevice="43b1e5fe7b186666", realSerialNo="43b1e5fe7b186666", ...)` 返回 `"board-lubancat"`（验证：verify-ch11.mjs 断言；INFO 日志含 `from args.device (serialNo→alias)`）
- [ ] `resolveAdbDeviceName(argDevice="43b1e5fe7b186666", realSerialNo="(auto)", ...)` 返回 `"board-lubancat"`（验证：argDevice 能反查即可，与 realSerialNo 无关）
- [ ] `resolveAdbDeviceName(argDevice="deadbeef", realSerialNo="deadbeef", ...)` 返回 `"deadbeef"`（验证：argDevice 是未登记 serialNo，反查不到，走 1b 原样使用）
- [ ] 别名不会被误判为 serialNo：`resolveAdbDeviceName(argDevice="board-lubancat", ...)` 走 1b 而非 1a（验证：`isValidSerialNo("board-lubancat")` 应为 true，但 `resolveDeviceNameBySerialNo("board-lubancat")` 应为 undefined，所以走 1b 原样使用）
- [ ] **手动**：模拟 AI 的典型误用——先调 `adb_device_list` 拿到 serialNo `43b1e5fe7b186666`，再调 `adb_shell_open({device: "43b1e5fe7b186666"})`，观察日志目录为 `.embedded/log/board-lubancat/`（而非 `43b1e5fe7b186666/`）

## 集成

- [ ] `adbShellOpenHandler` 改造后调用链完整：`shell.open()` → `getSerialNo()` → `resolveAdbDeviceName()` → `adbStore.create(finalDeviceName)` → `enableFromEnv(finalDeviceName)`（验证：阅读 shell.ts 改动，确认五步顺序无缺漏）
- [ ] `device-resolver.ts` 被 shell.ts 和 exec.ts 同时引用，无重复实现（验证：`grep -rn "function resolveAdbDeviceName" src/` 只有 1 处定义）
- [ ] `resolveDeviceNameBySerialNo` 和 `isValidSerialNo` 仅在 `src/shared/config.ts` 定义一次（验证：`grep -rn "export function isValidSerialNo\|export function resolveDeviceNameBySerialNo" src/` 各 1 处）

## 编译与测试

- [ ] `npm run build` 编译无错误（验证：执行命令，退出码 0）
- [ ] `node scripts/verify-ch11.mjs` 输出 `All ch11 verify cases passed`，退出码 0（验证：执行命令）
- [ ] `npm run format:check` 通过（验证：执行命令无 diff 输出；若有运行 `npm run format:fix`）
- [ ] `npm run eslint:fix` 无错误（验证：执行命令，退出码 0）
- [ ] 代码符合 `ts-lang-spec` 规范（验证：lint 通过 + 人工检查命名/注释/JSDoc 风格）
- [ ] 文件编码未被破坏：新建文件 `device-resolver.ts` 为 UTF-8 无 BOM / LF；修改的已有文件保持原编码（验证：`file --mime-encoding src/mcp/tools/adb/*.ts src/shared/config.ts` 或编辑器查看）
- [ ] 临时验证脚本已删除：`scripts/verify-ch11.mjs` 不存在（验证：`ls scripts/verify-ch11.mjs` 报 No such file；`git status` 不显示该文件）

## 端到端场景

### 场景 1：核心修复——不传 device 时目录与真实连接一致（手动）

- [ ] 前置：`.mcp.json` 设 `DEVICE=board-b`，实际连接的设备 serialNo 为 `43b1e5fe7b186666`（对应 config 中的 `board-lubancat`）
- [ ] 操作：调用 `adb_shell_open`（不传 `device` 参数）
- [ ] 预期：日志文件出现在 `.embedded/log/board-lubancat/adb_<n>_<timestamp>.log`，**不是** `board-b/`
- [ ] 预期：`adb_session_list` 返回的该会话 `deviceName="board-lubancat"`

### 场景 2：显式传别名时原样使用（手动）

- [ ] 前置：同场景 1
- [ ] 操作：调用 `adb_shell_open({device: "my-custom-name"})`（未登记的别名）
- [ ] 预期：日志目录为 `.embedded/log/my-custom-name/`，会话 `deviceName="my-custom-name"`（走优先级 1b，原样使用）

### 场景 2.5：AI 误传 serialNo 时自动纠正为别名（手动，新增）

- [ ] 前置：同场景 1（`process.env.DEVICE=board-b`，实际连接 serialNo `43b1e5fe7b186666` 对应别名 `board-lubancat`）
- [ ] 操作：模拟 AI 的典型误用——先调 `adb_device_list` 拿到 serialNo，再调 `adb_shell_open({device: "43b1e5fe7b186666"})`（把 serialNo 当别名传）
- [ ] 预期：日志目录为 `.embedded/log/board-lubancat/`（**不是** `43b1e5fe7b186666/`），会话 `deviceName="board-lubancat"`（走优先级 1a，serialNo 被反查纠正为别名）
- [ ] 预期：server 日志含 `[adb] deviceName resolved from args.device (serialNo→alias): 43b1e5fe7b186666 → board-lubancat`

### 场景 3：未绑定 serialNo 的设备（手动）

- [ ] 前置：config 中无任何设备绑定当前连接的 serialNo（如一台新设备 `abcdef123456`）
- [ ] 操作：不传 `device` 调用 `adb_shell_open`
- [ ] 预期：日志目录为 `.embedded/log/abcdef123456/`

### 场景 4：无序列号调试板（手动）

- [ ] 前置：连接一台 `adb devices` 显示 `????????????` 的调试板
- [ ] 操作：不传 `device` 调用 `adb_shell_open`
- [ ] 预期：日志目录为 `.embedded/log/adb-unknown/`；多次会话日志聚合在同一目录

### 场景 5：Serial/SSH 未受影响（手动）

- [ ] 操作：分别调用 `serial_shell_open` 和 `ssh_shell_open`
- [ ] 预期：日志目录行为与改动前完全一致（仍按 `args.device ?? process.env.DEVICE ?? "default"` 解析）

## 回归检查

- [ ] `adb_shell_open` 在 `SAVE2FILE_PATH` 未设置或为 `"none"` 时不创建日志目录（验证：清空 env 后调用，确认不报错、不建目录——保留 file-logger.ts 现有降级）
- [ ] `adb_shell_open` 多设备场景仍正常抛错（验证：mock 或手动连接 2+ 台设备，不传 `device` 调用，确认走 `#discoverDevice()` 的 `Multiple ADB devices found` 错误，不走降级）
- [ ] `adb_shell_open` 零设备场景仍正常抛错（验证：无设备连接时调用，确认走 `No ADB device found` 错误）
- [ ] `resolveDeviceName()` 本身未被修改（验证：`git diff src/shared/config.ts` 确认 `resolveDeviceName` 函数体无改动，只新增了两个函数）
