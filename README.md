## 一、简介

### 1. 是什么？

`embedded-mcp-toolkit` 是一个基于 MCP（Model Context Protocol）协议的嵌入式板卡远程管理工具，通过多个 MCP 工具提供嵌入式设备交互能力。支持以下功能：

- **串口管理**：打开/关闭串口连接、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、进入 U-Boot 命令行、U-Boot 会话标记管理、经 ZMODEM 上传/下载文件
- **SSH 管理**：打开/关闭 SSH 会话、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、查看远端设备活跃连接、远程编译（结构化错误/警告反馈）、经 SFTP 上传/下载文件
- **ADB 管理**：一次性 adb 命令（`adb install` / `adb push` 等）、交互式 ADB shell 会话、设备列表扫描
- **本地 PowerShell**：一次性执行本地 PowerShell 命令（独立进程、UTF-8 编码、超时强杀进程树，命令与结果随业务日志体系落盘到 `.embedded/log/local`）
- **Windows 系统扫描**：扫描可用 COM/LPT 端口、扫描本机网络适配器与 IP 配置、目标 IP 子网可达性分析
- **基础信息**：查询 MCP 服务器版本、获取设备配置信息（单台或全部）、跨连接类型查询活跃会话元数据、查询 MCP 宿主端点
- **多会话管理**：同时保持多个串口、SSH、ADB 会话，支持独立读写
- **KeyProvider 密钥管理**：支持文件 IPC 和终端交互两种方式，自动处理 PSH 动态口令生成的密钥
- **进程退出自动清理**：客户端断开或进程终止时自动释放所有串口、SSH、ADB 连接

> 项目背景与价值定位（为什么需要它、与 PowerShell 直调的能力分界与场景选型）详见 [docs/项目简介.md](./docs/项目简介.md)。

### 2. 架构关系

OpenCode、MCP Client 与 MCP Server 的三层关系如下：

```
┌─────────────────────────────────────────────┐
│  OpenCode (MCP Host)                        │
│  ┌────────────┐  ┌────────────┐             │
│  │ MCP Client │  │ MCP Client │  ...        │
│  │ (stdio)    │  │ (http)     │             │
│  └─────┬──────┘  └─────┬──────┘             │
└────────┼───────────────┼────────────────────┘
         │               │
    stdin/stdout      HTTP/SSE
         │               │
┌────────┴────────┐   ┌──┴───────────┐
│ MCP Server A    │   │ MCP Server B │
│ (embedded-mcp-  │   │ (其他服务)    │
│  toolkit)       │   │              │
└─────────────────┘   └──────────────┘
```

| 角色 | 说明 | 在本项目中的体现 |
|------|------|----------------|
| **MCP Host** | AI 应用，管理多个 Client，把 tool result 喂给 LLM | OpenCode / Claude Code |
| **MCP Client** | Host 内部组件，与 Server 保持 1:1 连接，通过 JSON-RPC 通信 | Host 每配置一个 Server 就创建一个 Client |
| **MCP Server** | 提供 tools 供 Agent 调用的独立进程 | `embedded-mcp-toolkit` |

**通信流程**：OpenCode 读取配置 → 创建 MCP Client → 以 stdio 启动 MCP Server 子进程 → 双方通过 JSON-RPC 通信。Agent 说"调用 xx 工具"时，Host 通过 Client 向 Server 发 `tools/call`，结果返回给 LLM。

**注意**：Server 发送的推送通知（如 `notifications/message`）由 Client 接收后止于 Host，**不会**转发给 Agent。因此需要 Agent 感知的事件应通过 tool 返回值（pull 模式）传递。

### 3. 怎么安装

