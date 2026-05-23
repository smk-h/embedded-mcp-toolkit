<!-- more -->

## 一、 psh简介

### 1. 是什么？

`psh`（Portal Shell，门禁 Shell）是一个终端门禁安全系统。它作为**守门程序（gate shell）** 替代系统登录 Shell，在用户提供有效解锁密钥之前，锁定终端并拦截所有非法命令。

**工作流程：** 启动后呈现锁定界面 → 仅允许 `dmesg`、`ps` 诊断命令 → 输入 `debug` 获取挑战码 → 输入正确密钥 → `execvp` 进入真正的 Shell。

**核心思路：** 系统管理者可以将锁定的控制台交由他人操作——对方可以查看日志和进程列表，但必须在获得解锁密钥后才能执行任意命令。

### 2. 系统架构与原理

#### 2.1 架构全景

```
                    ┌─────────────┐
                    │  init (PID1)│  ← systemd / busybox-init / sysvinit
                    │             │
                    │  respawn:   │  ← auto-restart on exit
                    │   -/bin/psh │  ← "-" prefix = login shell
                    └──────┬──────┘
                           │ fork/exec
                    ┌──────▼──────┐
                    │     psh     │
                    │ (gate prog) │
                    └──────┬──────┘
                           │
              ┌────────────┼───────────────┐
              │            │               │
        ┌─────▼──────┐ ┌───▼──────┐ ┌──────▼───────┐
        │MODE_LOCKED │ │ debug    │ │MODE_UNLOCKING│
        │ dmesg/ps   │ │→challenge│ │ enter key    │
        │ others deny│ └──────────┘ └──────┬───────┘
        └────────────┘                     │
                                     key == "123456"?
                                           │ yes
                                   ┌───────▼───────┐
                                   │   /bin/sh -l  │  ← execvp replaces psh
                                   │ (login shell) │
                                   └───────────────┘
```

#### 2.2 进程流转

（1）**Init 拉起 psh：** 通过 init 配置（inittab 的 `respawn` 或 systemd 的 `Restart=always`）以 login shell 方式启动 psh，进程退出后 init 自动重启。

（2）**锁定模式：** 主循环读取用户输入——白名单命令 (`dmesg` / `ps`) fork 子进程执行后返回；`debug` 生成挑战码并切换到解锁模式；其他输入一律提示不支持。

（3）**解锁模式：** 等待密钥输入——空输入取消并回到锁定模式，错误密钥拒绝，正确密钥 (`123456`) 跳出主循环。

（4）**Shell 启动：** 通过 `execvp("/bin/sh", {"sh", "-l", NULL})` 将 psh 进程完全替换为登录 Shell。**使用 execvp 而非 fork 子进程的好处**：无额外父进程残留、新 Shell 继承相同 PID 和 TTY、Shell 退出后 init 通过 respawn 自动重新拉起 psh。

### 3. 安全机制

| 机制 | 说明 |
|------|------|
| 白名单命令策略 | 仅 `dmesg`、`ps`、`free`、`top` 为安全的只读诊断命令 |
| 信号拦截 | 忽略 SIGINT / SIGTSTP，防止 Ctrl-C / Ctrl-Z 绕过认证 |
| 挑战码机制 | 每次 `debug` 生成新随机码 `PSH-XXXX-XXXX-XXXX-XXXX` |
| 日志审计 | 记录 START、AUTH_OK、EXIT_FAIL 到 `/var/log/psh.log` |

## 二、psh设计

### 1. 关键函数

#### 1.1 launch_shell() —— 解锁后启动真正 Shell

```c
static void launch_shell(void)
{
    const char *shell = DEFAULT_SHELL;
    char *argv[3];

    argv[0] = (char *)shell;
    argv[1] = "-l";
    argv[2] = NULL;

    setenv("PSH_AUTH", "1", 1);

    execvp(shell, argv);

    perror("psh: execvp failed");
    exit(1);
}
```

【**设计要点**】

