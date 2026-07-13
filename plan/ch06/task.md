# 会话存储统一 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/sessions/session-store.ts` | ShellSessionStore 泛型类 |
| 新建 | `src/mcp/sessions/index.ts` | 聚合导出 |
| 新建 | `src/mcp/tools/ssh/sessions.ts` | sshStore 实例 + disposeAllSshSessions |
| 新建 | `src/mcp/tools/serial/sessions.ts` | serialStore 实例 + disposeAllSerialSessions |
| 新建 | `src/mcp/tools/adb/sessions.ts` | adbStore 实例 + disposeAllAdbShellSessions |
| 新建 | `src/mcp/tools/win/sessions.ts` | powerStore 实例 + disposeAllPowerShellSessions |
| 修改 | `src/mcp/tools/win/powershell.ts` | 删 sessions Map/counter/disposeAll，改用 store |
| 修改 | `src/mcp/tools/adb/shell.ts` | 删 sessions Map/counter/disposeAll，改用 store |
| 修改 | `src/mcp/tools/ssh/shell.ts` | 删 sessions Map/counter/disposeAll，改用 store |
| 修改 | `src/mcp/tools/ssh/build.ts` | import sessions → import sshStore |
| 修改 | `src/mcp/tools/ssh/sftp.ts` | import sessions → import sshStore |
| 修改 | `src/mcp/tools/serial/shell.ts` | 删 sessions Map/counter/disposeAll，改用 store，保留 portToSession |
| 不改 | `src/mcp/tools/win/index.ts` | 工具注册不变 |
| 不改 | `src/mcp/tools/adb/index.ts` | 工具注册不变 |
| 不改 | `src/mcp/tools/ssh/index.ts` | 工具注册不变 |
| 不改 | `src/mcp/tools/serial/index.ts` | 工具注册不变 |
| 不改 | `src/mcp/tools/adb/exec.ts` | 一次性命令，不涉及会话 |
| 不改 | `src/mcp/server.ts` | 注册循环和 cleanup 钩子不动 |
| 不改 | `src/mcp/tool-registry.ts` | 基础构件不动 |
| 不改 | `src/mcp/sessions/registry.ts` | 中心化元数据不动 |

## T1: 新建 ShellSessionStore

**文件：** `src/mcp/sessions/session-store.ts`
**依赖：** 无（ch05 的 BaseShell 已就绪）
**步骤：**
1. 导入 `BaseShell`（类型约束，来自 `../../transports/base-shell.js`）、`registry`（来自 `./registry.js`）、`SessionType`（类型，来自 `./registry.js`）、`text`（来自 `../tool-registry.js`）、`logger`（来自 `../../shared/logger.js`）。
2. 定义 `ShellSessionStore<T extends BaseShell>`：
   - 私有字段：`#sessions: Map<string, T>`、`#counter: number = 0`、`#prefix: string`
   - 构造函数接收 `prefix: string`
   - `create(shell, meta): string`：生成 ID（`${this.#prefix}_${++this.#counter}`）、`#sessions.set(id, shell)`、调 `registry.register({ id, type, deviceName, connectionInfo, createdAt: new Date().toISOString() })`、返回 ID
   - `get(sessionId): T | undefined`：直接 `#sessions.get`
   - `getOrNotFound(sessionId)`：调 get，不存在时返回 `{ ok: false, response: { content: [text(`Session ${sessionId} not found.`)] } }`；存在返回 `{ ok: true, shell }`
   - `remove(sessionId): void`：`#sessions.delete` + `registry.unregister`
   - `disposeAll(logPrefix): Promise<void>`：遍历 entries，逐个 `shell.close()`（try/catch 包裹，失败时 `logger.error`），调 `registry.unregister(id)`，最后 `#sessions.clear()`。成功日志格式 `[${logPrefix}] session ${id} closed`，失败日志格式 `[${logPrefix}] session ${id} close failed`

**验证：** `npx tsc --noEmit` 编译通过。

## T2: 新建 sessions/index.ts

**文件：** `src/mcp/sessions/index.ts`
**依赖：** T1
**步骤：**
1. 从 `./session-store.js` 导出 `ShellSessionStore`。
2. 从 `./registry.js` re-export `registry`、`SessionType`、`SessionMeta`，供各通道统一从 `../../sessions/index.js` 引用。

**验证：** `npx tsc --noEmit` 编译通过。

## T3: PowerShell 通道迁移

**文件：** `src/mcp/tools/win/sessions.ts`（新建）、`src/mcp/tools/win/powershell.ts`（改）
**依赖：** T2
**步骤：**

3a. 新建 `win/sessions.ts`：
- `import { ShellSessionStore } from "../../sessions/index.js"`
- `import { PowerShellShell } from "../../../transports/powershell.js"`
- `export const powerStore = new ShellSessionStore<PowerShellShell>("power")`
- `export async function disposeAllPowerShellSessions(): Promise<void> { await powerStore.disposeAll("power_dispose"); }`