#### 3.1 npm

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
│   ├── settings.local.json      # 项目配置文件（自动生成，一般无需改）
│   ├── skills                   # claude skills,只是写了一些技能，实际可能不需要
│   ├── start-claude.bat.tmp     # 以指定环境变量启动claude的bat脚本
│   └── start-claude.ps1.tmp     # 以指定环境变量启动claude的powershell脚本
├── .mcp.json                    # claude code的mcp配置文件
├── .opencode                    # opencode 的配置目录（非 Claude 用户可忽略）
│   └── opencode.json
├── .embedded                    # 嵌入式工具包专属目录（配置 + 日志统一收纳）
│   ├── configs                  # 配置目录
│   │   ├── challenge.txt        # 登录psh时的挑战码（动态口令）
│   │   ├── config.example.yaml  # 配置模板文件（含完整字段说明，供参考）
│   │   ├── config.yaml          # 实际生效的配置（随包发布，只含 default，按需编辑）
│   │   ├── devices              # 设备配置分文件目录，一台设备一个 .yaml
│   │   │   └── board-example.yaml # 示例设备配置（复制并改名为你的设备）
│   │   └── password_input.txt   # 密钥文件，通过挑战码生成
│   └── log                      # 日志目录，当前claude启动时会自动创建，写入一些工具调用日志
│       └── 2026-05-27_09-06-09.log
├── node_modules                 # node 依赖包目录（npm 自动生成）
│   ├── .bin
│   ├── .package-lock.json
│   ├── @smai-kit                # @smai-kit/embedded-mcp-toolkit中是编译后的js脚本
│   ├── #...
│   └── zod
├── package-lock.json
└── package.json                 # npm 项目依赖清单
```

#### 3.2 源码安装

git clone源码后：

```shell
npm i         # 安装依赖
npm run build # 编译，编译后就可以在当前目录下启动claude使用了
```

### 4. 工具介绍

#### 4.1 基础工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `version_tool` | 获取 MCP 服务器版本和工具包信息 | `当前MCP版本是什么` |
| `device_info_tool` | 获取设备配置；不传 `device` 用默认设备，传 `all` 列出全部设备 | `当前设备信息是什么` / `列出所有可用设备` |
| `session_info` | 查询活跃会话元数据（串口/SSH/ADB 通用）：按 `session_id`、按 `device` 或全部，返回连接信息与原始日志路径 | `当前有哪些会话` / `列出 board-a 的会话` |
| `host_info` | 查询 MCP 宿主端点（username@ip）与日志保存目录；跨机部署下供构造 scp 命令，并暴露业务日志 / 原始数据日志的绝对路径供 AI 清理；本地启动返回 local | `宿主端点是什么` / `日志保存在哪里` |
| `greet_tool` | 演示用打招呼工具 | — |

#### 4.2 串口工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `serial_open` | 打开串口连接，启动交互式 shell 会话 | `打开串口` / `连接 COM3` |
| `serial_close` | 关闭串口会话，释放端口资源 | `关闭串口` / `退出串口 serial_1` |
| `serial_write` | 向串口会话发送命令 | `向串口发送命令` / `在串口执行 whoami` |
| `serial_read` | 读取串口会话的输出数据 | `读取串口输出` / `看看串口返回了什么` |
| `serial_exec` | 向串口发送命令并等待输出（write + read，自动完成检测，含常驻命令识别与双超时机制） | `在串口执行 uname -a` / `让串口运行命令 xxx` |
| `serial_shell_login` | 一键串口登录，自动检测 PSH 状态并解锁 | `串口一键登录` / `串口登录 board-test` |
| `serial_enter_uboot` | 重启设备并进入 U-Boot 命令行 | `重启进入 uboot` / `进入 U-Boot 命令行` |
| `serial_uboot_state` | 查询/检测/强制设置串口会话的 U-Boot 标记（detect/set/clear/status），标记决定 exec 的 marker 包装风格 | `检测当前是否在 U-Boot` / `标记为 U-Boot 会话` |
| `serial_send_ctrl` | 向串口会话发送控制字符（Ctrl+C/U/D/Z，不追加换行） | `串口发 Ctrl+C` / `中断串口命令` |
| `serial_upload` | 经 ZMODEM 上传二进制文件到设备（复用串口会话，不释放端口；设备需有 lrzsz） | `串口上传固件` / `把 update.bin 传到设备` |
| `serial_download` | 经 ZMODEM 从设备下载二进制文件（复用串口会话，不释放端口；设备需有 lrzsz） | `串口拉取日志` / `下载 /tmp/dmesg.log` |

> [!WARNING]
> **串口持续输出的设备慎用 ZMODEM 下载**：ZMODEM 是带内协议，设备持续打印（内核日志、常驻诊断输出等）会与协议帧物理交织。同等洪水强度下，下载方向（设备 `sz` → MCP）受污染双重命中（设备侧发送被打断 + MCP 接收侧污染）、恢复链路更脆、且受 `MAX_CRC_RETRIES=10` 重试上限约束，很容易传输失败；上传方向（MCP → 设备 `rz`）靠本地缓存可无限重传，相对能扛（仅吞吐滑坡）。若设备有持续打印，建议优先用上传；确需下载时，先停掉可控输出源（`dmesg -D`、kill 常驻打印任务）再传。完整分析见 [docs/MCP串口ZMODEM文件传输.md](./docs/MCP串口ZMODEM文件传输.md#四-串口持续输出对传输的影响)。

#### 4.3 ADB 工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `adb_device_list` | 列出所有已连接的 ADB 设备及其状态 | `列出 adb 设备` / `查看连接的安卓设备` |
| `adb_exec` | 一次性执行 adb 命令（无需持久会话），适合 `adb install`、`adb push`、短命令 | `adb push 文件` / `安装 apk` |
| `adb_shell_open` | 打开交互式 ADB shell 会话（Android 设备） | `打开 adb shell` / `连接安卓设备` |
| `adb_shell_close` | 关闭 ADB shell 会话并终止 adb 进程 | `关闭 adb` / `退出 adb_1` |
| `adb_shell_write` | 向 ADB shell 会话发送命令 | `adb 发送命令` / `在 adb 里执行 ls` |
| `adb_shell_read` | 读取 ADB shell 会话的输出数据 | `读取 adb 输出` / `adb 返回了什么` |
| `adb_shell_exec` | 向 ADB shell 发送命令并等待输出（write + read，自动完成检测） | `adb 执行 logcat` / `在 adb 运行命令 xxx` |
| `adb_shell_send_ctrl` | 向 ADB shell 会话发送控制字符（Ctrl+C/U/D/Z，不追加换行） | `adb 发 Ctrl+C` / `中断 adb 命令` |

#### 4.4 SSH 工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `ssh_shell_open` | 打开交互式 SSH shell 会话 | `打开 SSH` / `SSH 连接 board-test` |
| `ssh_shell_close` | 关闭 SSH shell 会话，释放连接 | `关闭 SSH` / `退出 ssh_1` |
| `ssh_shell_write` | 向 SSH 会话发送命令 | `SSH 发送命令` / `在 ssh 里执行 ls` |
| `ssh_shell_read` | 读取 SSH 会话的输出数据 | `读取 SSH 输出` / `SSH 返回了什么` |
| `ssh_shell_exec` | 向 SSH 发送命令并等待输出（write + read，自动完成检测，含常驻命令识别与双超时机制） | `SSH 执行 ifconfig` / `在 SSH 运行命令 xxx` |
| `ssh_shell_connection` | 检查远端板卡上活跃的 SSH 连接 | `查看设备上的 SSH 连接` / `谁连到了这台设备` |
| `ssh_shell_login` | 一键 SSH 登录，自动检测 PSH 状态并解锁 | `SSH 一键登录` / `SSH 登录 board-test` |
| `ssh_shell_send_ctrl` | 向 SSH 会话发送控制字符（Ctrl+C/U/D/Z，不追加换行） | `SSH 发 Ctrl+C` / `中断 SSH 命令` |
| `ssh_build` | 在远端执行编译命令，等待完成并结构化分类错误/警告/信息（每个会话同一时刻只跑一个编译） | `远程编译内核` / `make -j8 编译并分析结果` |
| `ssh_sftp_upload` | 复用 SSH 会话经 SFTP 上传本地文件到远端（流式传输，适合大文件） | `上传文件到板卡` / `把 build.sh 传到 /tmp` |
| `ssh_sftp_download` | 复用 SSH 会话经 SFTP 从远端下载文件到本地 | `从板卡下载文件` / `拉取 /var/log/dmesg` |

#### 4.5 Windows 工具

| 工具名称 | 功能说明 | 常用提示词 |
|---|---|---|
| `port_scan_tool` | 扫描 Windows 设备管理器中的 COM / LPT 端口 | `扫描可用串口` / `查看有哪些 COM 口` |
| `network_scan_tool` | 扫描 Windows 网络适配器和 IP 配置 | `扫描网络适配器` / `查看本机网卡信息` |
| `subnet_check_tool` | 分析目标 IP 的子网信息（网络地址/广播地址/可用范围/CIDR），判断是否与本机同子网可达 | `检查 192.168.16.1 是否可达` / `子网分析` |
| `power_shell_exec` | 独立进程一次性执行 PowerShell 命令（不依赖会话，UTF-8 编码免疫乱码，超时强杀整棵进程树，命令与结果落盘到 `{LOG_DIR}/local`） | `PowerShell 执行 ipconfig` / `用 ps 运行 xxx` |

> **注册策略**：`power_shell_exec` 默认仅在**远程 SSH 场景**（本 MCP 由 Linux 侧 AI 客户端经 ssh 拉起，客户端无法直接访问本机）注册。若客户端（Claude Code / ZCode / OpenCode 等）**原生运行在本机 Windows**，它自带的 shell 工具可以直接执行 PowerShell，这些工具默认**不注册**，避免 AI 经 MCP 绕行。在 `.mcp.json` 的 `env` 中设置 `POWERSHELL_TOOLS=1` 可强制开启，`0` 强制关闭；启动日志中会记录实际决策。
>
> `ssh_build` 的注册策略与 `power_shell_exec` **相反**：默认仅在**本地场景**（客户端与 MCP 同在本机 Windows）注册，此时编译服务器不可直达，`ssh_build` 是唯一编译通道；**远程 SSH 场景**下客户端已运行在 Linux 编译服务器上，自带 shell 即可本机编译，`ssh_build` 默认**不注册**，避免流量 Linux → Windows MCP → Linux 绕圈。在 `.mcp.json` 的 `env` 中设置 `SSH_BUILD_TOOLS=1` 可强制开启，`0` 强制关闭。

#### <a id="section_exec_timeout">4.6 重要机制：exec 的常驻命令识别与双超时策略</a>

`serial_exec` / `ssh_shell_exec` / `adb_shell_exec` 这三个交互式 exec 工具，采用了**提示符检测 + 分类超时**机制。核心思路：**普通命令靠提示符检测自然结束，常驻命令（ping/logcat/top 等永不返回提示符的）才默认套用短超时熔断**。

【**常驻命令识别**】

命令是否常驻按**首 token**（第一个空白/管道/重定向之前的命令名）判定。内置白名单（`config.yaml` 的 `execTimeout.residentCommands` 可扩展）：

- A 类（首 token 命中即常驻）：`ping`、`ping6`、`logcat`、`top`、`htop`、`watch`、`strace`、`tcpdump`
- B 类（首 token 命中且带 follow 参数才常驻）：`dmesg -w` / `--follow`、`journalctl -f` / `--follow`、`tail -f` / `-F` / `--follow`

不在白名单中的命令按普通命令处理。

【**两种超时策略**】

| 命令类型 | 默认超时 | 超时动作 | 超时类型 | 语义 |
|----------|---------|---------|---------|------|
| 普通命令（瞬时/长命令） | 5 分钟（兜底） | ❌ **不发 Ctrl+C** | `fallback`（兜底超时） | 异常——提示符未匹配的安全阀，调用方应确认/手动终止 |
| 常驻命令（ping/logcat/top...） | 10 秒（采样） | ✅ **发 Ctrl+C** | `sampling`（采样超时） | 中性——预期采样行为，输出已收集 |

【**机制流程**】

每条命令进入 exec 后：（0）**常驻分类**——按白名单判定命令类型，选定超时时长与动作；（1）**前置冲刷**清空缓冲区残留；（2）在有效时长内**发送命令并轮询**读取输出；（3）**结束判定**——检测到 shell 提示符（Android `:/ $` / `:/ #`、Linux `$` / `#` / `>`、U-Boot `=>`，支持 `promptPattern` 覆盖）→ 立即返回 `timeoutKind=none`；超时未检测到 → 按命令类型分支：

