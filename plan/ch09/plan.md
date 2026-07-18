# 日志文件命名与目录结构优化 Plan

## 架构概览

本次改动聚焦于「日志落盘的文件名与路径」，不引入新模块，只调整三个层面的行为：

1. **时间戳格式层**（`timestamp.ts`）—— 修改 `fileTimestamp()` 的返回格式，作为两类日志文件名的统一源头。
2. **终端原始日志路径层**（`file-logger.ts`）—— `enableFromEnv` 增加设备名参数，据此拼接设备子目录。
3. **调用方透传层**（4 个 tool 的 shell handler）—— 在 7 个调用点把已解析的 `deviceName` 透传给 `enableFromEnv`。

MCP 命令日志（`logger.ts`）无需改动代码——它调用 `fileTimestamp()` 的方式不变，格式随源头自动更新。

## 核心数据结构

本次无新增数据结构。仅一处接口签名变更：

### `enableFromEnv` 签名变更

**变更前：**
```ts
enableFromEnv(sessionId: string): void
```

**变更后：**
```ts
enableFromEnv(sessionId: string, deviceName?: string): void
```

- `sessionId`：会话 ID（如 `serial_1`），含义不变。
- `deviceName`（新增，可选）：当前会话所属设备名。提供时日志落入 `<savePath>/<deviceName>/` 子目录；未提供（`undefined` 或空串）时降级回 `<savePath>/` 根目录，保证日志不丢。
- 返回值：`void`，不变。

设计为可选参数而非必选，是为满足 F4 的降级要求，并保持向后兼容（理论上未来若有其它调用方未传 deviceName，仍能正常工作，只是不分目录）。

## 模块设计

### 模块 A：时间戳工具（`src/utils/timestamp.ts`）

**职责：** 提供日志文件名与行内时间戳的统一格式化。

**本次改动：** 仅修改 `fileTimestamp()` 的返回格式。

```ts
/**
 * @brief 日志文件名用时间戳（不含空格/冒号）
 *
 * 格式: YYYY-MM-DD_HHMMSS
 */
export function fileTimestamp(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}${f.mm}${f.ss}`;
}
```

- 去掉时分秒之间的两个 `-` 分隔符。
- 注释中的格式说明同步更新为 `YYYY-MM-DD_HHMMSS`。
- `beijingFields()`、`logTimestamp()`、`formatBeijingTime()` **不动**。

**依赖：** 无外部依赖，仅用内置 `Date`。

### 模块 B：终端原始日志记录器（`src/shared/file-logger.ts`）

**职责：** 按 shell 会话记录原始终端数据，每会话一个文件。

**本次改动：** 修改 `enableFromEnv` 方法，增加 `deviceName` 参数并据此构造设备子目录路径。

```ts
/**
 * @brief 根据环境变量 SAVE2FILE_PATH 自动启用日志
 *
 * 若 SAVE2FILE_PATH 值为 "none" 或空则跳过；
 * 否则按以下规则创建日志文件：
 *   - deviceName 可用 → {SAVE2FILE_PATH}/{deviceName}/{sessionId}_{YYYY-MM-DD_HHMMSS}.log
 *   - deviceName 缺失 → {SAVE2FILE_PATH}/{sessionId}_{YYYY-MM-DD_HHMMSS}.log（降级到根目录）
 *
 * @param sessionId 会话 ID（如 serial_1）
 * @param deviceName 设备名（如 board-lubancat）；可选，缺失时降级到根目录
 */
enableFromEnv(sessionId: string, deviceName?: string): void {
  const savePath = process.env.SAVE2FILE_PATH;
  if (!savePath || savePath === "none") return;
  const absDir = resolve(savePath);
  const fileName = `${sessionId}_${fileTimestamp()}.log`;
  const logPath = deviceName
    ? resolve(absDir, deviceName, fileName)
    : resolve(absDir, fileName);
  this.enable(logPath);
  logger.info(`[file-logger] file logging enabled: ${logPath}`);
}
```

关键点：
- 设备子目录的**实际创建**由 `enable(logPath)` 内部已有的 `mkdirSync(dir, { recursive: true })` 完成（见 `file-logger.ts:41-44`），**无需新增建目录逻辑**——`dirname(logPath)` 会自然取到 `<savePath>/<deviceName>` 这一级。
- 降级判断用 `deviceName` 的真值（空串、`undefined` 均视为缺失）。
- `enable()`、`disable()`、`write()` 三个方法**不动**。

**依赖：** `timestamp.ts`（`fileTimestamp`）、`logger.ts`（`logger.info`）、`fs`/`path`。

### 模块 C：调用方透传（4 个 tool 的 shell handler）

**职责：** 在各自 open / reopen / login handler 中调用 `enableFromEnv` 时透传 deviceName。

**改动清单（7 处调用点）：**

| 文件 | 行号 | handler | 透传值 |
|------|------|---------|--------|
| `src/mcp/tools/adb/shell.ts` | 136 | adb_shell_open | 局部变量 `deviceName`（L78：`args.device ?? resolveDeviceName()`） |
| `src/mcp/tools/serial/shell.ts` | 170 | serial_shell_open | 局部变量 `deviceName`（L109：`args.device ?? process.env.DEVICE ?? "default"`） |
| `src/mcp/tools/serial/shell.ts` | 661 | serial reopen | 局部变量 `deviceName`（L603：同上） |
| `src/mcp/tools/serial/shell.ts` | 989 | serial_shell_login | 函数参数 `deviceName`（L967） |
| `src/mcp/tools/ssh/shell.ts` | 104 | ssh_shell_open | 局部变量 `deviceName`（L74：`args.device ?? process.env.DEVICE ?? "default"`） |
| `src/mcp/tools/ssh/shell.ts` | 624 | ssh reopen | 局部变量 `deviceName`（L591：同上） |
| `src/mcp/tools/win/powershell.ts` | 91 | powershell_open | 字面量 `"local"`（L87：`deviceName: "local"`） |

每处改动形如：
```ts
// 变更前
shell.fileLogger.enableFromEnv(sessionId);
// 变更后
shell.fileLogger.enableFromEnv(sessionId, deviceName);
```

PowerShell 特殊：其 deviceName 是字面量 `"local"`（本地终端不属于任何远程设备），日志会落在 `<log_dir>/local/` 子目录下，与远程设备目录隔离，行为一致且合理。

**依赖：** 各 handler 已持有 `deviceName` 变量，无需新增解析逻辑。

## 模块交互

改动后的调用链（以 serial_shell_open 为例）：

```
serial_shell_open handler
  ├─ 解析 deviceName = args.device ?? process.env.DEVICE ?? "default"
  ├─ store.create(shell, { deviceName, ... }) → 返回 sessionId
  └─ shell.fileLogger.enableFromEnv(sessionId, deviceName)
       ├─ 读 SAVE2FILE_PATH，检查 none/空
       ├─ fileName = `${sessionId}_${fileTimestamp()}.log`
       │    └─ fileTimestamp() → "2026-07-18_135301"   ← 模块 A 的新格式
       ├─ logPath = resolve(savePath, deviceName, fileName)
       │            = ".embedded/log/board-lubancat/serial_1_2026-07-18_135301.log"
       ├─ this.enable(logPath)
       │    └─ mkdirSync(dirname(logPath), { recursive: true })  ← 自动建设备子目录
       └─ logger.info(...)
