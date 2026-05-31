## 一、简介

### 1. 是什么？

`embedded-mcp-toolkit` 是一个基于 MCP（Model Context Protocol）协议的嵌入式板卡远程管理工具，通过多个 MCP 工具提供嵌入式设备交互能力。支持以下功能：

- **串口管理**：打开/关闭串口连接、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、进入 U-Boot 命令行
- **SSH 管理**：打开/关闭 SSH 会话、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、查看远端设备活跃连接
- **本地 PowerShell**：打开/关闭本地 PowerShell 会话、发送命令、读取输出，方便在对话中直接操作 Windows 环境
- **Windows 系统扫描**：扫描可用 COM/LPT 端口、扫描本机网络适配器与 IP 配置
- **基础信息**：查询 MCP 服务器版本、获取当前设备配置信息
- **多会话管理**：同时保持多个串口、SSH、PowerShell 会话，支持独立读写
- **KeyProvider 密钥管理**：支持文件 IPC 和终端交互两种方式，自动处理 PSH 动态口令生成的密钥
- **进程退出自动清理**：客户端断开或进程终止时自动释放所有串口、SSH、PowerShell 连接

### 2. 怎么安装

#### 2.1 npm

目前支持工具的全局安装和本地指定目录安装，但是全局安装后还是只能在某个目录配置使用（需要claude配置文件、设备配置文件、mcp配置文件以及日志等），暂未测试过全局配置。

```shell
mkdir mcp-toolkit
cd mcp-toolkit

# 当前目录安装
npm i @smai-kit/embedded-mcp-toolkit

# 初始化
./node_modules/.bin/embedded-mcp-toolkit init
```

安装配置完成后目录结构如下：

```shell
mcp-toolkit
├── .claude                      # claude配置目录   
│   ├── CLAUDE.md
│   ├── settings.local.json      # 项目配置文件，不用管
│   ├── skills                   # claude skills,只是写了一些技能，实际可能不需要
│   ├── start-claude.bat.tmp     # 以指定环境变量启动claude的bat脚本
│   └── start-claude.ps1.tmp     # 以指定环境变量启动claude的powershell脚本
├── .mcp.json                    # claude code的mcp配置文件
├── .opencode                    # opencode的配置目录，暂时不用管
│   └── opencode.json
├── configs                      # 配置目录
│   ├── challenge.txt            # 登录psh时的挑战码（动态口令）
│   ├── config.example.yaml      # 配置模板文件
│   ├── config.yaml              # 复制上面的模板文件，进行板子的添加和修改
│   └── password_input.txt       # 密钥文件，通过挑战码生成
├── log                          # 日志目录，当前claude启动时会自动创建，写入一些工具调用日志
│   ├── 2026-05-27_09-06-09.log
├── node_modules                 # node依赖包目录，可以不用管
│   ├── .bin
│   ├── .package-lock.json
│   ├── @smai-kit                # @smai-kit/embedded-mcp-toolkit中是编译后的js脚本
│   ├── #...
│   └── zod
├── package-lock.json
└── package.json                 # npm项目包依赖管理文件，不用管
```

#### 2.2 源码安装

git clone源码后：

```shell
npm i         # 安装依赖
npm run build # 编译，编译后就可以在当前目录下启动claude使用了
```

### 3. 工具介绍

#### 3.1 基础工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `greet_tool` | 测试工具，按名称问候 | `给苏木打个招呼` |
| `version_tool` | 获取 MCP 服务器版本和工具包信息 | `当前MCP版本是什么` |
| `device_info_tool` | 获取当前设备配置（SSH、串口、KeyProvider） | `当前设备信息是什么` / `列出默认的设备` |

#### 3.2 串口工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `serial_open` | 打开串口连接，启动交互式 shell 会话 | `打开串口` / `连接 COM3` |
| `serial_close` | 关闭串口会话，释放端口资源 | `关闭串口` / `退出串口 serial_1` |
| `serial_write` | 向串口会话发送命令 | `向串口发送命令` / `在串口执行 whoami` |
| `serial_read` | 读取串口会话的输出数据 | `读取串口输出` / `看看串口返回了什么` |
| `serial_list` | 列出所有活跃的串口会话 | `列出串口会话` / `当前有哪些串口连接` |
| `serial_exec` | 向串口发送命令并等待输出（write + delay + read） | `在串口执行 uname -a` / `让串口运行命令 xxx` |
| `serial_shell_login` | 一键串口登录，自动检测 PSH 状态并解锁 | `串口一键登录` / `串口登录 board-test` |
| `serial_enter_uboot` | 重启设备并进入 U-Boot 命令行 | `重启进入 uboot` / `进入 U-Boot 命令行` |

