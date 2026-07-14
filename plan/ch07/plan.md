# sshd-config 命令 Plan

## 架构概览

`sshd-config` 作为一个顶层内联命令接入现有 CLI（`src/cli/index.ts`），与 `init` / `split` 并列。核心逻辑放在独立模块 `src/cli/commands/sshd-config.ts`，内部按三个功能项拆为三个步骤函数，共用一组交互与系统操作辅助函数。

```
src/cli/index.ts
  └── program.command("sshd-config").action(runSshdConfig)
                                          │
src/cli/commands/sshd-config.ts ◄─────────┘
  ├── runSshdConfig()            主入口：权限检查 → 平台校验 → 菜单循环
  ├── checkAdmin()               管理员权限检测
  ├── showMenu()                 交互式菜单
  ├── detectOpenSshInstallMethod()  OpenSSH 安装方式检测（MSI/Capability/未知）
  ├── step1InstallSsh()          [1] 安装 Windows OpenSSH Server
  ├── step2GenerateKey()         [2] 登录 Linux、生成密钥、SFTP 拉取公钥
  ├── step3ConfigSshd()          [3] 写 authorized_keys + 改 sshd_config
  ├── step4CheckStatus()         [4] 只读诊断（含安装方式展示）
  ├── step5UninstallSsh()        [5] 卸载 Windows OpenSSH Server
  ├── step6ShowConnectionInfo()  [6] 查看本机连接信息（用户名/IP，供 Linux 端参考）
  └── 辅助：askInput/askPassword/runPowerShell/runCmd/
            sshConnect/sshExec/sshDownload/sshDisconnect/openAppwizAndAwait
```

> 说明：`sshConnect/sshExec/sshDownload/sshDisconnect` 是本命令内部基于 `ssh2` 库的最小封装，**不**复用 `src/transports/ssh.ts` 的 `SSHShell`。理由：`SSHShell` 绑定 MCP 会话注册、PSH 解锁、会话 id 等业务机制，不适合一次性运维命令。

复用与重新实现的边界：

- **SSH 操作（重新实现，不复用）**：项目现有的 `SSHShell`（`src/transports/ssh.ts`）是为 MCP 工具设计的，依赖会话注册、PSH 解锁、会话 id 等业务机制，不适合一次性运维命令复用。本命令直接基于 `ssh2` 库（已是生产依赖）在 `sshd-config.ts` 内部实现三个最小操作：连接、执行命令、SFTP 下载文件，保持轻量与独立，不依赖 `src/transports/` / `src/services/` / `src/mcp/` 任何模块。
- **命令注册风格（复用）**：参照 `split` 命令，`src/cli/index.ts` 中 `program.command("sshd-config").action(...)`，逻辑全部下沉到 `commands/sshd-config.ts`。
- **日志风格（复用）**：参照 `init.ts` / `split.ts` 的 emoji 前缀输出（✅ ⚠️ ❌ ⏭）。

## 核心数据结构

### `SshdConfigOptions`

```ts
// 由 Commander 解析后传入；本期命令无命令行选项，预留扩展
export interface SshdConfigOptions {
  // 暂无选项，保留接口与 init/split 一致
}
```

### `LinuxServerInfo`（仅内存，不落盘）

```ts
// 第 [2] 步交互式收集的 Linux 编译服务器连接信息
export interface LinuxServerInfo {
  host: string;
  port: number;     // 默认 22
  username: string;
  password: string; // 仅内存，不写日志/磁盘
}
```

### `PowerShellResult`

