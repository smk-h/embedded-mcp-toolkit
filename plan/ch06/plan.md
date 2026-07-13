# 会话存储统一 Plan

## 架构概览

在会话域（`src/mcp/sessions/`）引入一个泛型存储设施 `ShellSessionStore`，消除四个工具通道文件中重复的"会话 Map + 计数器 + registry 协调 + 批量清理"样板。四个传输类已统一继承 `BaseShell`（ch05 成果），这是泛型存储能工作的类型基础。

核心设计原则：**只收敛语义稳定的共性（存什么、键是什么、怎么注册、怎么销毁），不收敛语义易变的共性（通用工具 handler 留在各通道）。**

```
src/mcp/
├── sessions/                            # 【会话域】
│   ├── registry.ts                      #   已有：id → 元数据（轻量索引）
│   ├── session-store.ts                 #   【新增】ShellSessionStore<T extends BaseShell>
│   └── index.ts                         #   【新增】聚合导出
├── tools/
│   ├── ssh/
│   │   ├── sessions.ts                  #   【新增】sshStore 实例 + disposeAllSshSessions
│   │   ├── shell.ts                     #   【改】删 sessions Map/counter/disposeAll，改用 store
│   │   ├── build.ts                     #   【改】import sessions → import sshStore
│   │   ├── sftp.ts                      #   【改】同上
│   │   └── index.ts                     #   【不改】逐条注册不变
│   ├── serial/
│   │   ├── sessions.ts                  #   【新增】serialStore 实例 + disposeAllSerialSessions
│   │   ├── shell.ts                     #   【改】改用 store + portToSession 保留在此
│   │   └── index.ts                     #   【不改】
│   ├── adb/
│   │   ├── sessions.ts                  #   【新增】adbStore 实例 + disposeAllAdbShellSessions
│   │   ├── shell.ts                     #   【改】改用 store
│   │   ├── exec.ts                      #   【不改】一次性命令，不涉及会话
│   │   └── index.ts                     #   【不改】
│   └── win/
│       ├── sessions.ts                  #   【新增】powerStore 实例 + disposeAllPowerShellSessions
│       ├── powershell.ts                #   【改】改用 store
│       └── index.ts                     #   【不改】

src/mcp/server.ts                        # 【不改】注册循环和 cleanup 钩子不动
src/mcp/tool-registry.ts                 # 【不改】
src/transports/base-shell.ts             # 【不改】
```

数据流不变：`server.ts` 仍遍历 `mcpXxxTools` 数组注册工具，`cleanupAllSessions` 仍调用四个 `disposeAllXxxSessions` 函数。

## 核心数据结构

### ShellSessionStore（泛型会话存储）

```ts
class ShellSessionStore<T extends BaseShell> {
  #sessions: Map<string, T>;
  #counter: number;
  #prefix: string;        // "ssh" / "serial" / "adb" / "power"

  constructor(prefix: string);

  // 创建会话：生成 ID（${prefix}_${++counter}）、存入 Map、注册到 registry
  // 返回生成的 sessionId
  create(
    shell: T,
    meta: { type: SessionType; deviceName: string; connectionInfo: string }
  ): string;

  // 查询会话（不存在返回 undefined）
  get(sessionId: string): T | undefined;

  // 查询会话，不存在时返回统一的 not-found MCP 响应
  // 返回 { shell } 或 { response }，调用方据此判断
  getOrNotFound(sessionId: string):
    | { ok: true; shell: T }
    | { ok: false; response: { content: [{ type: "text"; text: string }] } };

  // 删除会话：从 Map 删除、从 registry 注销（不调 close，由调用方控制）
  remove(sessionId: string): void;

  // 批量清理：遍历 close 所有会话、清空 Map、注销 registry
  // logPrefix 用于 dispose 日志（如 "ssh_dispose"）
  disposeAll(logPrefix: string): Promise<void>;
}
```

**设计要点：**

- `create` 只负责"生成 ID + 存 Map + 注册 registry"，**不调 open**（open 由各通道的 open handler 负责，因为参数各异）。
- `remove` 只负责"删 Map + 注销 registry"，**不调 close**（close 由各 handler 在合适时机调，如 close handler 先 `shell.close()` 再 `store.remove()`）。职责分离，避免存储类越权控制连接生命周期。
- `getOrNotFound` 封装重复最多的 not-found 样板，返回值用判别联合（`ok: true/false`），类型安全。
- `disposeAll` 接收 `logPrefix` 参数，保持各通道的 dispose 日志前缀（`ssh_dispose` / `serial_dispose` / `adb_dispose` / `power_dispose`）。
- Serial 的 `portToSession` 不进基类——它作为通道侧的扩展能力，通过 `serialStore.get()` 配合 serial 目录内的查重逻辑实现（见下文）。

