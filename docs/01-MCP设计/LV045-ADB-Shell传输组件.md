<!-- more -->

## 一、 简介

### 1. 设计目标

`AdbShell` 是 MCP Server 中负责与 Android 设备进行持久化 ADB Shell 交互的传输层组件。其设计目标包括：

- 通过 `child_process.spawn` 启动长期运行的 `adb shell` 子进程
- 提供 `open` / `write` / `read` / `close` 四个核心方法
- 与 `PowerShellShell`、`SerialShell`、`SSHShell` 保持统一的接口模式
- 支持 MCP Server 单进程同时管理多个 ADB 会话

### 2. 架构定位

```text
┌─────────────────────────────────────────┐
│           MCP Server (Node.js)          │
│  ┌─────────────────────────────────┐    │
│  │          AdbShell 实例           │    │
│  │  ┌─────────┐    ┌──────────┐    │    │
│  │  │ #buffer │ ←──│ 事件监听   │   │    │
│  │  └─────────┘    └──────────┘    │    │
│  └─────────────────────────────────┘    │
│              │ pipe                     │
│              ▼                          │
│  ┌─────────────────────────────────┐    │
│  │    adb shell 子进程 (OS 进程)     │    │
│  │  stdout/stderr → Node.js Stream │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

`AdbShell` 不直接解析命令语义，只负责 **进程生命周期管理** 和 **输出数据中转**。

### 3. 与 adb 三层架构的关系

```text
┌────────────┐  socket    ┌────────────┐  USB/TCP  ┌──────┐
│ adb client │ ────────→  │ adb server │ ────────→ │ adbd │
│ (spawn)    │ tcp:5037   │ (后台常驻)  │           │(设备) │
└────────────┘            └────────────┘           └──────┘
     ↑
     └─ AdbShell 负责管理这一层进程
```

上层调用者只需调用 `spawn("adb", ["-s", serialNo, "shell"])`，设备发现、连接协商、命令路由均由 adb 体系内部完成。

## 二、 功能设计

### 1. 子进程创建

`open()` 方法通过 `spawn` 启动持久化 `adb shell` 子进程：

```typescript
const proc = spawn("adb", args, {
  stdio: ["pipe", "pipe", "pipe"],
});
```

- `stdio: ["pipe", "pipe", "pipe"]` 为 `stdin`、`stdout`、`stderr` 各创建一条 OS 匿名管道
- 子进程启动后保持运行，不会随单条命令执行而退出
- `proc` 是 `ChildProcess` 实例，用于后续与子进程通信

### 2. 输出流监听

子进程启动后，注册 `stdout` 和 `stderr` 的数据事件：

```typescript
proc.stdout?.on("data", (data: Buffer) => {
  this.#appendBuffer(data.toString());
});
proc.stderr?.on("data", (data: Buffer) => {
  this.#appendBuffer(data.toString());
});
```

#### 2.1. `proc.stdout`

`proc.stdout` 是子进程标准输出流的 **Readable Stream**。数据流向为：

```text
设备命令输出 → adb 子进程 stdout → OS 管道 → Node.js Stream
```

#### 2.2. `?.` 可选链

`proc.stdout` 在极端情况下可能为 `null`。使用 `?.` 可在 `null` 时静默短路，避免运行时异常。

#### 2.3. `.on("data", callback)`

这是 Node.js Stream 模块的核心事件机制：

- `"data"` 事件在管道有 **新的数据块** 可读时触发
- 底层由 **libuv**（C 库）监听管道可读状态，数据就绪后向 Event Loop 排队事件
- 回调参数 `data` 为 `Buffer` 实例，承载原始字节流

#### 2.4. `Buffer` 转字符串

`Buffer` 是 Node.js 的二进制数据容器。通过 `data.toString()` 按 **UTF-8** 编码转换为字符串，再交给 `#appendBuffer` 处理。此步骤避免了字节流传输过程中的编码丢失。

#### 2.5. `stderr` 合并设计

`stderr` 与 `stdout` 采用完全对称的监听方式，但输出被追加到 **同一个内部缓冲区**。原因：

- adb shell 场景中，部分提示信息走 `stderr`
- 错误输出对用户同样重要，合并处理可简化读取逻辑
- 调用者通过单次 `read()` 即可获取全部输出

### 3. 数据缓冲累积

#### 3.1. 核心方法

```typescript
#appendBuffer(data: string): void {
  if (!this.#collecting) {
    return;
  }
  this.#buffer += data;
  if (this.#buffer.length > MAX_BUFFER_SIZE) {
    if (this.#overflow) {
      this.#buffer = this.#buffer.slice(-MAX_BUFFER_SIZE);
    } else {
      this.#buffer = this.#buffer.substring(0, MAX_BUFFER_SIZE);
    }
  }
}
```

#### 3.2. 设计要点

- **流式数据块累积**：子进程输出不会一次性到达，可能分多次 `"data"` 事件触发。`#buffer` 负责累积所有片段，直到 `read()` 被调用
- **收集开关**：`#collecting` 标志控制是否接收数据。`open()` 时短暂开启获取 banner；`write()` 时重新开启；`read()` 后关闭
- **溢出保护**：当缓冲区超过 `MAX_BUFFER_SIZE` 时，根据 `#overflow` 标志选择 **截断头部保留尾部** 或 **截断尾部保留头部**

### 4. 事件驱动模型

#### 4.1. 为什么不用同步读取

`adb shell` 子进程的执行时间不可控：

- 设备响应速度差异大
- USB / TCP 网络延迟波动
- 部分命令输出量大、持续时间长

若使用同步读取，主线程被阻塞，无法同时处理其他 session。

