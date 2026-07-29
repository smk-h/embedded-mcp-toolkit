# 会话日志路径提供 Plan

## 架构概览

本功能不新增模块，而是在现有的「文件日志 → 会话注册表 → 查询工具」链路上补一个信息断点：

```
[FileLogger]              [会话注册表 registry]          [session_info]
enableFromEnv ──返回路径──→ SessionMeta.logPath ──查询──→ 格式化输出 Log 行
   ↑                              ↑                          ↑
 数据来源（已存在）          新增字段（本任务）          新增展示行（本任务）
```

三个改动点都落在既有组件上：

- **FileLogger.enableFromEnv**：从 `void` 改为返回日志文件路径（数据来源，已存在，仅改返回值）
- **SessionMeta / CreateSessionMeta**：新增 `logPath` 可选字段（数据载体）
- **session_info**：格式化输出新增 `Log:` 行（展示层）

三通道（serial/ssh/adb）的会话建立入口各自把 `enableFromEnv` 的返回值写入会话元数据，逻辑同构。

## 核心数据结构

### SessionMeta（会话元数据）

在 `registry.ts` 的 `SessionMeta` 接口新增一个可选字段：

```ts
export interface SessionMeta {
  id: string;
  type: SessionType;
  deviceName: string;
  connectionInfo: string;
  createdAt: string;
  logPath?: string; // 【新增】该会话对应的日志文件完整路径；文件日志未启用时为 undefined
}
```

字段语义：
- 文件日志启用时，值为 `enableFromEnv` 实际创建的文件路径（绝对路径，由 `resolve()` 产生）
- 文件日志未启用（`SAVE2FILE_PATH` 未配置或为 `none`）时，值为 `undefined`
- 会话存续期间不变（复用会话不重建日志文件）

### CreateSessionMeta（创建会话所需的元数据）

在 `session-store.ts` 的 `CreateSessionMeta` 接口新增同名可选字段，供各通道 handler 构建后传入：

```ts
export interface CreateSessionMeta {
  type: SessionType;
  deviceName: string;
  connectionInfo: string;
  logPath?: string; // 【新增】日志文件路径，来自 enableFromEnv 的返回值
}
```

## 模块设计

### FileLogger.enableFromEnv（数据来源）

**职责：** 根据环境变量创建日志文件，返回实际文件路径。

**对外接口：**
```ts
enableFromEnv(sessionId: string, deviceName?: string): string | undefined
```

**改动：** 返回类型从 `void` 改为 `string | undefined`。
- 文件已创建时，`return logPath`（方法内已有的局部变量，目前算完即丢弃）
- 环境未配置（`SAVE2FILE_PATH` 为空或 `none`）时，`return undefined`（对应现有的 `return;` 早退点）

**依赖：** 无新增。`enable` / `write` / `disable` 行为完全不变。

### ShellSessionStore.create（透传）

**职责：** 注册会话实例与元数据。

**改动点（session-store.ts:95-101 的 register 调用）：**

当前 `create()` 内显式逐字段构造 `SessionMeta` 传给 `registry.register`：
```ts
registry.register({
  id: sessionId,
  type: meta.type,
  deviceName: meta.deviceName,
  connectionInfo: meta.connectionInfo,
  createdAt: new Date().toISOString(),
});
```
新增一行透传：
```ts
  logPath: meta.logPath,
```

注意：这里**不展开 `meta`**（保持与现有显式构造风格一致，`id` 和 `createdAt` 仍由 store 自动填充）。

### session_info（展示层）

**职责：** 格式化会话元数据，展示日志路径。

**改动点（session_info.ts 的 `formatSessionMeta`）：**

在现有字段后新增一行：
```ts
`  Log:          ${s.logPath ?? "(file logging disabled)"}`,
```

- 有路径 → 显示完整路径
- 无路径（undefined）→ 显示 `(file logging disabled)`

该改动在 `session_info` 的三种查询模式（按 session_id、按 device、列出全部）下统一生效，因为三种模式都经过 `formatSessionMeta`。

## 模块交互

### 关键：调用顺序调整

当前所有通道的会话建立入口都存在一个**顺序依赖问题**：

```
现状（错误顺序）：
  sessionId = store.create(shell, { ... })   ← 此刻写 meta，但还没有 logPath
  shell.fileLogger.enableFromEnv(sessionId, deviceName)   ← 此刻才知道路径
```

`create()` 执行时 `logPath` 还不存在，无法写进 meta。必须调整为：

```
调整后（正确顺序）：
  logPath = shell.fileLogger.enableFromEnv(预生成的 sessionId, deviceName)   ← 先拿路径
  sessionId = store.create(shell, { ..., logPath })                          ← 再写 meta
```

但 `enableFromEnv` 需要 `sessionId` 来构造文件名（`{sessionId}_{timestamp}.log`），而 `sessionId` 由 `create()` 生成。这是一个**先有鸡还是先有蛋**的依赖。

