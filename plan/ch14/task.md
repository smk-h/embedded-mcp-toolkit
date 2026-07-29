# 会话日志路径提供 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/shared/file-logger.ts` | `enableFromEnv` 返回类型 `void` → `string \| undefined` |
| 修改 | `src/mcp/sessions/registry.ts` | `SessionMeta` 接口新增 `logPath?: string` 字段 |
| 修改 | `src/mcp/sessions/session-store.ts` | `CreateSessionMeta` 加 `logPath?`；`create()` 透传；新增 `peekNextId()` |
| 修改 | `src/mcp/tools/basic/session_info.ts` | `formatSessionMeta` 新增 `Log:` 行 |
| 修改 | `src/mcp/tools/serial/shell.ts` | 3 处调用点顺序调整（serial_open / login 新建 / registerSession 新建） |
| 修改 | `src/mcp/tools/ssh/shell.ts` | 2 处调用点顺序调整（ssh_shell_open / ssh_shell_login） |
| 修改 | `src/mcp/tools/adb/shell.ts` | 1 处调用点顺序调整（adb_shell_open） |
| 新建 | `test/client/test_session_log_path.mjs` | 端到端验证 session_info 返回日志路径 |

---

## T1：enableFromEnv 返回日志文件路径

**文件：** `src/shared/file-logger.ts`
**依赖：** 无
**步骤：**
1. 将 `enableFromEnv` 方法的返回类型签名从 `void` 改为 `string | undefined`
2. 在方法内 `if (!savePath || savePath === "none") return;` 早退点，改为 `return undefined;`
3. 在方法末尾（`this.enable(logPath);` 之后、`logger.info(...)` 之后），添加 `return logPath;`
4. 不改动 `enable` / `write` / `disable` 任何逻辑

**验证：** `npm run build` 编译通过；返回值类型为 `string | undefined`

---

## T2：会话元数据新增 logPath 字段

**文件：** `src/mcp/sessions/registry.ts`
**依赖：** 无
**步骤：**
1. 在 `SessionMeta` 接口（约 32-38 行）末尾新增字段 `logPath?: string;`
2. 补充行内注释说明：该会话对应的日志文件完整路径；文件日志未启用时为 undefined

**验证：** `npm run build` 编译通过

---

## T3：CreateSessionMeta 加字段 + create 透传 + peekNextId

**文件：** `src/mcp/sessions/session-store.ts`
**依赖：** T2
**步骤：**
1. 在 `CreateSessionMeta` 接口（约 38-42 行）末尾新增字段 `logPath?: string;`，注释说明来自 `enableFromEnv` 返回值
2. 在 `create()` 方法的 `registry.register({...})` 调用（约 95-101 行）中，新增一行 `logPath: meta.logPath,` 透传该字段（保持与现有显式逐字段构造风格一致，不展开 `meta`）
3. 新增 `peekNextId()` 方法（放在 `create()` 之后）：
   - 返回 `${this.#prefix}_${this.#counter + 1}`
   - **不递增** `#counter`、不写 Map、不调 registry
   - 补充文档注释说明用途：预览下一个将分配的 sessionId，供调用方在 `create` 之前先用该 ID 调用 `enableFromEnv` 建日志文件
   - 注释说明并发安全：单线程 + peek→enableFromEnv→create 三步无 await，同微任务内完成

**验证：** `npm run build` 编译通过

---

## T4：session_info 展示日志路径

**文件：** `src/mcp/tools/basic/session_info.ts`
**依赖：** T2
**步骤：**
1. 在 `formatSessionMeta` 函数（约 63-72 行）返回数组中，在 `Created` 行之后、空串 `""` 之前，新增一行：
   `` `  Log:          ${s.logPath ?? "(file logging disabled)"}` ``
2. 该改动对 `session_info` 的三种查询模式（按 session_id、按 device、列出全部）统一生效（三者都经过 `formatSessionMeta`）
3. 不改动 handler 逻辑、不改动其他字段

**验证：** `npm run build` 编译通过

---

## T5：serial 通道 3 处调用点顺序调整

**文件：** `src/mcp/tools/serial/shell.ts`
**依赖：** T1、T3
**步骤：**

对以下 3 处调用点，统一按「peekNextId → enableFromEnv → create(带 logPath)」调整顺序：

**5a. `serial_open` handler（约 166-173 行）：**
- 当前：先 `serialStore.create(...)` 拿 sessionId，再 `enableFromEnv(sessionId, deviceName)`
- 调整为：
  ```
  const sessionId = serialStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  const actualId = serialStore.create(shell, { type: "serial", deviceName, connectionInfo: ..., logPath });
  // actualId === sessionId（peekNextId 保证），后续代码用 actualId 或 sessionId 均可
  ```
- 注意 `connectionInfo` 表达式保持原样：`${config.port} @ ${config.baudRate ?? 115200}`

**5b. `serial_shell_login` 新建分支（约 665-672 行）：**
- 当前：先 `const newId = serialStore.create(...)`，再 `enableFromEnv(newId, deviceName)`
- 调整为：先 `peekNextId` → `enableFromEnv` → `create(带 logPath)`
- `newSessionId = newId` 赋值保持（后续状态机流程依赖 `newSessionId`）