```ts
// 封装 PowerShell/外部命令执行结果，统一处理退出码与输出
export interface PowerShellResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

### 菜单选项常量

```ts
// 主菜单选项枚举值
const MENU_INSTALL_SSH = "1";
const MENU_GENERATE_KEY = "2";
const MENU_CONFIG_SSHD = "3";
const MENU_CHECK_STATUS = "4";
const MENU_UNINSTALL_SSH = "5";
const MENU_SHOW_INFO = "6";
const MENU_EXIT = "0";
```

### `OpenSshInstallInfo`（安装方式检测结果）

```ts
// detectOpenSshInstallMethod() 的返回，供 step4 诊断展示与 step5 卸载策略选择
interface OpenSshInstallInfo {
  method: "msi" | "capability" | "unknown"; // 安装方式
  methodLabel: string;   // 给用户展示的中文标签（"MSI"/"Capability"/"未知"）
  exePath: string | null; // sshd.exe 实际路径（已安装时），未找到为 null
  detail: string;        // 判定依据说明（如"服务 ImagePath 指向 Program Files\OpenSSH"）
}
```

## 模块设计

### `src/cli/commands/sshd-config.ts`（新建，唯一改动文件之一）

**职责**：承载 `sshd-config` 命令的全部逻辑——权限检查、平台校验、交互菜单、三个步骤函数、辅助函数。**不依赖** `src/transports/` / `src/services/` / `src/mcp/` 任何模块，SSH 操作基于 `ssh2` 库在本文件内重新实现为最小封装。

**对外接口**：
- `runSshdConfig(opts: SshdConfigOptions): Promise<void>`：主入口，供 `src/cli/index.ts` 注册的 `.action()` 调用。

**内部函数（模块私有，不导出）**：

| 函数 | 职责 |
|------|------|
| `checkAdmin()` | 检测当前进程是否具备管理员权限（执行 `net session` 或 PowerShell `IsInRole`） |
| `relaunchAsAdmin()` | 非管理员时自动 UAC 提权重启：用 PowerShell `Start-Process -Verb RunAs` 启动新管理员进程（弹 UAC），本进程退出；失败提示并以非零码退出 |
| `isWindows()` | 平台判断（`process.platform === "win32"`） |
| `showMenu()` | 打印主菜单文本（不含标题，标题由主循环单独打印以便清屏后先出标题） |
| `clearScreen()` | 清屏：ANSI 转义 `\x1Bc` 复位终端；非 TTY 环境（管道/重定向）跳过，避免向非终端写入控制字符 |
| `pauseForMenu()` | step 执行完毕后的暂停等待：提示"按 Enter 回到菜单，按 q 退出"，Enter 返回 false、q 返回 true、其它输入忽略循环重提示 |
| `askInput(rl, prompt)` | 读取一行明文输入（host/user） |
| `askPassword(rl, prompt)` | 读取密码（关闭回显；Node 无原生关闭回显 API，采用 raw mode 逐字符读取，显示为空或 `*`） |
| `parseServerAddress(input)` | 解析 `user@host[:port]` 紧凑格式为 `{host, port, username}`；无端口默认 22；格式非法返回 null |
| `runPowerShell(script)` | 通过 `child_process.exec` 执行 PowerShell 命令，返回 `PowerShellResult` |
| `runCmd(cmd, args, opts)` | 通用命令执行封装（用于 msiexec、sshd.exe install 等） |
| `findSshdExe()` | 在候选路径（Program Files\\OpenSSH、System32\\OpenSSH）中查找已存在的 sshd.exe，返回路径或 null |
| `detectOpenSshInstallMethod()` | 检测 OpenSSH 安装方式（MSI / Capability / 未知），综合三信号（服务 ImagePath > Capability State > 文件探测）交叉判定，供 step4 诊断与 step5 卸载复用 |
| `ensureSshdService()` | 检查 sshd 服务是否已注册；未注册则用 `findSshdExe()` 定位 sshd.exe 后执行 `sshd.exe install` 补注册（解决 MSI 静默安装不注册服务的问题） |
| `openAppwizAndAwait()` | 打开"程序和功能"（appwiz.cpl）并等待用户手动卸载后按回车继续；封装 step5 中三处相同的"开 appwiz + 等待回车"逻辑 |
| `sshConnect(info)` | 基于 ssh2 建立到 Linux 的 SSH 连接，返回 `Client`（不复用 SSHShell） |
| `sshExec(client, cmd)` | 在已建立的 ssh2 连接上执行一条命令并收集 stdout，返回字符串（不复用 SSHShell.exec） |
| `sshDownload(client, remotePath, localPath)` | 在已建立的 ssh2 连接上发起 SFTP，把远端文件下载到本地（不复用 SSHShell.downloadFile） |
| `sshDisconnect(client)` | 关闭 ssh2 连接，释放资源 |
| `step1InstallSsh()` | [1] 检测→用户选择安装途径（默认 MSI）→MSI（本地已存在则跳过下载）/在线→ensureSshdService(注册服务)→启动→设自启 |
| `step2GenerateKey()` | [2] 交互收集 Linux 信息→SSH 登录→检测 sshd→ssh-keygen→SFTP 拉公钥 |
| `step3ConfigSshd()` | [3] 写 authorized_keys（去重）→备份 sshd_config→改配置→检查 sshd 服务是否注册→已注册则重启(失败回滚)/未注册则跳过(提示手动重启) |
| `step4CheckStatus()` | [4] 只读诊断：sshd 服务状态（含安装方式检测）+ sshd_config 关键项 + authorized_keys 状态 + 本地公钥状态，汇总展示 |
| `step5UninstallSsh()` | [5] detectOpenSshInstallMethod 判定方式→msi(msiexec /x 或 appwiz.cpl)/capability(Remove-WindowsCapability)/unknown(appwiz.cpl)→清理 sshd 服务残留 |
| `step6ShowConnectionInfo()` | [6] 只读展示：os.userInfo() 用户名 + os.networkInterfaces() 过滤后的 IPv4 + 拼接 ssh 命令示例 |

**依赖**：
- Node 内置：`child_process`、`fs`/`fs/promises`、`path`、`os`、`readline`、`https`、`net`。
- 第三方：`ssh2`（已是生产依赖，直接 `import { Client } from "ssh2"`，**不**经过 `src/transports/ssh.ts`）。
- 不引入新依赖；不 import 任何 `src/transports/` / `src/services/` / `src/mcp/` 模块。

### `src/cli/index.ts`（修改：新增命令注册）

**职责**：注册 `sshd-config` 顶层命令，`.action()` 调用 `runSshdConfig`。

**改动**：在 `split` 命令注册之后、`demo` 命令之前，新增一段命令注册（含 Doxygen 风格注释，与现有命令一致）。

## 模块交互

### 主流程

```
bin/embedded-mcp-toolkit-cli.js
  └── src/cli/index.ts
        └── program.command("sshd-config").action(runSshdConfig)
              └── src/cli/commands/sshd-config.ts: runSshdConfig()
                    ├── isWindows()?           ──否──→ 提示并退出
                    ├── checkAdmin()?          ──否──→ relaunchAsAdmin()
                    │                                    ├── UAC 确认 → 新管理员窗口重启，本进程退出
                    │                                    └── UAC 拒绝/失败 → 提示并退出(非0)
                    └── 菜单循环 while(true):
                          ├── clearScreen()              ← 每轮清屏
                          ├── 打印标题 + showMenu()
                          ├── prompt("请选择: ")
                          ├── "0" → 直接退出（不暂停）
                          ├── "1" → step1InstallSsh()
                          ├── "2" → step2GenerateKey()
                          ├── "3" → step3ConfigSshd()
                          ├── "4" → step4CheckStatus()
                          ├── "5" → step5UninstallSsh()
                          ├── "6" → step6ShowConnectionInfo()
                          └── pauseForMenu()             ← step 完毕后暂停
                                ├── Enter → 回循环顶部（clearScreen 重显菜单）
                                └── q     → 退出