**解决方案：让 store 提供"预览 sessionId"的能力，解耦 ID 生成与元数据注册。**

在 `ShellSessionStore` 新增一个方法：
```ts
peekNextId(): string
```
返回下一个将分配的 sessionId（`{prefix}_{counter+1}`），不递增计数器、不注册任何东西。

调整后的调用序列（以 serial 为例）：
```
1. sessionId = serialStore.peekNextId()                          // 预览 ID（不副作用）
2. logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName)  // 用预览 ID 建日志，拿到路径
3. serialStore.create(shell, { type, deviceName, connectionInfo, logPath })  // 正式注册，ID 与预览一致
```

这样：
- 日志文件名里的 sessionId 与最终注册的 sessionId 完全一致（`peekNextId` 保证）
- meta 在 `create` 时就携带了 logPath，一步到位

**并发安全说明：** `peekNextId` 和 `create` 之间，Node 的事件循环是单线程的，且这两步之间无 `await`（都是同步调用），不存在另一个调用抢占计数器的窗口。即使有多个 open 并发，由于 `enableFromEnv` 是同步的，`peekNextId → enableFromEnv → create` 三步在同一微任务内完成，计数器不会被中间插入。

### 三通道调用点调整清单

每个调用点都按「先 peekNextId → enableFromEnv → create(带 logPath)」调整：

| 通道 | 文件 | 当前调用点 | 调整内容 |
|------|------|-----------|---------|
| serial | `serial/shell.ts` | `serial_open` handler（约 166-173） | 顺序调整 + create 加 logPath |
| serial | `serial/shell.ts` | `serial_shell_login` 新建分支（约 665-672） | 顺序调整 + create 加 logPath |
| serial | `serial/shell.ts` | `registerSession` 新建分支（约 1069-1076） | 顺序调整 + create 加 logPath |
| ssh | `ssh/shell.ts` | `ssh_shell_open` handler（约 99-105） | 顺序调整 + create 加 logPath |
| ssh | `ssh/shell.ts` | `ssh_shell_login` handler（约 627-633） | 顺序调整 + create 加 logPath |
| adb | `adb/shell.ts` | `adb_shell_open` handler（约 152-158） | 顺序调整 + create 加 logPath |

**复用分支不调整：** serial 的 `registerSession` 复用分支（`existingId` 命中）、login 的 `portToSession` 命中分支，不重建日志文件，meta 中的 logPath 保持首次建立时的值，无需改动。

## 文件组织

```
src/
├── shared/
│   └── file-logger.ts          — enableFromEnv 返回类型 void → string|undefined（改返回值）
├── mcp/
│   ├── sessions/
│   │   ├── registry.ts         — SessionMeta 加 logPath?: string
│   │   └── session-store.ts    — CreateSessionMeta 加 logPath?: string；create() 透传 logPath；新增 peekNextId()
│   └── tools/
│       ├── basic/
│       │   └── session_info.ts — formatSessionMeta 新增 Log 行
│       ├── serial/
│       │   └── shell.ts        — 3 处调用点顺序调整（serial_open / login 新建 / registerSession 新建）
│       ├── ssh/
│       │   └── shell.ts        — 2 处调用点顺序调整（ssh_shell_open / ssh_shell_login）
│       └── adb/
│           └── shell.ts        — 1 处调用点顺序调整（adb_shell_open）
└── ...
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 路径提供方式 | 复用现有 `session_info`，加 `Log` 行 | `session_info` 已是「按 session_id 查 registry 元数据」的同构先例；不新增工具，避免工具表膨胀；路径本就是会话元数据的一部分，内聚 |
| 解决 ID/路径的顺序依赖 | 新增 `peekNextId()` 预览 ID | 解耦「ID 生成」与「元数据注册」，让 enableFromEnv 能在 create 之前用预览 ID 建文件、拿路径，再由 create 一步写入 meta。比「create 后回填 meta」更内聚（meta 一次性写全，无中间不一致状态） |
| 字段可选性 | `logPath?: string`（可选） | `SAVE2FILE_PATH` 未配置时 enableFromEnv 返回 undefined，字段必须可空；保证未启用场景不产生假路径 |
| 未启用时展示 | `Log: (file logging disabled)` | 明确告知而非省略，避免调用方困惑「到底能不能查」；不输出任何文件路径 |
| 日志写入逻辑是否动 | 不动 | 本次只动「路径如何被外部知晓」，不动「日志如何被写入」（spec N2 零行为回归） |
| 命名规则是否动 | 不动 | 仍为 `{sessionId}_{timestamp}.log`；改命名是更大改动且无必要（路径提供已解决「找不到」问题） |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变（如原为 GB2312/GBK 则仍按原编码写回，绝不转换）。

开发阶段编写代码时，必须遵循 ts-lang-spec 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