3b. 改 `win/powershell.ts`：
- 删除 `const sessions = new Map<string, PowerShellShell>()`、`let sessionCounter = 0`、`disposeAllPowerShellSessions` 函数
- 添加 `import { powerStore } from "./sessions.js"`
- **powerShellOpenHandler** 改动：原 `const sessionId = \`power_${++sessionCounter}\`; sessions.set(sessionId, shell); registry.register({...})` → `const sessionId = powerStore.create(shell, { type: "powershell", deviceName: "local", connectionInfo: shell.getWorkingDir() })`
- 删除 `import { registry }` （改由 store 内部调用，powershell.ts 不再直接用 registry）
- **powerShellCloseHandler**：`sessions.get` → `powerStore.getOrNotFound`（不命中直接 return response）；`shell.close()` 保留；`sessions.delete + registry.unregister` → `powerStore.remove(args.session_id)`
- **powerShellWriteHandler / ReadHandler / ExecHandler**：`sessions.get` + `if (!shell) return not-found` → `powerStore.getOrNotFound` + `if (!result.ok) return result.response`；其余逻辑（write/read/sleep）不变

**验证：** `npx tsc --noEmit` 编译通过；确认 `disposeAllPowerShellSessions` 仍可从 `win/sessions.ts` 导出。

## T4: ADB 通道迁移

**文件：** `src/mcp/tools/adb/sessions.ts`（新建）、`src/mcp/tools/adb/shell.ts`（改）
**依赖：** T3（确认 T3 模式可复用）
**步骤：**

4a. 新建 `adb/sessions.ts`：
- `export const adbStore = new ShellSessionStore<AdbShell>("adb")`
- `export async function disposeAllAdbShellSessions(): Promise<void> { await adbStore.disposeAll("adb_dispose"); }`

4b. 改 `adb/shell.ts`：
- 删除 `sessions Map`、`sessionCounter`、`disposeAllAdbShellSessions`
- 添加 `import { adbStore } from "./sessions.js"`
- **adbShellOpenHandler**：`adb_${++sessionCounter}` + `sessions.set` + `registry.register` → `adbStore.create(shell, { type: "adb", deviceName, connectionInfo: shell.getSerialNo() })`
- 删除 `import { registry }`
- **adbShellCloseHandler**：改用 `adbStore.getOrNotFound` + `adbStore.remove`
- **adbShellWriteHandler / ReadHandler / ExecHandler**：改用 `adbStore.getOrNotFound`

**验证：** `npx tsc --noEmit` 编译通过。

## T5: SSH 通道迁移（含 build/sftp）

**文件：** `src/mcp/tools/ssh/sessions.ts`（新建）、`src/mcp/tools/ssh/shell.ts`（改）、`src/mcp/tools/ssh/build.ts`（改）、`src/mcp/tools/ssh/sftp.ts`（改）
**依赖：** T4
**步骤：**

5a. 新建 `ssh/sessions.ts`：
- `export const sshStore = new ShellSessionStore<SSHShell>("ssh")`
- `export async function disposeAllSshSessions(): Promise<void> { await sshStore.disposeAll("ssh_dispose"); }`

5b. 改 `ssh/shell.ts`：
- 删除 `export const sessions = new Map`、`let sessionCounter = 0`、`disposeAllSshSessions`
- 添加 `import { sshStore } from "./sessions.js"`
- 删除 `import { registry }`
- **sshShellOpenHandler**：`ssh_${++sessionCounter}` + `sessions.set` + `registry.register` → `sshStore.create(shell, { type: "ssh", deviceName, connectionInfo: \`${config.host}:${config.port ?? 22}\` })`
- **sshShellLoginHandler**：有两处会话注册（open 后立即注册 + LOCKED 失败/UNLOCKING 失败/ERROR 时的清理），都改为 `sshStore.create` / `sshStore.remove`
  - 成功注册处：`ssh_${++sessionCounter}` + `sessions.set` + `registry.register` → `sshStore.create(...)`
  - 失败清理处（4 处 `sessions.delete(sessionId); registry.unregister(sessionId)`）：→ `sshStore.remove(sessionId)`
  - 注意：原代码中 `const sessionId = \`ssh_${++sessionCounter}\`` 需改为 `const sessionId = sshStore.create(shell, {...})`，close 失败清理时直接用该 sessionId
- **sshShellCloseHandler / WriteHandler / ReadHandler / ExecHandler**：改用 `sshStore.getOrNotFound` + `sshStore.remove`
- **sshConnectionsHandler**：`sessions.get` → `sshStore.getOrNotFound`

5c. 改 `ssh/build.ts`：
- `import { sessions } from "./shell.js"` → `import { sshStore } from "./sessions.js"`
- `const shell = sessions.get(args.session_id); if (!shell) return ...` → `const result = sshStore.getOrNotFound(args.session_id); if (!result.ok) return result.response; const shell = result.shell;`