- 直接使用 `DEFAULT_SHELL`（`/bin/sh`），**不读取 `$SHELL` 环境变量**。因为 sshd 会将 `$SHELL` 设为 `/etc/passwd` 中的值（即 `/bin/psh`），读取 `$SHELL` 会导致 psh 递归启动自身。
- 传递 `-l` 参数，使 `/bin/sh` 以登录模式启动，从而加载 `/etc/profile`，命令行提示符显示为 `root@ATK-IMX6U:~#` 而非默认的 `sh-4.3#`。
- 设置 `PSH_AUTH=1` 环境变量，供下游脚本或程序识别已认证状态。

#### 1.2 main() —— 交互/非交互模式分流

```c
if (!isatty(STDIN_FILENO)) {
    char **sh_argv = malloc((argc + 1) * sizeof(char *));
    sh_argv[0] = DEFAULT_SHELL;
    for (i = 1; i < argc; i++)
        sh_argv[i] = argv[i];
    sh_argv[argc] = NULL;
    execvp(DEFAULT_SHELL, sh_argv);
    ...
}
```

【**设计要点**】

- 通过 `isatty()` 判断当前会话是否为交互式终端。
- **交互模式**（有 TTY）：串口登录、SSH 交互登录 → 进入 psh 锁定/认证流程。
- **非交互模式**（无 TTY）：SSH 远程命令、SCP → 透明透传到 `/bin/sh`，转发全部参数。

#### 1.3 信号处理

```c
static void signal_handler(int sig)
{
    switch (sig) {
    case SIGINT:
    case SIGTSTP:
        break;
    case SIGTERM:
        _exit(0);
    }
}
```

- `SIGINT`（Ctrl-C）：忽略，防止通过中断绕过认证。
- `SIGTSTP`（Ctrl-Z）：忽略，防止挂起到后台绕过认证。

#### 1.4 run_portal_shell()

该函数在 `psh.c` 文件中声明：

```c
static void run_portal_shell(void);
```

【**函数作用**】实现 psh 的双模式状态机主循环：`MODE_LOCKED` 下拦截非法命令并处理白名单指令；`MODE_UNLOCKING` 下接收并验证解锁密钥。通过全局变量 `authenticated` 传递认证结果。

#### 1.5 verify_key()

该函数在 `psh.c` 文件中声明：

```c
static int verify_key(const char *user_key);
```

【**函数作用**】采用固定密钥比对，检查用户输入是否为 `"123456"`。

【**参数含义**】

- `user_key`：用户输入的密钥字符串

【**返回值**】返回 1 表示验证通过，返回 0 表示失败。

#### 1.6 generate_challenge()

该函数在 `psh.c` 文件中声明：

```c
static void generate_challenge(char *output, size_t len);
```

【**函数作用**】基于纳秒级时间戳和进程 ID 生成随机种子，输出格式为 `PSH-XXXX-XXXX-XXXX-XXXX` 的十六进制挑战码。

【**参数含义**】

- `output`：输出缓冲区指针
- `len`：缓冲区大小

【**返回值**】无返回值。结果写入缓冲区并设置 `challenge_generated = 1`。

### 2. 使用方法与示例

#### 2.1 本地编译运行

```bash
make psh                    # 编译
sudo make install           # 安装到 /bin/psh
/bin/psh                    # 直接运行
```

#### 2.2 交互示例

```
╔════════════════════════════════════════╗
║       Portal Shell v2.0                ║
╠════════════════════════════════════════╣
║  System is LOCKED                      ║
║  - dmesg   View kernel log             ║
║  - ps      Show process list           ║
║  - debug   Get unlock code             ║
╚════════════════════════════════════════╝

locked> ls
[PSH] Command not supported in locked mode.
[PSH] Available commands: dmesg, ps, debug

locked> debug
╔════════════════════════════════════════╗
║  Challenge: PSH-A3F1-7B2E-90C4-D518    ║
║  Fixed Key: 123456                     ║
║  Enter '123456' to unlock shell        ║
╚════════════════════════════════════════╝
Enter key to unlock: 123456
[PSH] Access Granted! Unlocking shell...
$ _
```

#### 2.3 串口登录

串口连接后直接进入 psh 锁定界面：

```
[mxc0] ...

╔════════════════════════════════════════╗
║         Protect Shell v2.1             ║
╚════════════════════════════════════════╝

locked> debug
Enter key to unlock: 123456

[PSH] Access Granted! Unlocking shell...

root@ATK-IMX6U:~#
```

#### 2.4 SSH 交互登录

