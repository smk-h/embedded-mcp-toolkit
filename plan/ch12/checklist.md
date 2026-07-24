# 串口 ZMODEM 文件传输 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为而非实现细节。代码重构但行为不变时，checklist 依然适用。

## 实现完整性

- [ ] **[F1] serial_upload 工具已注册且可被调用**（验证：启动 MCP server，工具列表中出现 `serial_upload`，schema 含 session_id/local_path 必填项及 remote_name/remote_dir/recv_cmd/timeout 选填项）
- [ ] **[F2] serial_download 工具已注册且可被调用**（验证：工具列表中出现 `serial_download`，schema 含 session_id/remote_path/local_path 必填项及 send_cmd/timeout 选填项）
- [ ] **[F3] 字节旁路通路存在且默认不启用**（验证：读 `src/transports/serial.ts`，存在 `writeBuffer(buf: Buffer)` 和 `attachRawReceiver(cb)` 方法；`#rawReceiver` 默认为 null，data 监听在 null 时只走 `appendData` 原路径）
- [ ] **[F4] 超时参数生效**（验证：传 `timeout=2` 上传大文件，2 秒内返回失败结果；不传 timeout 时默认 300 秒生效）
- [ ] **[F5] 设备端命令可覆盖**（验证：传 `recv_cmd="rz -e"` 调用 serial_upload，串口日志/设备端确认执行的是 `rz -e` 而非默认 `rz`）

## 二进制传输正确性

- [ ] **[AC1] 上传二进制文件两端字节一致**（验证：构造覆盖 `0x00~0xFF` 全字节范围的 1KB 测试文件，serial_upload 上传后设备端 `md5sum <远端路径>` 与本地 `md5sum <本地路径>` 输出完全一致）
- [ ] **[AC2] 下载二进制文件两端字节一致**（验证：serial_download 拉取设备 `/bin/sh`，本地 `md5sum` 与设备端 `md5sum /bin/sh` 一致）
- [ ] **[AC1 进阶] 含 0x00/0xFF 的文件不被污染**（验证：单独构造一个含大量 `0x00` 和 `0xFF` 字节的文件，上传 + 下载往返后本地 md5 与原文件一致——证明字节旁路真正绕过了文本态 toString 编码）

## 会话连续性

- [ ] **[AC3] 传输全程不释放串口，会话保持可用**（验证：记录传输前的 session_id，serial_upload/serial_download 完成后，用**同一 session_id** 调 `serial_exec "echo ok"` 正常返回 `ok`；全程日志中无串口 close/reopen 记录）
- [ ] **[AC5] 超时中止后会话仍可用**（验证：serial_upload 传 `timeout=2` 上传大文件触发超时中止，2 秒返回失败 + 已传字节数 > 0；随后同 session 调 `serial_exec "echo alive"` 正常返回）

## 进度与摘要

- [ ] **[AC4] 大文件进度反馈**（验证：上传 5MB 文件，stderr 出现多次进度日志含已传字节数；最终返回摘要含 bytes≈5MB、durationMs>0、rate 与波特率量级匹配，如 115200 下约 1~2 KB/s）
- [ ] **[AC4 进阶] 进度日志不刷屏**（验证：长传输（如 30 秒以上）期间，logger 进度输出被节流，每秒不超过 1 条，无刷屏现象）
- [ ] **[AC10] 传输摘要格式与 SFTP 一致**（验证：对比 serial_upload 与 ssh_sftp_upload 的返回文本结构，均含 `Upload succeeded/failed`、`local:`、`remote:`、`size:`、`time:`、`rate:` 字段或等价多行信息）

## 兼容性（不破坏现有功能）

- [ ] **[AC8/N1] 现有串口工具行为不变**（验证：对照 `src/transports/serial.ts` 和 `src/mcp/tools/serial/shell.ts` 的 git diff，确认 8 个现有工具的 handler 逻辑未被改动；依次调用 serial_open → serial_exec → serial_read → serial_send_ctrl → serial_close，行为与改动前一致）
- [ ] **[N1] 字节旁路未挂载时 data 监听路径不变**（验证：读 `serial.ts` data 监听代码，`#rawReceiver` 为 null 时仅执行 `appendData(data.toString())`，与改动前逐字一致；无额外分支或副作用）
- [ ] **[N1] 其他通道不受影响**（验证：对照 git diff，SSH/ADB/PowerShell 通道文件无功能性改动，仅 ssh.ts/sftp.ts 因 TransferResult 提取改变了 import 路径——运行 ssh_sftp_upload 确认功能正常）
- [ ] **[N2] TransferResult 提取后 SSH 功能不回归**（验证：`ssh_sftp_upload` 上传一个文件，返回摘要格式与改动前一致；`npm run build` 无类型错误）

