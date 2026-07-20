# ADB 日志目录设备名错位修复 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `src/shared/config.ts` | 新增 `isValidSerialNo()`、`resolveDeviceNameBySerialNo()` 两个导出函数 |
| 新建 | `src/mcp/tools/adb/device-resolver.ts` | 封装 `resolveAdbDeviceName()` 三级降级，被 shell.ts 和 exec.ts 共用 |
| 修改 | `src/mcp/tools/adb/shell.ts` | `adbShellOpenHandler` 改造：日志启用挪到 open() 后，用降级函数算 deviceName；schema description 更新 |
| 修改 | `src/mcp/tools/adb/exec.ts` | `adbExecHandler` 改造：deviceName 解析改用降级函数；schema description 更新 |

**测试策略说明：** 本项目无单测框架（package.json 无 vitest/jest，仅有 build + lint）。验证采用：
- `npm run build` 编译通过作为强约束
- 纯函数（`isValidSerialNo` / `resolveDeviceNameBySerialNo` / `resolveAdbDeviceName`）写一个临时验证脚本（`scripts/verify-ch11.mjs`），用 Node 直接跑断言，验证完即删
- 端到端场景依赖真实设备，在 checklist 阶段用文档说明 + 手动触发验证

---

## T1: 在 config.ts 新增 `isValidSerialNo` 函数

**文件：** `src/shared/config.ts`
**依赖：** 无
**步骤：**
1. 在文件中合适位置（建议 `parseSerialNo` 函数之后，`resolveAdbSerial` 之前，与 serial 相关函数聚集）新增导出函数 `isValidSerialNo`
2. 函数签名：`export function isValidSerialNo(serialNo: string | undefined | null): boolean`
3. 实现判定规则（任一命中即返回 false）：
   - `serialNo` 为 `undefined` / `null`
   - `serialNo.trim() === ""`（空串或纯空白）
   - `/^\?+$/.test(serialNo)`（全 `?` 字符，如 `????????????`）
   - `serialNo === "(auto)"`（`getSerialNo()` 在未指定时的占位返回值）
4. 其余情况返回 true
5. 添加 JSDoc 注释，说明判定规则和各无效形态的来源

**验证：** `npm run build` 编译通过；阅读函数确认 4 条判定规则齐全

---

## T2: 在 config.ts 新增 `resolveDeviceNameBySerialNo` 函数

**文件：** `src/shared/config.ts`
**依赖：** T1（不直接依赖，但逻辑相关，建议紧邻放置）
**步骤：**
1. 在 `isValidSerialNo` 之后新增导出函数 `resolveDeviceNameBySerialNo`
2. 函数签名：`export function resolveDeviceNameBySerialNo(serialNo: string): string | undefined`
3. 实现逻辑：
   - 调用 `loadConfig().devices` 获取设备配置映射（可能为 `undefined`，做空值兜底返回 undefined）
   - 用 `Object.entries(devices)` 遍历（保证 YAML 插入顺序）
   - 对每个 `[name, cfg]`，调用已有的私有 `parseSerialNo(cfg.adb?.serialNo)` 解析出真实 serialNo
   - 若解析结果与入参 `serialNo` 字面相等，记录该 `name` 为候选
   - **多设备命中处理**：继续遍历完所有设备，若命中数 > 1，记录 WARNING 日志（含所有命中的别名和 serialNo），返回**第一个**命中的别名
   - 遍历结束未命中，返回 `undefined`
4. 添加 JSDoc 注释，说明：返回先定义的别名、多设备命中的 WARNING 行为、依赖 `parseSerialNo` 私有函数
5. 不要 export `parseSerialNo`（保持私有，仅本函数内部调用）

**验证：** `npm run build` 编译通过；阅读函数确认遍历顺序、多设备 WARNING、parseSerialNo 复用均正确

---

## T3: 新建 device-resolver.ts 实现 `resolveAdbDeviceName`

**文件：** `src/mcp/tools/adb/device-resolver.ts`（新建）
**依赖：** T1、T2
**步骤：**
1. 新建文件，添加文件头注释（参照 `src/mcp/tools/adb/shell.ts` 的文件头风格：Copyright + File name + Author + Date + Version + Description）
2. 添加 imports：
   - 从 `../../../shared/config.js` 导入 `isValidSerialNo`、`resolveDeviceNameBySerialNo`
   - 从 `../../../shared/logger.js` 导入 `logger`