#### 3.3 SSH 工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `ssh_shell_open` | 打开交互式 SSH shell 会话 | `打开 SSH` / `SSH 连接 board-test` |
| `ssh_shell_close` | 关闭 SSH shell 会话，释放连接 | `关闭 SSH` / `退出 ssh_1` |
| `ssh_shell_write` | 向 SSH 会话发送命令 | `SSH 发送命令` / `在 ssh 里执行 ls` |
| `ssh_shell_read` | 读取 SSH 会话的输出数据 | `读取 SSH 输出` / `SSH 返回了什么` |
| `ssh_shell_list` | 列出所有活跃的 SSH 会话 | `列出 SSH 会话` / `当前有哪些 SSH 连接` |
| `ssh_shell_exec` | 向 SSH 发送命令并等待输出（write + delay + read） | `SSH 执行 ifconfig` / `在 SSH 运行命令 xxx` |
| `ssh_shell_connection` | 检查远端板卡上活跃的 SSH 连接 | `查看设备上的 SSH 连接` / `谁连到了这台设备` |
| `ssh_shell_login` | 一键 SSH 登录，自动检测 PSH 状态并解锁 | `SSH 一键登录` / `SSH 登录 board-test` |

#### 3.4 Windows 工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `port_scan_tool` | 扫描 Windows 设备管理器中的 COM / LPT 端口 | `扫描可用串口` / `查看有哪些 COM 口` |
| `network_scan_tool` | 扫描 Windows 网络适配器和 IP 配置 | `扫描网络适配器` / `查看本机网卡信息` |
| `power_shell_open` | 打开本地 PowerShell 交互式会话 | `打开 PowerShell` / `启动本地 PowerShell` |
| `power_shell_close` | 关闭 PowerShell 会话并终止进程 | `关闭 PowerShell` / `退出 power_1` |
| `power_shell_write` | 向 PowerShell 会话发送命令 | `PowerShell 执行命令` / `执行 ps 命令 xxx` |
| `power_shell_read` | 读取 PowerShell 会话的输出数据 | `读取 PowerShell 输出` / `PowerShell 返回了什么` |
| `power_shell_list` | 列出所有活跃的 PowerShell 会话 | `列出 PowerShell 会话` / `当前有哪些 ps 会话` |
| `power_shell_exec` | 向 PowerShell 发送命令并等待输出（write + delay + read） | `PowerShell 执行 ipconfig` / `用 ps 运行 xxx` |

## 二、配置说明

### 1. claude配置

目前还未测试过全局配置，后续测试验证。**当前配置下，只测试过在指定项目目录使用**。

#### 1.1 `.claude/settings.local.json`

```json
{
  "permissions": {
    "allow": [
      "mcp__embedded-board__device_info_tool",
      "mcp__embedded-board__ssh_shell_login",
      "mcp__embedded-board__ssh_shell_connection",
      "mcp__embedded-board__ssh_shell_close",
      "mcp__embedded-board__serial_shell_login",
      "mcp__embedded-board__serial_close",
      "mcp__embedded-board__serial_exec",
      "mcp__embedded-board__version_tool",
      "mcp__embedded-board__ssh_shell_exec",
      "mcp__embedded-board__serial_list",
      "mcp__embedded-board__serial_read",
      "mcp__embedded-board__ssh_shell_list"
    ]
  },
  "enabledMcpjsonServers": [
    "embedded-board"
  ]
}
```

- `permissions`：允许claude自动执行而不需要用户确认，这个其实不用管，在claude code运行时会提醒 `Yes, and don’t ask again for: xxxx`，选择这个就会自动添加到这里，下一次再运行就不需要再确认。
- `enabledMcpjsonServers`：启用的 MCP 服务器列表。当前仅启用 `embedded-board`。

#### 1.2 `.mcp.json`

