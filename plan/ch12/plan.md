# 串口 ZMODEM 文件传输 Plan

## 架构概览

本次改动在现有串口会话上叠加 ZMODEM 二进制文件传输能力，核心思路是「**MCP 进程内充当 ZMODEM 对端，全程不释放串口**」。整体分三层，自底向上：

```
┌─────────────────────────────────────────────────────────────┐
│  工具层  src/mcp/tools/serial/transfer.ts                    │
│  serial_upload / serial_download handler                     │
│  · 查会话 · 触发设备 rz/sz · 调 bridge · 格式化摘要           │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────┴──────────────────────────────────┐
│  协议层  src/services/zmodem/zmodem-bridge.ts                │
│  zmodemSend / zmodemReceive                                  │
│  · 封装 zmodem.js · 桥接串口字节旁路 ←→ ZMODEM 会话          │
│  · 进度回调 · 超时中止 · 返回 TransferResult                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ 依赖
┌──────────────────────────┴──────────────────────────────────┐
│  传输层  src/transports/serial.ts（改造）                     │
│  字节旁路：writeBuffer(buf) / attachRawReceiver(cb)          │
│  · 绕过文本态 OutputBuffer · 不影响现有 serial_write/read     │
└─────────────────────────────────────────────────────────────┘
```

**为什么分三层**：传输层只管「字节怎么进出串口」，与协议无关（未来若有别的二进制协议也可复用字节旁路）；协议层只管「ZMODEM 帧怎么编解码和状态机」，与 MCP 工具无关；工具层只管「参数校验、触发设备命令、格式化返回」。三层解耦，各层可独立测试。

### 改动概览

| 层 | 组件 | 文件 | 操作 | 职责 |
|---|---|---|---|---|
| 传输层 | 字节旁路 | `src/transports/serial.ts` | 修改 | 新增 `writeBuffer` / `attachRawReceiver`，改造 data 监听为双写 |
| 协议层 | ZMODEM 桥 | `src/services/zmodem/zmodem-bridge.ts` | 新建 | 封装 zmodem.js，提供 `zmodemSend` / `zmodemReceive` |
| 协议层 | 导出 | `src/services/zmodem/index.ts` | 新建 | re-export 桥接函数与类型 |
| 工具层 | 传输工具 | `src/mcp/tools/serial/transfer.ts` | 新建 | `serial_upload` / `serial_download` 的 config + handler |
| 工具层 | 注册 | `src/mcp/tools/serial/index.ts` | 修改 | `mcpSerialTools` 数组追加 2 项 |
| 共享 | 摘要工具 | `src/shared/transfer-result.ts` | 新建 | 提取 `TransferResult` + `formatBytes`/`formatRate`/`formatTransferSummary` |
| 共享 | SSH 适配 | `src/transports/ssh.ts` | 修改 | `TransferResult` 改为从 shared re-import |
| 共享 | SFTP 适配 | `src/mcp/tools/ssh/sftp.ts` | 修改 | format 函数改为从 shared re-import |
| 文档 | README | `README.md` | 修改 | 工具表追加 2 行 |
| 依赖 | package | `package.json` | 修改 | 新增 `zmodem.js` 依赖 |

新建 4 个文件，修改 5 个文件。

不改动：`base-shell.ts`（字节旁路只在 SerialShell 内做，不下沉到基类）、SSH/ADB/PowerShell 通道、`session-store.ts`、`registry.ts`、现有 8 个串口工具的逻辑。

## 核心数据结构

### TransferResult（从 SSH 提取到 shared，字段不变）

```ts
/**
 * @brief 文件传输结果摘要
 *
 * 由各通道的文件传输方法返回（SSH 的 uploadFile/downloadFile、串口的 zmodemSend/zmodemReceive），
 * 工具层据此格式化为 MCP 文本响应。
 */
export interface TransferResult {
  direction: "upload" | "download"; // 传输方向：upload 本地→远端，download 远端→本地
  localPath: string; // 本地文件路径
  remotePath: string; // 远端文件路径
  bytes: number; // 传输字节数（源文件大小）
  durationMs: number; // 耗时（毫秒）
  success: boolean; // 是否成功
  error?: string; // 失败时的错误信息（成功时为 undefined）
}
```

