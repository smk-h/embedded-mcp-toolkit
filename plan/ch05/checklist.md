# Transport 层抽象重构 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。本章核心约束是**零功能回归**（除 F5 的 ADB/PowerShell FileLogger 补挂外）。

## 实现完整性

- [ ] `BaseShell` 抽象基类已创建，统一持有 `OutputBuffer` 和 `FileLogger`，实现 `open/write/read/drain/close` 模板方法（验证：`out/transports/base-shell.js` 存在；grep 确认五个方法在基类中实现）。

- [ ] `BaseShell` 定义了三个受保护抽象方法 `acquire/rawWrite/release` 及抽象属性 `bannerWaitMs`（验证：源码 `src/transports/base-shell.ts` 含 `abstract` 关键字）。

- [ ] `InteractiveShell` 接口已补全为含 `open/write(三参)/read/drain/close` 五个方法，并迁到独立文件（验证：`src/transports/interactive-shell.ts` 存在；`src/transports/loop.ts` 改为 `import type`）。

- [ ] 四个传输类均 `extends BaseShell`（验证：grep `extends BaseShell` 命中 4 处：ssh.ts / serial.ts / adb.ts / powershell.ts）。

- [ ] 四个传输类不再各自实例化 `OutputBuffer`（验证：grep `new OutputBuffer` 在 `src/transports/` 下仅命中 `base-shell.ts` 一处）。

- [ ] 四个传输类不再各自实例化 `FileLogger`（验证：grep `new FileLogger` 在 `src/transports/` 下仅命中 `base-shell.ts` 一处）。

- [ ] 子类的 data 监听回调统一调用 `this.appendData(text)`（验证：grep `appendData` 在四个子类中各命中 data 监听处）。

## 零回归验证（核心）

### 编译与类型

- [ ] `npm run build` 编译通过，无 TypeScript 错误（验证：build 命令退出码 0）。

- [ ] 四个传输类显式 `implements InteractiveShell` 或通过继承 BaseShell 满足接口，类型检查通过（验证：编译无 `TS2420/TS2714` 等接口实现错误）。

### banner 采集时长保持

- [ ] SSH/Serial 的 `bannerWaitMs = 500`（验证：grep `bannerWaitMs = 500` 命中 ssh.ts、serial.ts）。

- [ ] ADB/PowerShell 的 `bannerWaitMs = 800`（验证：grep `bannerWaitMs = 800` 命中 adb.ts、powershell.ts）。

### 异常行为保持

- [ ] 未打开的 shell 调用 write 仍抛出与现状一致的错误（验证：检查 SSHShell 的 rawWrite 含 `throw new Error("Shell not open. Call open() first.")`；SerialShell 含 `"Serial not open..."`；AdbShell 含 `"ADB shell not open..."`；PowerShellShell 含 `"PowerShell shell not open..."`）。

### 端到端零回归（逐通道）

> 以下场景需连接真实设备或 Mock。若环境受限，至少执行 PowerShell 通道（本地可测）和 ADB 通道（若有连机设备）；SSH/Serial 若无法连设备，以编译+日志对比为兜底。

- [ ] **PowerShell 通道**：通过 MCP 工具执行 `power_shell_open → power_shell_exec("Get-Date") → power_shell_read → power_shell_close`，输出与重构前一致（验证：返回合法日期字符串，无异常；session 列表正确增减）。

- [ ] **ADB 通道**（若有设备）：通过 MCP 工具执行 `adb_shell_open → adb_shell_exec("getprop ro.product.model") → adb_shell_close`，输出与重构前一致。

- [ ] **SSH 通道**（若有设备）：通过 MCP 工具执行 `ssh_shell_open → ssh_shell_exec("uname -a") → ssh_shell_read → ssh_shell_close`，输出与重构前一致（验证：对比 `.embedded/log` 下重构前后同设备的会话日志，banner 和命令输出逐字一致）。

- [ ] **Serial 通道**（若有设备）：通过 MCP 工具执行 `serial_open → serial_exec("uname -a") → serial_close`，输出与重构前一致。