```bash
$ ssh root@192.168.16.105
root@192.168.16.105's password:  <SSH 密码>

...（同上 psh 锁定界面）

locked> debug
Enter key to unlock: 123456

root@ATK-IMX6U:~#
```

#### 2.5 SSH 非交互命令（透明透传）

无需解锁，psh 自动透传：

```bash
$ ssh root@192.168.16.105 "ls -la /"
total 76
drwxr-xr-x  24 root root  4096 ...

$ ssh root@192.168.16.105 "cat /proc/cpuinfo"
...
```

#### 2.6 SCP 文件传输（透明透传）

```bash
$ scp myfile root@192.168.16.105:/tmp/
myfile           100%   11KB  11.0KB/s   00:00
```

---

## 三、 系统部署指南

psh 依赖 init 系统的 respawn 机制持续拉起。不同 init 系统配置方式不同。

### 1. 前置准备（所有系统通用）

```bash
# 安装编译工具和依赖
sudo apt-get install -y gcc make procps
# procps 提供 ps 命令（psh 白名单命令之一）
# dmesg 由 util-linux 提供，为基础包无需显式安装

# 编译安装
make psh
sudo cp psh /bin/psh && sudo chmod 0755 /bin/psh

# 创建日志文件
sudo touch /var/log/psh.log && sudo chmod 0666 /var/log/psh.log
```

### 2. 几个常见系统

除了busybox的，其他几个暂时没有做验证。

#### 2.1 BusyBox init —— 嵌入式系统（OpenWrt / Alpine 等）

BusyBox init 原生支持 `/etc/inittab`，直接指向 psh：

```bash
echo "::respawn:-/bin/psh" >> /etc/inittab
reboot
```

#### 2.2 systemd —— 现代桌面/服务器系统（Ubuntu / Debian 12+）

项目中提供了现成的 service 模板文件和自动化部署脚本：

```bash
# 编译 + 安装 + 启用服务（一键完成）
sudo ./docker/setup-systemd.sh

# 仅安装不编译
sudo ./docker/setup-systemd.sh install

# 卸载
sudo ./docker/setup-systemd.sh remove
```

脚本自动完成以下步骤：

（1）编译安装 psh 到 `/bin/psh`

（2）创建审计日志 `/var/log/psh.log`

（3）systemctl enable --now` 启动服务

手动配置时，关键参数：`Restart=always` 等效于 inittab 的 respawn，`StandardInput=tty` **必须设置**，否则 psh 的 `isatty()` 检查会失败。

调试时可通过 `journalctl -u psh.service -f` 查看日志。

#### 2.3 sysvinit —— 传统 Debian 系统（可选）

```bash
sudo apt-get purge -y systemd systemd-sysv
sudo apt-get install -y sysvinit-core sysvinit-utils
echo "::respawn:-/bin/psh" | sudo tee -a /etc/inittab
sudo reboot
```

【**警告**】替换 systemd 可能导致依赖它的服务异常，仅建议在隔离环境中使用。

#### 2.4 方案对比

| 方案 | 配置文件 | 配置行数 | TTY 绑定 | 适用场景 |
|------|----------|----------|----------|----------|
| BusyBox init | `/etc/inittab` | 1 行 | 自动 | 嵌入式设备首选 |
| systemd | `psh.service` 文件 | ~15 行 | 需显式指定 | 服务器/桌面首选 |
| sysvinit | `/etc/inittab` | 1 行 | 自动 | 旧版系统兼容 |

### 3. 串口 + SSH 双通道部署示例

以下配置适用于嵌入式 Linux 系统，使**串口登录**和 **SSH 登录**都经过 psh 认证，同时保证 SCP 和非交互式 SSH 命令不受影响。下面的示例是在busybox根文件系统中进行。

####  3.1 串口 + SSH 双通道架构

```
串口登录                    SSH 登录
   │                          │
   ▼                          ▼
init (inittab)               sshd
   │                          │
   │ ::respawn:-/bin/psh      │ read /etc/passwd → shell = /bin/psh
   ▼                          ▼