迁移说明：该接口原定义于 `src/transports/ssh.ts:45-53`，本次**原样移动**到 `src/shared/transfer-result.ts`，ssh.ts 和 sftp.ts 改为从此处 re-import。字段顺序、类型、注释保持不变。

### ZmodemProgress（协议层进度回调参数）

```ts
/**
 * @brief ZMODEM 传输进度信息
 *
 * 由 zmodemSend / zmodemReceive 在传输过程中通过 onProgress 回调上报。
 * 上传时 total 已知（本地文件大小）；下载时 total 在收到 ZFILE offer 后才有值。
 */
export interface ZmodemProgress {
  /** 已传输字节数 */
  bytes: number;
  /** 文件总字节数（未知时为 undefined，如下载初期未收到 offer 时） */
  total?: number;
}
```

### ZmodemTransferOptions（协议层函数参数）

```ts
/**
 * @brief ZMODEM 传输的可选参数
 */
export interface ZmodemTransferOptions {
  /** 进度回调，传输过程中按块频率触发 */
  onProgress?: (p: ZmodemProgress) => void;
  /** 中止信号；abort 后立即停止 ZMODEM 会话并返回失败结果 */
  signal?: AbortSignal;
}
```

## 模块设计

### 模块 A：`src/transports/serial.ts`（字节旁路，改造）

**职责：** 为 ZMODEM 等二进制协议提供绕过文本态 OutputBuffer 的字节透传通路，满足 spec F3。

**改动点 1：新增私有字段**

```ts
export class SerialShell extends BaseShell {
  #serialPort: SerialPort | null = null;
  #config: SerialShellConfig;
  #rawReceiver: ((b: Buffer) => void) | null = null;  // ★ 新增：二进制旁路接收回调
  // ...
}
```

**改动点 2：新增两个 public 方法**

```ts
/**
 * @brief 发送原始字节到串口
 *
 * 绕过 lineEnding 拼接和文本态路径，直接写字节。
 * 供 ZMODEM 等二进制协议使用；普通命令仍用 write(string)。
 *
 * @param buf 要发送的字节
 * @throws 串口未打开时抛出 "Serial not open. Call open() first."
 */
writeBuffer(buf: Buffer): void {
  if (!this.#serialPort || !this.#serialPort.isOpen) {
    throw new Error("Serial not open. Call open() first.");
  }
  this.#serialPort.write(buf);
}

/**
 * @brief 挂载 / 卸载原始字节接收回调
 *
 * 挂载后（cb 非空），串口 data 事件改为"双写"：
 *   - 原始 Buffer 喂给 cb（ZMODEM 协议层消费）
 *   - 仍按原样进文本态 OutputBuffer（不影响 serial_read 等现有工具）
 * 卸载（cb=null 或调用返回的卸载函数）后恢复纯文本态。
 *
 * @param cb 字节接收回调；传 null 卸载
 * @returns 卸载函数，调用后移除回调
 */
attachRawReceiver(cb: ((b: Buffer) => void) | null): () => void {
  this.#rawReceiver = cb;
  return () => {
    if (this.#rawReceiver === cb) this.#rawReceiver = null;
  };
}
```

**改动点 3：改造 data 监听为双写**

原代码（`serial.ts:111-113`）：
```ts
serialPort.on("data", (data: Buffer) => {
  this.appendData(data.toString());
});
```

改为：
```ts
serialPort.on("data", (data: Buffer) => {
  if (this.#rawReceiver) this.#rawReceiver(data);   // ★ 二进制旁路（默认 null，行为不变）
  this.appendData(data.toString());                  // 文本态路径保留
});
```

**关键设计：双写而非替换。** ZMODEM 期间设备回显的协议字节也会进 OutputBuffer，但此时 handler 不会调 `serial_read`（传输结束才读 shell 提示符），两者互不干扰。卸载后 `#rawReceiver=null`，data 监听与改动前**逐字一致**——这是 N1（不影响现有工具）的保证。

