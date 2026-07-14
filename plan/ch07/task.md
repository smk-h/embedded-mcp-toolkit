# sshd-config 命令 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/commands/sshd-config.ts` | sshd-config 命令全部逻辑：权限检查、平台校验、菜单循环、三个步骤函数、SSH 最小封装、辅助函数 |
| 修改 | `src/cli/index.ts` | 新增 `sshd-config` 顶层命令注册（import + program.command + .action），插入位置在 `split` 命令之后、`demo` 命令之前 |

> 约定：本任务列表中所有 `ssh*` 私有函数（sshConnect/sshExec/sshDownload/sshDisconnect）均基于 `ssh2` 库在 `sshd-config.ts` 内部实现，**不** import `src/transports/ssh.ts`。

## T1: 创建模块骨架与类型定义

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** 无
**步骤：**
1. 新建 `src/cli/commands/sshd-config.ts`，写入文件头 Doxygen 注释（`@file` / `@brief`，参照 `split.ts`）。
2. import 依赖：`child_process` 的 `exec` / `execFileSync`；`fs` 与 `fs/promises` 的 `existsSync` / `mkdirSync` / `readFileSync` / `writeFileSync` / `copyFileSync`；`path` 的 `resolve` / `join` / `dirname`；`os` 的 `homedir` / `platform`；`readline` 的 `createInterface`；`https`；`net`；`{ Client }` from `ssh2`；`{ type ConnectConfig }` from `ssh2`（按需）。
3. 定义并导出接口 `SshdConfigOptions`（本期为空对象，预留扩展）。
4. 定义模块内部接口 `LinuxServerInfo { host: string; port: number; username: string; password: string }`。
5. 定义模块内部接口 `PowerShellResult { success: boolean; exitCode: number; stdout: string; stderr: string }`。
6. 定义菜单常量：`MENU_INSTALL_SSH="1"` / `MENU_GENERATE_KEY="2"` / `MENU_CONFIG_SSHD="3"` / `MENU_CHECK_STATUS="4"` / `MENU_UNINSTALL_SSH="5"` / `MENU_SHOW_INFO="6"` / `MENU_EXIT="0"`。
7. 写入 `runSshdConfig` 主函数的空骨架（`export async function runSshdConfig(opts: SshdConfigOptions): Promise<void> {}`），内部暂只 `// TODO`。

**验证：** `npx tsc --noEmit src/cli/commands/sshd-config.ts` 不报错（或后续 T8 统一编译验证；此处只需文件语法正确、import 可解析）。

## T2: 实现平台校验与管理员权限检查

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T1
**步骤：**
1. 实现 `isWindows(): boolean`，返回 `process.platform === "win32"`。
2. 实现 `checkAdmin(): boolean`：优先用 `execFileSync("net", ["session"], { stdio: "ignore" })`，退出码 0 视为管理员；try/catch 捕获非零退出码，回退执行 PowerShell 脚本（`[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()` 配合 `IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`，stdout 含 `True` 即管理员）；两者皆失败返回 `false`。
3. 实现 `relaunchAsAdmin(): void`：构造 PowerShell 命令 `Start-Process -FilePath '<node.exe>' -ArgumentList '<cli.js>', 'sshd-config' -Verb RunAs`，通过 `execFileSync` 执行（弹 UAC）。成功后本进程 `process.exit(0)`（让位给新窗口）；执行抛错（用户拒绝 UAC 或失败）→ 提示"需要管理员权限才能运行，请在 UAC 弹窗中点击是"并以 `process.exit(1)` 退出。注意：`-FilePath` 用 `process.execPath`（node.exe 全路径），`-ArgumentList` 含 `process.argv[1]`（cli.js 路径）与 `sshd-config` 子命令。
4. 在 `runSshdConfig` 开头加入：先 `if (!isWindows())` → `console.error` 提示"本命令仅支持 Windows"并 `return`；再 `if (!checkAdmin())` → `relaunchAsAdmin()`（自动 UAC 提权重启，本进程退出；提权失败则提示并退出）。

**验证：** 编译通过。在非管理员窗口运行 `node ./bin/embedded-mcp-toolkit-cli.js sshd-config`，应弹出 UAC 确认窗口；点是后新管理员窗口启动（暂无菜单，直接正常退出）；点否后原窗口提示需要管理员权限并以非零码退出。在管理员窗口运行能通过检查进入菜单。