```

### step1 内部流程（默认 MSI，用户可选在线）

```
step1InstallSsh()
  ├── runPowerShell("Get-Service sshd")         ← 检测服务是否已存在
  │     └── 存在 → 提示"已安装"并 return
  ├── runPowerShell("Get-WindowsCapability ... OpenSSH.Server") ← 检测 Capability 状态
  │     └── State=Installed → 提示"已安装"并 return
  ├── askChoice("选择安装方式 [1]MSI(默认) [2]在线安装: ")  ← 默认 MSI
  │     ├── "2" → 在线分支：
  │     │     └── runPowerShell("Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0")
  │     └── "1"/其它 → MSI 分支：
  │           ├── existsSync(.embedded/ssh/OpenSSH-Win64.msi)?
  │           │     ├── 是  → 跳过下载
  │           │     └── 否  → downloadFile(OPENSSH_MSI_URL, .embedded/ssh/OpenSSH-Win64.msi)
  │           └── runCmd("msiexec", ["/i", msiPath, "/quiet", "/norestart"])
  ├── ensureSshdService()                        ← 确保服务已注册（关键）
  │     ├── runPowerShell("Get-Service sshd") → 已注册则跳过
  │     └── 未注册 → findSshdExe() 定位 sshd.exe → runCmd(sshdExe, ["install"])
  ├── runPowerShell("Start-Service sshd")
  └── runPowerShell("Set-Service -Name sshd -StartupType Automatic")