**改动点 4：release() 卸载回调**

```ts
protected async release(): Promise<void> {
  this.#rawReceiver = null;  // ★ 新增：释放时清理
  if (this.#serialPort) { /* 原逻辑不变 */ }
}
```

**依赖：** 无新增。复用已有的 `#serialPort` 和 `serialport` 库（原生支持 Buffer 读写）。

### 模块 B：`src/services/zmodem/zmodem-bridge.ts`（协议层，新建）

**职责：** 封装 `zmodem.js` 库，把 SerialShell 的字节旁路 ←→ ZMODEM 会话粘合起来，对外暴露两个高阶函数。满足 spec F1（发送）、F2（接收）、F4（进度+超时中止）。

**对外接口：**

```ts
import type { SerialShell } from "../../transports/serial.js";
import type { TransferResult } from "../../shared/transfer-result.js";

/**
 * @brief ZMODEM 上传：MCP 当发送端，设备端已跑 rz
 *
 * 数据流：
 *   本地文件 → 分块读 → ZMODEM 编码 → writeBuffer → 串口 → 设备 rz
 *   设备 rz 回执 → 串口 → attachRawReceiver → session.consume → 库内部解析
 *
 * @param shell      已建立的串口会话
 * @param localPath  本地源文件路径
 * @param remoteName 远端文件名（ZMODEM offer 携带，设备 rz 据此命名）
 * @param opts       进度回调 / 中止信号
 * @returns 传输结果摘要
 */
export async function zmodemSend(
  shell: SerialShell,
  localPath: string,
  remoteName: string,
  opts?: ZmodemTransferOptions
): Promise<TransferResult>;

/**
 * @brief ZMODEM 下载：MCP 当接收端，设备端已跑 sz
 *
 * 数据流：
 *   设备 sz → 串口 → attachRawReceiver → session.consume → 库解析 ZFILE offer
 *   库输出 ZRPOS 等回执 → writeBuffer → 串口 → 设备 sz
 *   收到的文件数据 → 写本地文件流
 *
 * @param shell     已建立的串口会话
 * @param localPath 本地目标文件路径
 * @param opts      进度回调 / 中止信号
 * @returns 传输结果摘要
 */
export async function zmodemReceive(
  shell: SerialShell,
  localPath: string,
  opts?: ZmodemTransferOptions
): Promise<TransferResult>;
```

**内部实现要点（基于 zmodem.js@0.1.10 实测 API）：**

库的 ZMODEM 会话对象核心 API（来自 `src/zsession.js` 探索）：
- `session.set_sender(cb)`：注册输出回调，库要发的字节通过 `cb(octets: number[])` 吐出
- `session.consume(octets: number[])`：喂入从对端收到的字节
- `Zmodem.Validation.offer_parameters({name, size, mtime, mode})`：校验并归一化 offer 参数
- `Session.Send`：发送端会话，内部通过一个 Sender 对象的 `send(chunk)`/`end()` 驱动数据
- `Session.Receive`：接收端会话，事件 `offer`（含 `accept(offset)`/`skip()`）、`data`、`session_end`
- `Zmodem.Session.parse(octets)`：从首帧判断该建 Send 还是 Receive

**zmodemSend 流程：**

```
1. stat(localPath) 拿 size；失败 → 返回 success:false TransferResult（对齐 ssh uploadFile 模式）
2. offer = Zmodem.Validation.offer_parameters({ name: remoteName, size, mtime: mtimeMs })
3. 建库的 Send 会话（offer 经库内部建链流程，库会等待设备 rz 发来的 ZRINIT）
4. session.set_sender(octets => shell.writeBuffer(Buffer.from(octets)))   // 输出 → 串口
5. detach = shell.attachRawReceiver(buf => session.consume(Array.from(buf)))  // 串口 → 库
6. 流式读本地文件（fs.createReadStream，分块 ≤ 8192，对齐库的 MAX_CHUNK_LENGTH）
   每个 chunk：sender.send(chunk) 后触发 opts.onProgress({ bytes: 累计, total: size })
7. 文件读完：sender.end()
8. await session 结束（监听 session_end 事件 resolve）
9. 清理：detach() 卸载旁路
10. 返回 TransferResult（direction:"upload", bytes:size, durationMs, success:true）
    try/catch：任何错误 → session.abort() + 返回 success:false + error
    finally：detach()
```