```

命令日志的调用链不变（仅文件名格式随 `fileTimestamp()` 自动更新）：

```
Logger.ensureInit()
  └─ this.logFile = join(dir, `${fileTimestamp()}.log`)
                   = ".embedded/log/2026-07-18_135400.log"   ← 模块 A 的新格式
```

## 文件组织

```
embedded-mcp-toolkit/
├── src/
│   ├── utils/
│   │   └── timestamp.ts          — [修改] fileTimestamp() 返回格式 + 注释
│   ├── shared/
│   │   ├── file-logger.ts        — [修改] enableFromEnv 签名 + 设备子目录拼接 + 注释
│   │   └── logger.ts             — [不动] 命令日志，文件名随 fileTimestamp() 自动更新
│   └── mcp/tools/
│       ├── adb/shell.ts          — [修改] L136 透传 deviceName
│       ├── serial/shell.ts       — [修改] L170/L661/L989 透传 deviceName（3 处）
│       ├── ssh/shell.ts          — [修改] L104/L624 透传 deviceName（2 处）
│       └── win/powershell.ts     — [修改] L91 透传 "local"
└── .embedded/log/                — 运行时产物
    ├── 2026-07-18_135400.log     — 命令日志（新格式，根目录）
    └── board-lubancat/           — 设备子目录（新增）
        ├── serial_1_2026-07-18_135301.log
        └── ssh_2_2026-07-18_140522.log
```

共 **6 个文件**改动：1 个时间戳工具 + 1 个日志记录器 + 4 个 tool handler（含 7 个调用点）。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 时间戳格式修改位置 | 直接改 `timestamp.ts` 的 `fileTimestamp()` 函数体 | `logger.ts` 和 `file-logger.ts` 两处调用方都需要新格式，改源头一处覆盖两处，避免格式逻辑散落 |
| deviceName 传递方式 | 修改 `enableFromEnv` 签名加参数，由各 handler 透传 | 各 handler 已持有准确的 deviceName（含 `args.device` 用户传参、powershell 的 `"local"`）；若在 `enableFromEnv` 内部调 `resolveDeviceName()` 会丢失这些上下文，且与 powershell 的 `"local"` 语义冲突 |
| `deviceName` 是否可选 | 设计为可选参数 `deviceName?: string` | 满足 F4 降级要求（缺失时回退根目录）；保持向后兼容，降低改动风险 |
| 降级逻辑位置 | `enableFromEnv` 内部，用 `deviceName` 真值判断 | 该方法已负责环境变量检查和路径构造，降级判断天然在此，调用方无需感知 |
| 设备子目录创建方式 | 复用 `enable()` 内部已有的 `mkdirSync(dir, { recursive: true })` | `dirname(logPath)` 会自然取到 `<savePath>/<deviceName>` 这一级，无需新增建目录代码，零冗余 |
| PowerShell 的 deviceName 取值 | 透传字面量 `"local"` | 与该 handler 已有的 `meta.deviceName = "local"` 一致；本地终端不属于远程设备，独立子目录 `local/` 与远程设备目录隔离，行为统一 |
| 是否改动 `logger.ts` | **不改** | 命令日志文件名格式随 `fileTimestamp()` 自动更新；F1 明确命令日志不分目录，无需其它改动 |
| 是否改动 `base-shell.ts` | **不改** | 它只声明 `readonly fileLogger = new FileLogger()`，不涉及 `enableFromEnv` 调用 |

## 编码规范

**编程语言：** TypeScript（Node.js，ESM 模块）

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。本次以修改已有文件为主，无新建文件。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本次涉及的 6 个源文件均为项目内既有 UTF-8 / LF 文件，修改时须保持原编码原样写回，绝不转换。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