### Serial 的 portToSession（通道侧扩展，不进基类）

Serial 通道的 COM 口防重逻辑不放进 `ShellSessionStore` 基类，而是保留在 `serial/sessions.ts` 或 `serial/shell.ts` 内，以模块级 `Map<port, sessionId>` 形式存在，与 `serialStore` 实例配合使用：

```ts
// serial/shell.ts 内（或 serial/sessions.ts 内）
const portToSession = new Map<string, string>();   // 保留在 serial 目录

// open 防重检查：portToSession.get(port) + serialStore.get(id)
// open 成功：portToSession.set(port, id) + serialStore.create(shell, {...})
// close 清理：serialStore.remove(id) + portToSession.delete(port)
// disposeAll：serialStore.disposeAll(...) 后 portToSession.clear()
```

**理由：** portToSession 是串口特有的防重逻辑，强行塞进基类会污染 SSH/ADB/PowerShell 三个用不到它的通道。保留在 serial 目录，读 serial 只看 serial 目录即可理解全部串口行为。

## 模块设计

### sessions/session-store.ts
**职责：** 泛型会话存储，承担 ID 生成、Map 管理、registry 协调、批量清理。
**对外接口：** `ShellSessionStore` 类。
**依赖：** `BaseShell`（类型约束，来自 `transports/base-shell.ts`）、`registry`（元数据注册，来自同目录 `registry.ts`）、`text`（来自 `tools/tool-registry.ts`）、`logger`。

### sessions/index.ts
**职责：** 聚合导出 `ShellSessionStore`（并 re-export `registry`、`SessionType`、`SessionMeta` 供各通道统一引用）。
**依赖：** session-store、registry。

### 各通道的 sessions.ts（新增）
**职责：** 实例化本通道的 store（传入前缀），导出 store 实例 + disposeAll 包装函数。
**关键：** disposeAll 包装函数名必须与现状一致（`disposeAllSshSessions` 等），server.ts 按名引用。
- `ssh/sessions.ts`：`export const sshStore = new ShellSessionStore<SSHShell>("ssh")` + `disposeAllSshSessions`
- `serial/sessions.ts`：`export const serialStore = new ShellSessionStore<SerialShell>("serial")` + `disposeAllSerialSessions`；portToSession 若放此处则一并导出
- `adb/sessions.ts`：`export const adbStore = new ShellSessionStore<AdbShell>("adb")` + `disposeAllAdbShellSessions`
- `win/sessions.ts`：`export const powerStore = new ShellSessionStore<PowerShellShell>("power")` + `disposeAllPowerShellSessions`

### 各通道的 shell.ts / powershell.ts（改）
**职责：** open + 通用工具 handler + 通道特有工具 handler，改用 store 查询 shell。
**改动：**
- 删除模块级 `sessions Map`、`sessionCounter`、`disposeAll` 函数（移到 sessions.ts）
- `sessions.get(id)` → `store.getOrNotFound(id)` 或 `store.get(id)`
- open/login 中 `sessions.set + registry.register + sessionCounter` → `store.create(shell, { type, deviceName, connectionInfo })`
- close handler 中 `sessions.delete + registry.unregister` → `store.remove(id)`（close 仍先 `shell.close()`）
- 通用工具 handler（close/write/read/exec）的**逻辑保留在本文件**，只把查询入口换成 store
- Serial 的 `portToSession` 及相关清理逻辑保留在本文件（或 sessions.ts）

### 各通道的 index.ts（不改）
**职责：** 逐条注册工具。本章不引入工厂，工具注册方式完全不变。

### SSH 的 build.ts / sftp.ts（改）
**职责：** 通过 store 查询 shell。
**改动：** `import { sessions } from "./shell.js"` → `import { sshStore } from "./sessions.js"`；`sessions.get(id)` → `sshStore.get(id)`（或 `getOrNotFound`）。

## 模块交互

### 会话创建调用链（以 SSH open 为例）

```
AI 调用 ssh_shell_open
  └→ sshShellOpenHandler（仍由 shell.ts 自定义实现）
     ├→ new SSHShell(config)
     ├→ shell.open()                         [传输层]
     ├→ sshStore.create(shell, meta)         [存储层：生成 ssh_1、存 Map、注册 registry]
     │   └→ 内部：counter++ → "ssh_1" → #sessions.set → registry.register
     │   └→ 返回 "ssh_1"
     ├→ shell.fileLogger.enableFromEnv("ssh_1")
     └→ return "Session ssh_1 opened. ..."
```

### close 调用链