**zmodemReceive 流程：**

```
1. detach = shell.attachRawReceiver(buf => 喂给 session 或预解析缓冲区)
2. 收到首批字节后用 Zmodem.Session.parse 判断建 Receive 会话
3. session.on("offer", xfr => {
     // xfr.get_details() 拿到 { name, size }
     writeStream = fs.createWriteStream(localPath)
     xfr.accept()   // 接受，告知对端开始传
   })
4. session.on("data", bytes => {
     writeStream.write(Buffer.from(bytes))
     累计 bytes；触发 onProgress({ bytes, total: offer.size })
   })
5. session.on("session_end", () => { writeStream.end(); resolve })
6. set_sender: session.set_sender(octets => shell.writeBuffer(Buffer.from(octets)))
7. await 结束
8. 清理：detach()
9. 返回 TransferResult（direction:"download", bytes:实际收到, durationMs, success）
   失败时：unlink(localPath) 清理半写文件（对齐 ssh downloadFile 模式）
   finally：detach()
```

**超时与中止（F4）：** 由工具层（模块 C）通过 `AbortSignal` 控制；协议层在 `opts.signal.aborted` 为真时调 `session.abort()`，库会发 ZMODEM 中止序列（CAN×5）通知设备。这样设备端的 rz/sz 也会干净退出，不会残留半传状态。

**进度频率（N3）：** 进度在每次 `send(chunk)` / `data` 事件时触发；为避免 16 分钟传输刷屏，工具层可节流（如每 1 秒最多记一条 logger）。节流逻辑放工具层，协议层每次都回调。

**依赖：**
- `zmodem.js`（新增依赖，npm `zmodem.js@^0.1.10`，Apache-2.0，唯一依赖 `crc-32`）
- `SerialShell.writeBuffer` / `attachRawReceiver`（模块 A）
- `fs`（流式读写）、`fs/promises`（stat、unlink）
- `TransferResult`（shared）

**库导入注意事项：** zmodem.js 是 CommonJS 包，且其 `index.js` 导出的是面向终端场景的 `zsentry`。本方案需直接用底层的 `Zmodem.Session.Send/Receive`，因此从包根导入后取 `.Session` 命名空间。需在实现时验证导入路径（可能是 `import Zmodem from "zmodem.js"` 后用 `Zmodem.Session`，或直接 require 子模块）。这是实现期需首要验证的点，task.md 中列为 T1 的验证项。

### 模块 C：`src/mcp/tools/serial/transfer.ts`（工具层，新建）

**职责：** 定义 `serial_upload` / `serial_download` 的 schema 和 handler。满足 spec F1、F2、F4、F5。

**serial_upload 配置：**

```ts
export const serialUploadConfig = {
  description:
    "Upload a binary file to the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (rz command). " +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    local_path: string;
    remote_name?: string;
    remote_dir?: string;
    recv_cmd?: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session ID returned by serial_open" },
      local_path: { type: "string", description: "Local source file path" },
      remote_name: { type: "string", description: "Remote file name (default: basename of local_path)" },
      remote_dir: { type: "string", description: "Remote directory hint (default: current dir of rz)" },
      recv_cmd: { type: "string", description: "Device receive command (default: 'rz'). e.g. 'rz -e'" },
      timeout: { type: "number", description: "Timeout in seconds (default: 300)" },
    },
    required: ["session_id", "local_path"],
  }),
};
```

**serial_upload handler 流程：**

