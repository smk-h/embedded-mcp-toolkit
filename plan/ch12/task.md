# 串口 ZMODEM 文件传输 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/shared/transfer-result.ts` | `TransferResult` 接口 + `formatBytes`/`formatRate`/`formatTransferSummary` |
| 修改 | `src/transports/ssh.ts` | 删除本地 `TransferResult`，改为从 shared re-import 并 re-export |
| 修改 | `src/mcp/tools/ssh/sftp.ts` | 删除本地三个 format 函数，改为从 shared re-import |
| 修改 | `src/transports/serial.ts` | 新增 `#rawReceiver` 字段、`writeBuffer`、`attachRawReceiver`，改造 data 监听为双写，release 卸载 |
| 新建 | `src/services/zmodem/zmodem-bridge.ts` | `zmodemSend` / `zmodemReceive`，封装 zmodem.js，桥接串口字节旁路 |
| 新建 | `src/services/zmodem/index.ts` | re-export 桥接函数与类型 |
| 新建 | `src/mcp/tools/serial/transfer.ts` | `serial_upload` / `serial_download` 的 config + handler |
| 修改 | `src/mcp/tools/serial/index.ts` | `mcpSerialTools` 数组追加 2 项 |
| 修改 | `package.json` | 新增 `zmodem.js` 依赖 |
| 修改 | `README.md` | 工具表追加 `serial_upload` / `serial_download` 两行 |

## T1: 验证 zmodem.js 导入路径与核心 API

**文件：** 无（探查验证，不落代码）
**依赖：** 无
**说明：** zmodem.js 的 `index.js` 导出的是面向终端场景的 `zsentry`，本方案需用底层 `Zmodem.Session.Send/Receive`。这是实现期的首要风险点，必须先确认导入方式，否则后续模块 B 的所有代码都建立在不确定的 API 上。

**步骤：**
1. 确认依赖已装：`package.json` 检查是否有 `zmodem.js`；若无则 `npm install zmodem.js@^0.1.10`
2. 写一个临时探查脚本（不入库），尝试三种导入方式，打印拿到的对象结构：
   - `import Zmodem from "zmodem.js"` → 检查 `Zmodem.Session`、`Zmodem.Session.Send`、`Zmodem.Session.Receive`、`Zmodem.Validation` 是否存在
   - `import { Session } from "zmodem.js"` → 检查是否可直接解构
   - `require("zmodem.js")` → 检查 CommonJS 形态（该包是 CJS，ESM 项目需确认 interop）
3. 确认 `Zmodem.Validation.offer_parameters({name, size, mtime})` 可调用且返回归一化对象（含 `serial:null`）
4. 确认 `Zmodem.Session.Send` 是 class（`new Zmodem.Session.Send(zrinitHdr)` 抛 "Need first header!" 证明构造需 ZRINIT 首帧）
5. 记录最终采用的导入语句，供 T5 使用
6. 删除临时探查脚本

**验证：** 探查脚本能打印出 `Session.Send`、`Session.Receive`、`Validation.offer_parameters` 均为 function/class；确定的导入语句记录在案。若三种导入都拿不到底层 Session，则需回退评估（可能要直接 require 子路径如 `zmodem.js/src/zsession`）。

## T2: 提取共享 TransferResult（模块 E）

**文件：** `src/shared/transfer-result.ts`（新建）、`src/transports/ssh.ts`（修改）、`src/mcp/tools/ssh/sftp.ts`（修改）
**依赖：** 无
**说明：** 纯移动，不改任何函数逻辑。先做这步是因为后续 T5（协议层）和 T7（工具层）都要 import `TransferResult`，需先就位。

**步骤：**
1. 新建 `src/shared/transfer-result.ts`
2. 将 `src/transports/ssh.ts:45-53` 的 `TransferResult` 接口（含注释）原样移入新文件并 `export`
3. 将 `src/mcp/tools/ssh/sftp.ts:24-87` 的 `formatBytes`、`formatRate`、`formatTransferSummary` 三个函数（含注释）原样移入新文件并 `export`
4. 在 `src/transports/ssh.ts` 顶部新增 `import { TransferResult } from "../shared/transfer-result.js"`，删除本地接口定义，保留 `export type { TransferResult } from "../shared/transfer-result.js"`（re-export，避免破坏现有 `import { type TransferResult } from ".../ssh.js"` 的调用方）
5. 在 `src/mcp/tools/ssh/sftp.ts` 顶部新增 `import { formatBytes, formatRate, formatTransferSummary } from "../../../shared/transfer-result.js"`，删除本地三个函数定义
6. 检查 sftp.ts 中 `TransferResult` 的 import 路径：原来从 `../../../transports/ssh.js` 引，现在 ssh.ts 已 re-export，路径可不改；或直接改从 shared 引（推荐，更清晰）