```

> 说明：MSI 包缓存在 `<cwd>/.embedded/ssh/OpenSSH-Win64.msi`，重复执行 [1] 时若文件已存在则跳过下载直接静默安装，适合反复部署/离线环境。在线分支失败不自动回退到 MSI（用户已显式选择），只报错退出本项。
>
> **服务注册说明**：MSI 静默安装（msiexec /quiet）有时只释放文件不注册 Windows 服务（当系统中已存在 OpenSSH 文件时尤其常见）。因此安装后必须调用 `ensureSshdService()`——先检查 `Get-Service sshd`，未注册则用 `sshd.exe install` 补注册。sshd.exe 按候选路径查找：`C:\Program Files\OpenSSH\sshd.exe`（MSI 目录）优先，`C:\Windows\System32\OpenSSH\sshd.exe`（Windows 自带）兜底。

```
step2GenerateKey()
  ├── prompt("编译服务器地址 user@host[:port]: ")  ← 紧凑格式一次输入
  │     └── parseServerAddress() 拆出 username/host/port（无端口默认 22）
  ├── askPassword("登录密码: ")
  ├── sshConnect(info)                          ← import { Client } from "ssh2"，直连
  │     └── 失败 → 提示连接错误并 return
  ├── 信息采集（仅展示，不参与路径逻辑）：
  │     ├── sshExec(client, "whoami")            → 当前登录用户名
  │     ├── sshExec(client, "hostname -I")       → 主机 IP
  │     └── sshExec(client, "eval echo ~$USER")  → 家目录绝对路径
  │     └── 打印三项信息供用户核对
  ├── sshExec(client, "systemctl status sshd || service ssh status")
  │     └── 未运行 → 提示安装命令、sshDisconnect、return
  ├── sshExec(client, "test -f ~/.ssh/id_mcp_server && echo EXISTS")
  │     └── EXISTS → askChoice 是否覆盖；否 → sshDisconnect、return
  ├── sshExec(client, "ssh-keygen -t rsa -b 4096 -N '' -f ~/.ssh/id_mcp_server")
  ├── sshExec(client, "ls -la ~/.ssh")           → 列出密钥目录所有文件供确认
  ├── sshDownload(client, "~/.ssh/id_mcp_server.pub", "<cwd>/.embedded/ssh/id_mcp_server.pub")
  │                                                ← client.sftp() + fastGet
  └── sshDisconnect(client)
