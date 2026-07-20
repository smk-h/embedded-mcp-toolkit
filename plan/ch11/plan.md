# ADB 日志目录设备名错位修复 Plan

## 架构概览

本次改动聚焦"让 ADB 日志目录名反映真实连接设备"，涉及 4 个文件，核心是引入一个**设备名反查工具函数**，并在 ADB 两个 handler 中改用它替代连接前的静态猜测。

### 改动概览

| 组件 | 文件 | 职责 |
|---|---|---|
| 新增工具函数 | `src/shared/config.ts` | `resolveDeviceNameBySerialNo()`：serialNo → 设备别名反查；`isValidSerialNo()`：serialNo 有效性判定 |
| 改造 handler | `src/mcp/tools/adb/shell.ts` | `adbShellOpenHandler`：日志启用挪到 `open()` 后，按三级降级算 deviceName |
| 改造 handler | `src/mcp/tools/adb/exec.ts` | `adbExecHandler`：deviceName 解析改用同一套降级逻辑（共用工具函数） |
| schema 更新 | `src/mcp/tools/adb/shell.ts` + `exec.ts` | `device` 参数描述补充行为说明 |

不改动：`file-logger.ts`、`session-store.ts`、`registry.ts`、`resolveDeviceName()`、`shell.open()` / `#discoverDevice()`、Serial/SSH/PowerShell 通道。

## 核心数据结构

### 设备名反查结果（无新类型，复用现有 string）

反查函数返回 `string | undefined`：
- 命中 → 返回设备别名（如 `"board-lubancat"`）
- 未命中 → 返回 `undefined`，由调用方按降级策略决定下一步

### serialNo 有效性判定结果（无新类型）

`isValidSerialNo()` 返回 `boolean`。判定规则见接口签名小节。

## 模块设计

### 模块 A：`src/shared/config.ts`（新增 2 个导出函数）

**职责：** 提供设备名反查与 serialNo 有效性判定能力，供 ADB 两个 handler 共用。

**对外接口：**

```ts
/**
 * @brief 判定 serialNo 字符串是否有效
 *
 * 无效形态：空串、纯空白、全 ? 字符（如 ????????????）、"(auto)" 占位符。
 * 这些都是 adb 在硬件无序列号、或程序未拿到真实 serialNo 时的产物。
 *
 * @param serialNo 待判定的 serialNo 字符串
 * @returns true 表示有效，可参与反查或直接用作目录名
 */
export function isValidSerialNo(serialNo: string | undefined | null): boolean;

/**
 * @brief 根据真实 ADB serialNo 反查设备别名
 *
 * 遍历 config.yaml 的 devices 配置，对每个设备解析其 adb.serialNo
 * （去掉 sn_ 前缀，parseSerialNo 复用），与输入 serialNo 字面相等即命中。
 *
 * 多设备绑定同一 serialNo 时：返回配置文件中先定义的那个（YAML 对象键的插入顺序），
 * 并记录 WARNING 日志提示存在重复绑定。
 *
 * @param serialNo 真实 serialNo（需先经 isValidSerialNo 判定为有效）
 * @returns 命中的设备别名；未命中返回 undefined（由调用方决定降级）
 */
export function resolveDeviceNameBySerialNo(serialNo: string): string | undefined;
```

**依赖：**
- `loadConfig()`（已有，文件内）：读取 devices 配置
- `parseSerialNo()`（已有，文件内私有）：解析 `sn_xxx` 前缀。**保持私有**，由 `resolveDeviceNameBySerialNo` 内部调用，不暴露
- `logger`（已有）：WARNING 日志

**实现要点：**
- `parseSerialNo` 已存在且私有，直接复用，无需改为 export
- YAML 对象键的插入顺序：JavaScript 规范保证字符串键按插入顺序遍历（整数键除外，但设备名都是字符串），因此 `Object.entries(loadConfig().devices)` 的遍历顺序即配置文件中的定义顺序
- config 读取异常（loadConfig 抛错）由调用链已有的 try-catch 兜底，本函数自身不新增 try-catch（保持与 `resolveAdbSerial` 等同源函数一致的错误传播风格）

### 模块 B：`src/mcp/tools/adb/shell.ts`（改造 `adbShellOpenHandler`）

**职责：** 让日志目录名与真实连接设备一致。

**改动点：**