**验证：** `npm run build` 编译通过，无类型错误；`ssh_sftp_upload` / `ssh_sftp_download` 的返回文本格式与改动前一致（人工对比或读代码确认逻辑未变）。

## T3: 传输层字节旁路（模块 A）

**文件：** `src/transports/serial.ts`（修改）
**依赖：** 无（与 T2 可并行）

**步骤：**
1. 在 `SerialShell` 类中新增私有字段：`#rawReceiver: ((b: Buffer) => void) | null = null;`（紧邻 `#config` 声明处）
2. 新增 public 方法 `writeBuffer(buf: Buffer): void`：
   - 校验 `this.#serialPort?.isOpen`，未打开抛 `"Serial not open. Call open() first."`
   - 调 `this.#serialPort.write(buf)`
3. 新增 public 方法 `attachRawReceiver(cb: ((b: Buffer) => void) | null): () => void`：
   - 赋值 `this.#rawReceiver = cb`
   - 返回卸载函数：`() => { if (this.#rawReceiver === cb) this.#rawReceiver = null; }`
4. 改造 `acquire()` 中 `serial.ts:111-113` 的 data 监听为双写：
   ```ts
   serialPort.on("data", (data: Buffer) => {
     if (this.#rawReceiver) this.#rawReceiver(data);
     this.appendData(data.toString());
   });
   ```
5. 在 `release()` 开头新增 `this.#rawReceiver = null;`（卸载回调，防止野指针）

**验证：**
- `npm run build` 编译通过
- 代码审查确认：`#rawReceiver` 默认 null 时，data 监听与改动前**逐字一致**（只多一个 null 判断，走原 `appendData` 路径）
- `writeBuffer` 与现有 `rawWrite`/`sendRaw`/`write` 互不干扰，现有串口工具不受影响

## T4: zmodem 依赖与目录骨架

**文件：** `package.json`（修改）、`src/services/zmodem/index.ts`（新建）
**依赖：** T1（确认导入路径）

**步骤：**
1. `npm install zmodem.js@^0.1.10`，确认写入 `package.json` dependencies 和 `package-lock.json`
2. 新建 `src/services/zmodem/index.ts`，先放占位 re-export：
   ```ts
   export { zmodemSend, zmodemReceive } from "./zmodem-bridge.js";
   export type { ZmodemProgress, ZmodemTransferOptions } from "./zmodem-bridge.js";
   ```
   （此时 `zmodem-bridge.ts` 尚未创建，编译会报错，T5 完成后修复——或本任务先注释掉，T5 再启用）

**验证：** `package.json` 含 `zmodem.js` 条目；`npm ls zmodem.js` 能解析到版本。

## T5: 协议层 zmodem-bridge（模块 B）

**文件：** `src/services/zmodem/zmodem-bridge.ts`（新建）
**依赖：** T1（导入路径）、T2（TransferResult）、T3（writeBuffer/attachRawReceiver）、T4（依赖装好）

**步骤：**
1. 文件顶部按 T1 确认的方式 import zmodem.js，拿到 `Session`/`Validation` 命名空间
2. 定义并 export 类型 `ZmodemProgress`（`{ bytes: number; total?: number }`）和 `ZmodemTransferOptions`（`{ onProgress?: ...; signal?: AbortSignal }`）
3. 实现 `zmodemSend(shell, localPath, remoteName, opts?)`：
   - `const start = Date.now()`
   - `const st = await stat(localPath)`，失败返回 `success:false` 的 TransferResult（对齐 ssh uploadFile）
   - `const offer = Validation.offer_parameters({ name: remoteName, size: st.size, mtime: st.mtimeMs })`
   - 建库的 Send 会话（用 offer；按 T1 探明的 API，可能需先 `Zmodem.Session.parse` 或直接传 offer 建链——以库文档/实测为准）
   - `session.set_sender(octets => shell.writeBuffer(Buffer.from(octets)))`
   - `const detach = shell.attachRawReceiver(buf => session.consume(Array.from(buf)))`
   - 用 `fs.createReadStream(localPath, { highWaterMark: 8192 })` 流式读，每个 chunk 调 `sender.send(chunk)`，累计 bytes，触发 `opts.onProgress({ bytes, total: st.size })`
   - 流结束调 `sender.end()`
   - `await` session_end 事件（`session.on("session_end", resolve)` 包成 Promise）
   - `try/catch`：错误时 `session.abort()` + 返回 `success:false`；`finally: detach()`
   - 监听 `opts.signal`：若 `aborted` 则 `session.abort()`