- [ ] **PSH 登录**（若有设备）：执行 `ssh_shell_login` / `serial_shell_login`，PSH 状态机驱动解锁流程与重构前一致（验证：解锁成功、challenge code 正确显示、session 正常建立）。

- [ ] **SSH SFTP**：执行 `ssh_sftp_upload` / `ssh_sftp_download`，文件传输成功（验证：上传后远端文件存在且大小一致；下载后本地文件存在）。

### close 释放顺序保持

- [ ] SSH close 顺序仍为 SFTP → stream → client（验证：检查 SSHShell.release 的释放顺序）。

- [ ] Serial close 仍含 2s 超时 + destroy 兜底（验证：检查 SerialShell.release 含 `setTimeout(2000)` 和 `port.destroy()`）。

- [ ] ADB/PowerShell close 仍含 exit + 3s kill 兜底（验证：检查 release 含 `stdin.write("exit")` 和 `setTimeout(3000)` / `proc.kill()`）。

### FileLogger 行为

- [ ] SSH/Serial 的文件日志行为不变（验证：配置 `SAVE2FILE_PATH` 后，会话日志文件正常生成；不配置时不生成）。

- [ ] **F5 行为增量**：配置 `SAVE2FILE_PATH` 后，ADB/PowerShell 会话建立时生成 `<sessionId>_<时间戳>.log` 日志文件，含 banner 原始数据（验证：open 后检查 `SAVE2FILE_PATH` 目录下有 `adb_1_*.log` / `power_1_*.log`）。

- [ ] **F5 无副作用**：不配置 `SAVE2FILE_PATH` 时，ADB/PowerShell 会话正常工作，不生成日志文件、无报错（验证：grep 日志无 `[file-logger]` 输出）。

### demo 命令可用

- [ ] `embedded-mcp-toolkit demo ssh interact` 命令可正常启动交互终端（验证：命令启动后显示 banner 和 prompt，输入命令有响应，Ctrl+C 正常退出）。

- [ ] `embedded-mcp-toolkit demo serial interact` 命令同上。

### 工具层零改动验证

- [ ] `tools/ssh/shell.ts`、`tools/serial/shell.ts` 中对 shell 方法的调用代码无改动（验证：`git diff` 这两个文件无业务逻辑变更）。

- [ ] `tools/adb/shell.ts`、`tools/win/powershell.ts` 仅新增 `enableFromEnv` 一行，其余调用代码无改动（验证：`git diff` 仅命中新增行）。

## 集成

- [ ] MCP server 启动正常，18 个工具全部注册（验证：通过 `/mcp list` 或 inspector 看到 `embedded-board` connected，工具数与重构前一致）。

- [ ] 会话 disposeAll 在进程退出时正常清理四个通道（验证：server.ts 的 cleanupAllSessions 仍调用四个 disposeAll 函数；关闭 server 后无残留进程/端口占用）。

## 端到端场景

- [ ] **场景 1（PowerShell 全流程）**：配置 `SAVE2FILE_PATH=./.embedded/log`，启动 MCP server，调用 `power_shell_open` → `power_shell_exec("$PSVersionTable.PSVersion")` → `power_shell_close`，观察返回的 PowerShell 版本号正确，且 `.embedded/log` 下生成了 `power_1_*.log` 日志文件。

- [ ] **场景 2（未配置 SAVE2FILE_PATH）**：不配置 `SAVE2FILE_PATH`，重复场景 1 的流程，功能正常且不生成额外日志文件（验证 F5 无副作用）。

- [ ] **场景 3（异常处理）**：调用 `power_shell_write` 传入一个不存在的 session_id，返回 `Session xxx not found.`（验证：错误处理与重构前一致）。

- [ ] **场景 4（进程退出清理）**：打开一个 PowerShell 会话后，直接关闭 MCP server 进程（模拟客户端断开），观察 `tasklist | findstr powershell.exe` 无残留进程（验证：cleanup 机制未被破坏）。
