<!-- more -->

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/shared/resident-detector.ts` | 常驻命令检测器：`classifyResident` + 内置白名单 + 首 token 提取 |
| 修改 | `src/mcp/shared/exec-runner.ts` | 编排层：`ExecTimeoutConfig`/`ExecTimeoutKind` 类型、`ExecInput`/`ExecResult` 新字段、双超时分支、新常量 |
| 修改 | `src/shared/config.ts` | `DeviceConfig` 新字段 + `getExecTimeoutConfig` 注入函数 |
| 修改 | `src/mcp/tools/adb/shell.ts` | 取配置透传 + 三分支格式化 + schema 描述 |
| 修改 | `src/mcp/tools/ssh/shell.ts` | 同 adb（对称） |
| 修改 | `src/mcp/tools/serial/shell.ts` | 同 adb（对称） |
| 修改 | `.embedded/configs/devices/board-example.yaml` | 新增三项配置示例 + 注释（模板文档） |

---

## T1: 新建常驻命令检测器

**文件：** `src/mcp/shared/resident-detector.ts`
**依赖：** 无
**步骤：**
1. 顶部写文件头 JSDoc 注释块（版权、文件名、作者、日期、版本、Description），风格对齐 `prompt-detector.ts:1-22`。
2. 定义并导出 `ResidentVerdict` 类型：
   ```ts
   export type ResidentVerdict =
     | { kind: "resident"; reason: string }
     | { kind: "normal"; reason: string };
   ```
3. 定义内置 A 类白名单常量（首 token 精确匹配集），用 `ReadonlySet<string>`：
   `ping`、`ping6`、`logcat`、`top`、`htop`、`watch`、`strace`、`tcpdump`。加 JSDoc 说明每类命令性质。
4. 定义内置 B 类参数模式（首 token + flag）。用「命令名 → 检测 flag 的正则」的只读记录结构。三条：
   - `dmesg`：检测 `-w` 或 `--follow`
   - `journalctl`：检测 `-f` 或 `--follow`
   - `tail`：检测 `-f`、`-F` 或 `--follow`
   - 正则要求 flag 作为独立 token：`/(?:^|\s)(?:-w|--follow|-f|-F)(?=\s|=|$)/`（确保 `-f` 不误匹配 `-file`）。正则源码字符串里反斜杠双写（`\s`、`\\s`），与 `UbootDefaults` 风格一致。
5. 实现内部函数 `extractFirstToken(command: string): string`：
   - `command.trim()` 后按 `/[\s|;>&<()` `]/` 分割取首段（遇空白/管道/分号/重定向/括号/反引号即止）。
   - 去除首尾成对的单/双引号。
   - 空串返回 `""`。
   - 显式标注返回类型 `string`（strict 模式）。
6. 实现并导出主函数 `classifyResident(command: string, extraResidentCommands?: readonly string[]): ResidentVerdict`：
   - `const token = extractFirstToken(command)`；若 `token === ""` 返回 `{ kind: "normal", reason: "empty command" }`。
   - 构造有效 A 类集：用户 `extraResidentCommands`（若有）与内置 A 类集合并集去重（可复用「Array.from(new Set([...]))」或简单遍历，保持顺序无要求）。优先查用户扩展集（命中 reason 标 `user-config`），再查内置集（reason 标 `builtin-set`）。命中即返回 `{ kind: "resident", reason: "${来源}: ${token}" }`。
   - 再查 B 类：若 `token` 是 B 类三命令之一，用对应正则测 `command`（或首 token 之后的剩余串），命中返回 `{ kind: "resident", reason: "builtin-pattern: ${token} with follow flag" }`。
   - 否则返回 `{ kind: "normal", reason: "first-token: ${token}" }`。

**验证：** `npx tsc --noEmit` 编译通过；手动构造测试调用（可在 `node` REPL 或临时脚本）：`classifyResident("ping 1.2.3.4")` → resident；`classifyResident("echo hi")` → normal；`classifyResident("tail -f x")` → resident；`classifyResident("tail x")` → normal；`classifyResident("echo a | grep b")` → normal（首 token 是 echo）；`classifyResident("myapp", ["myapp"])` → resident。

---

## T2: 改造 exec-runner.ts 类型与常量

**文件：** `src/mcp/shared/exec-runner.ts`
**依赖：** T1（import `classifyResident`、`ResidentVerdict`）
**步骤：**
1. import 新模块：`import { classifyResident, type ResidentVerdict } from "./resident-detector.js";`（注意 `.js` 后缀）。
2. 新增常量（放在现有 `DEFAULT_MAX_DURATION_MS` 等附近，exec-runner.ts:29-41 区域）：
   - `DEFAULT_SAMPLING_TIMEOUT_MS = 10000`（常驻采样，JSDoc 注明沿用 ch08 默认值）
   - `DEFAULT_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000`（普通兜底，5 分钟）
   - 保留 `DEFAULT_MAX_DURATION_MS = 10000` 常量名，JSDoc 改注为「向后兼容别名，等于 DEFAULT_SAMPLING_TIMEOUT_MS」，避免外部引用断裂。
3. 定义并导出新类型：
   - `export type ExecTimeoutKind = "none" | "sampling" | "fallback";`
   - `export interface ExecTimeoutConfig { residentCommands?: readonly string[]; samplingTimeoutMs?: number; fallbackTimeoutMs?: number; }`（字段全部 readonly + optional，JSDoc 说明各字段含义与默认值兜底位置）。
4. 改造 `ExecInput`（exec-runner.ts:49-70）：新增可选字段 `readonly execTimeoutConfig?: ExecTimeoutConfig;`，加 JSDoc。
5. 改造 `ExecResult`（exec-runner.ts:88-97）：
   - 新增 `readonly timeoutKind: ExecTimeoutKind;`（JSDoc：取代单纯布尔 timedOut 的语义载体）。
   - `timedOut` 字段保留，JSDoc 改注为「派生布尔（= timeoutKind !== "none"），保持向后兼容」。
   - `interrupted`、`output`、`elapsedMs` 不变。

**验证：** `npx tsc --noEmit` 编译通过（此时 `runExec` 函数体尚未用到新字段，但接口改造应能编译；若有「未使用 import」告警属正常，T3 会消费）。

---

## T3: 改造 runExec 核心流程

**文件：** `src/mcp/shared/exec-runner.ts`
**依赖：** T2
**步骤：**
1. 在 `runExec` 函数体顶部（exec-runner.ts:126-130 取默认值的区域）之后、步骤 1 前置冲刷之前，插入常驻分类逻辑：
   ```ts
   const verdict: ResidentVerdict = classifyResident(
     input.command,
     input.execTimeoutConfig?.residentCommands
   );
   const isResident = verdict.kind === "resident";
   // maxDuration 优先级最高（spec F6），只覆盖时长；动作按常驻性
   const defaultTimeout = isResident
     ? (input.execTimeoutConfig?.samplingTimeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS)
     : (input.execTimeoutConfig?.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS);
   const effectiveTimeout: number = input.maxDuration ?? defaultTimeout;
   ```
2. 把后续用到 `maxDuration` 的地方（exec-runner.ts:133 `deadline = Math.max(maxDuration, minDelay)`、L201 超时日志的 `${maxDuration}`）改为用 `effectiveTimeout`。`maxDuration` 局部变量（L126）可保留或移除——若保留则注明「仅记录调用方原始传入值」，但实际逻辑一律用 `effectiveTimeout`。建议移除 L126 的 `maxDuration` 局部变量，避免混淆。
3. 在分类后加日志（满足 N4）：`logger.info("${logPrefix} classified: ${verdict.kind} (${verdict.reason}), effectiveTimeout=${effectiveTimeout}ms");`
4. 改造正常完成分支（exec-runner.ts:190-195）：返回对象加 `timeoutKind: "none"`；`timedOut: false` 保持。
5. **拆分超时分支**（原 exec-runner.ts:199-212 单分支 → 两分支）：
   - 先记日志区分类型：`logger.warn("${logPrefix} ${isResident ? "sampling" : "fallback"} timeout after ${effectiveTimeout}ms (no prompt)${isResident ? ", sending Ctrl+C" : ", NOT sending Ctrl+C"}");`
   - 常驻分支：`input.sendCtrl("c"); await sleep(INTERRUPT_SETTLE_MS); accumulated += input.shell.drain();` 返回 `{ output, interrupted:false, timeoutKind:"sampling", timedOut:true, elapsedMs }`。
   - 普通分支：**不调用 sendCtrl**；仅 `accumulated += input.shell.drain();`（收集到点为止的残留）；返回 `{ output, interrupted:false, timeoutKind:"fallback", timedOut:true, elapsedMs }`。
6. 更新 `runExec` 顶部 JSDoc（exec-runner.ts:108-124）：流程描述补充「常驻分类」步骤，超时分支说明改为「按常驻性：常驻发 Ctrl+C 采样，普通不发兜底」。

**验证：** `npx tsc --noEmit` 编译通过；阅读超时分支确认两路径动作正确（常驻发 Ctrl+C、普通不发）。

---

## T4: 新增设备配置注入函数

**文件：** `src/shared/config.ts`
**依赖：** T2（import `ExecTimeoutConfig` 类型）
**步骤：**
1. import 类型：在 config.ts 顶部 import 区加 `import type { ExecTimeoutConfig } from "../mcp/shared/exec-runner.js";`（注意路径：config.ts 在 `src/shared/`，exec-runner.ts 在 `src/mcp/shared/`，相对路径 `../mcp/shared/exec-runner.js`）。
2. 改造 `DeviceConfig` 接口（config.ts:31-57），在 `promptPattern` 字段（L32）后新增三字段（保持与 adb/ssh/serial 平级）：
   ```ts
   residentCommands?: readonly string[];  // 常驻命令扩展名单（首 token 精确匹配），三通道共享，与内置白名单并集
   samplingTimeoutMs?: number;            // 采样超时（毫秒），常驻命令用，未配置默认 10000
   fallbackTimeoutMs?: number;            // 兜底超时（毫秒），普通命令用，未配置默认 300000
   ```
   每字段加行内注释说明用途与默认值兜底位置。
3. 新增注入函数，放在 `getPromptPattern`（config.ts:255-258）之后、`getUbootConfig`（L260）之前：
   ```ts
   /**
    * @brief 获取设备的 exec 超时配置
    *
    * 用于交互式 shell exec 的常驻命令分类与超时时长。设备级配置，三通道共享。
    * 未配置字段返回 undefined，由 runExec 用默认值兜底（采样 10s / 兜底 5min）。
    *
    * @param name 设备名（可选，默认 resolveDeviceName()）
    * @returns exec 超时配置片段，未配置时各字段为 undefined
    */
   export function getExecTimeoutConfig(name?: string): ExecTimeoutConfig {
     const device = getDeviceConfig(name ?? resolveDeviceName());
     return {
       residentCommands: device.residentCommands,
       samplingTimeoutMs: device.samplingTimeoutMs,
       fallbackTimeoutMs: device.fallbackTimeoutMs,
     };
   }
   ```

**验证：** `npx tsc --noEmit` 编译通过；确认 `getExecTimeoutConfig` 已 export。

---

## T5: 改造 adb 通道 handler

**文件：** `src/mcp/tools/adb/shell.ts`
**依赖：** T3、T4
**步骤：**
1. import 新函数：在现有 import 区（adb/shell.ts 顶部）加 `getExecTimeoutConfig`（从 config 模块）。
2. 在 handler 内取配置（adb/shell.ts:423 `new PromptDetector(...)` 之后）：
   ```ts
   const execTimeoutConfig = getExecTimeoutConfig(deviceName);
   ```
3. 透传进 `runExec`（adb/shell.ts:430-439 的 `runExec({...})`）：新增 `execTimeoutConfig,` 字段。
4. 改造格式化分支（adb/shell.ts:441-449）：把原 `if (execResult.timedOut)` 单分支改为按 `execResult.timeoutKind` 三分支：
   ```ts
   let output = execResult.output;
   if (execResult.timeoutKind === "sampling") {
     output = (output ? output + "\n" : "") +
       `[采样超时: 已收集 ${execResult.elapsedMs}ms 输出，已发送 Ctrl+C 终止常驻命令]`;
   } else if (execResult.timeoutKind === "fallback") {
     output = (output ? output + "\n" : "") +
       `[兜底超时: 已收集 ${execResult.elapsedMs}ms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`;
   }
   ```
5. 更新 `maxDuration` 的 schema 描述（adb/shell.ts:382-386）：原 `"Max execution time in ms before auto-interrupting with Ctrl+C (default: 10000)"` 改为 `"Override execution duration in ms. Default varies by command type: resident commands 10000 (sampling, Ctrl+C sent on timeout), normal commands 300000 (5min fallback, no interrupt sent). Action on timeout still follows resident classification."`。

**验证：** `npx tsc --noEmit` 编译通过；阅读确认三分支逻辑与文案正确。

---

## T6: 改造 ssh 通道 handler

**文件：** `src/mcp/tools/ssh/shell.ts`
**依赖：** T3、T4
**步骤：** 与 T5 完全对称，对应位置：取配置（ssh/shell.ts:361 后）、透传（L367-376）、格式化分支（L378-385）、schema 描述（L321-325）。文案与 adb 字节一致。

**验证：** `npx tsc --noEmit` 编译通过。

---

## T7: 改造 serial 通道 handler

**文件：** `src/mcp/tools/serial/shell.ts`
**依赖：** T3、T4
**步骤：** 与 T5 完全对称，对应位置：取配置（serial/shell.ts:437 后）、透传（L443-452）、格式化分支（L454-461）、schema 描述（L397-401）。文案与 adb 字节一致。

**验证：** `npx tsc --noEmit` 编译通过。

---

## T8: 更新配置模板示例

**文件：** `.embedded/configs/devices/board-example.yaml`
**依赖：** T4
**步骤：**
1. 先 Read 该文件确认现有结构与 `promptPattern` 的写法位置。
2. 在 `promptPattern` 字段附近新增三项配置示例（注释说明用途、默认值、留空行为）：
   ```yaml
   # 常驻命令扩展名单（首 token 精确匹配），与内置白名单(ping/logcat/top/...)并集。
   # 留空则仅用内置白名单。示例：自定义的持续输出命令可加在此。
   # residentCommands:
   #   - my_log_streamer
   #   - custom_top_like

   # 采样超时（毫秒）：常驻命令(ping/logcat/top 等)的默认执行时长，到点发 Ctrl+C 采样。
   # 留空默认 10000（10 秒）。
   # samplingTimeoutMs: 10000

   # 兜底超时（毫秒）：普通命令的兜底时长（提示符未匹配时的安全阀，到点不发 Ctrl+C）。
   # 留空默认 300000（5 分钟）。
   # fallbackTimeoutMs: 300000
   ```
   （用注释形式给出，避免改变默认行为，仅作模板示范。）

**验证：** YAML 语法合法（可用 `node -e "require('js-yaml').load(require('fs').readFileSync('.embedded/configs/devices/board-example.yaml','utf8'))"` 验证不报错）。

---

## 执行顺序

```
T1 ──→ T2 ──→ T3 ──→ T4 ──→ T5 ──┐
                            ↘ T6 ─┤
                            ↘ T7 ─┴→ T8
```

- T1 无依赖，最先。
- T2 依赖 T1（import 类型/函数）。
- T3 依赖 T2（用新类型改 runExec）。
- T4 依赖 T2（import ExecTimeoutConfig）。
- T5/T6/T7 依赖 T3+T4，三通道对称可并行（但建议顺序执行确保一致性）。
- T8 依赖 T4（配置字段已定义），可最后。