1. **导入新增**：从 `config.js` 引入 `resolveDeviceNameBySerialNo` 和 `isValidSerialNo`
2. **deviceName 解析逻辑改造**（核心）：

   原流程（连接前一次性确定）：
   ```
   deviceName = args.device ?? resolveDeviceName()   // 连接前
   serialNo = resolveAdbSerial(deviceName)
   shell.open()                                       // 连接
   enableFromEnv(sessionId, deviceName)               // 用连接前的值建目录
   ```

   新流程（连接后用真实 serialNo 决定）：
   ```
   // 阶段1：仍需 args.device ?? resolveDeviceName() 用于 resolveAdbSerial(确定 spawn 哪台设备)
   preliminaryDevice = args.device ?? resolveDeviceName()
   serialNo = resolveAdbSerial(preliminaryDevice)
   shell.open()                                       // 连接，shell.getSerialNo() 此时返回真实 serialNo

   // 阶段2：连接成功后，按三级降级算最终 deviceName
   realSerialNo = shell.getSerialNo()
   finalDeviceName = resolveAdbDeviceName(args.device, realSerialNo, preliminaryDevice)

   // 阶段3：用 finalDeviceName 建目录 + 写会话表
   enableFromEnv(sessionId, finalDeviceName)
   adbStore.create(shell, { ..., deviceName: finalDeviceName, ... })
   ```

3. **降级策略封装为本地辅助函数**（不暴露，仅 handler 内部用）：

   ```ts
   /**
    * @brief deviceName 降级解析（5 个优先级分支）
    *
    * @param argDevice        调用方显式传入的 device（可选；可能是别名或误传的 serialNo）
    * @param realSerialNo       shell.open() 后实拿的真实 serialNo
    * @param fallbackDevice   连接前的静态猜测值（args.device ?? resolveDeviceName()），
    *                         仅用于日志对照，不参与降级决策
    * @returns 最终的 deviceName（用作日志子目录名 + 会话表 deviceName 字段）
    */
   function resolveAdbDeviceName(
     argDevice: string | undefined,
     realSerialNo: string,
     fallbackDevice: string,
   ): string {
     // 优先级1a：args.device 传入且本身是 serialNo（反查能命中别名）→ 纠正为别名
     // 防御 AI 先调 adb_device_list 再传 serialNo 的常见误用
     if (argDevice && isValidSerialNo(argDevice)) {
       const aliasFromArg = resolveDeviceNameBySerialNo(argDevice);
       if (aliasFromArg) {
         logger.info(`[adb_shell_open] deviceName from args.device (serialNo→alias): ${argDevice} → ${aliasFromArg}`);
         return aliasFromArg;
       }
     }
     // 优先级1b：args.device 传入但不是 serialNo（是别名或未登记标识）→ 原样使用
     if (argDevice) {
       logger.info(`[adb_shell_open] deviceName from args.device: ${argDevice}`);
       return argDevice;
     }
     // 优先级2a/2b：真实 serialNo 有效
     if (isValidSerialNo(realSerialNo)) {
       const alias = resolveDeviceNameBySerialNo(realSerialNo);
       if (alias) {
         logger.info(`[adb_shell_open] deviceName from serialNo reverse-lookup: ${alias} (serialNo=${realSerialNo})`);
         return alias;
       }
       logger.info(`[adb_shell_open] deviceName from raw serialNo (no config binding): ${realSerialNo}`);
       return realSerialNo;
     }
     // 优先级3：serialNo 无效 → 固定占位符
     logger.info(`[adb_shell_open] deviceName from placeholder (invalid serialNo="${realSerialNo}")`);
     return "adb-unknown";
   }
   ```

4. **日志保留**：原 `serialSource` 日志逻辑（记录 serialNo 来源是 user/config/auto-discovery）保持不变，因为它描述的是"spawn 用了哪个 serialNo"；新增的降级日志描述"目录名怎么定的"，两者不冲突
5. **schema description 更新**：`device` 参数的 description 补充行为说明（见 F5）

**依赖：**
- `resolveDeviceNameBySerialNo` / `isValidSerialNo`（模块 A 新增）
- `shell.getSerialNo()`（已有）：连接后拿真实 serialNo
- `adbStore.create()`（已有）：meta 中 deviceName 字段改用 finalDeviceName

### 模块 C：`src/mcp/tools/adb/exec.ts`（改造 `adbExecHandler`）

**职责：** 让 `adb_exec` 的 deviceName 解析与 `adb_shell_open` 一致。

**背景：** `adb_exec` 不创建终端会话日志（一次性命令，输出走 MCP 响应），但其 INFO 日志中记录的 `device=` 字段当前用 `resolveDeviceName()` 静态猜测，与 `adb_shell_open` 改造后会不一致。

**改动点：**

