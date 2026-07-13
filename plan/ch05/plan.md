# Transport 层抽象重构 Plan

## 架构概览

引入抽象基类 `BaseShell`，采用**模板方法模式**统一四个传输类（SSHShell / SerialShell / AdbShell / PowerShellShell）的公共逻辑。基类持有 `OutputBuffer` 和 `FileLogger`，实现 `open / write / read / drain / close` 的公共流程；连接建立、发送、关闭的差异通过三个受保护的抽象方法委托给子类。

```
                    ┌──────────────────┐
                    │  InteractiveShell │  (接口，补全签名)
                    └────────┬─────────┘
                             │ implements
                    ┌────────┴─────────┐
                    │    BaseShell      │  (抽象基类，模板方法)
                    │  #output          │
                    │  fileLogger       │
                    │  open/write/read  │
                    │  drain/close      │
                    └────────┬─────────┘
                             │ extends
        ┌────────────┬───────┴────────┬───────────────┐
        ▼            ▼                ▼               ▼
   ┌─────────┐ ┌──────────┐    ┌──────────┐   ┌──────────────┐
   │SSHShell │ │SerialShell│    │ AdbShell │   │PowerShellShell│
   │+SFTP能力│ │+lineEnding│    │          │   │              │
   └─────────┘ └──────────┘    └──────────┘   └──────────────┘
```

四个子类只实现三个抽象方法（`acquire / rawWrite / release`）+ 各自的特有能力，公共逻辑全部继承。

## 核心数据结构

### BaseShell（抽象基类）

```ts
abstract class BaseShell implements InteractiveShell {
  protected readonly #output = new OutputBuffer();
  readonly fileLogger = new FileLogger();

  // —— 子类提供的配置项 ——

  /** banner 采集等待时长（毫秒），SSH/Serial=500，ADB/PowerShell=800 */
  protected abstract bannerWaitMs: number;

  /** 写入时的换行符，默认 "\n"，SerialShell 覆盖为 config.lineEnding ?? "\n" */
  protected get lineEnding(): string { return "\n"; }

  // —— 模板方法（基类实现，子类不可覆盖） —

  async open(): Promise<string> {
    await this.acquire();
    this.#output.startCollecting();
    await new Promise((r) => setTimeout(r, this.bannerWaitMs));
    return this.#output.read(1);
  }

  write(data: string, clear: number = 1, appendLineEnding: boolean = true): void {
    this.#output.prepareWrite(clear);
    const payload = appendLineEnding ? `${data}${this.lineEnding}` : data;
    this.rawWrite(payload);
  }

  read(clear: number = 1): string {
    return this.#output.read(clear);
  }

  drain(): string {
    return this.#output.drain();
  }

  async close(): Promise<void> {
    this.fileLogger.disable();
    await this.release();
    this.#output.reset();
  }

  // —— 子类必须实现的三个差异点 ——

  /** 建立连接并注册 data 监听（监听内调 append + fileLogger.write） */
  protected abstract acquire(): Promise<void>;

  /** 发送原始字节（已含换行处理），由子类检查"是否已打开" */
  protected abstract rawWrite(payload: string): void;

  /** 关闭连接/进程，释放通道资源 */
  protected abstract release(): Promise<void>;

  // —— 供子类 data 监听调用的工具方法 ——

  /** 将收到的文本追加到缓冲区并写入文件日志 */
  protected appendData(text: string): void {
    this.#output.append(text);
    this.fileLogger.write(text);
  }
}
```

**设计要点：**

- `#output` 为私有，子类通过 `appendData()` 间接写入 data 监听数据，无法直接操作缓冲区（防止子类绕过溢出策略）。
- `fileLogger` 为 `readonly` 公共，保留现状（tools 层需调用 `enableFromEnv`）。
- `bannerWaitMs` 为抽象属性，强制每个子类显式声明等待时长，避免遗漏差异。
- `lineEnding` 为可覆盖 getter，默认 `"\n"`，只有 SerialShell 需覆盖。
- `write` 拼好换行后传给 `rawWrite`，子类不再处理换行逻辑。
- `acquire` 只管"建立连接 + 注册监听"，不管 banner 采集（由基类 `open` 统一做）。
- `release` 只管"关闭通道资源"，不管 fileLogger 和 output（由基类 `close` 统一做）。