```
1. logger.info([serial_upload] session/local/remote)
2. result = serialStore.getOrNotFound(session_id); if (!ok) return response
3. shell = result.shell
4. fs.stat(local_path) 校验存在（不存在 → 返回错误文本）；拿 size
5. remoteName = args.remote_name ?? path.basename(local_path)
6. recvCmd = args.recv_cmd ?? "rz"
7. shell.write(recvCmd, 1)                        // 触发设备端 rz（F5，可覆盖）
8. 短延时（如 300ms）让设备进 ZMODEM 等待态
9. controller = new AbortController()
   timer = setTimeout(() => controller.abort(), (timeout ?? 300) * 1000)
10. lastLog = 0
    result = await zmodemSend(shell, local_path, remoteName, {
      onProgress: p => {
        if (Date.now() - lastLog >= 1000) {       // 节流 1 秒一条（N3）
          logger.info(`[serial_upload] progress ${p.bytes}/${p.total ?? "?"} bytes`)
          lastLog = Date.now()
        }
      },
      signal: controller.signal,
    })
11. clearTimeout(timer)
12. trailer = shell.read(1)                        // 收设备返回的 shell 提示符，确认会话活着
13. logger.info([serial_upload] ok/fail bytes/ms)
14. return { content: [text(formatTransferSummary(result) + (trailer ? `\n${trailer}` : ""))] }
```

**serial_download 配置与 handler：** 结构对称。`send_cmd` 默认 `"sz {remote}"`，`{remote}` 占位符替换为 `remote_path` 参数值。下载失败时 `zmodemReceive` 内部已清理半写文件。

```ts
export const serialDownloadConfig = {
  description:
    "Download a binary file from the device over ZMODEM via an existing serial session. " +
    "The device must have lrzsz installed (sz command). " +
    "Blocks until transfer completes, fails, or times out; progress is logged to stderr.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    remote_path: string;
    local_path: string;
    send_cmd?: string;
    timeout?: number;
  }>({
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session ID returned by serial_open" },
      remote_path: { type: "string", description: "Remote source file path on the device" },
      local_path: { type: "string", description: "Local destination file path" },
      send_cmd: { type: "string", description: "Device send command template (default: 'sz {remote}'). {remote} is replaced by remote_path" },
      timeout: { type: "number", description: "Timeout in seconds (default: 300)" },
    },
    required: ["session_id", "remote_path", "local_path"],
  }),
};
```

**依赖：**
- `serialStore`（`./sessions.js`）
- `zmodemSend` / `zmodemReceive`（`../../../services/zmodem/index.js`）
- `formatTransferSummary`（`../../../shared/transfer-result.js`）
- `logger`、`text`、`fromJsonSchema`（已有）

### 模块 D：`src/mcp/tools/serial/index.ts`（注册，修改）

**职责：** 把两个新工具注册进 `mcpSerialTools` 数组。

**改动：**

```ts
import {
  // ... 现有 8 个 ...
  serialUploadConfig, serialUploadHandler,
  serialDownloadConfig, serialDownloadHandler,
} from "./transfer.js";

export const mcpSerialTools: ToolEntry[] = [
  // ... 现有 8 项 ...
  mcpDefineTool("serial_upload", serialUploadConfig, serialUploadHandler),
  mcpDefineTool("serial_download", serialDownloadConfig, serialDownloadHandler),
];
```

server.ts **无需改动**——`server.ts:41-43` 的循环已覆盖 `mcpSerialTools` 全部条目。

### 模块 E：`src/shared/transfer-result.ts`（共享摘要，新建）

**职责：** 提取 SSH 通道的 `TransferResult` 接口和三个 format 函数，供串口通道复用。满足 spec N2。

**内容（从 ssh.ts / sftp.ts 原样迁移）：**

```ts
export interface TransferResult { /* 见「核心数据结构」 */ }

export function formatBytes(bytes: number): string { /* 从 sftp.ts:24-37 原样移入 */ }
export function formatRate(bytesPerSec: number): string { /* 从 sftp.ts:40-54 原样移入 */ }
export function formatTransferSummary(result: TransferResult): string { /* 从 sftp.ts:57-87 原样移入 */ }
```