1. **导入新增**：同模块 B
2. **deviceName 解析改造**：

   原流程：
   ```
   deviceName = args.device ?? resolveDeviceName()
   serialNo = resolveAdbSerial(deviceName)
   execAdb(["-s", serialNo, ...])   // 一次性执行，无连接后状态
   ```

   问题：`adb_exec` 走 `spawnSync`，命令执行完进程就退出，没有"连接后"的概念。但执行命令前可以通过 `adb devices` 现场扫一次拿到真实 serialNo（与 `#discoverDevice()` 同源逻辑）。

   新流程（仅在未传 args.device 时扫一次，避免对显式传参场景增加开销）：
   ```
   preliminaryDevice = args.device ?? resolveDeviceName()
   serialNo = resolveAdbSerial(preliminaryDevice)

   // 仅在 args.device 未传 + serialNo 也为空（走自动发现）时，
   // 现场扫一次 adb devices 拿真实 serialNo 参与降级
   finalDeviceName = args.device
     ? args.device
     : resolveExecDeviceName(serialNo, preliminaryDevice)

   execAdb(["-s", serialNo ?? autoDiscoveredSerialNo, ...])
   ```

   其中 `resolveExecDeviceName` 复用 `resolveAdbDeviceName` 的降级逻辑：
   - 若 `serialNo` 有值（来自 config 绑定）→ 直接反查（一定能命中，因为 serialNo 本就是从 config 查出的）
   - 若 `serialNo` 为空（自动发现）→ 现场 `adb devices` 扫一次拿真实 serialNo，再走降级

3. **为避免重复实现**：把降级函数 `resolveAdbDeviceName` 提取到一个共享位置。有两个选择：
   - **方案 P1**：放 `src/mcp/tools/adb/device-resolver.ts`（新建小文件，ADB 专用）
   - **方案 P2**：放 `src/shared/config.ts`（与 `resolveDeviceNameBySerialNo` 同源，但该函数依赖 ADB 特有的 `adb-unknown` 概念，放 shared 略污染）

   **选 P1**：新建 `src/mcp/tools/adb/device-resolver.ts`，导出 `resolveAdbDeviceName(argDevice, realSerialNo, fallbackDevice)`，被 shell.ts 和 exec.ts 同时引用。理由：
   - "adb-unknown 占位符"是 ADB 通道的专属概念，不应下沉到 shared
   - 文件小（~40 行），职责单一
   - 与 spec F4"反查函数作为公共工具"不冲突——F4 的反查函数仍放 config.ts，P1 的降级函数只是组合调用它

**依赖：**
- `resolveAdbDeviceName`（新建 `device-resolver.ts`）
- `execAdb`（已有）：现场执行 `adb devices` 扫描

### 模块 D：`src/mcp/tools/adb/device-resolver.ts`（新建）

**职责：** 封装 ADB 通道的 deviceName 降级解析（含"误传 serialNo 纠正"防御），被 shell.ts 和 exec.ts 共用。

**对外接口：**

```ts
/**
 * @brief ADB 通道 deviceName 解析
 *
 * 优先级：
 *   1a. argDevice 传入且本身是 serialNo（反查命中别名）→ 纠正为别名
 *   1b. argDevice 传入但无法反查为别名（是别名或未登记标识）→ 原样使用
 *   2a. argDevice 未传 + realSerialNo 有效 + 反查命中 → 用别名
 *   2b. argDevice 未传 + realSerialNo 有效但未绑定 → 用 serialNo 本身
 *   3.  realSerialNo 无效 → 固定占位符 "adb-unknown"
 *
 * @param argDevice      调用方显式传入的 device（可选；可能是别名或误传的 serialNo）
 * @param realSerialNo     真实 serialNo（shell.getSerialNo() 或 adb devices 现场扫描）
 * @param fallbackDevice 连接前的静态猜测值，仅用于日志对照
 * @returns 最终 deviceName（日志子目录名 + 会话表 deviceName 字段）
 */
export function resolveAdbDeviceName(
  argDevice: string | undefined,
  realSerialNo: string,
  fallbackDevice: string,
): string;
```

**依赖：**
- `isValidSerialNo` / `resolveDeviceNameBySerialNo`（来自 `src/shared/config.ts`）
- `logger`（来自 `src/shared/logger.ts`）

## 模块交互

### 调用链：`adb_shell_open` 改造后

```
adbShellOpenHandler(args)
  │
  ├─ preliminaryDevice = args.device ?? resolveDeviceName()      [config.ts]
  ├─ serialNo = resolveAdbSerial(preliminaryDevice)              [config.ts]
  │
  ├─ shell.open()                                                 [transports/adb.ts]
  │     └─ #discoverDevice() 若 serialNo 为空 → adb devices 现场扫
  │
  ├─ realSerialNo = shell.getSerialNo()                             [transports/adb.ts]
  │
  ├─ finalDeviceName = resolveAdbDeviceName(                      [device-resolver.ts] ★新增
  │     args.device, realSerialNo, preliminaryDevice)
  │     ├─ argDevice 命中 → 直接返回
  │     ├─ isValidSerialNo(realSerialNo)                              [config.ts] ★新增
  │     │   ├─ true → resolveDeviceNameBySerialNo(realSerialNo)       [config.ts] ★新增
  │     │   │         ├─ 命中 → 返回别名
  │     │   │         └─ 未命中 → 返回 realSerialNo
  │     │   └─ false → 返回 "adb-unknown"
  │
  ├─ sessionId = adbStore.create(shell, {
  │     type: "adb",
  │     deviceName: finalDeviceName,        ★ 与日志目录一致
  │     connectionInfo: realSerialNo,
  │   })                                                          [session-store.ts]
  │
  └─ shell.fileLogger.enableFromEnv(sessionId, finalDeviceName)   [file-logger.ts]
```

