<!-- more -->

## 一、 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/shared/prompt-detector.ts` | PromptDetector、CONTROL_CHAR_MAP、ControlChar 类型 |
| 新建 | `src/mcp/shared/send-ctrl.ts` | sendControlChar 函数 |
| 新建 | `src/mcp/shared/exec-runner.ts` | runExec、ExecInput、ExecResult |
| 修改 | `src/shared/config.ts` | DeviceConfig 加 promptPattern 字段 + 新增 getPromptPattern |
| 修改 | `src/mcp/tools/adb/shell.ts` | adbShellExecHandler 改调 runExec + 新增 adbShellSendCtrlHandler |
| 修改 | `src/mcp/tools/adb/index.ts` | 注册 adb_shell_send_ctrl |
| 修改 | `src/mcp/tools/ssh/shell.ts` | sshShellExecHandler 改调 runExec + 新增 sshShellSendCtrlHandler |
| 修改 | `src/mcp/tools/ssh/index.ts` | 注册 ssh_shell_send_ctrl |
| 修改 | `src/mcp/tools/serial/shell.ts` | serialExecHandler 改调 runExec + 新增 serialSendCtrlHandler |
| 修改 | `src/mcp/tools/serial/index.ts` | 注册 serial_send_ctrl |
| 修改 | `src/transports/adb.ts` | spawn 参数 `shell` → `shell -t -t`(真机验证发现:强制 PTY 才回显提示符) |

> 注:`exec-runner.ts` 的 PTY 回显剥离逻辑(stripEcho)在 T4 实现时已一并加入,不单独列任务。

## 二、 任务列表

### T1: 新建 PromptDetector 与控制字符映射

**文件:** `src/mcp/shared/prompt-detector.ts`
**依赖:** 无
**步骤:**

1. 新建文件 `src/mcp/shared/prompt-detector.ts`,UTF-8 无 BOM、LF 换行
2. 定义 `ControlChar` 类型:`"c" | "u" | "d" | "z"`
3. 定义并导出 `CONTROL_CHAR_MAP` 常量,映射 `c→\x03`、`u→\x15`、`d→\x04`、`z→\x1a`,用 `as const` 或 `Readonly<Record>` 保证不可变
4. 定义 `PromptDetector` 类:
   - 静态只读字段 `DEFAULT_PATTERN`,值为覆盖 Android(`:/ $`、`:/ #`)、Linux(`$`、`#`、`>`)、U-Boot(`=>`)的默认正则,锚定输出末尾 `$`
   - 构造函数接收可选 `customPattern?: string`,有则 `new RegExp(customPattern)`,无则用 `DEFAULT_PATTERN`
   - 方法 `detect(accumulated: string): boolean`,返回 `this.pattern.test(accumulated)`
5. 顶部加文件头注释(版权块 + 文件描述),遵循项目既有风格(参考 base-shell.ts 头部)
6. 每个导出项加 JSDoc 注释,说明用途

**验证:** `npx tsc --noEmit` 编译无错误;正则逻辑可手动验证:对 `"root@host:~# "` 返回 true,对 `"some output"` 返回 false

### T2: config 扩展提示符正则配置

**文件:** `src/shared/config.ts`
**依赖:** 无(可与 T1 并行)
**步骤:**

1. 在 `DeviceConfig` 接口(第 18 行)增加设备级可选字段 `promptPattern?: string`,带注释说明「用于 exec 提示符检测覆盖,留空用默认正则」
2. 新增导出函数 `getPromptPattern(name?: string): string | undefined`:
   - 位置放在 `getAdbConfig`(第 220 行)之后
   - 实现:`const device = getDeviceConfig(name ?? resolveDeviceName()); return device.promptPattern;`
   - 加 JSDoc 注释,说明配置优先级与默认行为
3. **注意编码:** config.ts 为已有文件,必须保持原编码与换行符不变,写回前先确认原文件编码(本仓库统一 UTF-8/LF,但需核实)

**验证:** `npx tsc --noEmit` 编译无错误;手动测试 `getPromptPattern("board-a")` 在无配置时返回 undefined,配置后返回对应字符串

### T3: 新建 sendControlChar

**文件:** `src/mcp/shared/send-ctrl.ts`
**依赖:** T1(用 ControlChar、CONTROL_CHAR_MAP)
**步骤:**

1. 新建文件 `src/mcp/shared/send-ctrl.ts`,UTF-8 无 BOM、LF 换行
2. 从 `./prompt-detector.js` 导入 `ControlChar`、`CONTROL_CHAR_MAP`
3. 从 `../../transports/interactive-shell.js` 导入 `InteractiveShell` 类型
4. 定义并导出 `sendControlChar(shell: InteractiveShell, key: ControlChar, settleMs?: number): Promise<string>`:
   - 默认 `settleMs = 200`
   - 查 `CONTROL_CHAR_MAP[key]` 得到字节字符串,如 `"c"` → `"\x03"`
   - 调用 `shell.write(byte, 1, false)` —— 关键:`appendLineEnding=false` 保证不追加换行
   - 调用 `shell.drain()` 丢弃控制字符可能的回显(如 `^C`)与残留
   - `await new Promise(r => setTimeout(r, settleMs))` 让信号生效
   - 返回发送的字节字符串