### InteractiveShell 接口（补全）

```ts
interface InteractiveShell {
  open(): Promise<string>;
  write(data: string, clear?: number, appendLineEnding?: boolean): void;
  read(clear?: number): string;
  drain(): string;
  close(): Promise<void>;
}
```

**与现状对比：** 原 `loop.ts` 的接口缺 `open` / `drain`，且 `write` 只有 `clear` 参。补全后与四个类的实际签名一致。

## 模块设计

### BaseShell
**职责：** 持有 OutputBuffer 和 FileLogger，实现 open/write/read/drain/close 模板方法，定义三个抽象钩子。
**对外接口：** 被 SSHShell/SerialShell/AdbShell/PowerShellShell 继承。
**依赖：** OutputBuffer、FileLogger。

### SSHShell
**职责：** SSH 通道。acquire 建立 Client + PTY shell；rawWrite 写 #stream；release 释放 SFTP→stream→client。额外保留 SFTP 能力（uploadFile/downloadFile/#ensureSftp）。
**依赖：** ssh2 库、BaseShell。

### SerialShell
**职责：** 串口通道。acquire 打开 SerialPort；rawWrite 写 #serialPort；release 关闭串口（保留 2s 超时 + destroy 兜底）。覆盖 `lineEnding`。
**依赖：** serialport 库、BaseShell。

### AdbShell
**职责：** ADB 通道。acquire 自动发现设备 + spawn adb shell；rawWrite 写 #process.stdin；release 发 exit + 等 close + 3s kill 兜底。
**依赖：** child_process、BaseShell。

### PowerShellShell
**职责：** PowerShell 通道。acquire spawn powershell；rawWrite 写 #process.stdin；release 发 exit + 等 close + 3s kill 兜底。保留 encodePsCommand/execPowerShell 一次性执行工具。
**依赖：** child_process、BaseShell。

### loop.ts（demo 交互循环）
**职责：** 从 `interactive-shell.ts` 导入接口（不再就地定义）。
**依赖：** InteractiveShell 接口。

## 模块交互

### open() 调用链（以 SSH 为例）

```
工具层 sshShellOpenHandler
  └→ new SSHShell(config)
     └→ shell.open()                          [基类模板方法]
        ├→ this.acquire()                      [子类实现]
        │   ├→ new Client() + connect(PTY)
        │   ├→ stream.on("data", d => this.appendData(d.toString()))   [子类注册，调基类工具]
        │   └→ this.#stream = stream
        ├→ this.#output.startCollecting()      [基类]
        ├→ await sleep(this.bannerWaitMs=500)  [基类，用子类的值]
        └→ return this.#output.read(1)         [基类]
```

### write() 调用链

```
工具层 xxxWriteHandler
  └→ shell.write(cmd, clear, appendLineEnding)    [基类模板方法]
     ├→ this.#output.prepareWrite(clear)           [基类]
     ├→ payload = appendLineEnding ? cmd+lineEnding : cmd   [基类]
     └→ this.rawWrite(payload)                     [子类实现]
        └→ if (!#stream) throw "Shell not open"     [子类检查，保持现状]
           #stream.write(payload)                   [子类发送]
```

### close() 调用链（以 SSH 为例）

```
工具层 xxxCloseHandler / disposeAllXxxSessions
  └→ shell.close()                            [基类模板方法]
     ├→ this.fileLogger.disable()             [基类统一]
     ├→ await this.release()                   [子类实现]
     │   ├→ #sftp.end() → null
     │   ├→ #stream.close() → null
     │   └→ #client.end() → null
     └→ this.#output.reset()                  [基类统一]
```

## 文件组织

```
src/transports/
├── base-shell.ts          # 【新增】BaseShell 抽象基类
├── interactive-shell.ts   # 【新增】InteractiveShell 接口（从 loop.ts 迁入并补全签名）
├── output-buffer.ts       # 【不变】OutputBuffer 实现
├── ssh.ts                 # 【改】SSHShell extends BaseShell
├── serial.ts              # 【改】SerialShell extends BaseShell
├── adb.ts                 # 【改】AdbShell extends BaseShell
├── powershell.ts          # 【改】PowerShellShell extends BaseShell
└── loop.ts                # 【改】InteractiveShell 改从 ./interactive-shell.js 导入

src/shared/
└── file-logger.ts         # 【不变】FileLogger 实现

src/mcp/tools/
├── adb/shell.ts           # 【改】open 成功后增加 shell.fileLogger.enableFromEnv(sessionId)
└── win/powershell.ts      # 【改】同上
（ssh/shell.ts、serial/shell.ts 不改，已有 enableFromEnv 调用）
```