## T3: 实现交互式主菜单循环

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T2
**步骤：**
1. 实现 `prompt(question: string): Promise<string>`：基于 `createInterface` 的单次问答，参照 `init.ts` 的 `prompt` 实现（问完即 `rl.close()`）。
2. 实现 `clearScreen(): void`：向 `process.stdout` 写 ANSI 转义 `\x1Bc`（RIS 全屏复位，清屏+复位光标+清滚动缓冲）；非 TTY 环境（`process.stdout.isTTY` 为 falsy）跳过，避免向管道/重定向输出写入控制字符。
3. 实现 `pauseForMenu(): Promise<boolean>`：提示"\n按 Enter 回到菜单，按 q 退出: "，用 `prompt` 读一行；输入为空（Enter）返回 false；输入 `q`/`Q` 返回 true；其它输入忽略，循环重新提示（不响应、不退出，避免误触）。
4. 实现 `showMenu(): void`：打印菜单文本（[1]-[6] 六项 + [0] 退出）。注意标题（`=== embedded-mcp-toolkit sshd-config ===`）不由 showMenu 打印，而由主循环单独打印，以便清屏后先出标题再出菜单。
5. 在 `runSshdConfig` 中加入 `while (true)` 循环：
   - 循环顶部：`clearScreen()` → 打印标题 → `showMenu()` → `const choice = await prompt("请选择: ")`
   - `choice === MENU_EXIT` → 打印再见并 `return`（直接退出，不经过 pauseForMenu）
   - switch 分发：`MENU_INSTALL_SSH`/`MENU_GENERATE_KEY`/`MENU_CONFIG_SSHD`/`MENU_CHECK_STATUS`/`MENU_UNINSTALL_SSH`/`MENU_SHOW_INFO` → 对应 step（先留空调用）；default → 提示"无效选项"
   - switch 之后：`if (await pauseForMenu()) { 打印再见; return; }`——step 执行完毕后暂停，Enter 回循环顶部（清屏重显菜单），q 退出。

**验证：** 编译通过。运行命令能看到菜单；输入 0 能正常退出；输入 1-6 调用空函数后出现"按 Enter 回到菜单，按 q 退出"提示；按 Enter 后清屏并重新显示菜单（无历史输出残留）；按 q 退出；输入其它字符不响应继续等待。

## T4: 实现辅助函数（命令执行封装 + SSH 最小封装）

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T1
**步骤：**
1. 实现 `runPowerShell(script: string): Promise<PowerShellResult>`：用 `child_process.exec` 执行 `powershell -NoProfile -Command <script>`，封装 stdout/stderr/exitCode，exitCode 0 → success。
2. 实现 `runCmd(cmd: string, args: string[]): Promise<PowerShellResult>`：用 `child_process.execFile` 执行通用命令（用于 msiexec 等），同样封装为 `PowerShellResult`。
3. 实现 `askPassword(prompt: string): Promise<string>`：用 `process.stdin` 的 raw mode 逐字符读取，读到 `\r` / `\n` 结束并恢复终端、输出换行；读取期间不回显明文（可选每字符输出 `*`）。注意用 try/finally 确保 raw mode 被恢复。
4. 实现 `sshConnect(info: LinuxServerInfo): Promise<Client>`：`new Client()`，`await` `ready` 事件，`connect({ host, port, username, password, readyTimeout: 10000 } as ConnectConfig)`；error 事件 reject。
5. 实现 `sshExec(client: Client, command: string): Promise<string>`：`client.exec(command, (err, stream) => {...})`，收集 stream 的 data/stderr 到字符串，close 后 resolve 完整 stdout（trim 尾部空白）。
6. 实现 `sshDownload(client: Client, remotePath: string, localPath: string): Promise<void>`：`client.sftp((err, sftp) => {...})`，`sftp.fastGet(remotePath, localPath, cb)`。
7. 实现 `sshDisconnect(client: Client): void`：`client.end()` + `client.on('close', ...)` 容错。

**验证：** 编译通过。`runPowerShell("Write-Output hello")` 应返回 success=true、stdout="hello"。SSH 函数此处不单独跑（需真实 Linux，留到 T10 端到端验证）。