- **常驻命令**：发 Ctrl+C 终止（避免 ping/logcat 后台持续运行污染后续会话），返回 `timeoutKind=sampling`，末尾追加 `[采样超时: 已收集 Xms 输出，已发送 Ctrl+C 终止常驻命令]`
- **普通命令**：不发 Ctrl+C（避免误杀可能已完成只是提示符没匹配的命令），返回 `timeoutKind=fallback`，末尾追加 `[兜底超时: 已收集 Xms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`

【**`timeoutMs` 的作用范围**】

`timeoutMs` 参数只覆盖「执行时长」，**不改变超时后的动作**（是否发 Ctrl+C 始终由命令常驻性决定）：

| 调用方式 | 命令类型 | 效果 |
|---------|---------|------|
| 不传 `timeoutMs` | 常驻命令（ping） | 默认 10s 采样超时，发 Ctrl+C |
| 不传 `timeoutMs` | 普通命令（make） | 默认 5min 兜底超时，不发 Ctrl+C |
| `timeoutMs: 30000` | 常驻命令（ping） | 30s 采样超时，发 Ctrl+C（时长覆盖，动作不变） |
| `timeoutMs: 5000` | 普通命令（sleep） | 5s 兜底超时，不发 Ctrl+C（时长覆盖，动作不变） |

