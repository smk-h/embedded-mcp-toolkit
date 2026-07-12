# SSH 文件传输工具（SFTP）Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] `SSHShell.uploadFile(localPath, remotePath)` 方法存在且可被调用（验证：`npm run build` 编译通过）
- [ ] `SSHShell.downloadFile(remotePath, localPath)` 方法存在且可被调用（验证：`npm run build` 编译通过）
- [ ] `SSHShell` 的 `#sftp` 字段懒加载：纯 shell 操作不触发 SFTP 建立（验证：ssh_shell_open 后只做 exec，连接正常，无 sftp 相关日志/开销）
- [ ] `TransferResult` 类型已导出，含 direction/localPath/remotePath/bytes/durationMs/success/error? 字段（验证：编译通过 + grep 导出符号）
- [ ] `ssh_sftp_upload` 工具配置存在，inputSchema 含 session_id/local_path/remote_path 三个 required 字段（验证：MCP 客户端列出工具定义）
- [ ] `ssh_sftp_download` 工具配置存在，inputSchema 含 session_id/remote_path/local_path 三个 required 字段（验证：MCP 客户端列出工具定义）

## 功能行为（需可用 SSH 设备）

- [ ] AC1 上传：ssh_shell_login 打开会话后，调用 ssh_sftp_upload 上传一个本地文件，远端目标路径出现该文件，远端 `ls -l` 显示的字节数与本地源文件一致（验证：上传后用 ssh_shell_exec 执行 `wc -c /远端路径` 对比）
- [ ] AC2 下载：ssh_sftp_download 下载远端文件到本地，本地目标文件存在且字节数与远端源一致（验证：本地 `stat` 对比远端 `wc -c`）
- [ ] AC3 会话不存在：传入未注册的 session_id（如 `ssh_999`），工具返回文本 "Session ssh_999 not found."，不抛异常（验证：观察 MCP 客户端返回内容，无 error envelope）
- [ ] AC5 摘要完整：传输成功后返回文本含「传输方向、源路径、目标路径、字节数、耗时(ms)、平均速率」六项（验证：人眼检查返回文本）
- [ ] AC6 源不存在：上传不存在的本地路径，返回含路径与失败原因的错误文本，远端无半成品文件；下载不存在的远端路径，返回错误文本，本地无半成品文件（验证：观察返回文本 + 检查目标路径无残留）

## SFTP 与 shell 共存（AC9）

- [ ] 同一会话顺序操作：ssh_shell_exec 执行命令 → ssh_sftp_upload 上传 → ssh_shell_exec 再次执行命令，三次均成功（验证：三次返回均正常，证明 SFTP 与 shell 通道在同连接共存）

## 回归（AC7）

- [ ] 现有 ssh_shell_open / close / write / read / exec / login 七个工具编译通过（验证：`npm run build`）
- [ ] ssh_build 工具编译通过（验证：`npm run build`）
- [ ] 一次 shell 往返正常：ssh_shell_login → ssh_shell_exec("uname -a") → 返回内核信息（验证：观察返回文本含 Linux 内核版本字符串）

## 资源释放（AC10）

- [ ] ssh_shell_close 关闭会话后，该会话的 SSHShell 实例的 SFTP 资源被释放（验证：代码审查 close 顺序含 `#sftp?.end()`；行为上——close 后再调 ssh_sftp_upload 应返回 not found 或连接已关闭错误）

## 大文件流式（AC8）

- [ ] 上传/下载一个约 50–100MB 文件时，MCP server 进程内存占用无显著峰值上涨（验证：传输期间观察 node 进程 RSS，对比传输前后基线，涨幅应在数十 MB 以内而非文件大小量级）

## 集成

- [ ] `mcpSshTools` 数组含全部 10 项（8 旧 + 2 新）（验证：grep index.ts 数组项数 / 编译期类型检查）
- [ ] MCP server 启动后，工具列表同时包含新旧工具（验证：启动 server 不报错，客户端 tools/list 返回 10 个 ssh_* 工具）

## 编译与测试

- [ ] `npm run build` 编译无错误
- [ ] 无未使用的 import / 变量（验证：tsc 严格模式无警告）
- [ ] 代码符合 plan.md 中声明的 `ts-lang-spec` 要求（验证：lint 通过或人工检查 JSDoc/命名/import 后缀）
- [ ] 文件编码未被破坏：新建文件 `sftp.ts` 为 UTF-8 无 BOM、LF（验证：编码检测工具核对）；修改的 `ssh.ts`/`index.ts` 保持原 UTF-8/LF 不变（验证：git diff 无编码变更迹象，文件无乱码）

## 端到端场景

- [ ] 场景 1（上传成果物）：本地构建出 `rootfs.img`（约几十 MB）→ ssh_shell_login board-ubuntu 打开会话 → ssh_sftp_upload 上传到 `/tmp/rootfs.img` → ssh_shell_exec `ls -l /tmp/rootfs.img` 确认字节数一致 → ssh_shell_close → 预期：全程成功，摘要显示字节数/耗时/速率
- [ ] 场景 2（下载产物）：板卡上有 `/var/log/syslog` → ssh_shell_login 打开会话 → ssh_sftp_download 下载到本地 `./syslog.bak` → 本地 `stat` 确认字节数 → ssh_shell_close → 预期：本地文件与远端字节数一致
- [ ] 场景 3（错误处理）：ssh_sftp_download 下载一个不存在的远端路径 `/no/such/file` → 预期：返回 "Download failed" 文本含路径与 "No such file" 原因，本地不产生残留文件