## T5: 实现 step1 —— 安装 Windows SSH 服务

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T4（用 runPowerShell / runCmd / prompt）
**步骤：**
1. 实现 `step1InstallSsh(): Promise<void>`。
2. 先检测是否已安装：`runPowerShell("Get-Service sshd -ErrorAction SilentlyContinue")`，success 且 stdout 含 sshd 则提示"已安装 OpenSSH Server，跳过"并 return。
3. 检测 Windows Capability 状态：`runPowerShell("Get-WindowsCapability -Online -Name OpenSSH.Server~~~~*")`。若 State 为 Installed 同样提示已安装并 return。
4. 让用户选择安装途径：`const choice = await prompt("选择安装方式 [1]MSI(默认) [2]在线安装: ")`。
5. **MSI 分支（默认，choice 为 "1" 或空或其它非 "2"）**：
   - a. 计算 MSI 缓存路径 `resolve(process.cwd(), ".embedded", "ssh", "OpenSSH-Win64.msi")`。
   - b. `existsSync(msiPath)` 为 true → 打印"已存在 MSI 安装包，跳过下载"并跳到 c；否则 `downloadFile(OPENSSH_MSI_URL, msiPath)`（确保目录存在）。
   - c. `runCmd("msiexec", ["/i", msiPath, "/quiet", "/norestart"])` 静默安装。
6. **在线分支（choice === "2"）**：`runPowerShell("Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0")`。失败时打印 stderr 摘要并 return（不自动回退到 MSI）。
7. **确保 sshd 服务已注册**（关键步骤，解决 MSI 静默安装不注册服务的问题）：
   - a. 实现 `findSshdExe(): string | null`：按候选路径 `["C:\\Program Files\\OpenSSH\\sshd.exe", "C:\\Windows\\System32\\OpenSSH\\sshd.exe"]` 用 `existsSync` 探测，返回首个存在的路径，都不存在返回 null。
   - b. 实现 `ensureSshdService(): Promise<boolean>`：先 `runPowerShell("Get-Service sshd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name")`，`stdout === "sshd"` 视为已注册返回 true；未注册则 `findSshdExe()` 定位 sshd.exe，`runCmd(sshdExe, ["install"])` 注册服务，成功返回 true，失败打印错误返回 false。
   - c. 在 step1 安装后、`Start-Service` 之前调用 `ensureSshdService()`；返回 false 时提示"请手动注册 sshd 服务：`<sshd.exe 路径> install`"并 return。
8. 启动并设自启：`runPowerShell("Start-Service sshd")` + `runPowerShell("Set-Service -Name sshd -StartupType Automatic")`。
9. 每步失败时打印中文错误（含 stderr 摘要）并 return，不抛异常。

**验证：** 编译通过。在已安装 sshd 的机器上运行应提示"已安装"并返回菜单；未安装时能看到安装方式选择提示；MSI 包已存在时跳过下载；MSI 安装后若服务未注册应自动执行 `sshd.exe install` 补注册。（完整安装验证留到 T10。）

## T6: 实现 step2 —— 编译服务器生成密钥对

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T4（用 prompt / askPassword / ssh*）
**步骤：**
1. 实现 `step2GenerateKey(): Promise<void>`。
2. 交互收集 `LinuxServerInfo`：`prompt("编译服务器地址 user@host[:port]: ")` 一次输入紧凑格式地址；用 `parseServerAddress(input)` 拆解为 `{host, port, username}`（无端口默认 22，格式非法提示重试或取消）；`askPassword("登录密码: ")` → password。
3. `const client = await sshConnect(info)`；失败 → 提示"无法连接编译服务器: <err>"并 return。
4. 信息采集（仅展示供核对，不参与后续路径逻辑）：依次 `sshExec(client, "whoami")` → 当前用户名；`sshExec(client, "hostname -I 2>/dev/null || hostname")` → 主机 IP；`sshExec(client, "eval echo ~$USER")` → 家目录绝对路径。打印三项信息（如"当前用户: root / 主机 IP: 1.2.3.4 / 家目录: /root"），格式醒目供用户确认连接目标正确。
5. 检测 sshd：`const st = await sshExec(client, "systemctl status sshd 2>/dev/null || service ssh status 2>/dev/null || echo NO_SSHD")`。若含 `NO_SSHD` → 打印常见发行版安装命令（apt/dnf 两行）+ 提示安装后重试，`sshDisconnect(client)` 后 return。
6. 检测密钥是否已存在：`const ex = await sshExec(client, "test -f ~/.ssh/id_mcp_server && echo EXISTS")`。若含 `EXISTS` → `const overwrite = await prompt("MCP 专用密钥已存在，是否覆盖? (y/N): ")`；非 y 开头 → `sshDisconnect` 并 return。
7. 生成密钥：`await sshExec(client, "ssh-keygen -t rsa -b 4096 -N '' -f ~/.ssh/id_mcp_server")`。
8. 列出密钥目录：`const listing = await sshExec(client, "ls -la ~/.ssh")`，打印 listing 供用户确认密钥已正确生成（应看到 id_mcp_server 与 id_mcp_server.pub）。
9. 展开远端绝对路径（SFTP 不识别 `~`）：`const pubPath = await sshExec(client, "echo ~/.ssh/id_mcp_server.pub")`，trim。
10. 确保本地目录存在：`mkdirSync(resolve(process.cwd(), ".embedded/ssh"), { recursive: true })`。
11. 下载：`await sshDownload(client, pubPath, resolve(process.cwd(), ".embedded/ssh/id_mcp_server.pub"))`。
12. `sshDisconnect(client)`，打印"公钥已保存到 .embedded/ssh/id_mcp_server.pub"。
13. 所有步骤 try/catch，失败打印中文提示并确保 `sshDisconnect` 被调用（finally 块）。