#### 4.2. 单线程 Event Loop 的工作方式

Node.js 主进程为 **单线程**，但 IO 操作由 libuv 在底层线程池中异步完成：

- libuv 监听所有子进程管道的可读事件
- 数据就绪后，将 `"data"` 事件排队到 Event Loop
- 主线程按顺序执行 JS 回调（即 `appendBuffer`）

这种设计使得一个 MCP Server 进程可同时管理多个 adb / serial / ssh / powershell session，而不会因为等待某个子进程的输出而卡死。

#### 4.3. "先写命令，后延时读取" 交互模式

```typescript
write("ls /sdcard");      // 1. 发送命令，立即返回
await sleep(1000);        // 2. 等待设备响应
const output = read();    // 3. 一次性读取累积的完整输出
```

此模式依赖事件驱动：

- 命令发送后，子进程输出通过 `"data"` 事件 **后台累积**
- 延时到期时，`#buffer` 已包含完整响应
- 调用 `read()` 取出内容并清空缓冲区

### 5. 对常驻命令的特殊影响

以 `logcat` 这类 **不会自行退出** 的命令为例：

#### 5.1. 事件持续触发

- 子进程 `stdout` 持续产生数据
- `"data"` 事件 **反复触发**
- `#buffer` 不断增长，直到触发溢出截断或 session 被关闭

#### 5.2. 不会阻塞主线程

`"data"` 回调仅为字符串追加操作，执行极快。主线程 Event Loop 不会卡住，其他 session 的回调仍可正常执行。

#### 5.3. Session 前台被占用

`logcat` 在设备 shell 中成为 **前台进程**，持续占用 `stdin`。后续通过 `write()` 发送的命令会被 `logcat` 接收，而非 shell 解析，导致 session **逻辑层面被卡住**。

> 【**注意**】这是 adb shell 的交互特性决定的，与 Node.js 的事件驱动机制无关。

### 6. 与其他 Shell 的对比

四种传输层在数据监听与缓冲机制上遵循 **完全相同的设计模式**，仅数据源存在差异。

#### 6.1. 核心机制的一致性

<table>
  <thead>
    <tr>
      <th> 维度 </th>
      <th> adb shell </th>
      <th> powershell </th>
      <th> serial </th>
      <th> ssh </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td> <code>#appendBuffer </code> </td>
      <td colspan="4"> 完全一致：检查 <code>#collecting </code> → 追加 <code>#buffer </code> → <code> MAX_BUFFER_SIZE </code> 溢出保护 </td>
    </tr>
    <tr>
      <td> <code> write(cmd, clear)</code> </td>
      <td colspan="4"> 完全一致：<code> clear = 1 </code> 丢弃溢出，<code> clear = 0 </code> 保留最新，统一开启 <code>#collecting </code> </td>
    </tr>
    <tr>
      <td> <code> read(clear)</code> </td>
      <td colspan="4"> 完全一致：返回 <code>#buffer </code>，<code> clear = 1 </code> 时清空并关闭收集 </td>
    </tr>
    <tr>
      <td> banner 收集 </td>
      <td colspan="4"> 完全一致：开启收集 → sleep → 读取 → 清空 → 关闭收集 </td>
    </tr>
  </tbody>
</table>

#### 6.2. 数据源的差异

<table>
  <thead>
    <tr>
      <th> 传输层 </th>
      <th> 底层对象 </th>
      <th> 数据来源 </th>
      <th> 事件来源 </th>
      <th> stdout 监听 </th>
      <th> stderr 监听 </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td> adb shell </td>
      <td> <code> spawn("adb", ...)</code> 子进程 </td>
      <td> OS 匿名管道 </td>
      <td> Node.js Stream 事件 </td>
      <td> <code> proc.stdout?.on("data")</code> </td>
      <td> <code> proc.stderr?.on("data")</code> </td>
    </tr>
    <tr>
      <td> powershell </td>
      <td> <code> spawn("powershell", ...)</code> 子进程 </td>
      <td> OS 匿名管道 </td>
      <td> Node.js Stream 事件 </td>
      <td> <code> proc.stdout?.on("data")</code> </td>
      <td> <code> proc.stderr?.on("data")</code> </td>
    </tr>
    <tr>
      <td> serial </td>
      <td> <code> SerialPort </code> 硬件句柄 </td>
      <td> UART 串口数据 </td>
      <td> <code> serialport </code> 库事件 </td>
      <td> <code> serialPort.on("data")</code> </td>
      <td> 无（UART 不区分 stdout/stderr）</td>
    </tr>
    <tr>
      <td> ssh </td>
      <td> <code> ssh2.ClientChannel </code> 流 </td>
      <td> SSH 协议通道流 </td>
      <td> <code> ssh2 </code> 库事件 </td>
      <td> <code> stream.on("data")</code> </td>
      <td> <code> stream.stderr.on("data")</code> </td>
    </tr>
  </tbody>
</table>

> 【**说明**】
>
> - **数据来源**：指数据从设备到达 Node.js 进程所经过的物理或逻辑通道。adb / powershell 走 OS 管道，serial 走 UART 串口，ssh 走 TCP 上的 SSH 协议通道。
> - **事件来源**：指触发 `"data"` 回调的上层事件系统。adb / powershell 使用 Node.js 原生的 Stream 事件，serial 依赖 `serialport` 库封装的事件，ssh 依赖 `ssh2` 库封装的事件。
> - serial 没有独立的 stderr 通道，因为 UART 串口是物理线路，设备侧 stdout 与 stderr 未分离，所有输出统一走 `serialPort.on("data")`。