【**AI 传参约定（必须预估传 `timeoutMs`）**】

exec 工具要求调用方（AI）**每次调用都预估命令预期耗时并显式传 `timeoutMs`**，仅当用户明确表示不传时才可省略。未传时落到的 300000ms（5 分钟）只是内部兜底安全阀，**不作为建议传值**——当前没有需要等满 5 分钟才有结果的命令，确有超过 ~2 分钟的命令时应显式传更大的值。分级参考（与工具描述一致）：

| 命令类型 | 建议 `timeoutMs` |
|---------|------------------|
| 基础瞬时命令（ls/pwd/echo/cat 小文件/ip addr/uname） | 3000-5000，上限 10000 |
| 大输出命令（cat 大文件、dmesg/journalctl 长输出、日志转储） | 20000-30000 |
| 中等任务（apt install、dd、服务重启） | 30000-120000 |
| reboot/reset/断电重启 | ≤120000 |
| 常驻命令采样（ping/logcat/top） | 10000（到点自动发 Ctrl+C） |

漏传 `timeoutMs` 时，exec 返回文本末尾会追加 `[提示: 本次未传 timeoutMs, ...]` 反向引导调用方下次显式传参；该提示不代表命令失败。

【**全局默认值（config.yaml 根层 `execTimeout`）**】

```yaml
# .embedded/configs/config.yaml
execTimeout:
  residentCommands:          # 常驻命令扩展名单（与内置白名单并集），留空仅用内置
    - my_log_streamer
  samplingTimeoutMs: 10000   # 常驻命令采样超时（ms），留空默认 10000
  fallbackTimeoutMs: 300000  # 普通命令兜底超时（ms），留空默认 300000（5 分钟）
```