**验证：** 编译通过。（真实 Linux 服务器验证留到 T10 端到端；T10 中应确认看到 whoami/IP/家目录三项信息输出，以及密钥生成后 ~/.ssh 目录列表。）

## T7: 实现 step3 —— 配置 Windows sshd

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T4（用 runPowerShell）
**步骤：**
1. 实现 `step3ConfigSshd(): Promise<void>`。
2. 读取本地公钥：`const pubPath = resolve(process.cwd(), ".embedded/ssh/id_mcp_server.pub")`；`!existsSync(pubPath)` → 提示"未找到公钥，请先执行 [2]"并 return。`const pubKey = readFileSync(pubPath, "utf8").trim()`。
3. 处理 authorized_keys：`const sshDir = resolve(homedir(), ".ssh")`；`!existsSync(sshDir)` → `mkdirSync(sshDir, { recursive: true })`。`const akPath = join(sshDir, "authorized_keys")`。读取已有内容（不存在则空），按行拆分，若已含 `pubKey` 则提示"公钥已存在，跳过"；否则追加 `pubKey + "\n"` 写回。
4. 处理 sshd_config：`const cfgPath = "C:\\ProgramData\\ssh\\sshd_config"`；`!existsSync(cfgPath)` → 提示"未找到 sshd_config，请先执行 [1] 安装 OpenSSH"并 return。
5. 备份：`const bakPath = cfgPath + ".bak"`；`!existsSync(bakPath)` → `copyFileSync(cfgPath, bakPath)`（已有 .bak 不覆盖，保留首次备份）。
6. 读 sshd_config 按行处理（逐行字符串数组）：
   - 遇到非注释的 `^\s*PubkeyAuthentication` → 替换为 `PubkeyAuthentication yes`（若无则末尾追加）。
   - 遇到非注释的 `^\s*AuthorizedKeysFile` → 替换为 `AuthorizedKeysFile .ssh/authorized_keys`（若无则末尾追加）。
   - 进入 `Match Group administrators` 段后，到下一个 `Match ` 或文件末尾之间的每一行前加 `#`（注释掉整段）。
   - 用一个 `inMatchAdmin` 状态标志位逐行扫描。
7. 写回 sshd_config（UTF-8）。
8. 重启 sshd：先 `runPowerShell("Get-Service sshd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name")` 检查服务是否注册（stdout === "sshd" 为已注册）；**未注册** → 跳过重启（不回滚配置），提示用户手动重启或执行 [1] 安装服务；**已注册** → `runPowerShell("Restart-Service sshd -Force")`，失败 → 尝试从备份回滚 sshd_config 并提示。
9. 回显最终关键配置：再读 sshd_config，打印 PubkeyAuthentication / AuthorizedKeysFile / Match Group 段的处理结果。
10. 失败路径用 try/catch 包裹，异常时打印中文提示。

**验证：** 编译通过。在已安装 sshd 且存在公钥的环境运行，应看到 authorized_keys 被写入、sshd_config.bak 生成、sshd 重启成功、关键配置回显。