4. 实现 `zmodemReceive(shell, localPath, opts?)`：
   - `const start = Date.now()`
   - `const detach = shell.attachRawReceiver(buf => 喂入 session 或预缓冲)`
   - 首批字节用 `Zmodem.Session.parse` 判断建 Receive 会话
   - `session.set_sender(octets => shell.writeBuffer(Buffer.from(octets)))`
   - `session.on("offer", xfr => { const details = xfr.get_details(); writeStream = createWriteStream(localPath); xfr.accept() })`
   - `session.on("data", bytes => { writeStream.write(Buffer.from(bytes)); 累计; onProgress({bytes, total: details.size}) })`
   - `session.on("session_end", () => { writeStream.end(); resolve() })`
   - `await` 结束，返回 `success:true` TransferResult（bytes=累计, direction:"download"）
   - `try/catch`：错误时 `session.abort()` + `await unlink(localPath)` 清理半写文件 + 返回 `success:false`；`finally: detach()`
   - 监听 `opts.signal`：aborted 则 abort
5. 两个函数都返回 `Promise<TransferResult>`

**验证：**
- `npm run build` 编译通过
- 代码审查：`attachRawReceiver` 与 `writeBuffer` 配对使用，`detach()` 在 finally 必被调用（无论成功失败）
- `signal.aborted` 检查路径覆盖（传输中、传输前）
- 真机冒烟（手动，非自动化）：设备跑 `rz`，调 `zmodemSend` 传一个 1KB 文本文件，设备端 `md5sum` 比对一致（验证 AC1 的最小用例）

## T6: 工具层 transfer handler（模块 C）

**文件：** `src/mcp/tools/serial/transfer.ts`（新建）
**依赖：** T2（formatTransferSummary）、T5（zmodemSend/zmodemReceive）

**步骤：**
1. 文件顶部 import：`fromJsonSchema`、`text`、`logger`、`serialStore`（`./sessions.js`）、`zmodemSend`/`zmodemReceive`（`../../../services/zmodem/index.js`）、`formatTransferSummary`（`../../../shared/transfer-result.js`）、`stat`（`fs/promises`）、`basename`（`path`）
2. 定义 `serialUploadConfig`（description + inputSchema，字段：session_id 必填、local_path 必填、remote_name 选填、remote_dir 选填、recv_cmd 选填、timeout 选填）
3. 实现 `serialUploadHandler`：
   - `logger.info` 记录入参
   - `serialStore.getOrNotFound(session_id)`，未命中返回 not-found 响应
   - `await stat(local_path)`，失败返回错误文本
   - `remoteName = args.remote_name ?? basename(local_path)`
   - `recvCmd = args.recv_cmd ?? "rz"`
   - `shell.write(recvCmd, 1)` 触发设备 rz
   - `await sleep(300)` 让设备进 ZMODEM 等待态
   - `const controller = new AbortController()`
   - `const timer = setTimeout(() => controller.abort(), (args.timeout ?? 300) * 1000)`
   - 节流变量 `let lastLog = 0`
   - `const result = await zmodemSend(shell, local_path, remoteName, { onProgress: 节流 1s 一条 logger, signal: controller.signal })`
   - `clearTimeout(timer)`
   - `const trailer = shell.read(1)`
   - `logger.info` 记录结果
   - 返回 `formatTransferSummary(result)` + 可选 trailer
4. 定义 `serialDownloadConfig`（字段：session_id 必填、remote_path 必填、local_path 必填、send_cmd 选填、timeout 选填）
5. 实现 `serialDownloadHandler`：
   - 结构对称
   - `sendCmd = (args.send_cmd ?? "sz {remote}").replace("{remote}", args.remote_path)`
   - `shell.write(sendCmd, 1)`
   - `await zmodemReceive(shell, local_path, { onProgress, signal })`
   - 其余同 upload