5. 加文件头注释与 JSDoc,说明流程与「为何 appendLineEnding=false」

**验证:** `npx tsc --noEmit` 编译无错误

### T4: 新建 runExec 编排逻辑

**文件:** `src/mcp/shared/exec-runner.ts`
**依赖:** T1(PromptDetector、ControlChar)
**步骤:**

1. 新建文件 `src/mcp/shared/exec-runner.ts`,UTF-8 无 BOM、LF 换行
2. 从 `./prompt-detector.js` 导入 `PromptDetector`、`ControlChar`
3. 从 `../../transports/interactive-shell.js` 导入 `InteractiveShell` 类型
4. 从 `../../shared/logger.js` 导入 `logger`
5. 定义并导出 `ExecInput` 接口(字段:shell、command、delay?、clear?、maxDuration?、pollInterval?、promptDetector、sendCtrl、logPrefix),与 plan.md 一致
6. 定义并导出 `ExecResult` 接口(字段:output、interrupted、timedOut、elapsedMs),三态语义注释完整(见 plan.md)
7. 定义并导出 `runExec(input: ExecInput): Promise<ExecResult>`:
   - 默认值:`maxDuration = input.maxDuration ?? 10000`、`pollInterval = input.pollInterval ?? 200`、`clear = input.clear ?? 1`、`minDelay = input.delay ?? 1000`
   - 记录 `startTime = Date.now()`
   - **前置冲刷:** `shell.drain()` 丢弃残留(logger.info 记录)
   - **发命令:** `shell.write(input.command, clear)`
   - **轮询循环** `while (Date.now() - startTime < maxDuration)`:
     - `await sleep(pollInterval)`
     - `accumulated += shell.drain()`
     - `if (input.promptDetector.detect(accumulated))` → 记日志,返回 `{ output: accumulated.trim(), interrupted: false, timedOut: false, elapsedMs: Date.now()-startTime }`
   - **熔断分支(超时):**
     - `input.sendCtrl("c")` 发 Ctrl+C
     - `await sleep(300)` 收集 SIGINT 后残留
     - `accumulated += shell.drain()`
     - `logger.warn` 记录熔断(含命令、maxDuration)
     - 返回 `{ output: accumulated.trim(), interrupted: false, timedOut: true, elapsedMs: Date.now()-startTime }`
   - 关于 `minDelay`:作为轮询的「最小持续时间」——若 maxDuration < minDelay(异常配置),取 minDelay 为准,保证短命令也有时间产出输出
8. 加完整 JSDoc,讲清三态语义、timed-out 与 interrupted 的区别

**验证:** `npx tsc --noEmit` 编译无错误;逻辑可单元验证(后续 T8 集成时真机验证)

### T5: 改造 adb_shell_exec + 新增 adb_shell_send_ctrl

**文件:** `src/mcp/tools/adb/shell.ts`
**依赖:** T1、T2、T3、T4
**步骤:**

1. 顶部导入:`runExec`、`ExecInput` from `../../../mcp/shared/exec-runner.js`;`sendControlChar` from `../../../mcp/shared/send-ctrl.js`;`PromptDetector` from `../../../mcp/shared/prompt-detector.js`;`getPromptPattern` from `../../../shared/config.js`
2. **改造 `adbShellExecHandler`(第 361 行):**
   - 保留 `delay`、`clear` 参数,新增可选 `maxDuration?: number` 参数
   - 在 `inputSchema`(第 318 行 `adbShellExecConfig`)增加 `maxDuration` 字段描述
   - 取 deviceName 后,调 `getPromptPattern(deviceName)` 得到 pattern(可能 undefined)
   - `new PromptDetector(pattern)`
   - 构造 `sendCtrl` 闭包:`(key: ControlChar) => { shell.write(CONTROL_CHAR_MAP[key], 1, false); }`(注意:这里不调 sendControlChar,因为 sendControlChar 内含 drain+sleep,exec 熔断时已自己 sleep;闭包只负责写字节)
   - 调 `runExec({ shell, command, delay, clear, maxDuration, promptDetector, sendCtrl, logPrefix: "[adb_shell_exec]" })`
   - 根据 `ExecResult` 格式化:`timedOut` 为 true 时追加 `\n[timed-out: collected ${elapsedMs}ms of output, Ctrl+C sent]`;否则原样返回 output 或 `(no output)`
3. **新增 `adbShellSendCtrlHandler` 与 `adbShellSendCtrlConfig`:**
   - 输入:`{ session_id: string; key: "c" | "u" | "d" | "z" }`
   - 流程:`adbStore.getOrNotFound` → 取 shell → `sendControlChar(shell, key)` → 返回 `Ctrl+${Key.toUpperCase()} sent (${byte})`
4. **注意编码:** shell.ts 为已有文件,保持原编码不变