## T7.5: 实现 step4 —— 检查 sshd 配置状态（只读诊断）

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T4（用 runPowerShell）
**步骤：**
1. 实现 `step4CheckStatus(): Promise<void>`。**纯只读**，不写文件、不重启服务。
2. 新增菜单常量 `MENU_CHECK_STATUS = "4"`，在 `showMenu()` 中增加 `[4] 检查 sshd 配置状态（只读诊断）` 一行。
3. 在 `runSshdConfig` 的菜单 switch 中增加 `case MENU_CHECK_STATUS: await step4CheckStatus(); break;`。
4. **检查项 (a) sshd 服务状态**：`runPowerShell("Get-Service sshd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status,StartType")`。解析 Status（Running/Stopped）与 StartType（Automatic/Manual/Disabled），打印。服务不存在 → ⚠️ 提示未安装，建议执行 [1]。
5. **检查项 (b) sshd_config 关键项**：`existsSync(SSHD_CONFIG_PATH)` 不存在 → ⚠️ 提示未配置；存在则 `readFileSync` 按行匹配：
   - `PubkeyAuthentication` 非注释行值为 yes → ✅，否则 ⚠️。
   - `AuthorizedKeysFile` 非注释行含 `.ssh/authorized_keys` → ✅，否则 ⚠️。
   - 存在非注释的 `Match Group administrators` 行 → ⚠️（分组规则仍激活），否则 ✅（已禁用）。
6. **检查项 (c) authorized_keys 状态**：`const akPath = join(homedir(), ".ssh", "authorized_keys")`。不存在 → ⚠️（0 条）；存在则 `readFileSync`，统计以 `ssh-rsa`/`ssh-ed25519`/`ecdsa-`/`sk-` 开头的行数作为公钥条数，打印条数。
7. **检查项 (d) 本地公钥状态**：`existsSync(resolve(process.cwd(), LOCAL_PUBKEY_REL))` → ✅ 存在 / ⚠️ 不存在（建议执行 [2]）。
8. **汇总结论**：统计 4 项中是否有异常。全部正常 → 打印"✅ 配置就绪，可尝试从 Linux 免密登录"；有异常 → 打印"⚠️ 存在 N 项异常"并列出建议执行的菜单项编号。

**验证：** 编译通过。在管理员窗口运行命令选 [4]，应看到 4 个检查项的状态报告（每项 ✅ 或 ⚠️）和汇总结论。在未配置的环境（如刚装好、未跑 [1][2][3]）应看到多个 ⚠️ 及对应建议。

## T7.6: 实现 OpenSSH 安装方式检测（detectOpenSshInstallMethod）

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T4（用 runPowerShell）
**步骤：**
1. 定义类型 `OpenSshInstallMethod = "msi" | "capability" | "unknown"` 与接口 `OpenSshInstallInfo { method; methodLabel; exePath; detail }`。
2. 定义路径常量 `MSI_SSHD_EXE = "C:\\Program Files\\OpenSSH\\sshd.exe"`、`CAPABILITY_SSHD_EXE = "C:\\Windows\\System32\\OpenSSH\\sshd.exe"`，并让 `SSHD_EXE_CANDIDATES` 复用它们。
3. 实现 `detectOpenSshInstallMethod(): Promise<OpenSshInstallInfo>`，综合三信号交叉判定：
   - 信号 C（先取）：`findSshdExe()` 得到 exePath。
   - 信号 B（最可靠）：若 sshd 服务已注册，读 `Get-CimInstance Win32_Service -Filter "Name='sshd'"` 的 ImagePath。
   - 信号 A：`Get-WindowsCapability ... | Select State`，判断是否 Installed。
   - 判定优先级 B > A > C：B 含 `program files\openssh` → MSI；B 含 `system32\openssh` → Capability；A=Installed 且无 MSI 目录 exe → Capability；C 命中对应路径 → 对应方式兜底；其余 → unknown。

**验证：** 编译通过。在 MSI 安装的环境调用（通过 [4] 或 [5] 间接验证）应返回 method="msi"；Capability 安装的环境应返回 "capability"；未安装应返回 "unknown"。