三项均为全局级，所有设备共享。设备级可覆盖（详见 [配置说明 execTimeout 段](#section_exec_config)）。

> `[采样超时: ...]` 是**中性采样结果，不是异常**——对 `logcat` 取样、`top` 采样就是预期行为，AI 不应视为命令出错。`[兜底超时: ...]` 则提示调用方注意命令可能仍在运行。


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
      "mcp__embedded-board__session_info",
      "mcp__embedded-board__serial_read",
      "mcp__embedded-board__ssh_shell_read"
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
        "BOARD_CONFIG_PATH": "./.embedded/configs/config.yaml",
        "LOG_SAVE": "1",
        "LOG_DIR": "./.embedded/log",
        "SAVE2FILE_PATH": "./.embedded/log"
      }
    }
  }
}
```

这个是`MCP`的配置文件。`env` 字段中定义的环境变量会在 Claude 启动 MCP server 时，**注入到 MCP server 子进程** 的 `process.env` 中。也就是说，这些变量只在 [src/mcp.ts](src/mcp.ts:102-107) 进程中通过 `process.env.DEVICE` 等方式读取，**不会** 影响 Claude 自身的 shell 环境变量。

- `DEVICE`：默认的设备名称，对应 [`config.yaml`](configs/config.example.yaml:163) 中 `devices` 下的 key。**与 `config.yaml` 的 `default` 字段同时存在时，`DEVICE` 优先级更高**（见下方[默认设备优先级](#13-默认设备优先级)）
- `BOARD_CONFIG_PATH`：主配置文件 `config.yaml` 的路径，相对于 **MCP server 进程的工作目录**（即启动 Claude 时的 `cwd`）。注意：`devices/` 目录的查找位置始终是 `config.yaml` 的同级目录，因此 `BOARD_CONFIG_PATH` 同时决定了 `config.yaml` 和 `devices/` 的位置
- `LOG_SAVE`：是否开启**业务日志**写入文件（`"1"` 表示开启），记录工具调用信息（工具名称、调用参数、会话生命周期等）。需配合 `LOG_DIR` 使用
- `LOG_DIR`：**业务日志**的存储目录，相对于 MCP server 进程的工作目录。开启后整个进程共用一个日志文件（格式 `YYYY-MM-DD_HH-mm-ss.log`）
- `SAVE2FILE_PATH`：**原始数据日志**的存储目录，记录串口、SSH、ADB 等 transport 接收到的原始字节流（每行附到达时间戳，每个会话单独一个文件）。设为 `"none"` 或留空则关闭。与 `LOG_SAVE` / `LOG_DIR` 相互独立

> **两个日志通道的区别**：`LOG_SAVE` + `LOG_DIR` 记录的是"程序自己说的话"（info / warn / error 等诊断信息）；`SAVE2FILE_PATH` 记录的是"设备/远端回的话"（transport 接收的原始数据流），用于排查设备到底返回了什么。两者独立，可单独或同时开启。

#### 1.3 默认设备优先级

工具调用时若未显式指定 `device` 参数，"用哪台设备"按下面的优先级依次回退（前者覆盖后者，代码见 [`resolveDeviceName()`](src/shared/config.ts:162-169)）：

| 优先级 | 来源 | 示例值 | 说明 |
|--------|------|--------|------|
| 1（最高） | 单次调用的 `device` 参数 | `ssh_shell_open` / `adb_shell_open` 等工具传入的 `device` 字段 | 只影响这一次调用 |
| 2 | `DEVICE` 环境变量（`.mcp.json` 的 `env`） | `board-b` | 进程级，所有工具共用 |
| 3 | `config.yaml` 的 `default` 字段 | `board-a` | 仅当 `DEVICE` 未设置时生效 |
| 4（兜底） | 硬编码默认值 | `board-a` | 三者都缺时使用 |

> **常见误区**：同时配了 `.mcp.json` 的 `DEVICE` 和 `config.yaml` 的 `default`，以为改了 `config.yaml` 就能切换设备，结果生效的还是 `DEVICE`。**想让 `config.yaml` 的 `default` 生效，把 `.mcp.json` 里的 `"DEVICE"` 这一行删掉即可。**

> 完整调用链：`args.device` → `DEVICE` → `config.yaml` 的 `default` → `board-a`。启动后可在日志里看到实际命中了哪一档，例如 `Device resolved: board-b (from env)`。

> 注：SSH/串口工具在**会话注册与日志命名**这一步用的是 `args.device ?? process.env.DEVICE ?? "default"`，跳过了 `config.yaml` 的 `default` 兜底；但这只影响日志目录名，**实际连接目标**（host、port 等）仍由 `getSSHConfig()/getSerialConfig()` 经 `resolveDeviceName()` 解析，结果与上表一致。

> Tips：MCP server 进程的工作目录就是启动 Claude（或其他 MCP 客户端）时所在的目录。可以在日志文件的第一行看到 `cwd: xxx` 来确认实际的工作目录。
>
> 环境变量不生效？看一下这里：[常见问题 2. 环境变量未生效？](#section1)

### 2. 日志信息

`.mcp.json` 中开启 `LOG_SAVE` 后，业务日志（`.embedded/log/` 下，格式 `YYYY-MM-DD_HH-mm-ss.log`）大致如下：

```powershell
[2026-05-27 18:55:39] [INFO] MCP server starting... cwd: E:\AI\embedded-mcp-toolkit
[2026-05-27 18:55:39] [INFO] MCP server env: {"DEVICE":"board-b","BOARD_CONFIG_PATH":"./.embedded/configs/config.yaml","LOG_SAVE":"1","LOG_DIR":"./.embedded/log"}
[2026-05-27 18:56:38] [INFO] Config loaded: E:\AI\embedded-mcp-toolkit\.embedded\configs\config.yaml
[2026-05-27 18:56:38] [INFO] Device resolved: board-b
[2026-05-27 18:57:13] [INFO] [serial_open] device=(default) port=(auto) baudRate=115200
[2026-05-27 18:57:13] [INFO] [serial_open] session opened: serial_1 port=COM3
[2026-05-27 18:58:13] [INFO] [serial_exec] session_id=serial_2 command=exit clear=1 timeoutMs=(default)
[2026-05-27 18:58:54] [INFO] [serial_enter_uboot] session_id=serial_2 timeoutMs=60000
```

每行记录工具名称、调用参数、会话生命周期等。首行的 `cwd` 可用于排查[相对路径问题](#2-环境变量未生效)；`SAVE2FILE_PATH` 写的是另一份原始字节流日志（transport 接收到的设备原始返回），与这份业务日志相互独立。

### 3. `configs`配置

设备配置围绕"设备名"组织——它既是配置的 key，也会作为日志目录名、分文件配置文件名使用。开始配置前，先了解一下设备名的命名要求。

#### 3.1 设备名称命名规则

设备名（即 `devices` 下的 key、`config.yaml` 的 `default`、`DEVICE` 环境变量、MCP 工具 `device` 参数所用的字符串）**没有任何强制约束**——代码层面零校验，不要求 `board-` 前缀，也没有正则、白名单或 enum 限制（`board-` 只是约定俗成）。

但设备名会被**直接用作文件/目录名**（[日志子目录](src/shared/file-logger.ts:75-77)、[分文件配置名](src/cli/commands/split.ts:80)），因此字符选择有现实要求：

| ✅ 推荐 | ❌ 避免 |
|--------|---------|
| 小写字母 + 连字符（kebab-case），如 `board-a`、`raspberry-pi`、`ubuntu-01` | 路径分隔符 `/` `\`（会改变目录层级，`..` 甚至导致目录穿越） |
| 数字、点号 `.` 也安全（如 `board-2.0`） | Windows 非法字符 `: * ? " < > \|`（`mkdirSync` 会直接抛错） |
| | 空串、空格、控制字符 |
| | 大小写不敏感系统（Windows/macOS）下与已有设备名仅大小写不同的名字 |