## 失败场景可诊断

- [ ] **[AC9a] 本地文件不存在**（验证：serial_upload 传一个不存在的 local_path，返回明确的错误信息，含文件路径，不崩溃不挂起）
- [ ] **[AC9b] 设备端命令无响应**（验证：serial_upload 传一个设备上不存在的命令如 `recv_cmd="rz_nonexistent"`，或设备未装 lrzsz 时 rz 不存在，超时后返回失败并说明超时/无响应）
- [ ] **[AC9c] 下载时远端文件不存在**（验证：serial_download 传一个设备上不存在的 remote_path，设备 sz 报错或无 ZFILE offer，工具超时/失败返回明确原因；不残留半写本地文件）

## 默认行为

- [ ] **[AC7] 默认命令下正常工作**（验证：不传 recv_cmd 调 serial_upload，设备端执行默认 `rz`，传输成功；不传 send_cmd 调 serial_download，设备端执行默认 `sz <remote_path>`，传输成功）
- [ ] **[AC6] 占位符替换正确**（验证：serial_download 传 `send_cmd="sz -e {remote}"` 且 `remote_path="/tmp/foo.bin"`，设备端实际执行 `sz -e /tmp/foo.bin`，`{remote}` 被正确替换）

## 编译与测试

- [ ] **项目编译无错误**（验证：`npm run build` 通过，tsc 无报错无警告）
- [ ] **lint 检查通过**（验证：`npm run lint` 或项目等价命令通过；代码符合 ts-lang-spec 的命名/风格/注释规范）
- [ ] **类型安全**（验证：build 过程中无 `any` 滥用、无 `@ts-ignore`；TransferResult/zmodemSend/zmodemReceive 等接口类型完整传递）
- [ ] **代码符合语言规范技能要求**（验证：人工检查新建文件的命名约定、JSDoc 注释风格、import 顺序是否与项目现有代码一致，如 `serial.ts`/`sftp.ts` 的风格）
- [ ] **文件编码未被破坏**（验证：新建文件 `src/shared/transfer-result.ts`、`src/services/zmodem/*.ts`、`src/mcp/tools/serial/transfer.ts` 均为 UTF-8 无 BOM、LF 换行；修改的 ssh.ts/sftp.ts/serial.ts/index.ts/README.md/package.json 保持原编码原样写回，用编码检测工具核对无乱码）
- [ ] **zmodem.js 依赖正确安装**（验证：`package.json` 含 `"zmodem.js": "^0.1.10"`；`npm ls zmodem.js` 能解析到版本；`package-lock.json` 已更新）

## 隔离与清理

- [ ] **attachRawReceiver 在传输结束后必被卸载**（验证：读 `zmodem-bridge.ts`，`detach()` 在 finally 块中调用，无论传输成功/失败/超时都会执行；传输后 `shell.#rawReceiver` 恢复 null）
- [ ] **超时 timer 必被清理**（验证：读 transfer.ts，`clearTimeout(timer)` 在 zmodemSend/Receive 返回后（无论结果）执行，无 timer 泄漏）
- [ ] **下载失败时清理半写文件**（验证：serial_download 失败后，本地 local_path 不存在残留的半写文件；读 bridge 确认 catch 中调了 unlink）

## 端到端场景

- [ ] **场景 1：完整上传工作流**（验证：`serial_open` 建会话 → `serial_upload` 上传 1MB 二进制固件 → 设备端 `md5sum` 确认 → 同会话 `serial_exec "ls -la <远端文件>"` 确认文件存在且大小正确 → `serial_close`。全程一个 session_id，无重连）
- [ ] **场景 2：完整下载工作流**（验证：`serial_open` → 设备端准备日志文件 → `serial_download` 拉取到本地 → 本地 `md5sum` 与设备端一致 → 同会话继续 `serial_exec` 正常 → `serial_close`）
- [ ] **场景 3：上传后立即可用**（验证：`serial_upload` 上传一个脚本文件到设备 → 传输完成 → 同会话 `serial_exec "chmod +x <文件> && ./<文件>"` 能执行——证明传输后 shell 会话状态完好，文件可立即使用）
- [ ] **场景 4：中断恢复**（验证：`serial_upload` 传 `timeout=2` 上传大文件触发超时 → 返回失败 + 已传字节 → 同会话立即再发 `serial_exec "echo recovered"` 正常 → 证明超时中止不会损坏会话，可继续操作或重试传输）
- [ ] **场景 5：连续多次传输**（验证：同一会话上连续 `serial_upload` 三个不同文件，每次都成功且 md5 一致，会话全程不断——证明字节旁路的挂载/卸载可反复进行，无状态残留）