此文件和`.claude`同级，文件内容如下（npm本地安装）：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "mcpServers": {
    "embedded-board": {
      "command": "./node_modules/.bin/embedded-mcp-toolkit",
      "args": [],
      "env": {
        "DEVICE": "board-b",
        "BOARD_CONFIG_PATH": "./configs/config.yaml",
        "LOG_SAVE": "1",
        "LOG_DIR": "./log"
      }
    }
  }
}
```

这个是`MCP`的配置文件。`env` 字段中定义的环境变量会在 Claude 启动 MCP server 时，**注入到 MCP server 子进程** 的 `process.env` 中。也就是说，这些变量只在 [src/mcp.ts](src/mcp.ts:102-107) 进程中通过 `process.env.DEVICE` 等方式读取，**不会** 影响 Claude 自身的 shell 环境变量。

- `DEVICE`：默认的设备名称，对应 [`config.yaml`](configs/config.example.yaml:163) 中 `devices` 下的 key
- `BOARD_CONFIG_PATH`：配置文件路径，相对于 **MCP server 进程的工作目录**（即启动 Claude 时的 `cwd`）
- `LOG_SAVE`：是否存储日志到文件（`"1"` 表示开启），会记录工具调用信息，例如工具名称、调用时传入的参数
- `LOG_DIR`：日志存储的目录，同样相对于 MCP server 进程的工作目录

> Tips：MCP server 进程的工作目录就是启动 Claude（或其他 MCP 客户端）时所在的目录。可以在日志文件的第一行看到 `cwd: xxx` 来确认实际的工作目录。
>
> 环境变量不生效？看一下这里：[常见问题 2. 环境变量未生效？](#section1)

### 2. 日志信息

这个是在`.mcp.json`中配置的，得到的日志信息可能如下：

```powershell
[2026-05-27 18:55:39] [INFO] MCP server starting... cwd: E:\AI\embedded-mcp-toolkit
[2026-05-27 18:55:39] [INFO] MCP server env: {"DEVICE":"board-b","BOARD_CONFIG_PATH":"./configs/config.yaml","LOG_SAVE":"1","LOG_DIR":"./log"}
[2026-05-27 18:56:20] [INFO] [greet_tool] name=苏木
[2026-05-27 18:56:27] [INFO] [version_tool]
[2026-05-27 18:56:38] [INFO] [device_info_tool] device=(default)
[2026-05-27 18:56:38] [INFO] Config loaded: E:\AI\embedded-mcp-toolkit\configs\config.yaml
[2026-05-27 18:56:38] [INFO] Device resolved: board-b
[2026-05-27 18:56:38] [INFO] [KeyProvider/ssh] challenge file: E:\AI\embedded-mcp-toolkit\configs\challenge.txt
[2026-05-27 18:56:38] [INFO] [KeyProvider/ssh] key file:       E:\AI\embedded-mcp-toolkit\configs\password_input.txt
[2026-05-27 18:56:38] [INFO] [KeyProvider/serial] challenge file: E:\AI\embedded-mcp-toolkit\configs\challenge.txt
[2026-05-27 18:56:38] [INFO] [KeyProvider/serial] key file:       E:\AI\embedded-mcp-toolkit\configs\password_input.txt
[2026-05-27 18:57:13] [INFO] [serial_open] device=(default) port=(auto) baudRate=115200
[2026-05-27 18:57:13] [INFO] Device resolved: board-b
[2026-05-27 18:57:13] [INFO] [serial_open] session opened: serial_1 port=COM3
[2026-05-27 18:57:36] [INFO] [serial_close] session_id=serial_1
[2026-05-27 18:57:55] [INFO] [serial_shell_login] device=(default) timeout=1500 key=(none)
[2026-05-27 18:57:55] [INFO] Device resolved: board-b
[2026-05-27 18:57:57] [INFO] [serial_shell_login] session opened: serial_2 port=COM3
[2026-05-27 18:58:13] [INFO] [serial_exec] session_id=serial_2 command=exit delay=1000 clear=1
[2026-05-27 18:58:27] [INFO] [serial_shell_login] device=(default) timeout=1500 key=(none)
[2026-05-27 18:58:27] [INFO] Device resolved: board-b
[2026-05-27 18:58:30] [INFO] Device resolved: board-b
[2026-05-27 18:58:30] [INFO] [KeyProvider/serial] challenge file: E:\AI\embedded-mcp-toolkit\configs\challenge.txt
[2026-05-27 18:58:30] [INFO] [KeyProvider/serial] key file:       E:\AI\embedded-mcp-toolkit\configs\password_input.txt
[2026-05-27 18:58:38] [INFO] [serial_shell_login] session reused: serial_2 port=COM3
[2026-05-27 18:58:54] [INFO] [serial_enter_uboot] session_id=serial_2 timeout=60s
[2026-05-27 18:59:11] [INFO] [serial_enter_uboot] detected any-key autoboot prompt
[2026-05-27 18:59:36] [INFO] [serial_exec] session_id=serial_2 command=help delay=3000 clear=1

