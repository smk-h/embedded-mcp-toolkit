# SSH 文件传输工具（SFTP）Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/transports/ssh.ts` | SSHShell 新增 #sftp 字段、#ensureSftp、uploadFile、downloadFile，扩展 close |
| 新建 | `src/mcp/tools/ssh/sftp.ts` | ssh_sftp_upload / ssh_sftp_download 配置 + handler + formatTransferSummary |
| 修改 | `src/mcp/tools/ssh/index.ts` | import 新工具，mcpSshTools 追加 2 项 |

---

## T1: 扩展 SSHShell 的 import 与 TransferResult 类型

**文件：** `src/transports/ssh.ts`
**依赖：** 无
**步骤：**
1. 在第 1 行 import 中追加 `SFTPWrapper` 类型：`import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";`
2. 在文件顶部 import 区（约第 9 行 FileLogger import 之后）新增：`import { stat } from "node:fs/promises";`
3. 在 `SSHShellConfig` interface（约第 22-30 行）之后、`SSHShell` class 之前，新增 `TransferResult` interface（字段：direction, localPath, remotePath, bytes, durationMs, success, error?）并附 JSDoc

**验证：** `npm run build` 编译通过（此时仅新增类型，未使用，不报错）

---

## T2: SSHShell 新增 SFTP 懒加载能力

**文件：** `src/transports/ssh.ts`
**依赖：** T1
**步骤：**
1. 在 SSHShell 类私有字段区（`#stream` 之后，约第 41-42 行）新增：`#sftp: SFTPWrapper | null = null;`，附 JSDoc 说明懒加载
2. 新增私有方法 `async #ensureSftp(): Promise<SFTPWrapper>`：
   - 若 `this.#sftp` 非空，直接返回
   - 若 `this.#client` 为空，`throw new Error("SSH connection not open.")`
   - 用 Promise 包装 `this.#client.sftp((err, sftp) => {...})`：err 非空则 reject，否则 `this.#sftp = sftp` 并 resolve
   - 附 JSDoc

**验证：** `npm run build` 编译通过（#ensureSftp 未被调用，编译器不报未使用错误因为是私有方法且后续 T3 会用）

---

## T3: SSHShell 新增 uploadFile / downloadFile

**文件：** `src/transports/ssh.ts`
**依赖：** T2
**步骤：**
1. 新增 `async uploadFile(localPath: string, remotePath: string): Promise<TransferResult>`，放在 `close()` 方法之前：
   - `const start = Date.now();`
   - `let bytes: number;` try 中 `const st = await stat(localPath); bytes = st.size;`，catch 返回失败 result（error 含路径与原因）
   - `const sftp = await this.#ensureSftp();`
   - Promise 包装 `sftp.fastPut(localPath, remotePath, (err) => {...})`：err 非空返回失败 result，否则返回成功 result
   - 失败时不让异常逃逸（catch 住，返回 success:false 的 result），保证 handler 层不抛异常（N5）
2. 新增 `async downloadFile(remotePath: string, localPath: string): Promise<TransferResult>`，对称实现：
   - `const start = Date.now();`
   - `const sftp = await this.#ensureSftp();`
   - `let bytes: number;` try 中 `const st = await sftp.stat(remotePath); bytes = st.size;`，catch 返回失败 result
   - Promise 包装 `sftp.fastGet(remotePath, localPath, (err) => {...})`
   - 同样 catch 所有异常返回 success:false
   - 失败时清理半成品本地文件（try unlink localPath，忽略错误）
3. 两个方法的 TransferResult 字段：direction="upload"/"download"，localPath/remotePath 原样回填，durationMs=`Date.now()-start`，bytes 失败时填 0

**验证：** `npm run build` 编译通过

---

## T4: SSHShell.close 扩展释放 SFTP 资源

**文件：** `src/transports/ssh.ts`
**依赖：** T2
**步骤：**
1. 在 `close()` 方法（约第 186-197 行）的 `this.fileLogger.disable();` 之后、关闭 `#stream` 之前，新增：
   ```
   if (this.#sftp) {
     this.#sftp.end();
     this.#sftp = null;
   }
   ```
   附注释说明释放 SFTP 子系统

