<!-- more -->

## 一、 架构概览

本次改动沿用 ch08 已建立的「三通道共用 `runExec` 统一编排层」架构，仅在其中插入「常驻命令分类」决策点，并把原本单一的「超时即发 Ctrl+C」路径拆为两条（采样超时路径 / 兜底超时路径）。新增一个与 `prompt-detector.ts` 并列的共享模块负责常驻识别；新增设备级配置项照搬 `getPromptPattern` 的注入模式。

组件划分：

- **常驻命令检测器（新增 `resident-detector.ts`）**：负责「命令字符串 → 是否常驻」的判定。内置默认白名单（首 token 精确匹配集 + 带 `-f/--follow/-w` 参数模式集），支持外部传入用户配置扩展名单，合并去重。纯函数式，不碰 shell。
- **exec 编排层（改造 `exec-runner.ts`）**：在 `runExec` 内部、发命令前做一次常驻分类；据此选择超时时长（采样时长 vs 兜底时长）与超时动作（发 Ctrl+C vs 不发）；返回结果用 `timeoutKind` 区分三态。
- **设备配置层（改造 `config.ts`）**：新增 `getExecTimeoutConfig(name?)` 注入函数，读取设备级三项配置（常驻命令扩展名单、采样超时时长、兜底超时时长）。
- **三通道 exec handler（改造 `adb/ssh/serial` 的 `shell.ts`）**：在原 `getPromptPattern(deviceName)` 调用点并行取 exec 超时配置，透传进 `runExec`；格式化返回结果时按 `timeoutKind` 产出两种不同的超时标注。

数据流：

```
config.yaml 设备段
   │  getExecTimeoutConfig(deviceName)
   ▼
handler ──→ runExec({ command, execTimeoutConfig, promptDetector, ... })
              │
              │  classifyResident(command)        ← resident-detector.ts
              │     ├─ 命中 → 常驻：采样时长(默认10s) + 超时发Ctrl+C
              │     └─ 未命中 → 普通：兜底时长(默认5min) + 超时不发Ctrl+C
              ▼
           ExecResult { timeoutKind: "none"|"sampling"|"fallback", ... }
              │
              ▼
handler 按 timeoutKind 格式化 → MCP 响应（两种标注文案）
```

## 二、 核心数据结构

### `ResidentVerdict`（常驻检测结论，新增）

```
type ResidentVerdict =
  | { kind: "resident"; reason: string }   // 常驻命令（含命中规则，供日志）
  | { kind: "normal"; reason: string };     // 普通命令（含首 token，供日志）
```

判定的单一结论，附带命中原因（哪条规则 / 首 token 值），供 `runExec` 写日志（满足 N4 可观测性）。

### `ExecTimeoutConfig`（设备级配置片段，新增）

```
interface ExecTimeoutConfig {
  /** 常驻命令扩展名单（用户配置追加），未配置为空数组 */
  readonly residentCommands?: readonly string[];
  /** 采样超时时长（毫秒），常驻命令用，未配置由 runExec 用默认值兜底 */
  readonly samplingTimeoutMs?: number;
  /** 兜底超时时长（毫秒），普通命令用，未配置由 runExec 用默认值兜底 */
  readonly fallbackTimeoutMs?: number;
}
```

由 `config.ts` 的 `getExecTimeoutConfig` 返回，作为 `ExecInput` 字段注入。字段全部可选，未配置时各消费点回退默认值（与 `getPromptPattern` 返回 `string | undefined` 由 `PromptDetector` 兜底的范式一致）。

### `ExecTimeoutKind`（超时类型枚举，新增）

```
type ExecTimeoutKind = "none" | "sampling" | "fallback";
```

- `none`：正常完成（提示符命中）
- `sampling`：常驻命令采样超时（到点发 Ctrl+C，中性语义）
- `fallback`：普通命令兜底超时（到点不发 Ctrl+C，异常语义）

### `ExecResult`（改造，exec-runner.ts:88-97）

```
interface ExecResult {
  readonly output: string;
  /** 保留字段，当前恒为 false（与 ch08 一致） */
  readonly interrupted: boolean;
  /** 超时类型（取代单纯布尔 timedOut 的语义载体） */
  readonly timeoutKind: ExecTimeoutKind;
  /** 是否超时（= timeoutKind !== "none"，派生布尔，保持向后兼容） */
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}
```

设计要点：
- 新增 `timeoutKind` 作为区分两种超时的权威字段。
- **保留 `timedOut`** 作为派生布尔（`timeoutKind !== "none"`），不破坏既有字段名。三个 handler 原本只读 `timedOut`，现在改读 `timeoutKind` 分支；保留 `timedOut` 可让任何未来消费者无感。
- `interrupted` 字段继续保留恒 false，与 ch08 一致。