```

会记录工具的名称、传入的参数等。

### 3. `configs`配置

#### 3.1 `config.yaml`

```yaml
# ============================================
# embedded-mcp-toolkit 设备配置文件模板
# 复制并修改: cp config.example.yaml config.yaml
# ============================================

# 默认使用的设备（对应 devices 下的 key）
default: board-b

devices:
  # ---- 设备 A ----
  board-a:
    ssh:
      host: "192.168.16.103"
      port: 22
      username: "root"
      password: "root"
      keyProvider:
        mode: "file" # file: 通过文件 IPC 获取密钥; terminal: 终端交互输入
        challengeFilePath: "./configs/challenge.txt" # 挑战信息写入文件路径
        keyFilePath: "./configs/password_input.txt" # 轮询密钥的文件路径
        pollInterval: 500 # 轮询间隔（毫秒）
        timeout: 120000 # 超时（毫秒），默认 2 分钟
    serial:
      port: "COM4"
      baudRate: 115200
      keyProvider:
        keyProvider:
        mode: "file"
        challengeFilePath: "./configs/challenge.txt"
        keyFilePath: "./configs/password_input.txt"
        pollInterval: 500
        timeout: 120000

  # ---- 设备 B ----
  board-b:
    ssh:
      host: "192.168.16.105"
      port: 22
      username: "root"
      password: "root"
      keyProvider:
        mode: "file"
        challengeFilePath: "./configs/challenge.txt"
        keyFilePath: "./configs/password_input.txt"
        pollInterval: 500
        timeout: 120000
    serial:
      port: "COM3"
      baudRate: 115200
      keyProvider:
        mode: "file"
        challengeFilePath: "./configs/challenge.txt"
        keyFilePath: "./configs/password_input.txt"
        pollInterval: 500
        timeout: 120000
```

一般来说只需要修改下面几个字段：

```yaml
    ssh:
      host: "xxx.xxx.xxx.xxx" # 设备IP地址
      port: 22
      username: "root"        # 设备的用户名
      password: "root"        # 设备用户的登录密码
    serial:
      port: "COM3"            # 串口的端号
      baudRate: 115200        # 波特率
```

其中keyProvider是对于具有psh的设备在解密时提供密钥方式的选择，支持文件读写和终端输入，对于claude code中自动调用工具登录的场景，最好还是使用文件读写的方式。这个字段可以保持默认。

#### 3.2 两个txt文本文件

```shell
configs/challenge.txt
configs/password_input.txt
```

- `configs/challenge.txt`是存放动态口令的，当一键登录的时候，会自动读取串口或者ssh的动态口令并存储到这个文件中
- `configs/password_input.txt`是存放密钥，使用动态口令生成密钥后写入这个文件即可

> Tips：当密钥被读走后，这两个文件都会被清空。

## 三、简单示例

### 1. 启动 claude

```shell
cd mcp-toolkit
claude
```

然后可以在claude中执行 `/mcp list`来查看mcp服务是否连接：

```powershell
╭─── Claude Code v2.1.152 ─────────────────────────────────────────────────────────────╮
│                                   │ Tips for getting started                         │
│           Welcome back!           │ Run /init to create a CLAUDE.md file with instr… │
│                                   │ ──────────────────────────────────────────────── │
│              ▐▛███▜▌              │ What's new                                       │
│             ▝▜█████▛▘             │ `/code-review --fix` now applies review finding… │
│               ▘▘ ▝▝               │ Skills and slash commands can now set `disallow… │
│                                   │ Added `/reload-skills` command to re-scan skill… │
│   Lanz-Auto · API Usage Billing   │ /release-notes for more                          │
│            D:\Temp\aaa            │                                                  │
╰──────────────────────────────────────────────────────────────────────────────────────╯


❯ /mcp list

────────────────────────────────────────────────────────────────────────────────────────
  Manage MCP servers
  1 server

    Project MCPs (D:\Temp\aaa\.mcp.json)
  ❯ embedded-board · ✔ connected · 18 tools

  https://code.claude.com/docs/en/mcp for help
 ↑/↓ to navigate · Enter to confirm · Esc to cancel
```

connected前面✔就表示mcp连接成功。

### 2. 常用提示词

