# SSH 文件传输工具（SFTP）Plan

## 架构概览

本次在现有 SSH 工具链上**追加**文件传输能力，分两层改动，不改动配置与会话注册体系：

1. **传输层扩展（`src/transports/ssh.ts`）** — 给 `SSHShell` 类增加 SFTP 子系统的懒加载访问与单文件上传/下载能力。SFTP 会话复用 `SSHShell` 内部已有的 ssh2 `Client`（同一连接上同时承载 shell 通道与 sftp 子系统），按需建立、随连接关闭释放。新增逻辑全部封装在传输层，ssh2 的回调式 API 不泄漏到工具层。

2. **工具层新增（`src/mcp/tools/ssh/sftp.ts`）** — 定义两个 MCP 工具 `ssh_sftp_upload`、`ssh_sftp_download`，做「会话查找 → 调传输层 → 格式化摘要文本」的薄封装，与 `shell.ts` 中现有工具的 handler 风格一致；在 `ssh/index.ts` 的 `mcpSshTools` 数组中追加两项完成注册。

```
┌─────────────────────────────────────────────────────────┐
│  MCP 客户端 (Claude Code / OpenCode)                    │
└──────────────┬──────────────────────────────────────────┘
               │ JSON-RPC
┌──────────────▼──────────────────────────────────────────┐
│  McpServer.registerTool(...)  ← server.ts               │
│    mcpSshTools[]  ← ssh/index.ts (追加 2 项)             │
│      ├ ssh_sftp_upload   ─┐                              │
│      └ ssh_sftp_download ─┴→ sftp.ts (handler)          │
└──────────────┬──────────────────────────────────────────┘
               │ sessions.get(session_id)
┌──────────────▼──────────────────────────────────────────┐
│  SSHShell (transports/ssh.ts)                           │
│    #client: ssh2 Client (复用, 已有)                     │
│    #stream: shell 通道 (复用, 已有)                      │
│    #sftp: SFTPWrapper (新增, 懒加载)                     │
│    uploadFile()/downloadFile() (新增)                    │
└─────────────────────────────────────────────────────────┘
```

> 本方案如何满足 spec 的 F 需求：F1/F2 由两个 MCP 工具覆盖；F3 由「会话查找」覆盖；F4 由 `TransferResult` + 摘要格式化覆盖；F5 由 `SSHShell` 的 SFTP 扩展覆盖。

## 核心数据结构

### `TransferResult`（新增，定义在 `transports/ssh.ts`）

单次文件传输的结果，由传输层方法返回、工具层格式化为文本。

```ts
/** @brief 文件传输结果摘要 */
export interface TransferResult {
  /** 传输方向："upload" 本地→远端，"download" 远端→本地 */
  direction: "upload" | "download";
  /** 本地文件路径 */
  localPath: string;
  /** 远端文件路径 */
  remotePath: string;
  /** 传输字节数（源文件大小） */
  bytes: number;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 是否成功 */
  success: boolean;
  /** 失败时的错误信息（成功时为 undefined） */
  error?: string;
}
```

### SFTP 字段（`SSHShell` 内部新增，私有）

```ts
// SSHShell 类新增私有字段
#sftp: SFTPWrapper | null = null;  // 懒加载的 SFTP 会话
```

## 模块设计

### `SSHShell`（修改 `src/transports/ssh.ts`）

**职责：** 在原有 shell 通道基础上，追加 SFTP 子系统的懒加载访问与单文件上传/下载。

**新增内部方法（私有）：**

- `async #ensureSftp(): Promise<SFTPWrapper>` — 懒加载 SFTP 会话。若 `#sftp` 已存在直接返回；否则校验 `#client` 非空后调用 `client.sftp((err, sftp) => ...)` 建立 SFTP 子系统并缓存。报错（如远端不支持 SFTP）以 reject 上抛。

**新增对外方法：**