## 三、 模块设计

### 模块 A：常驻命令检测器（新建 `src/mcp/shared/resident-detector.ts`）

**职责：** 给定原始命令字符串，判定它是常驻命令（永不返回 shell 提示符、持续输出）还是普通命令。

**对外接口：**

```
/**
 * 判定命令是否为常驻命令
 * @param command 用户原始命令字符串（如 "tail -f /var/log/x"）
 * @param extraResidentCommands 设备配置追加的常驻命令名（首 token 精确匹配）
 * @returns ResidentVerdict，含命中原因供日志
 */
export function classifyResident(
  command: string,
  extraResidentCommands?: readonly string[]
): ResidentVerdict;
```

**实现要点：**

1. **首 token 提取**：`command.trim()` 后按 `[\s|;>&<()`']` 分割取首段，再去除首尾引号。这样 `echo hi | grep foo` 的首 token 是 `echo`（遇 `|` 即止），符合 spec F1「首空格/管道/重定向之前」的定义。
   - 注意：现有 `src/mcp/tools/adb/exec.ts` 的 `tokenizeCommand` 是私有的且只在空白处分词，**不复用**。
2. **空命令兜底**：首 token 为空 → `normal`。
3. **内置默认白名单**（常量）：
   - 首 token 精确匹配集（A 类）：`ping`、`ping6`、`logcat`、`top`、`htop`、`watch`、`strace`、`tcpdump`。用 `Set<string>` + `has()` 判定。
   - 首 token + 参数模式集（B 类）：
     - `dmesg` 带 `-w` 或 `--follow`
     - `journalctl` 带 `-f` 或 `--follow`
     - `tail` 带 `-f`、`-F` 或 `--follow`
   - 参数模式匹配：取首 token 之后的剩余命令串，用正则检测目标 flag 是否作为独立 token 出现（如 `/(?:^|\s)(?:-w|--follow|-f|-F)(?=\s|=|$)/`）。注意区分 `-f` 与 `-file`——要求 flag 后是空白、`=`、或字符串结尾。
4. **用户配置扩展（F2）**：`extraResidentCommands` 与内置 A 类集合并集去重后，按首 token 精确匹配判定。用户配置只支持「首 token 精确匹配」这一种形式（最简、最可预测）；不支持用户配置参数模式（YAGNI，spec F1 的参数模式仅覆盖内置三命令）。
5. **优先级**：先查用户扩展集，再查内置 A 类，再查内置 B 类参数模式；命中即返回，附命中规则名。

**依赖：** 无（纯字符串处理）。

### 模块 B：exec 编排层（改造 `src/mcp/shared/exec-runner.ts`）

**职责：** 在 ch08 既有 `runExec` 流程中插入常驻分类，拆分超时时长与动作。

**改动点：**

1. **新增常量**（exec-runner.ts 顶部，与现有 `DEFAULT_MAX_DURATION_MS` 等并列）：
   - `DEFAULT_SAMPLING_TIMEOUT_MS = 10000`（常驻采样，沿用原 10 秒）
   - `DEFAULT_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000`（普通兜底，5 分钟）
   - 原 `DEFAULT_MAX_DURATION_MS`（10000）保留但改为内部兼容用途——见下「向后兼容」。
2. **`ExecInput` 新增字段**：
   - `execTimeoutConfig?: ExecTimeoutConfig`（设备级配置注入）
   - 其余字段不变。
3. **`runExec` 内部流程调整**（在步骤 1 前置冲刷之前、发命令之前插入分类）：
   - 调 `classifyResident(input.command, input.execTimeoutConfig?.residentCommands)` 得 `verdict`。
   - 据此选定 `effectiveTimeout`：
     - 常驻：`input.maxDuration ?? input.execTimeoutConfig?.samplingTimeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS`
     - 普通：`input.maxDuration ?? input.execTimeoutConfig?.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS`
   - 关键：**`maxDuration` 优先级最高**（spec F6），只覆盖「时长」，不改变「动作」（动作仍按常驻性）。
   - 记日志：`logger.info("${prefix} classified: ${verdict.kind} (first-token=...), effectiveTimeout=${effectiveTimeout}ms")`。
   - `deadline = max(effectiveTimeout, minDelay)` 沿用 ch08 逻辑。
4. **轮询提示符**（步骤 4）逻辑不变。
5. **超时分支拆分**（步骤 5，原 exec-runner.ts:199-212）：
   - 常驻 → 发 Ctrl+C（`input.sendCtrl("c")`）+ sleep + drain，返回 `timeoutKind: "sampling"`。
   - 普通 → **不发 Ctrl+C**，仅 drain 已有残留，返回 `timeoutKind: "fallback"`。
   - 日志区分两种类型。