```powershell
# 获取当前设备信息
❯ 当前设备信息是什么

# 登录设备，没有xxx的话是会用默认设备
❯ ssh一键登录xxx设备
❯ 串口一键登录xxx设备

# 退出登录
❯ 退出xxx设备登录
❯ 关闭ssh_id
❯ 关闭串口serial_id
❯ 关闭所有会话
```

## 四、常见问题

### 1. 串口被拒绝（Port busy / Access denied）

Windows 下串口（COM 口）是独占资源，同一时间只能有一个进程打开。如果 MCP server 尝试打开串口时提示 `Port is open`、`Access denied` 或 `Permission denied`，说明该 COM 口已被其他程序占用。

#### 1.1 常见占用场景

- 其他串口调试工具未关闭（如 SecureCRT、PuTTY、MobaXterm、Xshell、minicom 等）
- 资源管理器窗口打开着该串口（某些驱动会在资源管理器中锁定）
- 上一个 MCP server 实例未正常退出，残留进程仍持有串口句柄
- 虚拟机软件（VMware、VirtualBox）占用了宿主机串口做直通映射

#### 1.2 排查方法

（1）**关闭所有可能占用串口的工具**，然后重试。

（2）**Windows 任务管理器**检查是否有残留的 `node.exe` 进程，如果有则结束掉。

（3）使用 PowerShell 查看串口占用（需要管理员权限）：

```powershell
# 查看当前系统可用串口
[System.IO.Ports.SerialPort]::GetPortNames()

# 查看串口设备详细信息
Get-WMIObject Win32_SerialPort | Select-Object Name, Description, DeviceID
```

（4）在设备管理器（`devmgmt.msc`）中确认 COM 口编号未变化（USB 转串口设备重新插拔后编号可能改变）。

#### 1.3 解决方法