**5c. `registerSession` 新建分支（约 1069-1076 行）：**
- 当前：先 `serialStore.create(...)`，再 `enableFromEnv(sessionId, deviceName)`
- 调整为：先 `peekNextId` → `enableFromEnv` → `create(带 logPath)`

**所有 3 处共同注意：**
- 复用分支（`existingId` 命中、`portToSession` 命中）不改动——它们不重建日志文件，meta 中的 logPath 保持首次建立时的值
- 调整后删除原先在 create 之后的 `enableFromEnv` 调用（避免重复建日志文件）
- `portToSession.set(port, sessionId)` 等后续逻辑保持不变

**验证：** `npm run build` 编译通过；`npm run format:check` 通过

---

## T6：ssh 通道 2 处调用点顺序调整

**文件：** `src/mcp/tools/ssh/shell.ts`
**依赖：** T1、T3
**步骤：**

**6a. `ssh_shell_open` handler（约 99-105 行）：**
- 当前：先 `sshStore.create(...)`，再 `enableFromEnv(sessionId, deviceName)`
- 调整为：先 `sshStore.peekNextId()` → `enableFromEnv` → `create(带 logPath)`

**6b. `ssh_shell_login` handler（约 627-633 行）：**
- 同 6a 模式调整
- 注意 ssh 的 login 是否有类似 serial 的复用分支——若有，复用分支不改动

**验证：** `npm run build` 编译通过；`npm run format:check` 通过

---

## T7：adb 通道 1 处调用点顺序调整

**文件：** `src/mcp/tools/adb/shell.ts`
**依赖：** T1、T3
**步骤：**

**7a. `adb_shell_open` handler（约 152-158 行）：**
- 当前：先 `adbStore.create(...)`，再 `enableFromEnv(sessionId, finalDeviceName)`
- 调整为：先 `adbStore.peekNextId()` → `enableFromEnv` → `create(带 logPath)`

**验证：** `npm run build` 编译通过；`npm run format:check` 通过

---

## T8：端到端测试脚本

**文件：** `test/client/test_session_log_path.mjs`
**依赖：** T4、T5（serial 通道最先验证）
**步骤：**
1. 参照 `test/client/test_enter_uboot.mjs`、`test_device_info.mjs` 的写法，复用 `client.mjs`（connect）和 `common.mjs`（pass/fail/printResult）
2. `serverEnv` 配置 `SAVE2FILE_PATH`（文件日志启用场景）
3. 测试用例：
   - **用例 1（启用场景）：** `serial_shell_login` 建立会话 → `session_info(session_id)` → 断言返回含 `Log:` 行且路径非 `(file logging disabled)`，且该路径与磁盘实际存在的文件一致（用 `fs.existsSync` 校验）
   - **用例 2（路径匹配 sessionId）：** 断言返回的日志路径中含当前 sessionId 前缀（如 `serial_1_`）
4. 用 `finally` 关闭会话，参照现有测试风格
5. 文件编码：UTF-8 无 BOM、LF 换行

**验证：** `node --check test/client/test_session_log_path.mjs` 语法通过；连接真实 serial 设备运行后两个用例通过

---

## T9：未启用场景验证 + 格式/lint 收尾

**文件：** 无新文件（验证为主）
**依赖：** T1-T8
**步骤：**
1. **未启用场景验证：** 修改测试脚本或单独验证——用不含 `SAVE2FILE_PATH` 的 `serverEnv` 建立 serial 会话，调用 `session_info`，断言 `Log:` 行显示 `(file logging disabled)`
2. **prettier 格式：** `npm run format:check`，若有问题用 `npm run format:fix` 修复所有本次修改的 `.ts` 文件
3. **eslint：** `npm run eslint:fix`（按项目现有方式），确认无 lint 错误
4. **回归：** 运行 `node test/client/test_enter_uboot.mjs`（若设备可用）确认行为不回归

**验证：** 全部检查通过

---

## 执行顺序

```
T1 (file-logger) ──┐
T2 (registry) ──┐  │
                ├──┴── T3 (session-store: 依赖 T2) ──┐
T4 (session_info: 依赖 T2) ──────────────────────────┤
                                                     ├── T5 (serial: 依赖 T1,T3)
                                                     ├── T6 (ssh:    依赖 T1,T3)
                                                     └── T7 (adb:    依赖 T1,T3)
                                                              │
                                                              ▼
                                                         T8 (测试: 依赖 T4,T5)
                                                              │
                                                              ▼
                                                         T9 (收尾验证: 依赖全部)
```

- T1、T2 无依赖，可最先做（建议先 T2 再 T1，或并行）
- T3 依赖 T2；T4 依赖 T2
- T5/T6/T7 依赖 T1+T3，三通道同构，可连续做（建议 serial 先行，因为它是最主要场景）
- T8 依赖 T4（展示）+ T5（serial 通路打通）
- T9 是收尾，依赖全部完成