> 一句话：**起什么名字都行，只要避开路径分隔符和 Windows 非法字符；`board-` 前缀不是必需的。**

---

设备配置支持**两种布局**，二选一即可（兼容老配置）：

| 布局 | 适用场景 | 设备配置放在 |
|------|---------|-------------|
| **单文件布局**（老方式） | 设备少（1~2 台） | 全部写在 `config.yaml` 的 `devices` 段里 |
| **分文件布局**（新方式，推荐） | 设备多 | 每台设备一个文件，放在 `devices/` 目录下 |

> **两种布局同时存在时（`devices/` 目录非空 + `config.yaml` 还有 `devices` 段）：以 `devices/` 目录为准，`config.yaml` 里的 `devices` 段被忽略。** 此时修改设备请改 `devices/<设备名>.yaml`，改 `config.yaml` 的 `devices` 段无效。`default` 等全局字段始终从 `config.yaml` 读取。

#### 3.2 方式一：单文件布局（老方式）

所有设备写在 `config.yaml` 的 `devices` 段里，无需 `devices/` 目录：

```yaml
# config.yaml
default: board-b

devices:
  board-a:
    ssh:
      host: "192.168.16.103"
      port: 22
      username: "root"
      password: "root"
    serial:
      port: "COM4"
      baudRate: 115200
  board-b:
    ssh:
      host: "192.168.16.105"
      port: 22
      username: "root"
      password: "root"
    serial:
      port: "COM3"
      baudRate: 115200
```

#### 3.3 方式二：分文件布局（新方式，推荐）

`config.yaml` 只放 `default` 等全局设置，每台设备一个独立文件：

```
.embedded/configs/
├── config.yaml              # 仅放 default 等全局设置
└── devices/
    ├── board-a.yaml         # 每台设备一个文件，文件名即设备名
    └── board-b.yaml
```

`config.yaml`（仅全局设置）：

```yaml
# config.yaml
default: board-b
```

`devices/board-a.yaml`（单台设备的完整、自包含配置）：

```yaml
adb:
  serialNo: "sn_none"
ssh:
  host: "192.168.16.103"
  port: 22
  username: "root"
  password: "root"
serial:
  port: "COM4"
  baudRate: 115200
```

新增设备只需在 `devices/` 下复制一个 `.yaml` 文件并修改，无需改动 `config.yaml`。