**验证：**
- `npm run build` 编译通过
- 代码审查：超时 timer 必在 zmodemSend/Receive 返回后（无论成功失败）clearTimeout；AbortController.signal 正确透传

## T7: 注册新工具（模块 D）

**文件：** `src/mcp/tools/serial/index.ts`（修改）
**依赖：** T6

**步骤：**
1. 在 import 块新增：
   ```ts
   import {
     serialUploadConfig, serialUploadHandler,
     serialDownloadConfig, serialDownloadHandler,
   } from "./transfer.js";
   ```
2. 在 `mcpSerialTools` 数组末尾追加：
   ```ts
   mcpDefineTool("serial_upload", serialUploadConfig, serialUploadHandler),
   mcpDefineTool("serial_download", serialDownloadConfig, serialDownloadHandler),
   ```

**验证：**
- `npm run build` 编译通过
- 启动 MCP server，确认 `serial_upload` / `serial_download` 出现在工具列表中（`mcpSerialTools` 长度为 10）
- server.ts 无需改动（循环已覆盖）

## T8: README 文档更新

**文件：** `README.md`（修改）
**依赖：** T7

**步骤：**
1. 在 README 的串口工具表中追加两行：`serial_upload` / `serial_download`
2. 描述要点：基于 ZMODEM、需设备端 lrzsz、复用已开串口会话、阻塞式、支持超时
3. 在「前提/限制」相关位置补充说明：串口传 10MB @ 115200 约需 16 分钟（物理瓶颈）；设备需安装 lrzsz

**验证：** 阅读 README 工具表，两行条目清晰、参数说明准确。

## T9: 集成验证（真机）

**文件：** 无（运行验证）
**依赖：** T7、T8

**说明：** 这是端到端验证，覆盖 spec 的 AC1~AC10。需真机 + 串口 + 设备端 lrzsz。无法全自动化的项标注手动。

**步骤：**
1. **编译检查**：`npm run build` 通过
2. **lint 检查**：`npm run lint`（或项目等价命令）通过，代码符合 ts-lang-spec
3. **现有工具不受影响（AC8）**：`serial_open` → `serial_exec "uname -a"` → `serial_close`，行为正常
4. **上传二进制完整性（AC1）**：构造 1KB 全字节范围文件，`serial_upload` 上传，设备端 `md5sum` 与本地一致
5. **下载二进制完整性（AC2）**：`serial_download` 拉取设备 `/bin/sh`，本地 `md5sum` 与设备端一致
6. **会话不断（AC3）**：传输前后用同一 session_id 调 `serial_exec "echo ok"`，正常返回
7. **大文件进度（AC4）**：上传 5MB 文件，观察 logger 进度输出，摘要含合理 bytes/durationMs/rate
8. **超时中止（AC5）**：`serial_upload` 传 `timeout=2` 传 5MB，2 秒返回失败 + 已传字节；随后同 session 调 `serial_exec` 正常
9. **命令覆盖（AC6）**：`serial_upload` 传 `recv_cmd="rz -e"`，传输成功
10. **默认命令（AC7）**：不传命令参数，两个工具均正常
11. **失败诊断（AC9）**：构造本地文件不存在、设备无 rz（或传错命令）两种场景，返回明确错误
12. **摘要格式一致（AC10）**：对比 `serial_upload` 与 `ssh_sftp_upload` 返回文本结构一致

**验证：** 上述 12 项全部通过（或手动确认）；不通过的记录现象并修复后重跑。

## 执行顺序

```
T1（验证导入）─→ T4（装依赖+骨架）
                     │
T2（TransferResult）─┼─→ T5（协议层 bridge）─→ T6（工具层 handler）─→ T7（注册）─→ T8（README）─→ T9（集成验证）
                     │        ↑                    ↑
T3（字节旁路）───────┘────────┴────────────────────┘
```

**并行机会：**
- T2 与 T3 互不依赖，可并行
- T2、T3 完成后，T4/T5 串行（T5 依赖 T1+T2+T3+T4）

**关键路径：** T1 → T4 → T5 → T6 → T7 → T8 → T9

**风险卡点：** T1 是首要风险——若 zmodem.js 三种导入都拿不到底层 Session.Send/Receive，需回退评估（直接 require 子模块路径 `zmodem.js/src/zsession.js`，或换库）。T1 卡住则 T4/T5 无法推进。