```

> 注：四个 `ssh*` 函数是本文件内基于 ssh2 的最小封装，不经过 `src/transports/ssh.ts`。远端路径中的 `~` 由远端 shell 在 `sshExec` 执行时展开；`sshDownload` 的远端路径先用 `sshExec(client, "echo ~/.ssh/id_mcp_server.pub")` 展开为绝对路径再传给 SFTP（SFTP 不识别 `~`）。密钥名使用 `id_mcp_server` 而非通用 `id_rsa`，避免覆盖用户已有的通用密钥，明确标识为 MCP 专用。
>
> 编译服务器地址采用紧凑格式 `user@host[:port]` 一次输入（如 `cnb-dso-xxx@cnb.space` 或 `root@1.2.3.4:2222`），由 `parseServerAddress` 拆解为 host/port/username，避免逐项询问。

### step3 内部流程

```
step3ConfigSshd()
  ├── 读取 <cwd>/.embedded/ssh/id_mcp_server.pub（不存在→提示先执行[2]并 return）
  ├── 读取 ~/.ssh/authorized_keys（不存在则创建目录+空文件）
  ├── 去重追加公钥（按整行匹配去重）
  ├── 备份 C:\ProgramData\ssh\sshd_config → sshd_config.bak（已存在 .bak 不覆盖）
  ├── 改写 sshd_config：
  │     ├── 确保 PubkeyAuthentication yes
  │     ├── 确保 AuthorizedKeysFile .ssh/authorized_keys
  │     └── 注释 Match Group administrators 段（及其内的 AuthorizedKeysFile）
  ├── runPowerShell("Get-Service sshd") ← 检查服务是否注册
  │     └── 未注册 → 跳过重启（不回滚），提示手动重启或执行 [1]
  │     └── 已注册 → runPowerShell("Restart-Service sshd -Force")，失败则回滚
  └── 回显最终关键配置项
```

### step4 内部流程（只读诊断，不修改任何状态）

```
step4CheckStatus()
  ├── (a) sshd 服务状态
  │     └── runPowerShell("Get-Service sshd | Select Status,StartType")
  │           └── 打印：是否安装 / Running? / 启动类型
  ├── (a.2) 安装方式诊断
  │     └── detectOpenSshInstallMethod()
  │           └── 打印：MSI / Capability / 未知 + 判定依据
  ├── (b) sshd_config 关键项
  │     ├── 读取 C:\ProgramData\ssh\sshd_config（不存在 → 标记未配置）
  │     ├── 匹配 PubkeyAuthentication → yes?  ✅/⚠️
  │     ├── 匹配 AuthorizedKeysFile → .ssh/authorized_keys?  ✅/⚠️
  │     └── Match Group administrators 是否仍激活（非注释）?  ⚠️是/✅否
  ├── (c) authorized_keys 状态
  │     ├── existsSync(~/.ssh/authorized_keys)?
  │     └── 按行统计公钥条数（ssh-rsa/ssh-ed25519/... 开头的行）
  ├── (d) 本地公钥状态
  │     └── existsSync(<cwd>/.embedded/ssh/id_mcp_server.pub)?  ✅/⚠️
  └── 汇总结论：全部正常 → "可尝试免密登录"；有异常 → 列出建议执行的 [1]/[2]/[3]
```

> 说明：step4 是纯只读操作，仅用 runPowerShell 查询 + readFileSync/existsSync 检查，不写任何文件、不重启服务、不需要 Linux 连接。可在任意阶段随时运行查看当前配置就绪情况。新增的 (a.2) 安装方式诊断让用户能直观看到当前 OpenSSH 来源，辅助判断卸载时该走哪条策略。

### step5 内部流程（卸载，按检测到的安装方式分流）

```
step5UninstallSsh()
  ├── detectOpenSshInstallMethod()          ← 先判定安装方式（同时确认是否已安装）
  │     └── method=unknown 且 exePath=null → 提示"无需卸载"并 return
  ├── 打印安装方式与判定依据
  │
  ├── method=capability?
  │     └── runPowerShell("Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0")
  │           └── 失败 → openAppwizAndAwait() 兜底
  │
  ├── method=msi?
  │     ├── existsSync(.embedded/ssh/OpenSSH-Win64.msi)?
  │     │     ├── 是 → runCmd("msiexec", ["/x", msiPath, "/quiet", "/norestart"])
  │     │     │        └── 失败 → openAppwizAndAwait() 兜底
  │     │     └── 否 → openAppwizAndAwait()（本地无 MSI 包，只能手动卸载）
  │
  ├── method=unknown?
  │     └── openAppwizAndAwait()
  │           ├── runCmd("appwiz.cpl")       ← 打开"程序和功能"
  │           └── prompt("按回车继续")        ← 等用户手动卸载完成
  │
  └── 清理 sshd 服务残留
        └── isSshdServiceRegistered()?
              └── 是 → runCmd("sc.exe", ["delete", "sshd"])
