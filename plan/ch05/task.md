# Transport 层抽象重构 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/transports/interactive-shell.ts` | InteractiveShell 接口（补全签名） |
| 新建 | `src/transports/base-shell.ts` | BaseShell 抽象基类（模板方法） |
| 修改 | `src/transports/ssh.ts` | SSHShell extends BaseShell |
| 修改 | `src/transports/serial.ts` | SerialShell extends BaseShell |
| 修改 | `src/transports/adb.ts` | AdbShell extends BaseShell（补挂 FileLogger） |
| 修改 | `src/transports/powershell.ts` | PowerShellShell extends BaseShell（补挂 FileLogger） |
| 修改 | `src/transports/loop.ts` | InteractiveShell 改为从 interactive-shell.ts 导入 |
| 修改 | `src/mcp/tools/adb/shell.ts` | open/login 成功后调用 fileLogger.enableFromEnv |
| 修改 | `src/mcp/tools/win/powershell.ts` | open 成功后调用 fileLogger.enableFromEnv |

## T1: 新建 InteractiveShell 接口

**文件：** `src/transports/interactive-shell.ts`
**依赖：** 无
**步骤：**
1. 创建文件，定义 `InteractiveShell` 接口，含五个方法签名：
   - `open(): Promise<string>`
   - `write(data: string, clear?: number, appendLineEnding?: boolean): void`
   - `read(clear?: number): string`
   - `drain(): string`
   - `close(): Promise<void>`
2. 添加模块说明注释（接口用途、被 BaseShell 和 loop.ts 共用）。

**验证：** `npx tsc --noEmit` 编译通过（新文件无依赖，仅类型声明）。

## T2: 新建 BaseShell 抽象基类

**文件：** `src/transports/base-shell.ts`
**依赖：** T1
**步骤：**
1. 创建文件，导入 `OutputBuffer`（`./output-buffer.js`）、`FileLogger`（`../shared/file-logger.js`）、`InteractiveShell`（`./interactive-shell.js`）。
2. 定义 `abstract class BaseShell implements InteractiveShell`：
   - 私有字段：`#output = new OutputBuffer()`
   - 公共只读字段：`readonly fileLogger = new FileLogger()`
   - 抽象属性：`protected abstract bannerWaitMs: number`
   - 可覆盖 getter：`protected get lineEnding(): string { return "\n"; }`
3. 实现模板方法 `open()`：
   ```
   await this.acquire();
   this.#output.startCollecting();
   await new Promise((r) => setTimeout(r, this.bannerWaitMs));
   return this.#output.read(1);
   ```
4. 实现 `write(data, clear=1, appendLineEnding=true)`：
   ```
   this.#output.prepareWrite(clear);
   const payload = appendLineEnding ? `${data}${this.lineEnding}` : data;
   this.rawWrite(payload);
   ```
   注意：**不在此检查 shell 是否打开**（保持 F6，检查留给子类 rawWrite）。
5. 实现 `read(clear=1)`：`return this.#output.read(clear);`
6. 实现 `drain()`：`return this.#output.drain();`
7. 实现 `close()`：
   ```
   this.fileLogger.disable();
   await this.release();
   this.#output.reset();
   ```
8. 定义三个抽象方法：`protected abstract acquire(): Promise<void>` / `protected abstract rawWrite(payload: string): void` / `protected abstract release(): Promise<void>`
9. 定义工具方法 `protected appendData(text: string)`：`this.#output.append(text); this.fileLogger.write(text);`
10. 完整 JSDoc 注释，每个方法说明用途与与子类的协作关系。

**验证：** `npx tsc --noEmit` 编译通过（抽象类不能实例化，但语法应合法）。

## T3: loop.ts 切换接口导入来源

**文件：** `src/transports/loop.ts`
**依赖：** T1
**步骤：**
1. 删除文件内就地定义的 `InteractiveShell` 接口（第 1-11 行）。
2. 顶部添加 `import type { InteractiveShell } from "./interactive-shell.js";`。
3. `interactiveLoop` 函数签名不变，仍接收 `shell: InteractiveShell`。
4. 函数体逻辑完全不变。

**验证：** `npx tsc --noEmit` 编译通过；此时 SSHShell/SerialShell/AdbShell/PowerShellShell 尚未 `implements`，但因结构兼容仍可传入 `interactiveLoop`（鸭子类型）。

## T4: 迁移 SSHShell 到 BaseShell