3. 实现 `resolveAdbDeviceName`，签名：
   ```ts
   export function resolveAdbDeviceName(
     argDevice: string | undefined,
     realSerialNo: string,
     fallbackDevice: string,
   ): string
   ```
4. 实现降级逻辑（5 个优先级分支）：
   - **优先级 1a**：`argDevice` 真值 **且** `isValidSerialNo(argDevice)` 为 true **且** `resolveDeviceNameBySerialNo(argDevice)` 命中别名 → INFO 日志（`from args.device (serialNo→alias)`，含原值和纠正后的别名），返回别名。**目的**：防御 AI 先调 `adb_device_list` 拿 serialNo 再当 device 传入的误用
   - **优先级 1b**：`argDevice` 真值但 1a 未命中（argDevice 是别名或未登记标识）→ INFO 日志（`from args.device`），原样返回 `argDevice`
   - **优先级 2a/2b**：`argDevice` 未传 + `isValidSerialNo(realSerialNo)` 为 true：
     - 调用 `resolveDeviceNameBySerialNo(realSerialNo)`
     - 命中 → INFO 日志（`from serialNo reverse-lookup`，含 alias 和 serialNo），返回 alias
     - 未命中 → INFO 日志（`from raw serialNo (no config binding)`，含 serialNo），返回 `realSerialNo`
   - **优先级 3**：`argDevice` 未传 + `isValidSerialNo` 为 false → INFO 日志（`from placeholder (invalid serialNo)`，含原 serialNo 值），返回 `"adb-unknown"`
5. `fallbackDevice` 参数仅用于日志对照上下文（如记录"静态猜测值是 X，最终用了 Y"），不参与决策
6. 添加 JSDoc 注释，说明 5 个优先级分支和各参数用途；文件头 Description 也更新为反映新策略（不再说"三级降级"）

**验证：** `npm run build` 编译通过；阅读函数确认 5 个优先级分支齐全、每级都有 INFO 日志、`fallbackDevice` 仅用于日志；1a 的判定是 `isValidSerialNo(argDevice) && resolveDeviceNameBySerialNo(argDevice) 命中` 两步

---

## T4: 改造 adbShellOpenHandler

**文件：** `src/mcp/tools/adb/shell.ts`
**依赖：** T3
**步骤：**
1. 在文件 imports 区添加：
   - 从 `../../../shared/config.js` 的现有导入中追加 `isValidSerialNo`（如 T3 已用则不必，此处 shell.ts 自身不需要直接用，仅供 device-resolver 用——**确认 shell.ts 不需要直接导入 isValidSerialNo**，只导入 `resolveAdbDeviceName`）
   - 新增 `from "./device-resolver.js"` 导入 `resolveAdbDeviceName`
2. 改造 `adbShellOpenHandler` 函数体：
   - **保留**：`const deviceName = args.device ?? resolveDeviceName();`（重命名为 `preliminaryDevice` 更清晰，但若影响后续 `serialSource` 日志逻辑的最小改动，可保留原名 `deviceName`，仅新增 `finalDeviceName` 变量）——**选择最小改动**：保留 `deviceName` 原名作为 preliminary，新增 `finalDeviceName`
   - **保留**：`serialSource` 日志逻辑原样不动（描述 spawn 用的 serial 来源）
   - **保留**：`shell.open()` 调用及 try-catch 不变
   - **新增**（在 `shell.open()` 成功后、`adbStore.create()` 之前）：
     ```ts
     const realSerialNo = shell.getSerialNo();
     const finalDeviceName = resolveAdbDeviceName(args.device, realSerialNo, deviceName);
     ```
   - **修改** `adbStore.create` 调用：`deviceName: deviceName` → `deviceName: finalDeviceName`
   - **修改** `enableFromEnv` 调用：`enableFromEnv(sessionId, deviceName)` → `enableFromEnv(sessionId, finalDeviceName)`
   - **保留**：最后的返回结构（`Device: ${shell.getSerialNo()}`）不变
3. 检查 handler 内是否有其他用到 `deviceName` 的地方（如 logger.info），若有描述"目录名"语义的，改用 `finalDeviceName`；描述"preliminary 猜测"的保留 `deviceName`

