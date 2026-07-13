# 会话存储统一 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。本章核心约束是**零功能回归**——所有工具的对外行为、日志、session ID 必须与重构前逐字一致。

## 实现完整性

- [ ] `ShellSessionStore` 泛型类已创建，以 `BaseShell` 为类型约束（验证：`out/mcp/sessions/session-store.js` 存在；源码含 `<T extends BaseShell>`）。

- [ ] `sessions/index.ts` 已创建，导出 `ShellSessionStore` 并 re-export `registry`/`SessionType`/`SessionMeta`（验证：`out/mcp/sessions/index.js` 存在）。

- [ ] 四个通道各有 `sessions.ts`，导出 store 实例和 disposeAll 包装函数（验证：`ssh/sessions.ts`、`serial/sessions.ts`、`adb/sessions.ts`、`win/sessions.ts` 均存在）。

## 零回归验证（核心）

### 编译与类型

- [ ] `npm run build` 编译通过，无 TypeScript 错误（验证：build 退出码 0）。

- [ ] 四个 shell.ts/powershell.ts 中不再有模块级 `new Map<string` 的 sessions 声明（验证：`grep -rn "new Map<string.*Shell" src/mcp/tools/` 无命中，或仅在 serial/shell.ts 中命中 portToSession——这是允许的例外）。

- [ ] build.ts / sftp.ts 不再 `import { sessions }`（验证：`grep -rn "import { sessions }" src/mcp/tools/` 无命中）。

- [ ] 四个通道文件不再直接 `import { registry }`（验证：`grep -rn "sessions/registry" src/mcp/tools/` 无命中——registry 调用已收敛到 store 内部）。

### session ID 格式保持

- [ ] SSH 生成的 session ID 为 `ssh_<数字>`（验证：open 后返回 `ssh_1` 格式）。

- [ ] Serial 生成的 session ID 为 `serial_<数字>`（验证：open 后返回 `serial_1` 格式）。

- [ ] ADB 生成的 session ID 为 `adb_<数字>`（验证：open 后返回 `adb_1` 格式）。

- [ ] PowerShell 生成的 session ID 为 `power_<数字>`（验证：open 后返回 `power_1` 格式）。

### 日志前缀保持

- [ ] SSH 工具日志前缀为 `[ssh_shell_close]` / `[ssh_shell_write]` / `[ssh_shell_read]` / `[ssh_shell_exec]`（验证：执行工具后检查 `.embedded/log` 下的日志文件）。

- [ ] Serial 工具日志前缀为 `[serial_close]` / `[serial_write]` / `[serial_read]` / `[serial_exec]`。

- [ ] ADB 工具日志前缀为 `[adb_shell_close]` / `[adb_shell_write]` / `[adb_shell_read]` / `[adb_shell_exec]`。

- [ ] PowerShell 工具日志前缀为 `[power_shell_close]` / `[power_shell_write]` / `[power_shell_read]` / `[power_shell_exec]`。

- [ ] dispose 日志前缀为 `[ssh_dispose]` / `[serial_dispose]` / `[adb_dispose]` / `[power_dispose]`（验证：进程退出清理时检查日志）。

### disposeAll 函数保持

- [ ] `disposeAllSshSessions` / `disposeAllSerialSessions` / `disposeAllAdbShellSessions` / `disposeAllPowerShellSessions` 四个函数仍以同名导出（验证：grep `export async function disposeAll` 命中四个 sessions.ts）。

- [ ] `server.ts` 的 cleanup 钩子代码无改动（验证：`git diff src/mcp/server.ts` 为空）。

### 工具集保持

- [ ] SSH 注册的工具集含 open/close/write/read/exec/connection/login/build/sftp_upload/sftp_download（验证：通过 MCP inspector 或 `/mcp list` 确认工具数与重构前一致）。

- [ ] Serial 注册的工具集含 open/close/write/read/exec/login/enter_uboot。

- [ ] ADB 注册的工具集含 device_list/exec/open/close/write/read/exec（注：ADB 有两个 exec——`adb_exec` 一次性 + `adb_shell_exec` 会话内）。

- [ ] PowerShell 注册的工具集含 open/close/write/read/exec + port_scan/network_scan/subnet_check。

