<!-- more -->

## 一、 文档说明

本文档是 [`sshd-config` 命令](../src/cli/commands/sshd-config/index.ts)（Windows OpenSSH 免密登录环境配置）的**手动操作手册**。当该命令在部分 Windows 系统上无法正常使用时，参照本文档手工完成等效配置。

### 1. 背景与适用场景

`embedded-mcp-toolkit` 提供两个对偶命令完成「远程 Agent + 本地 MCP」环境搭建：

| 命令 | 角色 | 权限要求 |
| ---- | ---- | -------- |
| `sshd-config` | Windows 当 SSH 服务器，让 Linux 免密登录 Windows | 需要管理员权限，自动 UAC 提权 |
| `remote-mcp-config` | Windows 当 SSH 客户端，登录 Linux 写 MCP 桥接配置 | 普通权限，无平台限制 |

`sshd-config` 内部通过 PowerShell `Start-Process -Verb RunAs` 弹出 UAC 确认并新开管理员窗口重跑命令（实现见 [`src/cli/shared/platform.ts`](../src/cli/shared/platform.ts)）。部分 Windows 环境下（组策略限制 UAC 提权、安全软件拦截、终端环境差异等），**提权后的新窗口会一闪而过**，命令无法继续，且此类问题无法在工具侧全部兼容。

遇到闪退时，本手册提供两条出路：

（1）**优先尝试规避**：不依赖命令自动提权，手动以管理员身份打开终端后再运行命令（见下文第 2 节）。

（2）**完全手动配置**：规避无效时，按第三章流程手工执行命令自动完成的每一步操作（安装 SSH 服务、生成密钥、配置 sshd、生成 MCP 桥接模板）。

### 2. 优先尝试：管理员终端直接运行

自动提权闪退的根源是「新开管理员窗口」这一步。若终端本身就是管理员身份，命令不会再触发提权重启，通常即可正常运行：

（1）在开始菜单搜索 PowerShell 或终端，右键选择**以管理员身份运行**。

（2）`cd` 到项目根目录后执行：

```powershell
embedded-mcp-toolkit sshd-config
```

（3）能进入主菜单即成功，后续按菜单引导操作，无需本文档。

【**注意**】

若在管理员终端中运行仍闪退或卡死，再按第三章完全手动配置。

### 3. 手动配置总览

手动配置与命令一键流程（菜单 `[1]`）等价，共四步，顺序执行：

| 步骤 | 内容 | 执行位置 | 等效菜单项 |
| ---- | ---- | -------- | ---------- |
| 1 | 安装并启动 Windows OpenSSH 服务 | Windows 管理员 PowerShell | `[2]` 安装 Windows SSH 服务 |
| 2 | 生成 MCP 专用密钥对并回传公钥 | Linux 终端 + Windows | `[3]` 编译服务器生成密钥对 |
| 3 | 配置 sshd 免密登录（authorized_keys + sshd_config） | Windows 管理员 PowerShell | `[4]` 配置 Windows 中 sshd 服务 |
| 4 | 生成 Linux 端 MCP 桥接配置 | Linux 终端 | `[8]` 生成 Linux 端 MCP 配置模板 |

### 4. 前置条件

（1）**Windows 侧**：Windows 10 / 11 或对应 Windows Server，已安装 Node.js 与 npm，已通过 `npm install -g embedded-mcp-toolkit` 安装本工具，且已在项目根目录执行过 `embedded-mcp-toolkit init`（生成 `remote-start-mcp.bat` 与 `.embedded/configs/` 配置）。

（2）**Linux 侧**：编译服务器已安装并运行 sshd，Windows 与 Linux 网络互通。

（3）Linux 端未安装 sshd 时先安装启动：

```bash
# Debian/Ubuntu
sudo apt install openssh-server && sudo systemctl start sshd
# RHEL/CentOS
sudo dnf install openssh-server && sudo systemctl start sshd
```

---

## 二、 手动配置流程

### 1. 安装并启动 Windows OpenSSH 服务

以下命令均在**管理员 PowerShell**中执行。

#### 1.1 检测是否已安装

先确认是否已有 OpenSSH Server，避免重复安装：