```
AI 调用 ssh_shell_close
  └→ sshShellCloseHandler（仍由 shell.ts 实现，逻辑不变）
     ├→ logger.info("[ssh_shell_close] session_id=...")
     ├→ sshStore.getOrNotFound(session_id)
     │   ├→ 命中 → { ok: true, shell }
     │   └→ 未命中 → { ok: false, response: "Session xxx not found." }
     ├→ shell.close()                        [传输层关闭连接]
     ├→ sshStore.remove(session_id)          [存储层删 Map + 注销 registry]
     └→ return "Session xxx closed."
```

### Serial close（含 portToSession 清理）

```
AI 调用 serial_close
  └→ serialCloseHandler（仍由 shell.ts 实现）
     ├→ serialStore.getOrNotFound(session_id)
     ├→ const port = shell.getPort()         [获取 COM 口标识]
     ├→ shell.close()
     ├→ serialStore.remove(session_id)
     ├→ portToSession.delete(port)           [通道侧清理防重映射]
     └→ return "Session xxx closed."
```

### 进程退出清理

```
server.ts cleanupAllSessions()
  └→ disposeAllSshSessions()                 [sessions.ts 导出的包装函数]
     └→ sshStore.disposeAll("ssh_dispose")   [存储层遍历 close + 清空 + 注销]
        └→ 日志：[ssh_dispose] session ssh_1 closed ...
```

## 文件组织

```
src/mcp/sessions/                       # 【新增 session-store.ts、index.ts】
├── registry.ts                         #   不改
├── session-store.ts                    #   新增：ShellSessionStore
└── index.ts                            #   新增：聚合导出

src/mcp/tools/
├── ssh/
│   ├── sessions.ts                     #   新增：sshStore + disposeAllSshSessions
│   ├── shell.ts                        #   改：删 Map/counter/disposeAll，改用 store
│   ├── build.ts                        #   改：import sessions → import sshStore
│   ├── sftp.ts                         #   改：同上
│   └── index.ts                        #   不改
├── serial/
│   ├── sessions.ts                     #   新增：serialStore + disposeAllSerialSessions
│   ├── shell.ts                        #   改：改用 store + portToSession 保留
│   └── index.ts                        #   不改
├── adb/
│   ├── sessions.ts                     #   新增：adbStore + disposeAllAdbShellSessions
│   ├── shell.ts                        #   改：改用 store
│   ├── exec.ts                         #   不改
│   └── index.ts                        #   不改
└── win/
    ├── sessions.ts                     #   新增：powerStore + disposeAllPowerShellSessions
    ├── powershell.ts                   #   改：改用 store
    └── index.ts                        #   不改

src/mcp/server.ts                       #   不改
src/mcp/tool-registry.ts                #   不改
src/transports/base-shell.ts            #   不改
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 存储设施放哪个目录 | `src/mcp/sessions/` | 与 `registry.ts` 同属会话域，registry 存元数据、store 存实例，成对共存；不落在工具层内部，避免职责越界 |
| store 的 create 是否调 open | 否 | open 参数各通道差异大，由各通道 open handler 调；store 只管 ID 生成和注册 |
| store 的 remove 是否调 close | 否 | close handler 需要先 `shell.close()` 再 `store.remove()`，职责分离避免存储类越权控制连接生命周期 |
| not-found 封装方式 | 判别联合 `getOrNotFound` 返回 `{ok, shell/response}` | 类型安全，比传回调或抛异常更清晰；调用方用 `if (!result.ok) return result.response` 一行处理 |
| portToSession 位置 | serial 目录内（shell.ts 或 sessions.ts），不进基类 | 通道特有逻辑，不污染通用基类；保留 serial 文件的自洽性 |
| disposeAll 包装函数 | 各通道 sessions.ts 导出同名函数 | server.ts 按名引用（`disposeAllSshSessions` 等），改名会破坏 cleanup；包装函数内部委托 `store.disposeAll(logPrefix)` |
| disposeAll 的 logPrefix | 参数化传入 | 保持各通道 dispose 日志前缀（`ssh_dispose` 等）逐字一致，不在基类硬编码 |
| 通用工具 handler 是否合并 | 不合并 | 当前相同是"巧合的一致"，各通道可能独立演化；合并会增加耦合、阻碍差异化 |
| SSH sessions export 的替代 | build.ts/sftp.ts 改 import sshStore | 原 `export const sessions` 是为跨文件访问；改为通过 store 实例查询，解耦更彻底 |
| 各通道 index.ts 是否用工厂 | 不用，逐条注册不变 | 保留演化空间；本章只动会话存储，工具注册方式不碰 |

## 编码规范

**编程语言：** TypeScript（ESM，target ES2022，strict 模式）

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变（如原为 GB2312/GBK 则仍按原编码写回，绝不转换）。本项目源码为 UTF-8 无 BOM / LF，沿用即可。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