**验证:** `npx tsc --noEmit` 编译无错误;`npx eslint src/mcp/tools/adb/shell.ts` 无新增错误

### T6: 改造 ssh_shell_exec + 新增 ssh_shell_send_ctrl

**文件:** `src/mcp/tools/ssh/shell.ts`
**依赖:** T1、T2、T3、T4(T5 提供同构参考)
**步骤:**

1. 同 T5 的导入(路径相同,因 mcp/tools/ssh 与 mcp/tools/adb 同级)
2. **改造 `sshShellExecHandler`(第 322 行):**
   - 与 T5 第 2 步同构:保留 delay/clear,新增 maxDuration,取 promptPattern,构造 PromptDetector 与 sendCtrl 闭包,调 runExec,按三态格式化
   - `logPrefix: "[ssh_shell_exec]"`
3. **新增 `sshShellSendCtrlHandler` 与 `sshShellSendCtrlConfig`:**
   - 与 T5 第 3 步同构,store 换成 `sshStore`
4. **注意编码:** 已有文件,保持原编码

**验证:** `npx tsc --noEmit` 编译无错误;`npx eslint src/mcp/tools/ssh/shell.ts` 无新增错误

### T7: 改造 serial_exec + 新增 serial_send_ctrl

**文件:** `src/mcp/tools/serial/shell.ts`
**依赖:** T1、T2、T3、T4(T5 提供同构参考)
**步骤:**

1. 同 T5 的导入
2. **改造 `serialExecHandler`(第 399 行):**
   - 与 T5 第 2 步同构,store 是 `serialStore`
   - `logPrefix: "[serial_exec]"`
3. **新增 `serialSendCtrlHandler` 与 `serialSendCtrlConfig`:**
   - 工具名 `serial_send_ctrl`(serial 通道无 `_shell_` 中缀,与现有 serial_open/serial_write 命名一致)
   - 与 T5 第 3 步同构
4. **注意编码:** 已有文件,保持原编码

**验证:** `npx tsc --noEmit` 编译无错误;`npx eslint src/mcp/tools/serial/shell.ts` 无新增错误

### T8: 注册三个新工具到 index.ts

**文件:** `src/mcp/tools/adb/index.ts`、`src/mcp/tools/ssh/index.ts`、`src/mcp/tools/serial/index.ts`
**依赖:** T5、T6、T7
**步骤:**

1. **adb/index.ts:** 从 `./shell.js` 导入 `adbShellSendCtrlConfig`、`adbShellSendCtrlHandler`,在 `mcpAdbTools` 数组追加 `mcpDefineTool("adb_shell_send_ctrl", adbShellSendCtrlConfig, adbShellSendCtrlHandler)`
2. **ssh/index.ts:** 同理注册 `ssh_shell_send_ctrl`
3. **serial/index.ts:** 同理注册 `serial_send_ctrl`
4. 三个 index.ts 均为已有文件,保持原编码

**验证:** `npx tsc --noEmit` 编译无错误;启动 MCP server(`npm run build && npm start`),确认三个 send_ctrl 工具出现在工具列表中

### T9: 真机集成验证(adb 通道)

**文件:** 无(运行时验证)
**依赖:** T5、T8
**步骤:**

1. `npm run build` 确保产物最新
2. 连接 LubanCat 设备,打开 adb shell 会话
3. **验证 send_ctrl:** exec 执行 `logcat`,再调 `adb_shell_send_ctrl(session_id, key="c")`,确认 logcat 被终止、会话恢复
4. **验证熔断:** exec 执行 `logcat` 不传 maxDuration,确认约 10 秒后自动返回且标注 `[timed-out: ...]`
5. **验证 maxDuration 覆盖:** exec 执行 `logcat` 传 `maxDuration: 5000`,确认约 5 秒返回
6. **验证瞬时命令:** exec 执行 `ls /sdcard`,确认检测到提示符立即返回,无 timed-out 标注
7. **验证不误杀:** exec 执行 `sleep 5; echo done`,确认正常返回 done,未被熔断
8. **验证前置冲刷:** 先 exec `logcat` 等几秒,再 exec `echo hello`,确认 hello 输出无 logcat 残留

**验证:** 上述 7 项行为全部符合预期

## 三、 执行顺序

```
T1 ──┐
T2 ──┼── T3 ── T4 ──┬── T5 ──┐
                   │         ├── T8 ── T9
                   ├── T6 ──┤
                   └── T7 ──┘
```

- **T1、T2 可并行**(无相互依赖)
- **T3 依赖 T1**(用 ControlChar、CONTROL_CHAR_MAP)
- **T4 依赖 T1**(用 PromptDetector、ControlChar)
- **T5/T6/T7 依赖 T1~T4**,三者同构,建议按 adb → ssh → serial 顺序做(T5 作为参考样板,T6/T7 复制调整)
- **T8 依赖 T5/T6/T7**(工具要存在才能注册)
- **T9 依赖 T8**(工具注册后才能真机验证)

---
*本文档由 code-spec 技能辅助生成*