```

> 说明：step5 是 step1 的逆操作。核心思路是"按安装方式对症卸载"——MSI 装的用 msiexec /x，Capability 装的用 Remove-WindowsCapability，来源不明或包缺失时退回图形界面手动卸载。`openAppwizAndAwait()` 封装了"打开 appwiz.cpl + 等待用户按回车"的逻辑（手动卸载是异步过程，程序无法感知结束时机）。
>
> **残留清理边界**：仅自动清理 sshd 服务（MSI/Capability 卸载有时不删服务，用 `sc.exe delete` 补删）。**不自动删除** `C:\ProgramData\ssh`（可能含用户自定义的 authorized_keys / sshd_config）与 `C:\Program Files\OpenSSH` 目录，仅在末尾提示用户可手动清理，避免误删用户数据。

### detectOpenSshInstallMethod 检测逻辑（三信号交叉判定）

```
detectOpenSshInstallMethod()
  ├── 信号 C（先取，供后续填充 exePath）：findSshdExe() 文件探测
  ├── 信号 B（最可靠）：sshd 服务的 ImagePath
  │     └── runPowerShell("(Get-CimInstance Win32_Service -Filter \"Name='sshd'\").ImagePath")
  │         （仅服务已注册时可读）
  ├── 信号 A：Capability State
  │     └── runPowerShell("Get-WindowsCapability ... | Select State")
  │
  ├── 判定优先级 B > A > C：
  │     ├── B 含 "program files\openssh" → MSI
  │     ├── B 含 "system32\openssh"     → Capability
  │     ├── A=Installed 且无 MSI 目录 exe → Capability
  │     ├── C = MSI_SSHD_EXE            → MSI（兜底）
  │     ├── C = CAPABILITY_SSHD_EXE     → Capability（兜底）
  │     └── 其余                         → unknown
```

> 说明：为什么不能只看 `Get-WindowsCapability`？因为 MSI 安装的 OpenSSH 把文件放到 `C:\Program Files\OpenSSH` 后，Capability 也可能探测到 State=Installed（误判）。最可靠的区分信号是 **sshd 服务的 ImagePath**——服务实际加载的 exe 路径不会撒谎：`Program Files\OpenSSH\sshd.exe` 必为 MSI，`System32\OpenSSH\sshd.exe` 必为 Capability。只有服务未注册时 ImagePath 不可用，才退回 Capability State 与文件探测兜底。

### step6 内部流程（查看本机连接信息，只读）

```
step6ShowConnectionInfo()
  ├── (a) Windows 用户名
  │     └── os.userInfo().username
  │         └── 若含 "\" 取反斜杠后部分（DOMAIN\user → user）
  ├── (b) 本机 IPv4 地址
  │     └── os.networkInterfaces() 枚举所有网卡
  │           ├── 跳过 internal（回环 127.x）
  │           ├── 跳过 169.254（链路本地，DHCP 未获取时出现）
  │           └── 跳过虚拟网卡（名称匹配 virtual/vmware/hyper-v/vethernet/wsl/docker）
  ├── (c) 拼接 ssh 命令示例
  │     └── ssh -i ~/.ssh/id_mcp_server <user>@<primaryIp>
  │         （多 IP 时取首个，提示可换用其它 IP）
  └── 末尾提示需依次执行 [1]→[2]→[3] 才能免密成功