**文件：** `src/transports/ssh.ts`
**依赖：** T2
**步骤：**
1. 顶部导入：`import { BaseShell } from "./base-shell.js";`（删除 OutputBuffer、FileLogger 的直接导入，改为经基类继承）。
2. 类声明改为 `export class SSHShell extends BaseShell`。
3. 删除子类自有字段：`#output = new OutputBuffer()`、`readonly fileLogger = new FileLogger()`（已继承）。
4. 删除子类的 `open/write/read/drain/close` 方法（已继承），但保留 `open` 内的连接建立逻辑改写为 `acquire`。
5. 实现抽象属性 `protected bannerWaitMs = 500;`
6. 实现 `protected async acquire()`：
   - 原 `open()` 中从 `new Client()` 到 `this.#stream = stream` 的全部逻辑。
   - stream 的 data/stderr 监听回调：`this.#output.append(text); this.fileLogger.write(text);` 改为 `this.appendData(text);`（两处）。
   - stream close 监听：`this.#stream = null;` 保留。
   - 注意：**不在此调用 startCollecting / sleep / read(1)**（已由基类 open 统一做）。
7. 实现 `protected rawWrite(payload: string)`：
   ```
   if (!this.#stream) throw new Error("Shell not open. Call open() first.");
   this.#stream.write(payload);
   ```
   注意：payload 已含换行，**不要**再加 `\n`。
8. 实现 `protected async release()`：
   - 原 `close()` 中从 SFTP 释放到 client.end 的逻辑（#sftp.end→null、#stream.close→null、#client.end→null）。
   - **不在此调 fileLogger.disable / output.reset**（已由基类 close 统一做）。
9. 保留所有特有方法：`getHost/getPort/getUsername/getDeviceName`、`uploadFile/downloadFile/#ensureSftp`。
10. 保留 `interactiveShell`、`pshDemoSsh` 两个 demo 函数（它们调用 shell 的 open/write/read/close，签名未变）。
11. 构造函数 `constructor(config: SSHShellConfig)` 保留，仍存 `#config`。

**验证：**
- `npx tsc --noEmit` 编译通过。
- `node out/cli/index.js demo ssh interact`（若可连接设备）—— 或至少编译产物可正常加载。

## T5: 迁移 SerialShell 到 BaseShell

**文件：** `src/transports/serial.ts`
**依赖：** T2、T4（确认 T4 模式可复用）
**步骤：**
1. 导入 BaseShell，删除 OutputBuffer/FileLogger 直接导入。
2. 类声明改为 `export class SerialShell extends BaseShell`。
3. 删除 `#output`、`fileLogger` 字段。
4. 删除 `open/write/read/close` 方法。
5. 实现 `protected bannerWaitMs = 500;`
6. 覆盖 `protected get lineEnding(): string { return this.#config.lineEnding ?? "\n"; }`
7. 实现 `acquire()`：原 `open()` 中从 `new SerialPort` 到注册 data/close/error 监听的逻辑。data 监听回调改用 `this.appendData(text);`。**不调 startCollecting/sleep/read**。
8. 实现 `rawWrite(payload)`：
   ```
   if (!this.#serialPort || !this.#serialPort.isOpen) {
     throw new Error("Serial not open. Call open() first.");
   }
   this.#serialPort.write(payload);
   ```
9. 实现 `release()`：原 `close()` 中串口关闭逻辑（含 2s 超时 + destroy 兜底）。**不调 fileLogger.disable / output.reset**。
10. 保留 `sendRaw` 方法：改为 `this.write(data, clear, false);`（调用继承的 write，行为等价）。
11. 保留 `getPort/getDeviceName`、demo 函数（`interactiveSerialShell/pshDemoSerial/userLoginDemoSerial`）。

**验证：** `npx tsc --noEmit` 编译通过。

## T6: 迁移 AdbShell 到 BaseShell（补挂 FileLogger）

**文件：** `src/transports/adb.ts`
**依赖：** T2
**步骤：**
1. 导入 BaseShell，删除 OutputBuffer 直接导入。
2. 类声明改为 `export class AdbShell extends BaseShell`。
3. 删除 `#output` 字段（**AdbShell 原本无 fileLogger 字段，现在继承得到**）。
4. 删除 `open/write/read/drain/close` 方法。
5. 实现 `protected bannerWaitMs = 800;`
6. 实现 `acquire()`：原 `open()` 中从 `#discoverDevice` 到注册 stdout/stderr/close/error 监听的逻辑。
   - **关键变更**：stdout/stderr 监听回调原本是 `this.#output.append(data.toString());`，现在改为 `this.appendData(data.toString());`（多出了 fileLogger.write，但 fileLogger 未 enable 时 write 无副作用——见 FileLogger.write 第 101 行 `if (!this.#logStream) return;`）。
   - **不调 startCollecting/sleep/read**。