- 关闭占用程序后重试
- 如果是在 Claude 中，先执行"关闭所有会话"确保释放串口，再重新登录
- 重新插拔 USB 转串口设备，确认 COM 口编号后在 [`config.yaml`](#31-configyaml) 中更新 `serial.port` 字段

### <a id="section1">2. 环境变量未生效？</a>

如果启动后日志中没有看到 env 信息，或者工具运行时读取不到这些变量，可以从以下几个方面排查：

（1）**Claude Code 版本过低**：也可能是个原因吧，我使用的是 `2.1.152` 版本。更新命令：

```shell
npm list -g @anthropic-ai/claude-code              # 查看当前系统安装的node包的版本
npm view @anthropic-ai/claude-code versions --json # 查看 npm 服务器上发布的所有版本
npm i -g @anthropic-ai/claude-code                 # 全局安装
```

（2）**`.mcp.json` 文件路径不正确**：该文件必须放在 Claude 启动时的项目根目录下（与 `.claude/` 目录同级）。如果放错了位置，Claude 不会读取它。

（3）**`enabledMcpjsonServers` 未配置**：需要在 [`.claude/settings.local.json`](#11-claudesettingslocaljson) 中配置 `"enabledMcpjsonServers": ["embedded-board"]`，否则 Claude 不会启动对应的 MCP server。

（4）**修改 `.mcp.json` 后未重启 Claude**：`.mcp.json` 只在 Claude 启动时读取一次。修改后需要完全退出 Claude 再重新启动，新的环境变量才会生效。

（5）**JSON 格式错误**：`.mcp.json` 中缺少逗号、引号不匹配等语法错误会导致整个文件解析失败，Claude 可能静默忽略该配置。

（6）**`command` 路径错误**：如果 `command` 指定的脚本路径不存在（如未执行 `npm install` 导致 `./node_modules/.bin/embedded-mcp-toolkit` 不存在），MCP server 无法启动，环境变量自然也无法被读取。

（7）**相对路径的工作目录问题**：`BOARD_CONFIG_PATH` 和 `LOG_DIR` 使用的是相对路径，它们是相对于 **MCP server 进程的 `cwd`**（即启动 Claude 时所在的目录）解析的。如果不是从项目根目录启动 Claude，这些相对路径可能指向错误的位置。

### 3. 其他问题

......

## 五、开发计划

### 1. 功能概述

#### 1.1 目标

改造 shell 会话（adb/ssh/serial/powershell）的数据采集机制，从"按需收集"升级为"持续监听 + 并行扫描"，使 AI 能在任意时间点获取完整会话输出及已识别的错误告警。

#### 1.2 架构设计

```
stdout/stderr.on("data") ──→ appendBuffer(data)
                               ├── 存入 #buffer（等待 read() 拉取）
                               └── 即时扫描错误模式 → 命中则记入 #alerts 列表
```

【**两路并行**】

| 通路 | 功能 | 触发方式 |
|------|------|---------|
| 数据存储 | 持续写入 `#buffer`，不再丢弃 | data 事件自动触发 |
| 模式识别 | 扫描 error pattern，写入 `#alerts` | data 事件自动触发 |

【**与现有行为对比**】

- **现有**：`#collecting` 仅在 `write()` 到 `read()` 之间开启，其余时间数据丢弃
- **改造后**：`open()` 起 `#collecting` 始终为 `true`，所有输出持续归档

---

### 2. TODO 任务清单

| # | 状态 | 任务 | 涉及文件 | 优先级 |
|---|:---:|------|---------|:---:|
| 1 | ⬜ | **去掉 `#collecting = false` 关闭点** | `src/transport/adb.ts` | 高 |
|   |     | `open()` 中 banner 收集后不再关闭 `#collecting`；`read(clear=1)` 中保留 `#buffer = ""` 但不关闭 `#collecting` | | |
| 2 | ⬜ | **新增 `#alerts` 告警队列与 Alert 类型定义** | `src/transport/adb.ts` | 高 |
|   |     | 定义 `Alert { pattern, timestamp, detail }` 结构；新增 `#alerts: Alert[]` 成员 | | |
| 3 | ⬜ | **实现 `#scanAlerts(data)` 错误模式扫描器** | `src/transport/adb.ts` | 高 |
|   |     | 预定义嵌入式常见错误正则库（kernel panic、OOM、segfault、watchdog timeout 等）；在 `appendBuffer` 入口调用 `#scanAlerts(data)` | | |
| 4 | ⬜ | **增强 `read()` 返回值结构** | `src/transport/adb.ts` | 中 |
|   |     | `read()` 返回 `{ data, alerts: [{ pattern, timestamp, detail }] }`；如有未读告警一并返回并清空 `#alerts` | | |
| 5 | ⬜ | **增强 `exec()` 返回值，附带 alerts** | `src/mcp/tools/adb/shell.ts` | 中 |
|   |     | `exec()` 内部调用 `read()` 后，将 alerts 一并封装进 MCP 响应内容 | | |
| 6 | ⬜ | **适配 SSH transport** | `src/transport/ssh.ts` | 中 |
|   |     | 对 ssh.ts 做与 adb.ts 相同的改造（持续 buffer + 错误扫描 + alerts） | | |
| 7 | ⬜ | **适配 Serial transport** | `src/transport/serial.ts` | 中 |
|   |     | 对 serial.ts 做相同改造 | | |
| 8 | ⬜ | **适配 PowerShell transport** | `src/transport/powershell.ts` | 低 |
|   |     | 对 powershell.ts 做相同改造 | | |
| 9 | ⬜ | **抽取公共基类/混入，消除重复代码** | `src/transport/` | 低 |
|   |     | 四个 transport 类存在大量重复的 buffer/collecting 逻辑，改造完成后考虑抽取 `BaseTransport` 抽象类 | | |

---

### 3. 错误模式库

| 模式名 | 正则 / 关键字 | 场景 |
|--------|-------------|------|
| `kernel_panic` | `Kernel panic` | 内核崩溃 |
| `oom` | `Out of memory` / `OOM killer` | 内存耗尽 |
| `segfault` | `Segmentation fault` | 段错误 |
| `watchdog_timeout` | `watchdog.*timeout` | 看门狗超时 |
| `bus_error` | `Bus error` | 总线错误 |
| `gpio_error` | `gpio.*error` | GPIO 异常 |
| `i2c_error` | `i2c.*error` | I2C 通信异常 |
| `spi_error` | `spi.*error` | SPI 通信异常 |
| `uart_error` | `uart.*error` / `serial.*error` | 串口异常 |
| `mount_error` | `mount.*fail` | 挂载失败 |
| `network_down` | `link down` / `network unreachable` | 网络断开 |
| `nand_error` | `nand.*(error\|fail)` | NAND 闪存异常 |
| `emmc_error` | `mmc.*error` / `mmcblk.*error` | eMMC 异常 |

---

### 4. 预期效果

- AI 调用 `exec("dmesg")` 后，返回值中自动附带 `alerts: [{ pattern: "oom", detail: "..." }]`，无需 AI 自行解析长文本
- 后台持续采集不丢数据，即使 AI 间隔较长时间才调用下一次 `read()`
- 告警在 `stdout` 到达瞬间即被识别，不依赖 AI 轮询频率