```powershell
# 检测 sshd 服务（输出 sshd 即已注册）
Get-Service sshd -ErrorAction SilentlyContinue

# 检测 sshd.exe 文件（两个候选路径任一存在即已安装）
Test-Path "C:\Program Files\OpenSSH\sshd.exe"       # MSI 安装方式
Test-Path "C:\Windows\System32\OpenSSH\sshd.exe"     # 系统组件安装方式

# 检测系统组件状态（较慢，可能需要数十秒）
Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

任一信号显示已安装，直接跳到 1.4 节执行「注册、启动与自启」。

#### 1.2 MSI 离线安装（推荐）

下载 MSI 安装包后静默安装，下载一次可重复使用（与命令默认途径一致）：

（1）下载 MSI 安装包，保存到项目目录 `.embedded\ssh\OpenSSH-Win64.msi`（与命令的缓存路径保持一致，方便后续卸载时复用）：

```text
https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi
```

（2）执行静默安装：

```powershell
msiexec /i "<MSI 完整路径>" /quiet /norestart
```

例如项目在 `E:\AI\my-project`：

```powershell
msiexec /i "E:\AI\my-project\.embedded\ssh\OpenSSH-Win64.msi" /quiet /norestart
```

（3）也可以直接双击 MSI 走图形界面安装，效果相同。

#### 1.3 在线安装

不下载安装包，直接从 Windows Update 安装系统组件：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

【**注意**】

在线安装依赖 Windows Update，国内网络或禁用更新策略下可能长时间卡住或失败，失败后改用 1.2 节 MSI 离线安装。

#### 1.4 注册、启动与自启

安装完成后需确保 sshd 服务注册、启动并设为开机自启：

（1）**注册服务**（MSI 静默安装有时只释放文件不注册服务，需补注册；1.1 节已见 `Get-Service sshd` 有输出可跳过）：

```powershell
# 优先用 MSI 安装目录的 exe，不存在则用系统组件目录
& "C:\Program Files\OpenSSH\sshd.exe" install
# 或
& "C:\Windows\System32\OpenSSH\sshd.exe" install
```

（2）**启动服务**：

```powershell
Start-Service sshd
```

（3）**设置开机自启**：

```powershell
Set-Service -Name sshd -StartupType Automatic
```

#### 1.5 防火墙放行确认

MSI 与系统组件安装通常会自动创建防火墙规则，确认一下即可：

```powershell
# 查看是否已存在 OpenSSH Server 入站规则
Get-NetFirewallRule -Name *OpenSSH-Server*
```

无规则或显示已禁用时，手动创建放行 TCP 22 端口：

```powershell
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

### 2. Linux 端生成密钥对并回传公钥

#### 2.1 生成 MCP 专用密钥

在 **Linux 编译服务器**上，以登录 Windows 时要用的那个用户身份执行：

```bash
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_mcp_server
```

（1）密钥名固定为 `id_mcp_server`（MCP 专用，避免覆盖用户通用密钥 `id_rsa` / `id_ed25519`）。

（2）已存在同名密钥时，确认不再需要后先删除再生成：

```bash
rm -f ~/.ssh/id_mcp_server ~/.ssh/id_mcp_server.pub
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_mcp_server
```

#### 2.2 公钥回传 Windows

此时 Windows 的 sshd 已装好且支持密码登录，从 Linux 用 `scp` 把公钥推到 Windows（回车后输入 Windows 用户的登录密码）：

```bash
# <用户名> 为 Windows 登录用户名，<IP> 为 Windows 的 IP（可在 Windows 执行 ipconfig 查看）
scp ~/.ssh/id_mcp_server.pub <用户名>@<IP>:id_mcp_server.pub
```

然后在 **Windows** 上把公钥归档到项目目录（与命令的落地路径保持一致，后续若恢复使用命令，`[5] 检查状态`、`[6] 卸载` 仍能识别）：

```powershell
# 项目根目录下执行（示例项目在 E:\AI\my-project）
mkdir -Force .embedded\ssh | Out-Null
Move-Item -Force "$env:USERPROFILE\id_mcp_server.pub" ".embedded\ssh\id_mcp_server.pub"
```

【**注意**】

Windows 侧也可用记事本直接打开 `id_mcp_server.pub`，复制整行内容备用，下一节直接粘贴进 `authorized_keys`，中转文件只是归档。

### 3. 配置 Windows sshd 免密登录

对应命令菜单 `[4]`，三处操作：写 `authorized_keys`、修改 `sshd_config`、重启 sshd。修改 `sshd_config` 需要管理员权限。

#### 3.1 写入 authorized_keys

（1）打开当前用户的 `.ssh` 目录（不存在则创建），文件路径为 `C:\Users\<用户名>\.ssh\authorized_keys`：

```powershell
mkdir -Force "$env:USERPROFILE\.ssh" | Out-Null
notepad "$env:USERPROFILE\.ssh\authorized_keys"
```

（2）把公钥内容（`id_mcp_server.pub` 的**单行**完整内容，形如 `ssh-rsa AAAA... user@host`）粘贴为新的一行并保存。文件中已有相同内容则跳过（命令侧按整行去重）。