**验证：** `npm run build` 编译通过；代码审查 close 顺序：sftp → stream → client → output reset

---

## T5: 新建 sftp.ts 工具文件

**文件：** `src/mcp/tools/ssh/sftp.ts`（新建）
**依赖：** T1（TransferResult 类型）
**步骤：**
1. 顶部 import：
   - `{ fromJsonSchema } from "@modelcontextprotocol/server";`
   - `{ text } from "../../tool-registry.js";`
   - `{ logger } from "../../../shared/logger.js";`
   - `{ sessions } from "./shell.js";`
   - `{ type TransferResult } from "../../../transports/ssh.js";`
2. 新增辅助函数 `formatBytes(bytes: number): string` — 将字节数格式化为 "104857600 bytes (100.00 MB)"，支持 KB/MB/GB，<1KB 显示原始字节
3. 新增辅助函数 `formatRate(bytesPerSec: number): string` — 格式化速率为 "31.25 MB/s" 等
4. 新增 `formatTransferSummary(result: TransferResult): string` — 按 plan.md 的摘要模板格式化（Upload/Download succeeded/failed、local/remote/size/time/rate 五行或失败四行）
5. 新增 `sshSftpUploadConfig`（description + inputSchema: session_id/local_path/remote_path，均 required）+ `sshSftpUploadHandler(args)`（logger.info → sessions.get → 不存在返回 not found 文本 → shell.uploadFile → formatTransferSummary → text 返回）
6. 新增 `sshSftpDownloadConfig` + `sshSftpDownloadHandler`，对称实现（remote_path/local_path 顺序，调 downloadFile）
7. 所有 config/handler 附 JSDoc，风格对照 `shell.ts` 中 sshShellWriteConfig/Handler

**验证：** `npm run build` 编译通过（此时未注册，不报错）

---

## T6: 在 index.ts 注册新工具

**文件：** `src/mcp/tools/ssh/index.ts`
**依赖：** T5
**步骤：**
1. 在 import 区（约第 21 行 `from "./build.js";` 之后）新增：`import { sshSftpUploadConfig, sshSftpUploadHandler, sshSftpDownloadConfig, sshSftpDownloadHandler } from "./sftp.js";`
2. 在 `mcpSshTools` 数组末尾（`ssh_build` 项之后，约第 41 行）追加两项：
   ```
   mcpDefineTool("ssh_sftp_upload", sshSftpUploadConfig, sshSftpUploadHandler),
   mcpDefineTool("ssh_sftp_download", sshSftpDownloadConfig, sshSftpDownloadHandler),
   ```

**验证：** `npm run build` 编译通过；启动 MCP server 不报错

---

## T7: 回归与端到端验证

**文件：** 无（运行验证）
**依赖：** T6
**步骤：**
1. `npm run build` 完整编译，确认无 TS 错误、无未使用 import 警告
2. 启动 MCP server（`node ./bin/embedded-mcp-toolkit-cli.js` 或对应启动方式），确认不报错退出、工具列表包含新增两项
3. （如有可用板卡）端到端：ssh_shell_login 打开会话 → ssh_shell_exec 验证 shell 正常 → ssh_sftp_upload 上传一个测试文件 → ssh_shell_exec 在远端 `ls -l` 确认字节数一致 → ssh_sftp_download 下载回本地另一路径 → 对比本地源文件与下载文件字节数一致 → ssh_shell_close 关闭
4. 回归：确认 ssh_shell_open/close/write/read/exec/login 七个旧工具仍可正常编译与调用（AC7）

**验证：** 编译通过；MCP server 正常启动；端到端（若板卡可用）字节数一致

---

## 执行顺序

```
T1 ──→ T2 ──→ T3 ──┐
        ↘          ├──→ (T4 可与 T3 并行) ──→ T5 ──→ T6 ──→ T7
         T4 ───────┘
```

- T1→T2→T3 串行（类型→字段→方法，层层依赖）
- T4 仅依赖 T2（#sftp 字段），可与 T3 并行
- T5 依赖 T1（TransferResult 类型）
- T6 依赖 T5（工具导出符号）
- T7 依赖 T6（全部注册完成）
