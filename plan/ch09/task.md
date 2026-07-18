# 日志文件命名与目录结构优化 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/utils/timestamp.ts` | `fileTimestamp()` 返回格式从 `YYYY-MM-DD_HH-mm-ss` 改为 `YYYY-MM-DD_HHMMSS` |
| 修改 | `src/shared/file-logger.ts` | `enableFromEnv` 增加 `deviceName` 参数，据此拼接设备子目录；降级到根目录 |
| 修改 | `src/mcp/tools/adb/shell.ts` | L136 调用 `enableFromEnv` 时透传 `deviceName` |
| 修改 | `src/mcp/tools/serial/shell.ts` | L170 / L661 / L989 三处调用透传 `deviceName` |
| 修改 | `src/mcp/tools/ssh/shell.ts` | L104 / L624 两处调用透传 `deviceName` |
| 修改 | `src/mcp/tools/win/powershell.ts` | L91 调用透传字面量 `"local"` |

---

## T1: 修改时间戳格式

**文件：** `src/utils/timestamp.ts`
**依赖：** 无
**步骤：**
1. 定位 `fileTimestamp()` 函数（第 28-31 行）
2. 将返回值模板 `${f.y}-${f.m}-${f.d}_${f.hh}-${f.mm}-${f.ss}` 改为 `${f.y}-${f.m}-${f.d}_${f.hh}${f.mm}${f.ss}`（去掉时分秒之间的两个 `-`）
3. 更新函数上方的 JSDoc 注释，将格式说明 `YYYY-MM-DD_HH-mm-ss` 改为 `YYYY-MM-DD_HHMMSS`
4. `beijingFields()`、`logTimestamp()`、`formatBeijingTime()` 三个函数保持不动

**验证：**
- `npx tsc --noEmit` 编译通过，无类型错误
- 人工核对：返回值形如 `2026-07-18_135400`，时分秒之间无分隔符

---

## T2: 修改 `enableFromEnv` 签名与设备子目录拼接

**文件：** `src/shared/file-logger.ts`
**依赖：** T1（新格式由 `fileTimestamp()` 提供）
**步骤：**
1. 定位 `enableFromEnv` 方法（第 57-72 行）
2. 修改方法签名为 `enableFromEnv(sessionId: string, deviceName?: string): void`
3. 更新方法上方的 JSDoc 注释，说明：
   - 新参数 `deviceName`：设备名（如 `board-lubancat`），可选
   - 路径规则：`deviceName` 可用 → `<savePath>/<deviceName>/<sessionId>_<ts>.log`；缺失 → `<savePath>/<sessionId>_<ts>.log`
4. 修改方法体：提取 `fileName` 变量，用 `deviceName` 真值决定 `logPath`：
   ```ts
   const fileName = `${sessionId}_${fileTimestamp()}.log`;
   const logPath = deviceName
     ? resolve(absDir, deviceName, fileName)
     : resolve(absDir, fileName);
   ```
5. 后续 `this.enable(logPath)` 与 `logger.info(...)` 保持不变
6. 不改动 `enable()`、`disable()`、`write()` 三个方法

**验证：**
- `npx tsc --noEmit` 编译通过；可选参数 `deviceName?: string` 不破坏既有调用
- 人工核对：deviceName 为真值时 `logPath` 含设备子目录段；为空串/undefined 时 `logPath` 不含子目录段（降级）

---

## T3: adb handler 透传 deviceName

**文件：** `src/mcp/tools/adb/shell.ts`
**依赖：** T2
**步骤：**
1. 定位第 136 行 `shell.fileLogger.enableFromEnv(sessionId);`
2. 改为 `shell.fileLogger.enableFromEnv(sessionId, deviceName);`
3. 确认 `deviceName` 在该作用域已定义（第 78 行 `const deviceName = args.device ?? resolveDeviceName();`）

**验证：**
- `npx tsc --noEmit` 编译通过
- 人工核对：传参变量名与第 78 行定义一致

---

## T4: serial handler 透传 deviceName（3 处）

**文件：** `src/mcp/tools/serial/shell.ts`
**依赖：** T2
**步骤：**
1. 第 170 行（serial_shell_open）：`enableFromEnv(sessionId)` → `enableFromEnv(sessionId, deviceName)`；`deviceName` 见第 109 行
2. 第 661 行（serial reopen）：`enableFromEnv(newId)` → `enableFromEnv(newId, deviceName)`；`deviceName` 见第 603 行
3. 第 989 行（serial_shell_login）：`enableFromEnv(sessionId)` → `enableFromEnv(sessionId, deviceName)`；`deviceName` 为函数参数（第 967 行）
4. 三处分别确认 `deviceName` 在各自作用域已定义且可访问

**验证：**
- `npx tsc --noEmit` 编译通过
- 人工核对：三处传参变量名与各自作用域定义一致；reopen 用的是 `newId` 不是 `sessionId`

---

## T5: ssh handler 透传 deviceName（2 处）

**文件：** `src/mcp/tools/ssh/shell.ts`
**依赖：** T2
**步骤：**
1. 第 104 行（ssh_shell_open）：`enableFromEnv(sessionId)` → `enableFromEnv(sessionId, deviceName)`；`deviceName` 见第 74 行
2. 第 624 行（ssh reopen）：`enableFromEnv(sessionId)` → `enableFromEnv(sessionId, deviceName)`；`deviceName` 见第 591 行

**验证：**
- `npx tsc --noEmit` 编译通过
- 人工核对：两处传参变量名与各自作用域定义一致

---

## T6: powershell handler 透传 "local"

**文件：** `src/mcp/tools/win/powershell.ts`
**依赖：** T2
**步骤：**
1. 定位第 91 行 `shell.fileLogger.enableFromEnv(sessionId);`
2. 改为 `shell.fileLogger.enableFromEnv(sessionId, "local");`
3. 确认 `"local"` 与该 handler 已有的 `meta.deviceName = "local"`（第 87 行）语义一致

**验证：**
- `npx tsc --noEmit` 编译通过
- 人工核对：透传值是字面量 `"local"`，与 L87 保持一致

---

## T7: 端到端构建与产物核对

**文件：** 无（验证任务）
**依赖：** T1–T6 全部完成
**步骤：**
1. 执行 `npx tsc --noEmit` 确认全项目编译通过
2. 执行 `npm run build`（或项目既定的构建命令）确认产物正常
3. 若项目配置了 lint（如 ESLint），执行 lint 确认无新增告警
4. 全局搜索 `enableFromEnv` 确认所有调用点均已传 `deviceName`，无遗漏

**验证：**
- 编译无错误、无类型告警
- `grep -rn "enableFromEnv" src/` 输出的 7 个调用点全部含第二个参数

---

## 执行顺序

```
T1（时间戳格式）─┐
                 ├─→ T2（enableFromEnv 签名）─┬─→ T3（adb）        ─┐
                                           ├─→ T4（serial ×3）    ├─→ T7（端到端构建）
                                           ├─→ T5（ssh ×2）       ─┘
                                           └─→ T6（powershell）
```

- T1 必须先于 T2（T2 的文件名格式依赖 T1 的 `fileTimestamp()` 新格式，逻辑上先改源头）。
- T2 必须先于 T3–T6（调用方透传依赖签名变更后才能编译通过；其实由于参数可选，T3–T6 即使先改也能编译，但语义上先定接口再改调用更清晰）。
- T3 / T4 / T5 / T6 互相独立，可任意顺序或并行。
- T7 是整体集成验证，必须最后执行。
