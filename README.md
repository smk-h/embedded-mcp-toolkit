## 一、 简介

### 1. 是什么

`embedded-mcp-toolkit` 是一个基于 MCP（Model Context Protocol）协议的嵌入式板卡远程管理工具，通过多个 MCP 工具提供嵌入式设备交互能力。支持以下功能：

- **串口管理**：打开/关闭串口连接、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、进入 U-Boot 命令行、U-Boot 会话标记管理、经 ZMODEM 上传/下载文件、单片机（MCU）裸固件交互
- **SSH 管理**：打开/关闭 SSH 会话、发送命令、读取输出、一键登录（自动检测 PSH 并解锁）、查看远端设备活跃连接、远程编译（结构化错误/警告反馈）、经 SFTP 上传/下载文件
- **ADB 管理**：一次性 adb 命令（`adb install` / `adb push` 等）、交互式 ADB shell 会话、设备列表扫描
- **本地 PowerShell**：一次性执行本地 PowerShell 命令（独立进程、UTF-8 编码、超时强杀进程树，命令与结果随业务日志体系落盘到 `.embedded/log/local`）
- **Windows 系统扫描**：扫描可用 COM/LPT 端口、扫描本机网络适配器与 IP 配置、目标 IP 子网可达性分析
- **基础信息**：查询 MCP 服务器版本、获取设备配置信息（单台或全部）、跨连接类型查询活跃会话元数据、查询 MCP 宿主端点
- **多会话管理**：同时保持多个串口、SSH、ADB 会话，支持独立读写
- **KeyProvider 密钥管理**：支持文件 IPC 和终端交互两种方式，自动处理 PSH 动态口令生成的密钥
- **进程退出自动清理**：客户端断开或进程终止时自动释放所有串口、SSH、ADB 连接

> 项目背景与价值定位（为什么需要它、与 PowerShell 直调的能力分界与场景选型）详见 [项目简介](./docs/01-MCP设计/LV005-项目简介.md)。

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

## 二、 快速开始

### 1. npm 安装

目前支持工具的全局安装和本地指定目录安装，但是全局安装后还是只能在某个目录配置使用（需要 claude 配置文件、设备配置文件、mcp 配置文件以及日志等），暂未测试过全局配置。

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

各配置文件（`.claude/settings.local.json`、`.mcp.json` 环境变量、设备配置、日志参数）的逐项说明见 [配置指南](./docs/03-使用指南/LV005-配置指南.md)。

### 2. 源码安装

git clone 源码后：

```shell
npm i         # 安装依赖
npm run build # 编译，编译后就可以在当前目录下启动claude使用了
```

### 3. 启动与验证

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

### 4. 常用提示词

```powershell
# 获取当前设备信息
❯ 当前设备信息是什么

# 列出/查看会话（跨串口、SSH、ADB）
❯ 当前有哪些会话

# 登录设备，没有xxx的话是会用默认设备
❯ ssh一键登录xxx设备
❯ 串口一键登录xxx设备

# 退出登录
❯ 关闭ssh_id
❯ 关闭串口serial_id
❯ 关闭所有会话
```

全部工具的用途与对应提示词见 [工具参考](./docs/03-使用指南/LV010-工具参考.md)。

## 三、 文档导航

### 1. 使用指南

| 文档 | 内容 |
|------|------|
| [配置指南](./docs/03-使用指南/LV005-配置指南.md) | 客户端接入配置（`.mcp.json` / `settings.local.json`）、默认设备优先级、设备配置两种布局、`split` 命令、常用字段、日志与数据目录 |
| [工具参考](./docs/03-使用指南/LV010-工具参考.md) | 基础 / 串口 / ADB / SSH / Windows 全量工具表、工具注册策略、单片机（MCU）模式 |
| [常见问题](./docs/03-使用指南/LV020-常见问题.md) | 串口被拒绝、环境变量未生效、重启被中断 |

### 2. 设计与部署

| 文档 | 内容 |
|------|------|
| [项目简介](./docs/01-MCP设计/LV005-项目简介.md) | 项目背景、与 PowerShell 直调的能力分界、场景选型 |
| [MCP 工具超时机制](./docs/01-MCP设计/LV025-工具超时机制.md) | **客户端（协议层）**：请求 60s 超时的成因、opencode / Claude Code 的 `timeout` 配置 |
| [exec 超时机制](./docs/01-MCP设计/LV095-exec超时机制.md) | **服务端（工具内部）**：常驻命令识别、采样超时与兜底超时、`timeoutMs` 传参约定、全局默认值 |
| [串口 ZMODEM 文件传输](./docs/01-MCP设计/LV065-串口ZMODEM文件传输.md) | ZMODEM 传输原理、持续输出对传输的影响、参数与重试 |
| [U-Boot 正则配置指南](./docs/01-MCP设计/LV070-U-Boot正则配置指南.md) | `serial.uboot` 提示符识别的正则适配 |
| [DTR/RTS 线序与 STM32 ISP 模式](./docs/01-MCP设计/LV075-DTR-RTS线序与STM32-ISP模式.md) | 单片机线序诊断、进 ISP 与救砖 |
| [Linux 远程连接 Windows MCP](./docs/02-部署与远程/LV005-Linux远程连接Windows%20MCP配置指南.md) | 跨机部署的 SSH 桥接配置 |
| [本地 MCP 配置](./docs/02-部署与远程/LV045-本地MCP配置.md) | `local-mcp-config` 在其它项目目录复用本 MCP |
| [exe 打包指南](./docs/02-部署与远程/LV040-exe打包指南.md) | 单文件 exe 打包与分发 |

> 上表前两篇同叫"超时"，但层级不同：**LV025 管「客户端等多久就判失败」**（`tools/call` 往返时长，由 MCP Client 决定）；**LV095 管「服务端何时认为一条命令跑完了」**（提示符检测 + 常驻命令采样/兜底超时，由工具内部决定）。排查"请求超时"看前者，排查"命令被提前中断/迟迟不返回"看后者。

> 完整文档列表见 [`docs/`](./docs) 目录：`01-MCP设计`（机制与设计分析）、`02-部署与远程`（跨机部署方案）、`03-使用指南`（配置、工具与排错）。