### 端到端零回归（逐通道）

> PowerShell 可本地自测；其余通道若有设备则测，否则以编译+静态检查为兜底。

- [ ] **PowerShell 全流程**：`power_shell_open → power_shell_write("echo HI") → power_shell_read → power_shell_exec("Get-Date") → power_shell_close`，每步返回与重构前一致（验证：输出含 HI、返回日期、close 返回 closed）。

- [ ] **PowerShell not-found**：`power_shell_close` 传入不存在的 session_id，返回 `Session xxx not found.`（验证：文案逐字一致）。

- [ ] **PowerShell exec 兜底**：`power_shell_exec` 的输出为空时返回 `(no output)`（验证：文案逐字一致）。

- [ ] **ADB 全流程**（若有设备）：`adb_shell_open → adb_shell_exec("getprop ro.product.model") → adb_shell_close`，输出正确。

- [ ] **SSH 全流程**（若有设备）：`ssh_shell_open → ssh_shell_exec("uname -a") → ssh_shell_close`，输出正确。

- [ ] **Serial 全流程**（若有设备）：`serial_open → serial_exec("uname -a") → serial_close`，输出正确。

### 通道特有工具

- [ ] **SSH SFTP**：`ssh_sftp_upload` 上传文件成功，`ssh_sftp_download` 下载文件成功（验证：通过 sshStore 查询 shell，文件传输正常）。

- [ ] **SSH build**：`ssh_build` 工具能正常查询 session 并执行构建命令（验证：通过 sshStore 查询 shell）。

- [ ] **SSH login**（若有设备）：`ssh_shell_login` 正常工作，解锁成功/失败分支的 session 注册与清理正确（验证：通过 sshStore 创建/移除会话）。

- [ ] **Serial login**（若有设备）：`serial_shell_login` 正常工作，复用已有 session 和新建 session 两条路径的会话管理通过 serialStore + portToSession 正确。

- [ ] **Serial enter_uboot**（若有设备）：`serial_enter_uboot` 正常工作，session 管理通过 serialStore。

- [ ] **Serial portToSession 防重**：对已打开的 COM 口再次 `serial_open`，返回 `Serial port xxx is already open as session serial_N.`（验证：文案和行为与重构前一致）。

- [ ] **ADB device_list**：`adb_device_list` 正常返回设备列表（不依赖 session）。

## 集成

- [ ] MCP server 启动正常，工具全部注册（验证：server 启动无报错，`/mcp list` 显示 connected）。

- [ ] 进程退出清理正常：打开 PowerShell 会话后关闭 server，`tasklist | findstr powershell.exe` 无残留（验证：cleanup 钩子通过 disposeAll 包装函数正常工作）。

## 编译与测试

- [ ] 项目编译无错误（验证：`npm run build` 退出码 0）。

- [ ] 代码符合 plan.md 中声明的语言规范技能要求（验证：按 `ts-lang-spec` 检查命名/风格/注释）。

- [ ] 文件编码未被破坏：新建文件为 UTF-8 无 BOM / LF，修改的已有文件保持原编码不变（验证：用编码检测工具核对，无乱码）。

## 端到端场景

- [ ] **场景 1（PowerShell 全流程 + 日志验证）**：配置 `LOG_SAVE=1`，执行 `power_shell_open → power_shell_exec("$PSVersionTable.PSVersion") → power_shell_close`，检查日志文件含 `[power_shell_open]`、`[power_shell_exec]`、`[power_shell_close]` 三条前缀正确的日志。

- [ ] **场景 2（not-found 一致性）**：对四个通道分别传入不存在的 session_id 调 close，均返回 `Session xxx not found.`（验证：文案逐字一致，证明 getOrNotFound 封装正确）。

- [ ] **场景 3（进程退出清理）**：打开一个 PowerShell 会话，直接关闭 MCP server（模拟客户端断开），观察 cleanup 日志含 `[power_dispose] session power_1 closed`，且无残留进程。

- [ ] **场景 4（Serial 防重保护）**（若有 COM 口设备）：`serial_open` 打开某 COM 口后，再次 `serial_open` 同一 COM 口，返回 already open 提示；`serial_close` 关闭后可重新打开。