6. **正常完成分支**（步骤 4 内）返回 `timeoutKind: "none"`，`timedOut: false`。

**向后兼容处理**：旧的 `DEFAULT_MAX_DURATION_MS` 不再作为默认超时直接使用，但保留常量名（语义变为「采样默认值」的别名，等于 `DEFAULT_SAMPLING_TIMEOUT_MS`），避免任何潜在外部引用断裂；新代码统一用新常量。

**依赖：** `resident-detector.ts`、`prompt-detector.ts`（已有）、`InteractiveShell`（已有）。

### 模块 C：设备配置层（改造 `src/shared/config.ts`）

**职责：** 提供设备级 exec 超时配置的读取入口。

**改动点：**

1. **`DeviceConfig` 接口新增字段**（config.ts:31-57，放在 `promptPattern` 旁边，与 adb/ssh/serial 平级）：
   - `residentCommands?: readonly string[]`（常驻命令扩展名单）
   - `samplingTimeoutMs?: number`（采样超时，常驻命令）
   - `fallbackTimeoutMs?: number`（兜底超时，普通命令）
   - 字段风格：平铺在设备根层（与 `promptPattern` 一致），因为 exec 由三通道共享（N2）。注释标明「三通道共享」。
2. **新增注入函数**（放在 `getPromptPattern` 后、`getUbootConfig` 前，即 config.ts:258 与 260 之间）：
   ```
   export function getExecTimeoutConfig(name?: string): ExecTimeoutConfig {
     const device = getDeviceConfig(name ?? resolveDeviceName());
     return {
       residentCommands: device.residentCommands,
       samplingTimeoutMs: device.samplingTimeoutMs,
       fallbackTimeoutMs: device.fallbackTimeoutMs,
     };
   }
   ```
   - 返回 `ExecTimeoutConfig`（从 `exec-runner.ts` 导入类型，或把类型定义放在 config.ts 由 exec-runner 反向导入——选择前者，保持「类型归属编排层」）。
   - 未配置字段为 `undefined`，由 `runExec` 兜底（与 `getPromptPattern` 返回 `undefined` 由 `PromptDetector` 兜底一致）。

**依赖：** `ExecTimeoutConfig` 类型从 `exec-runner.ts` 导入。

### 模块 D：三通道 exec handler（改造 `adb/ssh/serial` 的 `shell.ts`）

**职责：** 读取超时配置注入 `runExec`，并按 `timeoutKind` 格式化返回标注。

**改动点（三处对称，以 adb 为例）：**

1. **读取配置**（adb/shell.ts:423 `new PromptDetector(...)` 旁）：
   - 新增 `const execTimeoutConfig = getExecTimeoutConfig(deviceName);`
   - import `getExecTimeoutConfig`。
2. **透传进 `runExec`**（adb/shell.ts:430-439 的 `runExec({...})`）：
   - 新增字段 `execTimeoutConfig`。
3. **格式化分支**（adb/shell.ts:441-449 的三态格式化块）：
   - 由原 `if (execResult.timedOut)` 单分支，改为按 `execResult.timeoutKind` 三分支：
     - `"none"`：原样返回。
     - `"sampling"`：追加 `[采样超时: 已收集 ${elapsedMs}ms 输出，已发送 Ctrl+C 终止常驻命令]`
     - `"fallback"`：追加 `[兜底超时: 已收集 ${elapsedMs}ms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`
   - 三通道文案保持字节一致（N2）。
4. **`inputSchema` 的 `maxDuration` 描述更新**（adb/shell.ts:382-386 等）：原「default: 10000」改为「default: 常驻命令 10000，普通命令 300000（5分钟）」，让调用方知悉默认值已按命令类型分流。

ssh（ssh/shell.ts:358-385）、serial（serial/shell.ts:434-461）改动与 adb 完全对称。

**依赖：** `getExecTimeoutConfig`、`runExec`（已改）。

## 四、 模块交互

典型调用链（以 `adb_shell_exec` 执行 `logcat` 为例）：

1. `adbShellExecHandler` 收到 `{ command: "logcat" }`。
2. 取 `deviceName = resolveDeviceName()`。
3. 取 `promptDetector = new PromptDetector(getPromptPattern(deviceName))`（ch08 既有）。
4. 取 `execTimeoutConfig = getExecTimeoutConfig(deviceName)`（新增）。
5. 调 `runExec({ shell, command, execTimeoutConfig, promptDetector, sendCtrl, logPrefix })`。
6. `runExec` 内：
   - `classifyResident("logcat", execTimeoutConfig.residentCommands)` → `{ kind: "resident", reason: "builtin-set: logcat" }`。
   - `effectiveTimeout = maxDuration ?? samplingTimeoutMs ?? 10000` = 10000。
   - 发命令、轮询、回显剥离（ch08 既有）。
   - 10 秒未现提示符 → 走常驻分支：`sendCtrl("c")` + sleep + drain → 返回 `timeoutKind: "sampling"`。