```

> 说明：step6 纯只读，仅用 Node `os` 模块读取本机信息，不调用 PowerShell、不写文件、不需要管理员权限。用途是帮用户快速拿到 Linux 端 ssh 命令所需的用户名和 IP——这在多网卡、域账户（`DOMAIN\user`）等场景下尤其有用，避免用户记错参数。虚拟网卡过滤能避免列出 VMware/Hyper-V/WSL 等不可达的内部 IP 干扰判断。

```
src/
├── cli/
│   ├── index.ts                    # 修改：新增 sshd-config 命令注册
│   └── commands/
│       ├── init.ts                 # 不动（参考其风格）
│       ├── split.ts                # 不动（参考其风格）
│       └── sshd-config.ts          # 新建：命令全部逻辑
└── ...（其余目录不动）

项目运行时产生的文件（非源码）：
<cwd>/.embedded/ssh/id_mcp_server.pub  # step2 拉取的公钥落地
~/.ssh/authorized_keys              # step3 写入
C:\ProgramData\ssh\sshd_config      # step3 修改
C:\ProgramData\ssh\sshd_config.bak  # step3 备份
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 命令形态 | 顶层内联命令 `sshd-config`，逻辑下沉到 `commands/sshd-config.ts` | 与 `init` / `split` 完全一致的风格；单一文件承载全部逻辑，避免过度拆分 |
| 管理员权限检测 | 优先 `net session`（退出码 0=管理员），失败回退 PowerShell `[Security.Principal.WindowsPrincipal]` | `net session` 轻量、无需启 PowerShell 进程；回退保证兼容性 |
| 非管理员时的提权 | 自动 UAC 提权重启（`Start-Process -Verb RunAs`），而非仅提示用户手动重启 | Windows 无纯原生原地提权（Linux sudo 式）；UAC 提权零依赖、对所有 Windows 可用，体验"运行→弹 UAC→点是→继续"优于"请手动关闭以管理员重启"。代价是开新窗口，但本命令为交互式菜单，新窗口从头开始可接受。不选 Win11 sudo/gsudo 是因其依赖系统版本或额外安装，开箱即用性差 |
| OpenSSH 安装方式 | 默认 MSI 离线安装，用户可选在线安装 | 在线安装 `Add-WindowsCapability` 依赖 Windows Update，国内网络易卡住甚至超时；MSI 下载一次后可重复使用，且 MSI 包存在本地时跳过下载，更适合反复部署。在线方式保留为可选项，满足能稳定访问 Windows Update 的环境 |
| SSH 登录与拉公钥 | 在命令内基于 `ssh2` 库重新实现最小封装（`sshConnect/sshExec/sshDownload/sshDisconnect`） | 现有 `SSHShell` 绑定 MCP 会话注册、PSH 解锁、会话 id 等业务机制，不适合一次性运维命令；直接用 ssh2 保持轻量独立，且 ssh2 已是生产依赖 |
| 密码交互输入 | readline + 终端 raw mode 逐字符读取（显示为空或 `*`） | Node 无原生 getpass；raw mode 跨 Windows 终端可用；满足 N4 不回显 |
| sshd_config 修改策略 | 整文件读取→按行处理→备份后整体写回 | sshd_config 是文本配置，逐行正则处理最稳妥；备份满足 N5 |
| Match Group 处理 | 注释整段（在每行前加 `#`）而非删除 | 保留原配置可追溯；用户能看到原样被注释的内容 |
| authorized_keys 去重 | 按公钥整行字符串比对 | 简单可靠；同一公钥不会重复写入 |
| 公钥落地位置 | `<cwd>/.embedded/ssh/id_mcp_server.pub` | 与项目 `.embedded/` 约定一致；相对 cwd，方便不同项目隔离 |
| 密钥命名 | `id_mcp_server`（而非通用 `id_rsa`） | 专用密钥避免覆盖用户已有的通用密钥；名称明确标识为 MCP 专用，与项目用途一致 |
| 错误处理 | 每个外部命令捕获退出码+输出，失败打印中文提示并 return（不 throw） | 与 init/split 风格一致；避免进程崩溃；单项失败不影响回到菜单 |
| 卸载策略 | 先检测安装方式再对症卸载（MSI→msiexec /x，Capability→Remove-WindowsCapability，未知→appwiz.cpl），而非统一用一种方式 | 不同安装方式的卸载命令不同：msiexec /x 卸不干净 Capability 装的，反之亦然。检测方式让卸载"精准命中"，避免一种方式失败时用户不知所措。MSI 包缺失时退回 appwiz.cpl 图形界面作为兜底 |
| 安装方式检测信号 | 优先 sshd 服务的 ImagePath，而非只看 Get-WindowsCapability | Capability State=Installed 有歧义（MSI 装的也可能被探测到）；服务 ImagePath 是最可靠信号——服务实际加载的 exe 路径不撒谎。三信号（B>A>C）交叉判定，覆盖服务未注册等边界场景 |
| 卸载残留清理范围 | 仅自动删 sshd 服务（sc.exe delete），不自动删配置/安装目录 | sshd 服务是卸载的明确目标，残留概率高；而 C:\ProgramData\ssh 可能含用户自定义配置，C:\Program Files\OpenSSH 留作下次安装复用，自动删有误删风险，改为末尾提示用户手动处理 |
| appwiz.cpl 等待机制 | 打开后用 prompt 阻塞等待用户按回车继续 | 手动卸载是异步图形界面操作，程序无法感知结束时机；用 prompt 等待是最简单的同步手段，用户卸载完成后按回车通知程序继续后续的残留清理 |
| 本机信息获取 | Node `os` 模块（userInfo / networkInterfaces），而非 PowerShell | 纯 Node API 零外部进程开销，跨平台一致；不依赖 PowerShell 的 `$env:USERNAME` / `ipconfig` 解析，也避免 PowerShell 子进程启动的延迟 |
| 虚拟网卡过滤 | 按网卡名正则（virtual/vmware/hyper-v/vethernet/wsl/docker）排除 | 多网卡 Windows（尤其装了 Docker Desktop/WSL2/Hyper-V 的开发机）会有一堆虚拟网卡 IP，对 Linux 端不可达，列出只会干扰用户判断 |
| step 间清屏 | 每轮菜单循环开始时 clearScreen()，step 执行后 pauseForMenu 等 Enter | step 输出（安装日志、密钥列表、诊断报告等）量大，不清屏会堆积导致菜单被推到屏幕外、难找当前位置。每轮清屏保证菜单始终从干净屏幕开始；step 后暂停给用户看完结果再清屏，避免结果一闪而过 |
| 清屏实现 | ANSI 转义 `\x1Bc`（RIS 全屏复位），非 TTY 跳过 | 比 `cls`/`clear` 命令轻量（不启子进程）；`\x1Bc` 比 `\x1B[2J\x1B[H` 更彻底（同时清屏+复位光标+清滚动缓冲）。管道/重定向非 TTY 时跳过，避免控制字符污染日志文件 |
| 暂停等待 | prompt 阻塞读一行，Enter 继续 / q 退出 / 其它忽略 | step 完成后需要让用户看完输出再决定下一步；用 readline 单行读取是最简方案。q 可退出省去回菜单再选 0；其它输入忽略避免误触 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。`src/cli/index.ts` 为现有文件，修改时保持其原有编码与换行。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能。

本次开发的额外约定：
- 文件头使用 `@file` / `@brief` Doxygen 注释块，与 `init.ts` / `split.ts` 一致。
- 导出函数使用 `@brief` / `@details` / `@param` / `@returns` Doxygen 注释，与现有命令风格一致。
- emoji 前缀输出（✅ ⚠️ ❌ ⏭ 🔄）与 init/split 保持一致。
- 模块私有函数不导出，仅 `runSshdConfig` 及必要类型导出。
- 外部命令执行统一通过 `runPowerShell` / `runCmd` 封装，不直接散落 `execSync`。