┌─────────────────────────────────────────┐
│              psh (gate prog)            │
│                                         │
│  ┌──────────┐     ┌──────────────┐      │
│  │ 无 tty?  │ yes │ 透明透传:      │     │
│  │          │ ──► │ exec /bin/sh │      │
│  └──────────┘     │ (转发所有参数) │      │
│       │ no        └──────────────┘      │
│       ▼                                 │
│  ┌──────────┐                           │
│  │ 锁定界面  │  ── debug ──►  挑战码     │
│  │ dmesg/ps │  ◄────────   输入密钥     │
│  └────┬─────┘                          │
│       │ 密钥正确                         │
│       ▼                                 │
│  ┌─────────────────────────┐            │
│  │ execvp("/bin/sh",       │            │
│  │         {"sh", "-l"})   │  登录模式   │
│  └─────────────────────────┘            │
└─────────────────────────────────────────┘
```

#### 3.2 编译与部署

##### 3.2.1 编译

```bash
# ARM 交叉编译
CC=arm-linux-gnueabihf-gcc
CFLAGS="-Wall -Wextra -O2 -D_GNU_SOURCE"
$CC $CFLAGS -o psh psh.c

```

若是在windows下可以使用docker编译：

```shell
# PowerShell script for building psh using Docker cross-compiler
# Usage: .\build-docker.ps1 [-Clean]

param(
    [switch]$Clean
)

# Configuration
$ImageName = "docker.cnb.cool/smk.k/alpha/dev-env/alpha-dev-env"
$ContainerName = "psh-builder"
$SourceDir = $PSScriptRoot
# Cross-compiler path in container
$CrossCompilerPath = "/opt/gcc-arm-8.3-2019.03-x86_64-arm-linux-gnueabihf/bin"

Write-Host "=== psh Docker Build Script ===" -ForegroundColor Cyan
Write-Host "Source directory: $SourceDir" -ForegroundColor Gray

# Check if Docker is available
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed or not in PATH"
    exit 1
}

# Build docker run arguments
$DockerArgs = @(
    "run",
    "--rm",
    "--name", $ContainerName,
    "-v", "${SourceDir}:/workspace",
    "-w", "/workspace",
    "-e", "PATH=${CrossCompilerPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    $ImageName
)

if ($Clean) {
    Write-Host "Cleaning build artifacts..." -ForegroundColor Yellow
    $DockerArgs += "make", "clean"
} else {
    Write-Host "Building psh..." -ForegroundColor Yellow
    $DockerArgs += "make", "psh"
}

Write-Host "Running: docker $($DockerArgs -join ' ')" -ForegroundColor Gray

# Execute docker command
& docker $DockerArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nBuild completed successfully!" -ForegroundColor Green
    
    # List generated files
    $artifacts = @("psh", "bg-demo")
    foreach ($file in $artifacts) {
        $filePath = Join-Path $SourceDir $file
        if (Test-Path $filePath) {
            $size = (Get-Item $filePath).Length
            Write-Host "  - $file ($size bytes)" -ForegroundColor Gray
        }
    }
} else {
    Write-Error "Build failed with exit code: $LASTEXITCODE"
    exit $LASTEXITCODE
}