## T7.7: 在 step4 中展示安装方式诊断

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T7.6
**步骤：**
1. 在 `step4CheckStatus` 的检查项 (a) sshd 服务状态之后，新增 (a.2) 安装方式诊断。
2. 调用 `detectOpenSshInstallMethod()`，打印 `安装方式: <methodLabel>（<detail>）`。

**验证：** 编译通过。运行 [4] 应在服务状态之后看到"安装方式"一行，显示 MSI / Capability / 未知 及判定依据。

## T7.8: 实现 step5 —— 卸载 Windows SSH 服务

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T7.6（用 detectOpenSshInstallMethod）
**步骤：**
1. 新增菜单常量 `MENU_UNINSTALL_SSH = "5"`，在 `showMenu()` 中增加 `[5] 卸载 Windows SSH 服务` 一行（位于 [4] 与 [0] 之间）。
2. 在 `runSshdConfig` 的菜单 switch 中增加 `case MENU_UNINSTALL_SSH: await step5UninstallSsh(); break;`。
3. 实现 `openAppwizAndAwait(): Promise<boolean>`：`runCmd("appwiz.cpl")` 打开"程序和功能"，成功后 `await prompt("卸载完成后按回车继续")` 阻塞等待用户手动卸载；失败时打印错误提示并返回 false。
4. 实现 `step5UninstallSsh(): Promise<void>`：
   - a. 调用 `detectOpenSshInstallMethod()` 检测安装方式。若 `method === "unknown" && exePath === null` → 提示"未检测到 OpenSSH 安装，无需卸载"并 return。
   - b. 打印检测到的安装方式与判定依据。
   - c. 按 method 分流：
     - `capability` → `runPowerShell("Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0")`；失败时调用 `openAppwizAndAwait()` 兜底。
     - `msi` → 本地存在 MSI 包（`resolve(cwd, LOCAL_MSI_REL)`）则 `runCmd("msiexec", ["/x", msiPath, "/quiet", "/norestart"])`；失败或无 MSI 包时调用 `openAppwizAndAwait()` 兜底。
     - `unknown` → 调用 `openAppwizAndAwait()` 让用户手动卸载。
   - d. 清理 sshd 服务残留：`isSshdServiceRegistered()` 为 true 时 `runCmd("sc.exe", ["delete", "sshd"])`，失败提示手动执行。
   - e. 末尾提示 `C:\ProgramData\ssh` 未自动清理，如需彻底清除请手动删除。
5. 每步失败打印中文提示并继续/return，不抛异常。

**验证：** 编译通过。MSI 安装环境运行 [5] 应看到检测到 MSI 方式并执行 msiexec /x；Capability 安装环境应执行 Remove-WindowsCapability；未安装环境应提示"无需卸载"。卸载后 `Get-Service sshd` 查不到服务。