> **从老方式迁移**：运行 `embedded-mcp-toolkit split`，自动把 `config.yaml` 的 `devices` 段拆分为 `devices/*.yaml`（详见 [3.4 配置拆分命令](#34-配置拆分命令-split)）。

#### 3.4 配置拆分命令（split）

`split` 命令用于把单文件布局的 `config.yaml` 迁移为分文件布局。它读取 `config.yaml` 的 `devices` 段，为每个设备生成一个独立的 `devices/<设备名>.yaml` 文件。

【**基本用法**】

```shell
# 使用默认源路径 ./.embedded/configs/config.yaml
embedded-mcp-toolkit split

# 指定源 config.yaml 路径
embedded-mcp-toolkit split --config ./path/to/config.yaml

# 强制覆盖已存在的设备文件（默认跳过已存在）
embedded-mcp-toolkit split --force
```

【**选项**】

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-c, --config <path>` | 源 `config.yaml` 路径 | `./.embedded/configs/config.yaml` |
| `-f, --force` | 覆盖已存在的设备文件 | `false`（默认跳过已存在） |

【**输出示例**】

```
✂️  embedded-mcp-toolkit 配置拆分
   源配置: ./.embedded/configs/config.yaml
   设备目录: ./.embedded/configs/devices
   覆盖模式: 跳过已存在

  ✅ 创建: board-a
  ✅ 创建: board-b
  ⏭  跳过（已存在）: board-c

✅ 拆分完成：创建 2，覆盖 0，跳过 1
```

【**说明**】

- 拆分后建议手动清理 `config.yaml` 中的 `devices` 段（保留 `default` 等全局字段），避免两份配置并存造成混淆。`devices/` 目录存在时，加载层只看 `devices/*.yaml`，`config.yaml` 的 `devices` 段不生效。
- 拆分是**非破坏性**的：原 `config.yaml` 不会被修改或删除，只是多出 `devices/*.yaml` 文件。
- 同一设备文件已存在时默认跳过，加 `--force` 才覆盖。

#### 3.5 常用字段说明

无论哪种布局，单台设备的字段含义相同，一般只需修改下面几个：

```yaml
ssh:
  host: "xxx.xxx.xxx.xxx" # 设备 IP 地址
  port: 22
  username: "root"        # 设备的用户名
  password: "root"        # 设备用户的登录密码
serial:
	  port: "COM3"            # 串口的端号
	  baudRate: 115200        # 波特率
```

	【**全局 execTimeout 配置**】<a id="section_exec_config"></a>
	
	常驻命令识别、采样超时、兜底超时的**全局默认值**写在 `config.yaml` 根层的 `execTimeout` 子段，所有设备共享（设备级同名字段可覆盖）：
	
	```yaml
	# config.yaml
	default: board-b
	execTimeout:
	  residentCommands:          # 常驻命令扩展名单（首 token 精确匹配），与内置白名单并集；留空仅用内置
	    - my_log_streamer
	  samplingTimeoutMs: 10000   # 常驻命令采样超时（ms），留空默认 10000
	  fallbackTimeoutMs: 300000  # 普通命令兜底超时（ms），留空默认 300000（5 分钟）
	```
	
	> 设备级覆盖（写在 `devices/<设备名>.yaml` 根层，与 `adb`/`ssh`/`serial` 平级）：`samplingTimeoutMs` / `fallbackTimeoutMs` 设备级优先（覆盖全局），`residentCommands` 全局 ∪ 设备级并集。详见 [exec 超时机制](#section_exec_timeout)。
	
	【**通道启用/禁用约定**】

| 通道 | 禁用取值 | 说明 |
|------|---------|------|
| SSH | `ssh.host: "none"` | 该设备不启用 SSH（调用 ssh 工具返回 "does not support SSH"） |
| 串口 | `serial.port: "none"` | 该设备不启用串口（调用 serial 工具返回 "does not support serial"） |
| ADB | `adb.serialNo: "sn_none"` 或留空 | 不绑定具体设备，由 adb 自动发现 |

不需要的通道可直接整段删除。

**关于 keyProvider**：用于具有 PSH 的设备在解锁时提供密钥，支持 `file`（文件读写）和 `terminal`（终端输入）两种模式。Claude Code 自动调用工具登录的场景下推荐 `file` 模式。其 `challengeFilePath` / `keyFilePath` 是**相对运行 MCP server 时的工作目录（cwd）**的路径，通常写 `./` 开头的项目相对路径即可（与 config.yaml 或设备文件的位置无关）。

**关于 uboot**：`serial.uboot` 子段用于 `serial_enter_uboot` 工具的提示符识别（autoboot 提示、命令提示符、printenv 验证键），全部可选，留空时使用内置默认值。各厂商 U-Boot 提示符差异较大，需要适配时请参考 [U-Boot 正则表达式配置指南](./docs/regex-guide.md)。

#### 3.6 两个 txt 文本文件

```shell
.embedded/configs/challenge.txt
.embedded/configs/password_input.txt
```

- `challenge.txt` 存放动态口令，一键登录时自动读取串口或 SSH 的动态口令并写入此文件
- `password_input.txt` 存放密钥，用动态口令生成密钥后写入此文件

> Tips：当密钥被读走后，这两个文件都会被清空。

## 三、简单示例

### 1. 启动 claude

```shell
cd mcp-toolkit
claude
```

然后在 claude 中执行 `/mcp list` 查看 MCP 服务是否连接：

```
  Manage MCP servers
  1 server

    Project MCPs (D:\Temp\aaa\.mcp.json)
  ❯ embedded-board · ✔ connected · 44 tools
```

`embedded-board` 前面的 `✔ connected` 即表示连接成功。

> 旧版每个通道各有一个 `serial_list` / `ssh_shell_list` / `power_shell_list` 列会话工具，现已统一合并为 `session_info`（跨连接类型查询，见 [4.1 基础工具](#41-基础工具)）。


### 2. 常用提示词

```powershell
# 获取当前设备信息
❯ 当前设备信息是什么

# 列出/查看会话（跨串口、SSH、ADB）
❯ 当前有哪些会话
❯ 列出 board-a 的所有会话

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
- 重新插拔 USB 转串口设备，确认 COM 口编号后在[设备配置](#35-常用字段说明)中更新 `serial.port` 字段

### <a id="section1">2. 环境变量未生效？</a>

如果启动后日志里看不到 env 信息，或工具读不到 `DEVICE`/`BOARD_CONFIG_PATH` 等变量，按以下顺序排查（配置写法详见 [1.1](#11-claudesettingslocaljson) / [1.2](#12-mcpjson)）：

**配置类（最常见）**

- **`.mcp.json` 放错位置**：必须在 Claude 启动的项目根目录（与 `.claude/` 同级），否则不读取。
- **`enabledMcpjsonServers` 漏配**：[`.claude/settings.local.json`](#11-claudesettingslocaljson) 需有 `"enabledMcpjsonServers": ["embedded-board"]`，否则不启动 server。
- **改完没重启**：`.mcp.json` 仅在 Claude 启动时读一次，改后需完全退出再重启。
- **`command` 路径不存在**：如未 `npm install`，`./node_modules/.bin/embedded-mcp-toolkit` 不存在，server 起不来。
- **JSON 语法错误**：缺逗号 / 引号不匹配会让整个 `.mcp.json` 解析失败，Claude 可能静默忽略。

**相对路径 / 工作目录**

- `BOARD_CONFIG_PATH`、`LOG_DIR` 等相对路径是相对 **MCP server 的 `cwd`**（即启动 Claude 的目录）解析的。不从项目根目录启动会指向错误位置——日志首行 `cwd: xxx` 可确认。

**Claude Code 版本**

- 版本过低也可能不兼容（本文档基于 `2.1.152`）。升级：`npm i -g @anthropic-ai/claude-code`。

### <a id="section_reboot_interrupted">3. 重启被中断？</a>

**现象**：用 `*_shell_exec` 执行 `reboot` 重启设备时，设备没有正常重启到新系统，而是停在某个中间状态（比如 bootloader 菜单、烧写流程、或者卡在启动脚本里）。

**背景**：很多嵌入式系统启动后会执行一批自动初始化脚本，脚本里为了方便调试，常在某些位置加 `sleep N` 并提示「Press Ctrl+C to stop …」之类的等待。这类等待点在调试时是好事，但放在「重启」场景下就成了陷阱——重启命令本身耗时远超 exec 的默认 `timeoutMs`（10 秒）。

**根因**：exec 工具采用 [提示符检测 + 超时熔断机制](#section_exec_timeout)，到 `timeoutMs` 仍未检测到 shell 提示符时，会**无条件自动发一次 Ctrl+C**。重启过程中本来就无 shell 提示符（设备在 kernel 关闭 → bootloader → kernel 启动之间），所以一旦超时，就会发 Ctrl+C——而这个 Ctrl+C 恰好可能落在初始化脚本的「等待用户中断」点上，导致启动流程被中止，设备停在中途。

**判断方法**：查看日志中是否有如下记录：

```
[serial_exec] timed out after 10000ms (no prompt), sending Ctrl+C
```

或返回内容末尾出现：

```
[timed-out: collected 10000ms of output, Ctrl+C sent]
```

只要看到 `Ctrl+C sent`，且设备实际未正常重启完成，基本可确认是这个问题。

**解决方法**：`reboot`、固件烧写、`kexec` 等长启动命令**不要用 `*_shell_exec` 跑默认超时**，二选一：

- **方式 A（推荐）**：改用 `*_shell_write` + `*_shell_read` 组合。`write` 只发送字节，没有任何超时和 Ctrl+C 逻辑，是重启/烧写场景的安全通道：

```
serial_write(session_id, "reboot")      ← 只发命令，不轮询、不熔断
serial_read(session_id, clear=1)        ← 多次轮询读取启动日志
serial_read(session_id, clear=1)
...
```

- **方式 B**：仍用 exec，但显式传足够大的 `timeoutMs`，确保命令完成前不触发熔断：

```
serial_exec(session_id, command="reboot", timeoutMs=120000)   ← 120 秒，远大于重启耗时
```

**如何提醒 AI**：在对话里直接说清楚，例如「执行 reboot 重启设备，**用 write 发送、用 read 轮询读取，不要用 exec**」，或「执行 reboot，**等待时间至少 120 秒**」。否则 AI 容易直接用 exec 的默认 10 秒超时，结果启动到一半被 Ctrl+C 中断。

> 完整机制说明见 [4.6 重要机制：exec 的提示符检测与超时熔断](#section_exec_timeout)。

> [!NOTE]
> 在提交 [6066447](https://github.com/smk-h/embedded-mcp-toolkit/commit/6066447daad275a1e1bc5128d20018d8f0a224b3) 后，普通命令（包括 `reboot`）默认走 5 分钟兜底超时且**不再自动发 Ctrl+C**，旧版描述的超时被中断问题已修复。详见 [4.6 重要机制：exec 的常驻命令识别与双超时策略](#section_exec_timeout)。