7. 实现 `rawWrite(payload)`：
   ```
   if (!this.#process || this.#process.exitCode !== null) {
     throw new Error("ADB shell not open. Call open() first.");
   }
   this.#process.stdin!.write(payload);
   ```
8. 实现 `release()`：原 `close()` 中进程终止逻辑（exit + 等close + 3s kill 兜底）。**不调 output.reset**（基类做）。
9. 保留 `getSerialNo/getDeviceName/#discoverDevice`。

**验证：** `npx tsc --noEmit` 编译通过。

## T7: 迁移 PowerShellShell 到 BaseShell（补挂 FileLogger）

**文件：** `src/transports/powershell.ts`
**依赖：** T2
**步骤：**
1. 导入 BaseShell，删除 OutputBuffer 直接导入。
2. 类声明改为 `export class PowerShellShell extends BaseShell`。
3. 删除 `#output` 字段。
4. 删除 `open/write/read/close` 方法（`drain` 也删，继承）。
5. 实现 `protected bannerWaitMs = 800;`
6. 实现 `acquire()`：原 `open()` 中从 spawn 到注册监听的逻辑。stdout/stderr 监听改用 `this.appendData(data.toString());`。
7. 实现 `rawWrite(payload)`：
   ```
   if (!this.#process || this.#process.exitCode !== null) {
     throw new Error("PowerShell shell not open. Call open() first.");
   }
   this.#process.stdin!.write(payload);
   ```
8. 实现 `release()`：原 `close()` 进程终止逻辑。
9. 保留 `encodePsCommand/execPowerShell/getWorkingDir` 及 `PS_EXEC_OPTIONS/POWERSHELL_TIMEOUT` 常量。

**验证：** `npx tsc --noEmit` 编译通过。

## T8: ADB tools 层补 enableFromEnv

**文件：** `src/mcp/tools/adb/shell.ts`
**依赖：** T6
**步骤：**
1. 在 `adbShellOpenHandler` 中，`registry.register({...})` 之后、return 之前，增加：
   `shell.fileLogger.enableFromEnv(sessionId);`
   （参照 `src/mcp/tools/ssh/shell.ts:109` 的位置和写法）。
2. 检查是否有其他创建 AdbShell 会话的 handler（如 login）——当前 ADB 无 login 工具，仅需 open 一处。

**验证：** `npx tsc --noEmit` 编译通过；grep 确认 `enableFromEnv` 出现在 adb tools 层。

## T9: PowerShell tools 层补 enableFromEnv

**文件：** `src/mcp/tools/win/powershell.ts`
**依赖：** T7
**步骤：**
1. 找到 PowerShell 会话创建的 handler（power_shell_open 对应的 handler）。
2. 在 registry.register 之后、return 之前，增加 `shell.fileLogger.enableFromEnv(sessionId);`。

**验证：** `npx tsc --noEmit` 编译通过。

## T10: 全量编译与产物检查

**文件：** 无（验证任务）
**依赖：** T1-T9
**步骤：**
1. `npm run build` 完整编译。
2. 确认 `out/transports/base-shell.js`、`out/transports/interactive-shell.js` 已生成。
3. 确认 `out/transports/ssh.js` 等子类产物引用了 base-shell。
4. grep 确认四个子类产物中不再有重复的 OutputBuffer 实例化（应只在 base-shell.js 中）。

**验证：** build 成功，无 TS 错误，产物结构正确。

## 执行顺序

```
T1(接口) → T2(基类) → T3(loop切换)
                        ↓
            T4(SSH) → T5(Serial) → T6(ADB) → T7(PowerShell)
                        ↓                        ↓
                        └──────────┬─────────────┘
                                   ▼
                        T8(ADB tools) → T9(PS tools) → T10(全量验证)
```

- T1→T2→T3 为基础层，必须最先完成。
- T4-T7 是四个子类的独立迁移，理论可并行，但建议串行以便逐步验证（每迁移一个即编译一次）。
- T8-T9 依赖对应子类迁移完成（需要继承来的 fileLogger）。
- T10 是收尾全量验证。

**回归验证纪律：** T4-T7 每完成一个子类，立即 `npx tsc --noEmit`；T10 完成后做一次完整的 `npm run build`，并尽可能对可连接的通道做一次 open→write→read→close 的冒烟测试。