## T7.9: 实现 step6 —— 查看本机连接信息

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T1（import os 的 userInfo/networkInterfaces）
**步骤：**
1. 新增菜单常量 `MENU_SHOW_INFO = "6"`，在 `showMenu()` 中增加 `[6] 查看本机连接信息（用户名/IP）` 一行（位于 [5] 与 [0] 之间）。
2. 在 `runSshdConfig` 的菜单 switch 中增加 `case MENU_SHOW_INFO: await step6ShowConnectionInfo(); break;`。
3. import 补充 `os` 模块的 `userInfo` 和 `networkInterfaces`（`homedir` 已 import，合并到同一行）。
4. 实现 `step6ShowConnectionInfo(): Promise<void>`：
   - a. (a) 用户名：`os.userInfo().username`；若含 `\` 取反斜杠后部分。
   - b. (b) IPv4 枚举：`os.networkInterfaces()` 遍历，跳过 `internal`、`169.254` 开头、网卡名匹配 `/virtual|vmware|hyper-v|vethernet|wsl|docker/i` 的项；打印所有候选 IP。
   - c. (c) 拼接 ssh 命令示例：`ssh -i ~/.ssh/id_mcp_server <user>@<primaryIp>`，多 IP 时取首个并提示换用其它。
   - d. 末尾提示需依次执行 [1]→[2]→[3] 才能免密成功。

**验证：** 编译通过。运行 [6] 应看到 Windows 用户名、至少一个物理网卡 IPv4（虚拟网卡 IP 不出现）、一条可复制的 ssh 命令示例。

## T8: 在 CLI 入口注册命令

**文件：** `src/cli/index.ts`
**依赖：** T1（需要 runSshdConfig 已导出）
**步骤：**
1. 在 `src/cli/index.ts` 顶部 import 区，新增 `import { runSshdConfig } from "./commands/sshd-config.js";`（紧跟 `runSplit` 的 import 之后）。
2. 在 `split` 命令注册块之后、`demo` 父命令定义之前，新增 `sshd-config` 命令注册：
   - `program.command("sshd-config").description("配置 Windows OpenSSH 免密登录环境（交互式菜单）").action(() => { runSshdConfig({}); });`
   - 附带与现有命令一致的 Doxygen 风格注释块（`@brief` / `@details` / `@example`）。
3. **保持 `src/cli/index.ts` 原有编码与换行符不变**（硬规则）。

**验证：** `npm run build` 编译通过，无 TypeScript 错误。

## T9: 帮助信息与基础冒烟验证

**文件：** 无（运行验证）
**依赖：** T8
**步骤：**
1. 运行 `node ./bin/embedded-mcp-toolkit-cli.js --help`，确认 `sshd-config` 出现在命令列表中，描述正确。
2. 运行 `node ./bin/embedded-mcp-toolkit-cli.js sshd-config --help`，确认无异常。
3. 在非管理员窗口运行 `node ./bin/embedded-mcp-toolkit-cli.js sshd-config`，确认提示"请以管理员身份运行"并退出（AC1）。
4. 在管理员窗口运行，确认菜单展示正确，输入 0 正常退出（AC3 部分）。

**验证：** 以上 4 项均符合预期。

## T10: 端到端全流程验证

**文件：** 无（运行验证）
**依赖：** T5、T6、T7、T8
**步骤：**
1. 准备一台可 SSH 登录的 Linux 服务器（已知 host/port/user/password）。
2. 在管理员 PowerShell 中运行 `embedded-mcp-toolkit sshd-config`，按 [1]→[2]→[3] 顺序执行。
3. [1] 后用 `Get-Service sshd` 确认服务 Running 且 StartupType=Automatic（AC4）。
4. [2] 后确认 `.embedded/ssh/id_mcp_server.pub` 生成且内容以 `ssh-rsa` 开头（AC5）。
5. [3] 后确认 `~/.ssh/authorized_keys` 含该公钥、`sshd_config.bak` 存在、sshd_config 中 Match Group administrators 段被注释（AC6、AC7）。
6. 从 Linux 服务器执行 `ssh <windows用户>@<windows IP>`，确认免密登录到 Windows PowerShell（AC8）。
7. grep 日志目录确认密码未落盘（AC9）。

**验证：** 全部 7 项符合预期；任一失败记录现象并回到对应任务修复。

## 执行顺序

```
T1 ──► T2 ──► T3 ──► T8 ──► T9
 │      │              │
 │      └────► T4 ──► T5 ─┐
 │                        ├──► T10
 └────────────────► T6 ──┤
                          │
                  T7 ────┤
                          │
        T4 ──► T7.6 ──► T7.7 ──► T7.8
                          │
                  T7.5 ──┘  (仅依赖 T4 的 runPowerShell，可独立编写)
                          │
                  T7.9 ──┘  (仅依赖 T1 的 os 模块，可独立编写)
```

说明：
- T1 是所有任务的基础（文件骨架与类型）。
- T2/T3 依赖 T1，实现主入口骨架与菜单循环。
- T4 是 step1/2/3/4/5 共用的辅助函数（命令执行封装 + SSH 最小封装），独立于 T2/T3。
- T5/T6/T7/T7.5 各自依赖 T4，几个 step 可并行编写但建议串行验证。
- T7.5（step4 只读诊断）仅用到 runPowerShell / readFileSync / existsSync，不依赖 SSH，可与 T5/T6/T7 并行。
- T7.6（安装方式检测）依赖 T4；T7.7（step4 展示安装方式）依赖 T7.6；T7.8（step5 卸载）依赖 T7.6。
- T7.9（step6 查看连接信息）仅依赖 T1 的 os 模块，不依赖 T4，可与其它 step 完全并行编写。
- T8 依赖 T1（导出的 runSshdConfig）；注册后 T9 可做基础冒烟。
- T10 是端到端验证，必须在 T5/T6/T7/T7.8/T7.9/T8 全部完成后进行，需要真实 Linux 环境。
