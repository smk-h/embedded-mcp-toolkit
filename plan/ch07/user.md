# 我的初步想法

前面已经知道了可以把mcp服务运行子啊windows本地，claude/opencode/zcode等可以运行在linux编译服务器中，这个时候就需要让linux服务器通过ssh免密登录windows。

我希望可以创建一个embedded-mcp-toolkit的命令，执行 embedded-mcp-toolkit sshd-config的时候执行。

## 1. 权限检查

执行前先检查是否在具有管理员权限的powershell中运行，若不是，则提示使用管理员权限启动并退出，若是才继续后面操作。

## 2.功能菜单

运行命令后，展示菜单，菜单包括

```text
[1] 安装windows ssh服务
[2] 编译服务器生成密钥对
[3] 配置windows中sshd服务
[4] 检查sshd配置状态（只读诊断）
[5] 卸载windows ssh服务
[6] 查看本机连接信息（用户名/IP）
```

- [1] 安装windows ssh服务

检查windows是否已经安装了sshd服务，若未安装，则参考 [连接到 OpenSSH 服务器](https://learn.microsoft.com/zh-cn/windows-server/administration/openssh/openssh_install_firstuse?tabs=powershell&pivots=windows-11) 这里参考powershell命令来在线安装，或者从 [OpenSSH-Win64-v10.0.0.0.msi](https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi)这里下载msi后自动安装

- [2] 编译服务器生成密钥对

通过ssh远程登录linux服务器，检查sshd是否启动，若未启动，则提示用户安装后重试，并给出安装命令，然后提示用户安装后重试。安装完毕后，在linux服务端生成公钥，并通过sftp把公钥文件传输过来到 .embedded/ssh 目录

- [3] 配置windows中sshd服务

把公钥文件写入windows下的 ~/.ssh/authorized_keys，写入完毕后检查windows下的sshd配置，保证linux登录的时候使用 ~/.ssh/authorized_keys。

- [5] 卸载windows ssh服务

提供卸载能力，对应 [1] 的逆操作。卸载时优先用当初安装的 MSI 包执行 `msiexec /x` 静默卸载（与安装时的 msiexec /i 对应）；如果本地 MSI 包已经删了，就自动打开"程序和功能"（appwiz.cpl），提示用户在图形界面里找到 OpenSSH 手动卸载。

卸载完成后，清理可能残留的 sshd 服务（有时 MSI 卸载不删服务，用 sc.exe delete 补删）。C:\ProgramData\ssh 配置目录不自动删（可能含用户自定义配置），只在末尾提示用户如需彻底清除可手动删除。

- [6] 查看本机连接信息

展示当前 Windows 的用户名和 IP 地址，方便拿到 Linux 端拼 ssh 命令。用户名用 Node 的 os.userInfo() 取，IP 用 os.networkInterfaces() 枚举所有网卡的 IPv4 地址（过滤掉回环、虚拟网卡）。最后拼一条可直接在 Linux 端执行的 ssh 命令示例（含 -i ~/.ssh/id_mcp_server 指定专用密钥）。

## 3. 安装方式检测

[5] 卸载前需要知道当前 OpenSSH 是怎么装的（MSI 还是 Windows Capability），才能选对应的卸载命令——msiexec /x 卸不干净 Capability 装的，反之亦然。

检测思路是综合看几个信号：
- `Get-WindowsCapability` 的 State（Installed 表示 Capability 装的，但 MSI 装的有时也会被探测到，不完全可靠）
- sshd 服务的 ImagePath（最可靠：路径含 Program Files\OpenSSH 的是 MSI 装的，含 System32\OpenSSH 的是 Capability 装的）
- sshd.exe 文件落在哪个目录（服务没注册时的兜底信号）

这个检测结果也在 [4] 检查状态里展示出来，让用户能看到当前 OpenSSH 的来源。

## 4. 关键决策（需求澄清后补充）

以下三点在需求澄清阶段确认，作为后续开发的约束：

### 4.1 Linux 编译服务器连接信息的获取方式：交互式逐项输入

第 [2] 步要 SSH 登录 Linux 编译服务器时，其连接信息（host、端口、用户名、密码）通过命令运行时交互式逐项输入（readline 提示），**不落盘、不持久化**，避免敏感凭据留在文件中。

### 4.2 Linux 侧生成密钥的用户身份：与登录用户相同

第 [2] 步在 Linux 上 `ssh-keygen` 生成密钥对时，使用「登录该 Linux 服务器的那个用户」身份执行。也就是说：将来从 Linux 免密登录 Windows 的，就是这次连接用的那个 Linux 用户。

### 4.3 Windows OpenSSH administrators_authorized_keys 易踩坑点：修改 sshd_config 禁用分组

Windows OpenSSH 默认有一条 `Match Group administrators` 规则，会让 Administrators 组成员的公钥读 `C:\ProgramData\ssh\administrators_authorized_keys` 而非用户家目录下的 `~/.ssh/authorized_keys`。处理方式：在第 [3] 步修改 `C:\ProgramData\ssh\sshd_config`，**注释掉/删除 Match Group administrators 段及其 `AuthorizedKeysFile` 指令**，让管理员账户也统一走 `~/.ssh/authorized_keys`。

### 4.4 命令位置与交互模型

- 新增顶层命令 `embedded-mcp-toolkit sshd-config`。
- 执行后先做管理员权限检查，通过后展示三选一菜单，用户输入序号选择执行哪一项（可重复选择，直到选择退出）。
- 每一项执行完毕后回到主菜单，支持单独执行某一项（例如第 [3] 步可独立重跑）。

### 4.5 目标平台

本命令仅在 Windows 上有意义（安装 Windows SSH 服务、配置 Windows sshd）。在非 Windows 平台运行时应给出明确提示并退出。