**验证：** `npm run build` 编译通过；对照 git diff 确认：`shell.open()` 后新增了 realSerialNo + finalDeviceName 两行；`adbStore.create` 和 `enableFromEnv` 的 deviceName 参数已改为 finalDeviceName；`serialSource` 日志逻辑未动

---

## T5: 改造 adbExecHandler

**文件：** `src/mcp/tools/adb/exec.ts`
**依赖：** T3
**步骤：**
1. 在 imports 区添加：
   - 从 `../../../shared/config.js` 追加导入 `isValidSerialNo`（供现场扫描判定用）
   - 新增 `from "./device-resolver.js"` 导入 `resolveAdbDeviceName`
2. 改造 `adbExecHandler` 函数体：
   - **保留**：`const deviceName = args.device ?? resolveDeviceName();` 和 `const serialNo = resolveAdbSerial(deviceName);`
   - **保留**：`serialSource` 日志逻辑（描述 serialNo 来源）
   - **新增**（在 serialSource 日志之后、`execAdb` 调用之前）：
     ```ts
     // 确定 finalDeviceName（仅用于日志归档，不影响 execAdb 的 serialNo）
     let realSerialNo: string;
     if (args.device) {
       // 显式传参：信任调用方，realSerialNo 取 serialNo（若有）或 args.device 本身
       realSerialNo = serialNo ?? args.device;
     } else if (serialNo) {
       // config 绑定了 serialNo：realSerialNo 即 serialNo
       realSerialNo = serialNo;
     } else {
       // 自动发现：现场扫一次 adb devices 拿真实 serialNo
       realSerialNo = scanFirstAdbDeviceSerialNo() ?? "(auto)";
     }
     const finalDeviceName = resolveAdbDeviceName(args.device, realSerialNo, deviceName);
     ```
   - **新增辅助函数**（文件内私有，不 export）：`scanFirstAdbDeviceSerialNo(): string | undefined`
     - 调用 `execAdb(["devices"])`（已有函数）
     - 解析输出，返回第一个状态为 `device` 的序列号；无设备返回 undefined
     - 复用 `src/transports/adb.ts` 中 `#discoverDevice` 的解析逻辑（但本处不抛错，返回 undefined 即可）
   - **修改** `[adb_exec]` INFO 日志：`device=${deviceName}` → `device=${finalDeviceName}`，可额外追加 `preliminary=${deviceName}` 便于对照
   - **保留**：`execAdb(cmdArgs)` 调用不变（cmdArgs 仍用原 serialNo）
3. 检查 `scanFirstAdbDeviceSerialNo` 与 `execAdb` 的循环依赖：`execAdb` 在本文件已定义，`scanFirstAdbDeviceSerialNo` 调用它无循环；注意 `scanFirstAdbDeviceSerialNo` 定义位置需在 `adbExecHandler` 之前（或用函数提升）

**验证：** `npm run build` 编译通过；对照 git diff 确认：新增了 realSerialNo 三分支判定 + finalDeviceName 计算；`[adb_exec]` 日志的 device 字段已改；execAdb(cmdArgs) 调用未动

---

## T6: 更新 schema description

**文件：** `src/mcp/tools/adb/shell.ts` + `src/mcp/tools/adb/exec.ts`
**依赖：** T4、T5
**步骤：**
1. 在 `shell.ts` 的 `adbShellOpenConfig.inputSchema` 中，`device` 参数的 `description` 字段更新为：
   ```
   Device alias (e.g. "board-lubancat"). Optional — when omitted, the program auto-discovers the unique connected device and resolves the device name from its serial number internally, so there is NO need to call adb_device_list first. If a raw serial number is passed instead of an alias, it is automatically resolved to the alias when bound. Targeting and log directory both follow the resolved device name.
   ```
2. 在 `exec.ts` 的 `adbExecConfig.inputSchema` 中，`device` 参数的 `description` 字段更新为类似说明（措辞适配 exec 语义，把 "log directory" 换成 "logging"，把 "auto-discovers" 换成 "resolves"）
3. 描述用英文（与现有 description 一致），覆盖三点：
   - **推荐传别名**：措辞含 `Device alias`，举例 `board-lubancat`。**不提 config.yaml**，避免诱导 AI 直接读配置文件（别名查询应走 `device_info_tool` 或工具内部自动处理）
   - **不传也安全**：措辞显式说明 `NO need to call adb_device_list first`，告诉 AI 不必预扫描
   - **误传 serialNo 会自动反查**：措辞含 `If a raw serial number is passed ... automatically resolved`