### 调用链：`adb_exec` 改造后

```
adbExecHandler(args)
  │
  ├─ preliminaryDevice = args.device ?? resolveDeviceName()
  ├─ serialNo = resolveAdbSerial(preliminaryDevice)
  │
  ├─ realSerialNo = args.device
  │     ? serialNo ?? preliminaryDevice                           // 显式传参直接用
  │     : (serialNo ?? scanAdbDevices())                          // 自动发现则现场扫
  │
  ├─ finalDeviceName = resolveAdbDeviceName(                      [device-resolver.ts]
  │     args.device, realSerialNo, preliminaryDevice)
  │
  ├─ logger.info(`[adb_exec] command=... device=${finalDeviceName} serialNo=...`)
  │
  └─ execAdb(["-s", serialNo_for_exec, ...args])
```

注：`execAdb` 实际执行的 serialNo 仍用 `resolveAdbSerial(preliminaryDevice)` 的结果（保持原有 spawn 行为），`finalDeviceName` 只用于日志归档。两者解耦。

## 文件组织

```
src/
├── shared/
│   └── config.ts                      [修改] 新增 isValidSerialNo、resolveDeviceNameBySerialNo
└── mcp/
    └── tools/
        └── adb/
            ├── shell.ts               [修改] adbShellOpenHandler 改造、schema description
            ├── exec.ts                [修改] adbExecHandler 改造、schema description
            └── device-resolver.ts     [新建] resolveAdbDeviceName 三级降级
```

新建文件 1 个，修改文件 3 个。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 反查函数放哪 | `src/shared/config.ts` | 与 `resolveDeviceName` / `resolveAdbSerial` / `parseSerialNo` 同源，配置解析逻辑集中 |
| 降级函数放哪 | 新建 `src/mcp/tools/adb/device-resolver.ts` | "adb-unknown 占位符"是 ADB 专属概念，不应下沉到 shared；shell.ts 和 exec.ts 共用 |
| `parseSerialNo` 是否 export | 保持私有 | 已被 `resolveAdbSerial` 内部使用，`resolveDeviceNameBySerialNo` 复用即可，无需暴露 |
| `adb_exec` 是否现场扫 `adb devices` | 是，但仅在未传 `args.device` 且 `serialNo` 为空时 | 避免对显式传参场景增加开销；自动发现场景本来就要靠 adb 现场信息 |
| `adb_exec` 的 finalDeviceName 与 execAdb 的 serialNo 是否解耦 | 解耦 | execAdb 用连接前的 `resolveAdbSerial` 结果保证 spawn 行为不变；finalDeviceName 只影响日志，互不干扰 |
| 多设备绑定同一 serialNo 的处理 | 返回先定义的别名 + WARNING 日志 | JavaScript 保证 YAML 字符串键按插入顺序遍历；WARNING 提示用户配置可能有误 |
| serialNo 有效性判定是否含 `emulator-XXXX` / `IP:port` | 一律视为有效 | 它们是非空、非全?、非 `(auto)` 的字符串，符合有效定义；`IP:port` 含 `:` 在 Windows 下作目录名非法是已知边界（spec 已声明不做） |
| args.device 误传 serialNo 是否纠正 | **是（优先级 1a）** | 实测发现 AI 经常先调 `adb_device_list` 拿 serialNo 再当 device 传入，若不纠正会产生 `43b1e5fe7b186666/` 这种串号目录。1a 在保留"信任调用方"主基调的同时做防御性反查，命中别名就用别名，未命中（未登记 serialNo 或别名）才原样使用。代价：纯粹的"信任调用方"语义被削弱，但结果更正确 |
| 优先级 1a 的判定依据 | `isValidSerialNo(argDevice) && resolveDeviceNameBySerialNo(argDevice) 命中` | 两步判定：先确认 argDevice 形态像 serialNo（避免对别名做无谓反查），再反查是否绑定到别名。别名（如 `board-lubancat`）因含字母连字符不会被 `isValidSerialNo` 误判为 serialNo |
| 是否引入单元测试 | 是 | `isValidSerialNo` / `resolveDeviceNameBySerialNo` / `resolveAdbDeviceName` 纯函数，易测；放 `test/` 下，与项目现有测试组织一致 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本仓库 `.editorconfig` 已声明 UTF-8 / LF，修改时按原样写回即可

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前调用该技能，并严格遵守上述文件编码规则。
