# ch05 用户需求：Transport 层抽象重构

## 背景现象

项目当前有四个传输类，分别对应四种连接通道：

| 类 | 文件 | 行数 | 连接方式 |
|---|---|---|---|
| `SSHShell` | `src/transports/ssh.ts` | ~390 | ssh2 库的 Client + PTY |
| `SerialShell` | `src/transports/serial.ts` | ~470 | serialport 库 |
| `AdbShell` | `src/transports/adb.ts` | ~280 | child_process.spawn("adb") |
| `PowerShellShell` | `src/transports/powershell.ts` | ~220 | child_process.spawn("powershell") |

四个类的核心方法 `open / write / read / drain / close` 签名几乎完全相同，内部都持有一个 `OutputBuffer` 实例管理缓冲区，且都挂载一个 `FileLogger` 记录原始数据。但它们之间**没有任何继承或接口契约关系**——每个类各自独立实现了整套缓冲区协作逻辑。

## 痛点

### 1. 大量重复代码

四个类中以下逻辑逐字重复：

- `#output = new OutputBuffer()` 字段声明
- `write(data, clear, appendLineEnding)` 方法：参数校验 → `output.prepareWrite(clear)` → 发送数据
- `read(clear)` 方法：直接转发 `output.read(clear)`
- `drain()` 方法：直接转发 `output.drain()`
- `open()` 末尾固定的 `startCollecting() + sleep 500~800ms + read(1)` 三连
- `close()` 中 `fileLogger.disable()` + `output.reset()` 的收尾

仅"连接建立"和"连接关闭"的具体实现因通道而异，其余完全可共享。

### 2. 抽象不一致，缺乏契约约束

存在一个 `InteractiveShell` 接口（`src/transports/loop.ts`），声明了 `write/read/close`，但它：

- **只被 demo 的 `interactiveLoop` 使用**，四个传输类本身并未 `implements` 它。
- 签名不完整：只声明了 `write(cmd, clear?)`，遗漏了第三参 `appendLineEnding`、`drain()`、`open()` 等方法。
- 四个类对它的"符合"是隐式的、靠人工保持的，没有编译期约束。

### 3. 能力挂载不统一

`FileLogger` 只在 `SSHShell` 和 `SerialShell` 上挂载了，`AdbShell` 和 `PowerShellShell` **没有**。这导致：

- ADB 会话和 PowerShell 会话的原始输出无法落盘复盘。
- 同为"shell 传输类"，能力却不一致，属于明显的抽象漏洞。

### 4. 改造的连锁成本

README 第五章已规划"持续监听 + alerts 扫描"的改造。当前若要给四个类都加上 alerts，需要在**四个文件里各改一遍** `stream.on("data")` 回调，极易遗漏。这正是重复代码的直接代价——任何对缓冲/采集策略的调整都要复制四份。

## 关键前提

- 四个类的**公共接口（open/write/read/drain/close）对外契约保持不变**，重构是内部的，上层 `tools/` 调用方无感知。
- 四个类的**连接建立与关闭逻辑本质不同**（SSH 是 TCP 握手 + PTY；Serial 是 COM 口打开；ADB/PowerShell 是 spawn 子进程），这部分必须保留为各子类的差异点，不能强行统一。
- 现有的 `OutputBuffer`（含 `append / prepareWrite / read / drain / startCollecting / reset` 及溢出策略）是成熟的、经过验证的逻辑，本次**不改动其内部实现**，只把它从"四个类各自组合"改为"基类统一持有"。

## 选定方向

采用**抽象基类 + 模板方法模式**，把可共享的缓冲区管理、日志挂载、公共方法实现上提到 `BaseShell`，把连接建立/发送/关闭的差异化实现留给各子类。

### 目标结构

```
src/transports/
├── base-shell.ts        # 新增：BaseShell 抽象基类
├── output-buffer.ts     # 不变：OutputBuffer 实现
├── interactive-shell.ts # 新增：InteractiveShell 接口（从 loop.ts 迁入并补全）
├── ssh.ts               # SSHShell extends BaseShell
├── serial.ts            # SerialShell extends BaseShell
├── adb.ts               # AdbShell extends BaseShell（补挂 FileLogger）
├── powershell.ts        # PowerShellShell extends BaseShell（补挂 FileLogger）
└── loop.ts              # 引用新的接口位置
```

### BaseShell 承担的职责

```
BaseShell（抽象）
├── #output: OutputBuffer              # 统一持有，子类共享
├── readonly fileLogger: FileLogger    # 统一挂载，四个子类一致
├── open(): Promise<string>            # 模板方法：调子类 acquire() → 统一收 banner
├── write(data, clear, appendLineEnding): void
├── read(clear): string
├── drain(): string
├── close(): Promise<void>             # 模板方法：fileLogger.disable → 子类 release() → output.reset
└── protected abstract acquire(): Promise<{ banner: string }>   # 子类：建立连接、注册 data 监听
    protected abstract rawWrite(data: string): void             # 子类：发送原始字节
    protected abstract release(): Promise<void>                 # 子类：关闭连接/进程
```

子类（如 `SSHShell`）只需实现三个抽象方法，其余全部继承。

## 范围边界

- **只重构传输层内部结构**，不改 `OutputBuffer` 的缓冲/溢出策略（那是后续章节的事）。
- **不改对外方法签名**：`open/write/read/drain/close` 的参数与返回类型与现状一致，上层 `tools/*.ts` 无需改动。
- **不改四个类的连接建立逻辑**：SSH 的 PTY 分配、Serial 的 COM 口打开、ADB/PowerShell 的 spawn 参数等保持原样，只是从 `open()` 搬到 `acquire()`。
- **demo 函数（pshDemoSsh / pshDemoSerial / userLoginDemoSerial）的剥离不在本章**：它们与传输类的耦合处理留待后续。
- **不引入 alerts / 持续监听**：那是独立章节，依赖本章的基类落地。
- **补挂 FileLogger 属于"修复抽象漏洞"**，纳入本章（AdbShell / PowerShellShell 统一挂上）。