**验证：** `npm run build` 编译通过；阅读两处 description 确认含三点说明、语言为英文、与现有 description 风格一致

---

## T7: 编写验证脚本（临时，验证后删除）

**文件：** `scripts/verify-ch11.mjs`（新建，临时）
**依赖：** T1、T2、T3
**步骤：**
1. 新建 `scripts/verify-ch11.mjs`，用 Node ESM 语法（`import` from `out/...`）
2. 前置：先 `npm run build` 确保 out/ 是最新
3. 测试用例：
   - **`isValidSerialNo`**：
     - `undefined` / `null` / `""` / `"   "` / `"????????????"` / `"(auto)"` → false
     - `"43b1e5fe7b186666"` / `"emulator-5554"` / `"192.168.1.100:5555"` → true
   - **`resolveDeviceNameBySerialNo`**：
     - 用项目现有 config（`board-lubancat` 绑定 `sn_43b1e5fe7b186666`），传入 `"43b1e5fe7b186666"` → 返回 `"board-lubancat"`
     - 传入未绑定的 serialNo（如 `"deadbeef"`）→ 返回 `undefined`
   - **`resolveAdbDeviceName`**：
     - **优先级 1a（误传 serialNo 自动纠正）**：
       - `argDevice="43b1e5fe7b186666", realSerialNo="43b1e5fe7b186666"` → 返回 `"board-lubancat"`（serialNo 反查为别名）
       - `argDevice="43b1e5fe7b186666", realSerialNo="(auto)"` → 返回 `"board-lubancat"`（argDevice 能反查即可，与 realSerialNo 无关）
     - **优先级 1b（别名或未登记标识原样使用）**：
       - `argDevice="board-b"` → 直接返回 `"board-b"`（无论 realSerialNo 是什么）
       - `argDevice="deadbeef"`（未登记 serialNo）→ 返回 `"deadbeef"`（反查不到，原样使用）
     - **优先级 2a/2b/3（未传 argDevice）**：
       - `argDevice=undefined, realSerialNo="43b1e5fe7b186666"` → 返回 `"board-lubancat"`
       - `argDevice=undefined, realSerialNo="deadbeef"` → 返回 `"deadbeef"`
       - `argDevice=undefined, realSerialNo="????????????"` → 返回 `"adb-unknown"`
       - `argDevice=undefined, realSerialNo="(auto)"` → 返回 `"adb-unknown"`
4. 每个断言用 `assert.strictEqual`，失败抛错；全部通过打印 `All ch11 verify cases passed`
5. 运行：`node scripts/verify-ch11.mjs`
6. **验证通过后删除该脚本**（`rm scripts/verify-ch11.mjs`），不提交到 git

**验证：** `node scripts/verify-ch11.mjs` 输出 `All ch11 verify cases passed`，退出码 0；脚本删除后 `git status` 不显示该文件

---

## T8: 代码风格与 lint 检查

**文件：** 全部改动文件
**依赖：** T1~T7
**步骤：**
1. 运行 `npm run format:check`，若有格式问题运行 `npm run format:fix` 修复
2. 运行 `npm run eslint:fix`，修复 lint 错误
3. 再次 `npm run build` 确认编译通过
4. 检查改动文件未破坏原编码（本仓库为 UTF-8 / LF，新建文件按此编码，修改文件保持原样）

**验证：** `npm run format:check` 通过；`npm run eslint:fix` 无错误；`npm run build` 通过

---

## 执行顺序

```
T1 (isValidSerialNo) ──┐
                     ├─→ T3 (device-resolver) ──┬─→ T4 (shell.ts)  ──┐
T2 (reverse-lookup) ─┘                          └─→ T5 (exec.ts)   ──┤
                                                                     ├─→ T6 (schema) → T7 (verify) → T8 (lint)
                                          T7 同时依赖 T1/T2/T3 ─────────┘
```

- T1、T2 可并行（无相互依赖）
- T3 依赖 T1、T2
- T4、T5 都只依赖 T3，可并行
- T6 依赖 T4、T5（改的是同一批文件）
- T7 依赖 T1、T2、T3（验证纯函数，不依赖 handler 改造）
- T8 最后，覆盖所有改动

**粒度估算：** 每个任务 3~8 分钟，总计约 40~60 分钟。