**迁移影响：**
- `src/transports/ssh.ts`：删除本地 `TransferResult` 定义，改为 `import { TransferResult } from "../shared/transfer-result.js"`；`export type { TransferResult }` 保持 re-export（避免破坏现有 import）
- `src/mcp/tools/ssh/sftp.ts`：删除本地 `formatBytes`/`formatRate`/`formatTransferSummary`，改为从 shared import

迁移为**纯移动**，函数实现一字不改，仅改变定义位置。

## 模块交互

### 调用链：serial_upload 完整流程

```
serialUploadHandler(args)
  │
  ├─ serialStore.getOrNotFound(session_id)                          [sessions.ts]
  │     └─ shell: SerialShell
  │
  ├─ fs.stat(local_path) → size                                    [node:fs]
  │
  ├─ shell.write(recv_cmd, 1)                                       [base-shell.ts]
  │     └─ rawWrite → #serialPort.write(string)                    [serial.ts]
  │        （设备 rz 启动，进入 ZMODEM 接收等待，回发 ZRINIT）
  │
  ├─ await zmodemSend(shell, local_path, remoteName, {onProgress, signal})
  │     │                                                          [zmodem-bridge.ts]
  │     ├─ detach = shell.attachRawReceiver(buf =>                  [serial.ts] ★模块A
  │     │     session.consume(Array.from(buf))                      [zmodem.js]
  │     │   )
  │     ├─ session.set_sender(octets =>                            [zmodem.js]
  │     │     shell.writeBuffer(Buffer.from(octets))                [serial.ts] ★模块A
  │     │   )
  │     ├─ 流式读本地文件 → sender.send(chunk) × N → sender.end()
  │     │     每次 send 后 onProgress({bytes, total})
  │     ├─ await session_end
  │     └─ detach()                                                 [serial.ts]
  │
  ├─ shell.read(1)                                                  [base-shell.ts]
  │     （收 shell 提示符，确认会话活着 —— 满足 AC3）
  │
  └─ return formatTransferSummary(result)                           [transfer-result.ts]
```

**字节流向（上传）：**
```
本地文件 → fs stream → sender.send → [zmodem.js 编码 ZDATA 帧]
  → set_sender 回调 → shell.writeBuffer → SerialPort.write(Buffer) → 串口 → 设备 rz

设备 rz 回执(ZRINIT/ZACK/ZEOF) → 串口 → SerialPort 'data' 事件
  → attachRawReceiver 回调 → session.consume → [zmodem.js 解析]
  （同时 data 也进 OutputBuffer，但此时无人读，互不干扰）
```

### 调用链：serial_download 完整流程

```
serialDownloadHandler(args)
  │
  ├─ serialStore.getOrNotFound(session_id) → shell
  ├─ sendCmd = (args.send_cmd ?? "sz {remote}").replace("{remote}", remote_path)
  ├─ shell.write(sendCmd, 1)        （设备 sz 启动，发 ZFILE offer + 文件数据）
  ├─ await zmodemReceive(shell, local_path, {onProgress, signal})
  │     ├─ detach = shell.attachRawReceiver(...)
  │     ├─ session.set_sender(...)
  │     ├─ session.on("offer", xfr => { writeStream=createWriteStream; xfr.accept() })
  │     ├─ session.on("data", bytes => writeStream.write(Buffer.from(bytes)); onProgress)
  │     ├─ session.on("session_end", () => { writeStream.end(); resolve })
  │     ├─ await session_end
  │     └─ detach()
  ├─ shell.read(1)
  └─ return formatTransferSummary(result)
```

### 与现有串口工具的隔离

```
serial_open ─┐
serial_exec ─┤  这些工具只用 write(string) / read()，
serial_read ─┤  不碰 writeBuffer / attachRawReceiver
serial_write ┘  → 字节旁路对它们完全透明，行为不变（满足 AC8 / N1）
```

## 文件组织