7. handler 按 `"sampling"` 追加采样超时标注 → MCP 响应。

普通命令（如 `make`）的链路：`classifyResident("make")` → `{ kind: "normal" }` → `effectiveTimeout = 5min` → 若 5 分钟内提示符命中则正常返回；若未命中走兜底分支（不发 Ctrl+C）→ `timeoutKind: "fallback"`。

## 五、 文件组织

```
embedded-mcp-toolkit/
├── src/
│   ├── mcp/shared/
│   │   ├── exec-runner.ts        — 改造：ExecInput/ExecResult 新字段、常驻分类、双超时分支
│   │   ├── resident-detector.ts  — 新建：classifyResident + 内置白名单 + 首 token 提取
│   │   └── prompt-detector.ts    — 不改（ch08 既有）
│   ├── shared/
│   │   └── config.ts             — 改造：DeviceConfig 新字段 + getExecTimeoutConfig
│   └── mcp/tools/
│       ├── adb/shell.ts          — 改造：取配置、透传、三分支格式化、schema 描述
│       ├── ssh/shell.ts          — 改造：同上（对称）
│       └── serial/shell.ts       — 改造：同上（对称）
└── .embedded/configs/
    └── devices/board-example.yaml — 改造：新增三项配置示例 + 注释（模板文档）
```

新建 1 个文件，改造 5 个源文件 + 1 个配置模板。

## 六、 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 常驻识别放在哪一层 | `runExec` 内部（单 chokepoint） | spec N2 要求三通道一致；`runExec` 是三通道唯一共用点，且已持有原始 `command`。放 handler 则需改三处、易不一致。 |
| 首 token 提取 | 自写，遇 `[\|;>&<()`']` 即止 | 现有 `tokenizeCommand`（adb/exec.ts）私有且只在空白分词，`echo hi \| grep foo` 会误判 `echo` 之后；spec F1 明确「首空格/管道/重定向之前」。 |
| 默认白名单形态 | A 类用 `Set<string>` 精确匹配，B 类用正则参数模式 | spec F1 区分两类；A 类简单可预测，B 类必须识别 `-f/-w/--follow` 参数。用户配置只支持 A 类形式（YAGNI）。 |
| 超时区分字段 | 新增 `timeoutKind` 枚举，保留 `timedOut` 派生布尔 | spec F5 要求两种标注不同；枚举是权威载体；保留 `timedOut` 不破坏既有字段名，未来消费者无感。 |
| 普通命令兜底动作 | 超时不发 Ctrl+C | 用户明确决策（需求澄清）：避免误杀可能已完成只是提示符没匹配的命令，或提示符误判的设备；异常语义标注引导调用方手动处理。 |
| 常驻命令采样动作 | 超时发 Ctrl+C | 用户明确决策：避免 ping/logcat 在设备后台持续运行污染后续会话；中性语义。 |
| `maxDuration` 优先级 | 最高，只覆盖时长不改变动作 | spec F6：调用方传 `maxDuration` 表示「我指定执行多久」，但终止动作仍按命令常驻性（常驻发 Ctrl+C、普通不发），语义最直观。 |
| 配置项位置 | 设备根层，与 `promptPattern` 平级 | exec 由三通道共享（N2），与 `promptPattern` 同性质；`getPromptPattern` 是最贴近的现成范本。 |
| 兜底超时默认值 | 5 分钟 | 用户决策（需求澄清）：覆盖大多数编译/安装/大文件场景；正常命令提示符匹配在毫秒级返回，此值仅异常兜底。 |
| 采样超时默认值 | 10 秒（沿用 ch08） | 用户决策：logcat 取 10 秒日志、ping 打 10 秒够用，可配置。 |
| 新模块命名 | `resident-detector.ts` | 与既有 `prompt-detector.ts` 命名对称，表意清晰（常驻检测器）。 |

## 七、 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行（`resident-detector.ts`）。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本项目源文件均为 UTF-8 无 BOM、LF，修改时沿用即可，绝不转换编码。

开发阶段编写代码时，必须遵循 ts-lang-spec 中定义的编码风格、命名约定、注释规范（本项目源码大量使用 JSDoc 注释块，新代码须保持同一风格；`removeComments: true` 仅影响编译产物，源码注释须完整保留）。import 路径须带 `.js` 后缀（`moduleResolution: NodeNext` 强制要求）。`strict: true` 下须显式标注参数与返回类型，妥善处理 `undefined`。