【**注意**】

（1）公钥必须写入**Linux 登录时所用 Windows 账户**的家目录，账户不匹配是免密失败的常见原因。

（2）保存时编码选**无 BOM 的 UTF-8 或 ANSI**，切勿存成 UTF-16，否则 sshd 无法解析公钥行。

#### 3.2 修改 sshd_config

（1）**备份原文件**（保留首次备份，与命令行为一致）：

```powershell
Copy-Item "C:\ProgramData\ssh\sshd_config" "C:\ProgramData\ssh\sshd_config.bak"
```

（2）用记事本以管理员身份打开配置文件：

```powershell
Start-Process notepad "C:\ProgramData\ssh\sshd_config" -Verb RunAs
```

（3）核对 / 修改以下三处：

（a）**开启公钥认证**：找到 `PubkeyAuthentication` 行（含注释形态 `#PubkeyAuthentication`），确保存在一条未注释的有效行：

```text
PubkeyAuthentication yes
```

（b）**指定公钥文件路径**：确保存在一条未注释的有效行：

```text
AuthorizedKeysFile .ssh/authorized_keys
```

（c）**注释掉 administrators 分组规则**：Windows 默认配置尾部有如下段落，把 `Match` 行与其下所有指令行**逐行加 `#` 注释**：

```text
# 原始内容（需注释）
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys

# 注释后
#Match Group administrators
#       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

【**注意**】

第（c）步是免密成败的关键：该规则会让管理员组用户的公钥改从 `C:\ProgramData\ssh\administrators_authorized_keys` 读取（且该文件有严格 ACL 要求），不注释掉时写入用户家目录的公钥不会生效。遇到下一条 `Match` 指令时该段结束，`Match` 之后的内容不要注释。

（4）保存文件。缺少（a）（b）对应行时，直接在文件末尾追加即可。

#### 3.3 重启 sshd 生效

```powershell
Restart-Service sshd -Force
```

重启失败时先用备份回滚再检查修改内容：

```powershell
Copy-Item -Force "C:\ProgramData\ssh\sshd_config.bak" "C:\ProgramData\ssh\sshd_config"
```

### 4. 生成 Linux 端 MCP 桥接配置

对应命令菜单 `[8]`。MCP 本体运行在 Windows（由 `remote-start-mcp.bat` 拉起），Linux 端客户端通过 ssh 免密连入 Windows 调用。

#### 4.1 配置模板

（1）在 Windows 上查询登录用户名与 IP（模板中要用）：

```powershell
$env:USERNAME
ipconfig
```

（2）在 Linux 项目根目录创建 `.mcp.json`，按以下模板填写：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "mcpServers": {
    "embedded-board": {
      "command": "ssh",
      "args": [
        "-i", "~/.ssh/id_mcp_server",
        "-o", "ServerAliveInterval=60",
        "-o", "ServerAliveCountMax=3",
        "<Windows用户名>@<Windows IP>",
        "<项目根目录>/remote-start-mcp.bat"
      ]
    }
  }
}
```

（3）按实际情况修改两处：

（a）`<Windows用户名>@<Windows IP>`：Windows 登录用户名与本机 IP。多网卡时选 Linux 可达的那个网段 IP。

（b）`<项目根目录>/remote-start-mcp.bat`：Windows 上 `remote-start-mcp.bat` 的**绝对路径**，统一用正斜杠，如 `E:/AI/my-project/remote-start-mcp.bat`。

【**注意**】

保活两行参数（`ServerAliveInterval=60`、`ServerAliveCountMax=3`）的作用是链路断开时让 ssh 最迟 180 秒自行退出，触发 MCP 客户端掉线重连，建议保留（取值与命令生成模板一致）。

#### 4.2 首次连接信任主机

MCP 客户端首次连接会卡在主机密钥确认上，需先在 Linux 端手动连一次：

```bash
ssh -i ~/.ssh/id_mcp_server <Windows用户名>@<Windows IP>
```

（1）出现 `Are you sure you want to continue connecting?` 时输入 `yes` 完成信任，登录成功后 `exit` 退出。

（2）此步同时验证了免密登录是否生效——未提示输密码直接进入即配置成功。

（3）之后重启 Linux 端 Claude Code / ZCode / CodeBuddy，MCP 桥接 server `embedded-board` 即可自动免密连接。

---

## 三、 验证与故障排查

### 1. Windows 侧配置核对

对应命令菜单 `[5]`（只读诊断），逐项核对：