## 子类改造对照表

| 子类 | acquire() 做什么 | rawWrite(payload) | release() | bannerWaitMs | lineEnding | 特有保留 |
|---|---|---|---|---|---|---|
| SSHShell | new Client+connect+shell(PTY)，注册 data/stderr/close 监听 | 检查 #stream，#stream.write(payload) | sftp.end→stream.close→client.end | 500 | `"\n"` | SFTP: uploadFile/downloadFile/#ensureSftp |
| SerialShell | new SerialPort+open，注册 data/close/error 监听 | 检查 #serialPort.isOpen，#serialPort.write(payload) | port.close(2s超时+destroy兜底) | 500 | config.lineEnding ?? `"\n"` | sendRaw（调 write 的便捷别名，需保留） |
| AdbShell | discoverDevice+spawn("adb",...)，注册 stdout/stderr/close/error 监听 | 检查 #process.exitCode，#process.stdin.write(payload) | stdin.write("exit")+等close(3s)+kill兜底 | 800 | `"\n"` | #discoverDevice、getSerialNo、getDeviceName |
| PowerShellShell | spawn("powershell",...)，注册 stdout/stderr/close/error 监听 | 检查 #process.exitCode，#process.stdin.write(payload) | stdin.write("exit")+等close(3s)+kill兜底 | 800 | `"\n"` | encodePsCommand、execPowerShell、getWorkingDir |

**关键改造纪律（防回归）：**
- 各子类 data 监听回调内的 `this.#output.append(text); this.fileLogger.write(text);` 统一替换为 `this.appendData(text);`（基类工具方法，语义等价）。
- `sendRaw`（SerialShell 独有）改为调用继承的 `write(data, clear, false)`，保持对外行为不变。
- 子类的 `getHost/getPort/getUsername/getDeviceName/getSerialNo/getWorkingDir` 等访问器原样保留，不进基类。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| `#output` 可见性 | 基类 private，子类通过 `appendData()` 间接写 | 防止子类绕过溢出策略；现状四个子类的 append 调用完全等价，封装后更安全 |
| `fileLogger` 可见性 | 基类 public readonly | tools 层需调用 enableFromEnv，保持现状；不能 private 否则破坏调用方 |
| banner 等待时长 | 抽象属性 `bannerWaitMs`，子类显式声明 | 强制保留 SSH/Serial=500、ADB/PS=800 的差异，避免被误统一 |
| 换行拼接位置 | 基类 `write` 拼好换行，子类 `rawWrite` 只发送 | 消除四个子类的重复拼接逻辑；Serial 的自定义 lineEnding 通过 getter 覆盖 |
| "未打开"检查位置 | 留在子类 `rawWrite` 中，基类不检查 | 基类无法感知各通道的"是否打开"状态（#stream/isOpen/exitCode）；保持现状的异常抛出行为（F6） |
| `close()` 模板 | fileLogger.disable → release → output.reset | SSH/Serial 现状就是此顺序；ADB/PS 补 fileLogger.disable 后一致。fileLogger 未 enable 时 disable() 无副作用 |
| 接口位置 | 单独 `interactive-shell.ts` | 与实现解耦，loop.ts 和未来其他消费方可独立引用 |
| ADB/PS 的 spawn+exit+kill 重复 | 本章不抽中间类（如 ProcessShell） | 控制 ch05 范围；两者 release 逻辑虽相似但分属不同通道，强行合并增加复杂度，收益有限 |

## 编码规范

**编程语言：** TypeScript（ESM，target ES2022，strict 模式）

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则：**
- **新建文件**（`base-shell.ts`、`interactive-shell.ts`）：UTF-8 无 BOM、LF 换行。
- **修改已有文件**（`ssh.ts`、`serial.ts`、`adb.ts`、`powershell.ts`、`loop.ts`、`tools/adb/shell.ts`、`tools/win/powershell.ts`）：保持原文件编码与换行符不变（本项目源码为 UTF-8 无 BOM / LF，沿用即可）。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