- `async uploadFile(localPath: string, remotePath: string): Promise<TransferResult>` — 将本地文件上传到远端。
  1. `#ensureSftp()` 取得 SFTP 会话
  2. `fs.promises.stat(localPath)` 取本地源文件大小（用于摘要，失败则报错）
  3. 记录起始时间，调用 `sftp.fastPut(localPath, remotePath, cb)` 流式上传
  4. 成功返回 `TransferResult { direction:"upload", success:true, bytes, durationMs }`，失败返回 `{ success:false, error }`

- `async downloadFile(remotePath: string, localPath: string): Promise<TransferResult>` — 将远端文件下载到本地。
  1. `#ensureSftp()` 取得 SFTP 会话
  2. `sftp.stat(remotePath)` 取远端源文件大小（用于摘要，失败则报错）
  3. 记录起始时间，调用 `sftp.fastGet(remotePath, localPath, cb)` 流式下载
  4. 成功返回 `TransferResult { direction:"download", success:true, bytes, durationMs }`，失败返回 `{ success:false, error }`

**`close()` 方法扩展（修改）：** 在关闭 shell stream、`client.end()` 之前，先 `#sftp?.end(); #sftp = null;` 释放 SFTP 子系统，再执行原有清理逻辑。保证 SFTP 资源随会话关闭释放（满足 N4/AC10）。

**依赖：** 新增 import `{ SFTPWrapper }` 类型（从 `ssh2`），新增 `import { stat } from "node:fs/promises"`。`Client` import 不变。

**不变项：** `open/write/read/drain/close` 对外签名与行为不变；`#client`/`#stream` 仍私有。SFTP 仅在被 `uploadFile/downloadFile` 触发时才建立，纯 shell 会话零开销。

### `ssh_sftp_upload` / `ssh_sftp_download`（新建 `src/mcp/tools/ssh/sftp.ts`）

**职责：** 两个 MCP 工具的配置与处理函数。薄封装——查找会话、调传输层、格式化摘要文本。

**工具配置（与 `shell.ts` 风格一致）：**

```ts
// ssh_sftp_upload
inputSchema: { session_id: string (必填), local_path: string (必填), remote_path: string (必填) }

// ssh_sftp_download
inputSchema: { session_id: string (必填), remote_path: string (必填), local_path: string (必填) }
```

> 命名遵循现有 `ssh_<subsystem>_<verb>` 规范（如 `ssh_shell_open`、`ssh_build`）。

**处理函数流程（两者对称）：**

1. `logger.info(...)` 记录入参（路径原样打印，不涉及密钥）
2. `sessions.get(args.session_id)` 查找会话；不存在返回 `Session xxx not found.` 文本
3. 调 `shell.uploadFile(...)` / `shell.downloadFile(...)`（传输层捕获所有异常，返回 `TransferResult`，不会 reject）
4. 调 `formatTransferSummary(result)` 格式化为多行文本返回

**摘要格式化函数 `formatTransferSummary(result: TransferResult): string`（定义在 sftp.ts）：**

```
Upload succeeded (ssh_1 → 192.168.16.105)
  local : /home/user/build/rootfs.img
  remote: /tmp/rootfs.img
  size  : 104857600 bytes (100.00 MB)
  time  : 3214 ms
  rate  : 31.25 MB/s
```

- 字节数同时给出原始值与人可读值（KB/MB/GB）
- 速率 = bytes / (durationMs/1000)，格式化为人可读
- 失败时输出 `Upload failed` + error 信息，不含 size/time/rate

**依赖：** import `sessions` from `./shell.js`，`text` from `../../tool-registry.js`，`logger`，`TransferResult` type from `../../../transports/ssh.js`。

### `ssh/index.ts`（修改）

**职责：** 在 `mcpSshTools` 数组末尾追加两项：

```ts
mcpDefineTool("ssh_sftp_upload", sshSftpUploadConfig, sshSftpUploadHandler),
mcpDefineTool("ssh_sftp_download", sshSftpDownloadConfig, sshSftpDownloadHandler),
```