5d. 改 `ssh/sftp.ts`：
- 同 5c（两处 `sessions.get`，分别在 sshSftpUploadHandler 和 sshSftpDownloadHandler）

**验证：** `npx tsc --noEmit` 编译通过；确认 build.ts/sftp.ts 不再 `import { sessions }`。

## T6: Serial 通道迁移（含 portToSession）

**文件：** `src/mcp/tools/serial/sessions.ts`（新建）、`src/mcp/tools/serial/shell.ts`（改）
**依赖：** T5
**步骤：**

6a. 新建 `serial/sessions.ts`：
- `export const serialStore = new ShellSessionStore<SerialShell>("serial")`
- `export async function disposeAllSerialSessions(): Promise<void> { await serialStore.disposeAll("serial_dispose"); }`

6b. 改 `serial/shell.ts`：
- 删除 `sessions Map`、`let sessionCounter = 0`、`disposeAllSerialSessions`
- **保留** `const portToSession = new Map<string, string>()`（COM 口防重，通道特有逻辑，留在本文件）
- 添加 `import { serialStore } from "./sessions.js"`
- 删除 `import { registry }`
- **serialOpenHandler**：
  - 防重检查 `portToSession.get(config.port)` + `sessions.has(existingId)` → `portToSession.get(config.port)` + `serialStore.get(existingId)`（sessions.has 改为 serialStore.get 判 undefined）
  - 注册 `serial_${++sessionCounter}` + `sessions.set` + `portToSession.set` + `registry.register` → `const sessionId = serialStore.create(shell, { type: "serial", deviceName, connectionInfo: \`${config.port} @ ${config.baudRate ?? 115200}\` }); portToSession.set(config.port, sessionId)`
- **serialCloseHandler**：`sessions.get` → `serialStore.getOrNotFound`；`shell.getPort()` 保留；`sessions.delete + registry.unregister` → `serialStore.remove`；`portToSession.delete(port)` 保留
- **serialWriteHandler / ReadHandler / ExecHandler**：改用 `serialStore.getOrNotFound`
- **serialShellLoginHandler**：
  - `cleanupNewSession` 内 `sessions.delete + registry.unregister` → `serialStore.remove`；`portToSession.delete` 保留
  - 复用已有 session 检查 `sessions.has(existingId)` → `serialStore.get(existingId)` 判 undefined
  - 新建会话注册 `serial_${++sessionCounter}` + `sessions.set` + `portToSession.set` + `registry.register` → `serialStore.create(...)` + `portToSession.set`
- **serialEnterUbootHandler**：`sessions.get` → `serialStore.getOrNotFound`
- **registerSession 辅助函数**：
  - `sessions.has(registeredId)` → `serialStore.get(registeredId)` 判 undefined
  - `serial_${++sessionCounter}` + `sessions.set` + `portToSession.set` → `serialStore.create(...)` + `portToSession.set(port, sessionId)`
  - 注意：registerSession 接收的是已 open 的 shell，create 只做注册不做 open，行为一致

**验证：** `npx tsc --noEmit` 编译通过；确认 portToSession 仍保留在 serial 目录。

## T7: 全量编译与产物检查

**文件：** 无（验证任务）
**依赖：** T1-T6
**步骤：**
1. `npm run build` 完整编译。
2. 确认 `out/mcp/sessions/session-store.js`、`out/mcp/sessions/index.js` 已生成。
3. 确认四个通道的 `sessions.js` 已生成。
4. grep 确认四个 shell.ts / powershell.ts 中不再有 `new Map<string` 的 sessions 声明（serial 的 portToSession 例外，应保留）。
5. grep 确认 `disposeAll*Sessions` 函数仍从 sessions.ts 导出。
6. grep 确认 build.ts / sftp.ts 不再 `import { sessions }`。
7. grep 确认四个通道文件不再直接 `import { registry }`（registry 调用收敛到 store 内部）。

**验证：** build 成功，产物结构正确，无残留的模块级 sessions Map。

## 执行顺序

```
T1(Store) → T2(sessions/index)
                ↓
   T3(PowerShell) → T4(ADB) → T5(SSH) → T6(Serial)
                                          ↓
                                  T7(全量验证)
```

- T1→T2 为会话域通用设施，必须最先完成。
- T3-T6 是四个通道的独立迁移，按复杂度递增顺序串行（PowerShell 最简单无 portToSession、Serial 最复杂含 portToSession 和 registerSession）。
- 每个通道迁移后立即 `npx tsc --noEmit`，确保问题早发现。
- T7 是收尾全量验证。

**回归验证纪律：**
- T3 完成后做 PowerShell 全流程冒烟测试（open→write→read→exec→close）。
- T7 完成后做完整冒烟 + 日志前缀对比验证。
- 每个通道迁移后，grep 核对该通道的工具名和日志前缀与重构前一致。