```powershell
# (a) 服务状态：Status 应为 Running，StartType 应为 Automatic
Get-Service sshd | Format-List Status, StartType

# (b) sshd_config 三项：均应有效（未注释）且取值正确
Select-String -Path "C:\ProgramData\ssh\sshd_config" -Pattern "PubkeyAuthentication|AuthorizedKeysFile|Match Group"

# (c) authorized_keys：输出公钥条数应大于 0
(Select-String -Path "$env:USERPROFILE\.ssh\authorized_keys" -Pattern "^\s*(ssh-rsa|ssh-ed25519|ecdsa-|sk-)").Count

# (d) 22 端口监听
Get-NetTCPConnection -LocalPort 22 -State Listen
```

### 2. Linux 侧连通性验证

```bash
# 免密登录验证（不提示密码直接进入即成功）
ssh -i ~/.ssh/id_mcp_server <Windows用户名>@<Windows IP>

# 端口连通性（不通则排查防火墙与 IP 选择）
ssh -v -i ~/.ssh/id_mcp_server <Windows用户名>@<Windows IP> 2>&1 | grep -i "connect"
```

### 3. 常见问题排查

（1）**仍提示输密码，免密不生效**：依次检查——`Match Group administrators` 段是否已整段注释；公钥是否写入了 Linux 登录所用 Windows 账户的家目录；`authorized_keys` 是否被存成 UTF-16 或每行末尾混入多余字符；修改后是否执行过 `Restart-Service sshd -Force`。

（2）**连接超时（Timeout）**：Windows 防火墙未放行 22 端口（见 1.5 节），或多网卡环境下 IP 选错，换用 `ipconfig` 列出的其它网段 IP。

（3）**连接拒绝（Connection refused）**：sshd 服务未启动，Windows 上执行 `Start-Service sshd`。

（4）**scp 回传公钥时密码被拒**：确认使用 Windows 本地账户密码（微软在线账户在部分 OpenSSH 版本下需用 PIN 对应的本地密码）；也可改用记事本手动复制粘贴公钥（见 2.2 节注意事项）。

（5）**MSI 静默安装后服务不存在**：正常现象，按 1.4 节用 `sshd.exe install` 补注册即可。

---

## 四、 卸载与清理

### 1. 手动卸载 OpenSSH 服务

对应命令菜单 `[6]`，顺序执行（先停服务再卸载，避免运行中的 sshd 占用文件）：

（1）停止服务：

```powershell
Stop-Service sshd -Force
```

（2）按安装方式卸载：

```powershell
# MSI 安装：本地保留有 MSI 包时静默卸载
msiexec /x "<MSI 完整路径>" /quiet /norestart
```

（3）MSI 包已丢失或系统组件安装时，用其它方式卸载：

```powershell
# 系统组件方式卸载
Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 或打开"程序和功能"图形界面手动卸载
cmd /c start "" appwiz.cpl
```

（4）删除服务残留（卸载有时不删服务）：

```powershell
sc.exe delete sshd
```

（5）从 `authorized_keys` 中删除 MCP 专用公钥行（删除 `id_mcp_server.pub` 对应的那一行，其它公钥保留）。

（6）从备份恢复 sshd_config：

```powershell
Copy-Item -Force "C:\ProgramData\ssh\sshd_config.bak" "C:\ProgramData\ssh\sshd_config"
Remove-Item "C:\ProgramData\ssh\sshd_config.bak"
```

【**注意**】

`C:\ProgramData\ssh` 目录可能含用户自定义配置，未自动删除；确认无需保留后可手动删除。

### 2. 清理 authorized_keys 失效公钥

对应命令菜单 `[9]`。CNB 等临时环境每次重建后指纹变化，`authorized_keys` 会残留失效公钥，批量清理方法：

（1）逐条核对指纹与注释（注释相同不代表重复，指纹才是可靠依据）：

```bash
# Linux 端查看某公钥指纹
ssh-keygen -lf ~/.ssh/id_mcp_server.pub
```

（2）Windows 上打开 `authorized_keys`，删除已失效（环境已销毁、指纹不再匹配）的公钥行后保存，每行一条、行间不留空行即可。

---

## 五、 相关文档

（1）[`Linux远程连接Windows MCP配置指南`](./Linux远程连接Windows%20MCP配置指南.md)：两个对偶命令的完整自动流程与整体架构。

（2）[`SSH免密登录故障排查`](./SSH免密登录故障排查.md)：免密登录问题进阶排查。

（3）[`MCP-CNB云环境访问Windows本地MCP方案`](./MCP-CNB云环境访问Windows本地MCP方案.md)：CNB 云环境场景下的公网隧道方案。

---

*本文档由 markdowncli 技能辅助生成*