并在顶部 import 中加入 `sftp.ts` 导出的 4 个符号。无需改动 `server.ts`（批注册循环已覆盖）。

## 模块交互

**上传/下载典型调用链：**

```
MCP 客户端
  → McpServer 分发到 ssh_sftp_upload handler (sftp.ts)
    → sessions.get(session_id) (shell.ts 的 Map)
      → SSHShell.uploadFile(localPath, remotePath) (ssh.ts)
        → #ensureSftp() → client.sftp() → SFTPWrapper (ssh2)
        → fs.stat(localPath)
        → sftp.fastPut(local, remote)
        ← TransferResult
      ← TransferResult
    → formatTransferSummary(result) → text
  ← { content: [text] }
```

**会话关闭时的资源释放：**

```
ssh_shell_close handler (shell.ts)
  → SSHShell.close()
    → #sftp?.end(); #sftp = null;   (新增)
    → #stream?.close(); #stream = null;   (已有)
    → #client.end(); #client = null;      (已有)
```

**SFTP 与 shell 通道共存（AC9）：** ssh2 协议允许同一 Client 连接上同时开 shell 通道（`client.shell()`）与 sftp 子系统（`client.sftp()`），二者互不干扰。因此同一 `session_id` 可先执行 `ssh_shell_exec`，再执行 `ssh_sftp_upload`，再执行 `ssh_shell_exec`，三次操作均走同一连接。

## 文件组织

```
src/
├── transports/
│   └── ssh.ts          — 修改：SSHShell 新增 #sftp/#ensureSftp/uploadFile/downloadFile/close 扩展
└── mcp/tools/ssh/
    ├── sftp.ts         — 新建：ssh_sftp_upload / ssh_sftp_download 配置 + handler + formatTransferSummary
    ├── shell.ts        — 不改（仅被 import sessions）
    ├── build.ts        — 不改
    └── index.ts        — 修改：import 新工具 + mcpSshTools 追加 2 项
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| SFTP 连接来源 | 复用 SSHShell 现有 ssh2 Client | ssh2 协议支持单连接多通道（shell + sftp 共存），避免重复 TCP+SSH 握手，满足 F3/N4 |
| SFTP 建立时机 | 懒加载（首次 upload/download 时） | 纯 shell 会话不建 SFTP，零开销；满足 N4 |
| 传输逻辑位置 | 放传输层（SSHShell.uploadFile/downloadFile） | 与 open/write/read 风格一致，ssh2 回调式 API（fastGet/fastPut）封装在 transport，tool 层保持薄封装 |
| 流式传输实现 | ssh2 内置 `fastGet`/`fastPut`（并行读写） | 库已实现流式 + 并行分块，无需自建 ReadStream/WriteStream，满足 N2（不撑内存） |
| 字节数来源 | upload: `fs.stat` 本地源；download: `sftp.stat` 远端源 | 源文件大小即成功传输字节数，无需 step 回调累计 |
| 摘要类型定义位置 | transport 层 `TransferResult` | 元信息由传输层产出，tool 层只负责格式化，职责清晰 |
| 错误处理 | 传输层 try/catch 包裹、返回 `success:false` 的 result | 与现有工具一致（N5），不向 handler 抛异常 |
| 工具命名 | `ssh_sftp_upload` / `ssh_sftp_download` | 遵循 `ssh_<subsystem>_<verb>` 规范（对照 `ssh_shell_open`、`ssh_build`） |

## 编码规范

**编程语言：** TypeScript（ESM，`NodeNext` 模块解析）

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变（`src/transports/ssh.ts` 与 `src/mcp/tools/ssh/index.ts` 均为现有 UTF-8/LF，修改时保持不变）。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前调用该技能，并严格遵守上述文件编码规则。与 `src/transports/ssh.ts`、`src/mcp/tools/ssh/shell.ts` 现有风格保持一致：JSDoc `@brief`/`@param`/`@return` 注释、import 带 `.js` 后缀、`fromJsonSchema` 泛型标注参数类型。