```

主要逻辑就是，挂载my-psh到容器中，直接编译。

##### 3.2.2 上传

```powershell
# 上传到板卡
scp psh root@192.168.16.105:/tmp/psh
scp -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa psh root@192.168.16.105:/tmp/psh
ssh root@192.168.16.105 "cp -f /tmp/psh /bin/psh && chmod +x /bin/psh"
```

在旧版内核(4.x)的 SSH 服务仅支持 ssh-rsa 主机密钥算法，而新版 ssh2 客户端默认已禁用此算法，通过 BOARD_HOST_KEY_ALGORITHMS 环境变量可显式指定算法列表，避免 "no matching host key type found" 错误。有时候改完还会报下面问题：

```powershell
E:\AI\embedded-mcp-toolkit\my-psh [main ≡ +0 ~1 -0 | +1 ~7 -0 !]> scp -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa psh root@192.168.16.105:/tmp/psh
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
It is also possible that a host key has just been changed.
The fingerprint for the RSA key sent by the remote host is
SHA256:Bvp2Hy5C2hdm1KoEtAoRWInu1pEZgIqDmAGx+L3t2m0.
Please contact your system administrator.
Add correct host key in C:\\Users\\username/.ssh/known_hosts to get rid of this message.
Offending RSA key in C:\\Users\\username/.ssh/known_hosts:24
Host key for 192.168.16.105 has changed and you have requested strict checking.
Host key verification failed.
C:\WINDOWS\System32\OpenSSH\scp.exe: Connection closed
```

这个一般是设备的主机密钥已更改，需要先删除旧的密钥记录，可以执行：

```powershell
ssh-keygen -R 192.168.16.105
```

#### 3.3 配置串口（/etc/inittab）

在 inittab 中添加 psh 作为前台登录程序（无需 getty，psh 自带认证和管理终端）：

```shell
::sysinit:/etc/init.d/rcS
::respawn:-/bin/psh
::restart:/sbin/init
```

参数说明：

- `::sysinit`：系统初始化脚本，在 respawn 之前执行，确保文件系统、网络等就绪
- `::respawn:-/bin/psh`：以 login shell 方式启动 psh，空 id 字段绑定到 init 控制台；进程退出后 init 自动重启
- `::restart:/sbin/init`：`kill -HUP 1` 时重新执行 init，热加载 inittab 修改，无需 reboot

#### 3.4 配置 SSH（/etc/passwd + /etc/shells）

修改 root 的登录 Shell：

```shell
root:x:0:0:root:/home/root:/bin/psh
```

将 `/bin/psh` 加入有效 Shell 列表：

```shell
# /etc/shells: valid login shells
/bin/sh
/bin/psh
```

#### 3.5 重启生效

```bash
reboot
```

## 四、排查与常见问题

### 1. 排查清单

| 步骤 | 检查项 | 命令 |
|------|--------|------|
| 1 | 二进制是否可执行 | `file /bin/psh` |
| 2 | psh 是否正常运行 | `ps aux \| grep psh` |
| 3 | 串口 inittab 配置 | `grep psh /etc/inittab` |
| 4 | root shell 配置 | `grep ^root /etc/passwd` |
| 5 | /etc/shells 包含 psh | `grep psh /etc/shells` |
| 6 | psh 日志 | `cat /var/log/psh.log` |
| 7 | 提示符是否为 `sh-4.3#` | 检查 `launch_shell()` 是否传递了 `-l` 参数 |

### 2. 常见问题

#### 2.1 SSH 登录后直接显示 shell，没有 psh

**原因**：`/etc/passwd` 中 root 的 shell 仍为 `/bin/sh`。

**解决**：

```bash
sed -i 's|^root:x:0:0:root:/home/root:/bin/sh|root:x:0:0:root:/home/root:/bin/psh|' /etc/passwd
```

#### 2.2 SSH 登录提示密码错误 / 拒绝连接

**原因**：`/etc/shells` 中未包含 `/bin/psh`，sshd 拒绝登录。

**解决**：

```bash
echo "/bin/psh" >> /etc/shells
```

#### 2.3 解锁后弹出 psh 锁定界面，反复循环

**原因**：`launch_shell()` 中读取了 `$SHELL` 环境变量，而 `$SHELL` 被设为 `/bin/psh`，导致递归启动自身。

**解决**：确保 `launch_shell()` 直接使用 `DEFAULT_SHELL`（`/bin/sh`），不读取 `$SHELL`。

#### 2.4 提示符显示 `sh-4.3#` 而非 `root@ATK-IMX6U:~#`

**原因**：psh 启动 shell 时未传递 `-l` 参数，shell 以非登录模式启动，`/etc/profile` 未被加载。

**解决**：在 `launch_shell()` 的 `argv[1]` 中添加 `"-l"` 参数。

#### 2.5 SCP 上传失败 / SSH 远程命令报错

**原因**：psh 在非交互模式下（无 TTY）拒绝执行，打印 `psh: not a terminal`。

**解决**：在 `main()` 中增加非交互模式检测，无 TTY 时直接 `exec /bin/sh` 并转发全部参数。

#### 2.6 串口无显示或无法交互

**原因**：使用 `::respawn:-/bin/psh` 格式时，绑定的是 init 当前控制台；若串口不是控制台，则 psh 不会出现在串口上。

**解决**：在 inittab 中指定确切 tty 设备，例如 `ttymxc0::respawn:-/bin/psh`；或确认内核 console 参数与串口一致。

---

*本文档由 markdowncli 技能辅助生成*