```
src/
├── shared/
│   └── transfer-result.ts                  [新建] TransferResult + format 三件套
├── services/
│   └── zmodem/
│       ├── index.ts                        [新建] re-export zmodemSend/zmodemReceive/类型
│       └── zmodem-bridge.ts                [新建] 协议层，封装 zmodem.js
├── transports/
│   ├── serial.ts                           [修改] 字节旁路 writeBuffer/attachRawReceiver
│   └── ssh.ts                              [修改] TransferResult 改 re-import
└── mcp/
    └── tools/
        ├── serial/
        │   ├── index.ts                    [修改] mcpSerialTools 追加 2 项
        │   └── transfer.ts                 [新建] serial_upload/download config+handler
        └── ssh/
            └── sftp.ts                     [修改] format 函数改 re-import

README.md                                    [修改] 工具表追加 2 行
package.json                                 [修改] 新增 zmodem.js 依赖
```

新建 4 个文件，修改 5 个文件。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 字节旁路做在哪层 | `SerialShell` 内部（不下沉到 `BaseShell`） | `#serialPort` 是 SerialShell 私有字段；SSH/ADB/PS 通道无需二进制旁路（SSH 走 SFTP，ADB/PS 是子进程）。下沉基类会污染不需要的通道 |
| 字节旁路与 OutputBuffer 的关系 | **双写并存**（rawReceiver + appendData 同时喂） | 替换式会破坏 `serial_read` 在 ZMODEM 期间的可观测性；双写让两者互不干扰，卸载后行为与改动前一致（N1 保证） |
| ZMODEM 协议实现 | 用现成库 `zmodem.js`，不自研 | ZMODEM 状态机（ZFILE/ZDATA/ZEOF/ZFINI + CRC16/32 + 流控）复杂且有坑；`zmodem.js@0.1.10` 是纯 JS 实现、Apache-2.0、被 xterm.js 等项目验证过，自研性价比极低 |
| 触发设备 rz/sz 的方式 | 工具内通过 `shell.write(cmd)` 自动触发 | ZMODEM 要求接收端先启动；自动触发让 AI 一步完成，无需手动两步操作。命令可覆盖（F5）适配不同设备 |
| 执行模型 | 阻塞式 tool call（对齐 serial_exec） | 用户决策；异步+status 工具会增加 3-4 个工具和状态管理复杂度，YAGNI。阻塞式简单且与现有风格一致 |
| 进度反馈通道 | logger（stderr），非返回值 | 阻塞式调用中途无法返回；logger 是项目现有进度输出手段；节流避免刷屏（N3） |
| 超时机制 | `AbortController` + `setTimeout` | `AbortSignal` 是标准中止模式，可透传到协议层调 `session.abort()`，让设备端也干净退出。比手动 flag 更可靠 |
| TransferResult 放哪 | 提取到 `src/shared/transfer-result.ts` | SSH 和串口两个通道共用同一摘要格式（N2）；提取避免重复，且让摘要风格跨通道统一。纯移动不改逻辑 |
| 文件读写方式 | 流式（fs.createReadStream / createWriteStream） | 10MB+ 文件不能全读进内存；流式分块对齐库的 MAX_CHUNK_LENGTH(8192)，内存占用恒定 |
| 分块大小 | ≤ 8192 字节 | zmodem.js 源码 `MAX_CHUNK_LENGTH=8192`（`zsession.js:38`），lrzsz 允许 8KiB 子包；超过会被库拒绝 |
| 下载失败时本地文件 | unlink 清理半写文件 | 对齐 ssh downloadFile 的做法（`ssh.ts:303-308`），避免残留损坏文件误导用户 |
| zmodem.js 导入路径 | 实现期首要验证项 | 该包 `index.js` 导出的是面向终端的 `zsentry`；底层 `Session.Send/Receive` 需确认导入方式（`.Session` 命名空间或子模块直引）。列为 T1 验证点 |
| 是否做单元测试 | 协议层桥接做轻量单测 | zmodemSend/zmodemReceive 依赖真实串口难全自动测，但 offer 参数构造、占位符替换、节流逻辑等纯函数部分可测 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本仓库 `.editorconfig` 已声明 UTF-8 / LF，修改时按原样写回即可

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前调用该技能，并严格遵守上述文件编码规则。
