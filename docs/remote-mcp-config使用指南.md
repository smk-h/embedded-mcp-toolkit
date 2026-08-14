<!-- more -->

## 一、 命令概述

`remote-mcp-config` 是 `embedded-mcp-toolkit` 提供的一个**交互式配置命令**，用于从 Windows 通过 SSH/SFTP 登录远程 Linux 服务器，在 Linux 端**自动写入 Claude Code / ZCode 的 MCP 桥接配置**。

它的核心价值，在于配合 MCP 服务实现「**远程 Agent + 本地 MCP**」的部署场景：MCP 本体始终由 Windows 本地的 `remote-start-mcp.bat` 启动（`node` 进程），Linux 编译服务器上的 Claude / ZCode 通过 `ssh` 免密反向登录到 Windows，把 MCP 作为远程工具来调用。`remote-mcp-config` 负责在 Linux 端把「桥接 server」的配置**按规范写入正确的文件**，省去手改 JSON 的繁琐与出错风险。

### 1. 命令与 MCP 环境的关系

一次完整的 MCP 环境配置，通常涉及两个对偶命令：

| 命令 | 角色 | 作用 |
|------|------|------|
| `sshd-config` | Windows 当 **SSH 服务器** | 让 Linux 免密登录进 Windows，搭好「桥」 |
| `remote-mcp-config` | Windows 当 **SSH 客户端** | 登录 Linux 后在其上写 MCP 桥接配置 |

> 本指南重点讲解 **`remote-mcp-config`** 这一侧。它负责把「桥接配置」写到 Linux 端正确的位置：它登录 Linux、通过 SFTP 读写几个 JSON 文件，自动把 `embedded-board` 这个 MCP 桥接 server 写入 Claude 全局 / Claude 项目 / ZCode 项目。

### 2. 适用场景

- 已经在 Windows 上用 `sshd-config` 搭好了「Linux → Windows」免密桥，需要把 MCP 桥接配置写到 Linux 端的 Claude / ZCode
- 需要在 Linux 编译服务器上配置 Claude 全局（`~/.claude.json`）或某个项目（`.mcp.json`）的 MCP 桥接
- 需要为 ZCode 项目（`.zcode/config.json`）配置 MCP 桥接
- 需要查看 Linux 端当前 MCP 配置状态、或删除已配置的桥接

### 3. 命令位置与源码

- 命令入口：[`src/cli/commands/remote-mcp-config/index.ts`](../src/cli/commands/remote-mcp-config/index.ts)
- 主菜单与主入口：[`src/cli/commands/remote-mcp-config/run.ts`](../src/cli/commands/remote-mcp-config/run.ts)
- 配置/删除/诊断流程：[`src/cli/commands/remote-mcp-config/operations.ts`](../src/cli/commands/remote-mcp-config/operations.ts)
- 落点路由：[`src/cli/commands/remote-mcp-config/target.ts`](../src/cli/commands/remote-mcp-config/target.ts)
- 状态判定与桥接构造：[`src/cli/commands/remote-mcp-config/status.ts`](../src/cli/commands/remote-mcp-config/status.ts)
- 命令注册：[`src/cli/index.ts`](../src/cli/index.ts)

---

## 二、 命令能做什么（三类落点）

`remote-mcp-config` 把 MCP 桥接 server（固定 key 名 `embedded-board`）写入 Linux 端的三类落点之一。**它的本质是「Windows 通过 SSH/SFTP 登录 Linux，读写 Linux 上几个 JSON 文件」**。Linux 端不需要安装 node、不需要本工具包、不需要设备配置——MCP 本体始终由 Windows 的 `remote-start-mcp.bat` 启动。

### 1. Claude 全局

- 写入文件：`~/.claude.json`
- 写入位置：顶层 `mcpServers.embedded-board`
- 效果：所有 Claude Code 项目都可用该桥接

### 2. Claude 项目

- 写入文件一：`<项目路径>/.mcp.json`
- 写入位置：`mcpServers.embedded-board`（server 定义）
- 写入文件二：`<项目路径>/.claude/settings.local.json`
- 写入位置：`enabledMcpjsonServers` 使能数组中追加 `embedded-board`
- 效果：仅指定项目可用该桥接

### 3. ZCode 项目

- 写入文件：`<项目路径>/.zcode/config.json`
- 写入位置：`mcp.servers.embedded-board`（额外带 `type: "stdio"` / `enabled: true`）
- 效果：指定 ZCode 项目可用该桥接（ZCode 全局本期不做）

### 4. 桥接 server 的定义

无论哪种落点，写入的 server 定义都是同一个「反向 SSH 桥接」：

```json
{
  "command": "ssh",
  "args": [
    "-i",
    "~/.ssh/id_mcp_server",
    "<win_user>@<win_ip>",
    "<remote-start-mcp.bat 的绝对路径>"
  ]
}
```

含义：Linux 端用专用密钥 `~/.ssh/id_mcp_server` 免密反向登录 Windows 的 `<win_user>@<win_ip>`，执行 `remote-start-mcp.bat` 拉起 Windows 上的 MCP 服务。ZCode 落点额外带 `type: "stdio"` / `enabled: true`。

---

## 三、 前置工作

使用 `remote-mcp-config` 之前，需要先准备好以下环境。**这些前置项缺失会导致命令无法运行或配置不生效**，务必逐项确认。

### 1. 运行平台：Windows

- `remote-mcp-config` 在本机（Windows）作为 **SSH 客户端** 运行。与 `sshd-config` 不同，它**不做平台校验、不需要管理员权限**，因为它只做 SSH/SFTP 客户端操作，不碰本机服务。
- 建议在 Windows 的 PowerShell / CMD 中运行。

### 2. 安装本工具（Node.js + npm）

- 需要已安装 Node.js（推荐 LTS 版本）与 npm。
- 通过 npm 全局安装（推荐）：

```bash
npm install -g embedded-mcp-toolkit
```

- 或源码安装（克隆仓库后）：

```bash
git clone <仓库地址>
cd embedded-mcp-toolkit
npm install
npm run build
```

### 3. 在 Windows 项目根目录先执行 `init` 初始化

`remote-mcp-config` 写入的桥接 server，其 `args` 里的 `remote-start-mcp.bat` 路径取自**运行命令时的当前工作目录（cwd）**。因此：

1. 先运行 `init` 在 Windows 项目根目录初始化，生成 `remote-start-mcp.bat` 及 `.embedded/configs/` 等配置：

```bash
embedded-mcp-toolkit init
```

2. **在初始化后的项目根目录**下运行 `remote-mcp-config`，这样桥接配置才能正确指向 `remote-start-mcp.bat`。

> `remote-start-mcp.bat` 的作用：锚定工作目录并注入 `DEVICE`、`BOARD_CONFIG_PATH`、`LOG_SAVE` 等环境变量，确保无论本地启动还是经 Linux 通过 SSH 远程启动，`node` 进程都能拿到与本地 Claude 启动一致的运行环境。

### 4. 搭建「Linux → Windows」免密桥（配套 `sshd-config`）

`remote-mcp-config` 写的是「反向 SSH 桥接」配置，依赖 Linux 能**免密登录进 Windows**。这需要先通过配套命令 `sshd-config` 搭好桥：

- 在 Windows 端安装并启动 OpenSSH Server（放行 22 端口入站）
- 在 Linux 编译服务器端生成 MCP 专用密钥对 `~/.ssh/id_mcp_server`（RSA 4096，免密）
- 把 Linux 端公钥写入 Windows 的 `~/.ssh/authorized_keys`

> 简单说：**先 `sshd-config` 搭桥（让 Linux 免密进来），再 `remote-mcp-config` 写桥接配置（在 Linux 端写 MCP 配置）**。

### 5. 远程 Linux 服务器（对端）

- 目标 Linux 服务器需**已安装并启动 sshd**，Windows 能 SSH 登录它。
- 需要知道 Linux 服务器的登录账号、IP（可选端口）与密码（命令会交互收集）。
- 若 Linux 端是 Claude / ZCode 的 Agent 运行环境，则本步骤后即可在 Linux 端启用 MCP 桥接。

### 6. 网络连通性

- Windows 与 Linux 之间需网络互通。
- 尤其要保证 Linux 能反向 SSH 到 Windows 的 IP（即「前置工作 4」中搭的桥），否则桥接 server 无法工作。
- 若 Windows 多网卡，`remote-mcp-config` 会让你**选择 Linux 可路由的那个 IP** 作为反向连接地址。

---

## 四、 如何运行命令

在 Windows 上打开终端，在**初始化后的项目根目录**执行：

```bash
embedded-mcp-toolkit remote-mcp-config
```

命令启动后会交互收集连接信息，连接成功后再展示交互式主菜单。

### 1. 连接信息交互

1. **远程 Linux 服务器地址**：输入 `user@host[:port]` 格式，如 `sumu@1.2.3.4` 或 `root@1.2.3.4:2222`。
2. **登录密码**：输入密码（不回显）。

命令尝试 SSH 连接 Linux。连接失败会报错并中止（请检查地址/端口/凭据，以及远端 sshd 是否可达）；成功后打开一个贯穿整个菜单循环复用的 SFTP 会话（避免反复开 channel 触发远端会话限制）。

### 2. 主菜单选项

| 编号 | 功能 | 说明 |
|------|------|------|
| `1` | 配置 MCP 桥接 | 采集本机端点 → 选择落点 → 展示状态 → 确认写入 |
| `2` | 查看远端当前 MCP 配置状态 | 只读诊断，不修改任何文件 |
| `3` | 删除已配置的 MCP | 从选中的落点移除 `embedded-board` |
| `0` | 退出 | 结束命令 |

---

## 五、 配置 MCP 桥接的完整流程

以下以菜单 `[1]`「配置 MCP 桥接」为例，说明一次完整配置做了什么。

### 1. 第一步：采集本机端点

命令自动采集 Windows 本机的 SSH 登录用户名与可用 IPv4 地址（已过滤回环、链路本地 `169.254`、以及 VirtualBox / VMware / Hyper-V / WSL / Docker 等虚拟网卡），并拼接 `remote-start-mcp.bat` 的绝对路径（取当前 cwd）：

- 仅 1 个 IP：直接采用，无需介入
- 多个 IP：交互式让你选择「Windows 主 IP（远程反连地址）」，避免取到 Linux 路由不可达的网段
- 无可用 IP：提示「未检测到本机可用 IPv4 地址」并中止

### 2. 第二步：选择落点（客户端类型 + 范围）

命令交互式引导你选择写入到哪里：

- **选择客户端类型**：`Claude Code` 或 `ZCode`
- 若选 **Claude Code**：再选**全局**（`~/.claude.json`，所有项目可用）或**项目**（需输入远端项目绝对路径）
- 若选 **ZCode**：直接输入远端项目绝对路径（本期仅项目级）

> 项目路径需为远端 Linux 上的**绝对路径**，如 `/home/sumu/my-project`。

### 3. 第三步：展示当前状态并确认

命令会**先读取并展示**各落点文件的当前状态（只读，不写入）：

- `absent`：未配置（文件不存在 / 无该 server / 未使能）
- `consistent`：已配置且与当前桥接定义一致
- `inconsistent`：已配置但 `command/args` 与当前定义不一致（将覆盖更新）
- `error`：文件存在但 JSON 解析失败（会中止）

确认无误后，选择「确认写入」才会真正落盘。

### 4. 第四步：写入配置

命令通过 SFTP 对每个落点文件执行「**备份 → 读 → 本地 JSON 改写 → 写回**」的原子流程：

1. 将原文件备份为 `<文件>.bak`（若 `.bak` 已存在则保留首次备份）
2. 读取原文件（不存在则当作空 `{}`）
3. 在本地对象上写入 `embedded-board` server 定义，并追加使能数组项
4. 序列化（2 空格缩进 + 尾换行）后写回远端
5. 写入失败自动用 `.bak` 回滚

> 所有文件读写都走 **SFTP 整文件**方式，不通过 shell 改文件，规避 JSON 引号转义与远端编码问题。

### 5. 第五步：回显与生效

写入完成后命令回显最终写入的桥接定义（`command` 与 `args`），并提示**需重启对应 client（Claude / ZCode）使配置生效**。

---

## 六、 查看与删除配置

### 1. 查看当前配置状态（菜单 `[2]`）

只读诊断：选择落点后，命令读取并展示各文件当前状态（`absent` / `consistent` / `inconsistent` / `error`），**不修改任何文件**。即使本机无可反连的 IP，也允许用占位端点做展示。

### 2. 删除已配置的 MCP（菜单 `[3]`）

选择落点后，命令展示各文件是否「已配置，可删除」，确认后从各文件中移除 `embedded-board`（server 定义 + 使能数组项）。文件不存在或未配置时会提示「无需删除」而非报错。同样带备份与失败回滚保护。

---

## 七、 使用流程小结（推荐顺序）

要在「远程 Agent + 本地 MCP」场景下完整配置好 MCP 环境，推荐按以下顺序操作：

```
1.  Windows 项目根目录执行 init          → 生成 remote-start-mcp.bat 与配置
2.  Windows 执行 sshd-config 搭桥        → Linux 免密反向登录进 Windows
3.  Windows 执行 remote-mcp-config       → 在 Linux 端写 Claude/ZCode 的 MCP 桥接配置
4.  Linux 端重启 Claude / ZCode          → 即可通过 embedded-board 调用 Windows 上的 MCP 工具
```

第 3 步 `remote-mcp-config` 的三种落点按需选择其一（Claude 全局 / Claude 项目 / ZCode 项目），可重复执行对不同落点或不同项目写入。

---

## 八、 常见问题

### 1. 连接 Linux 失败？

- 检查地址格式是否为 `user@host[:port]`、密码是否正确。
- 确认远端 Linux sshd 已启动且 Windows 能路由到达该 IP。

### 2. 桥接配置写好了，但 Linux 端调用 MCP 失败？

- 检查「Linux → Windows」免密桥是否已搭好：先用 `sshd-config` 完成安装 SSH + 生成密钥 + 配置 sshd 三步。
- 确认 Windows 防火墙放行 22 端口入站，Linux 能 `ssh` 反向登录 Windows。
- 确认 `remote-start-mcp.bat` 的路径在桥接定义中与 Windows 实际路径一致（运行命令的 cwd 需在项目根目录）。
- 多网卡时确认选择的「Windows 主 IP」是 Linux 可路由的那一个。

### 3. 提示「未检测到本机可用 IPv4 地址」？

- 本机网络可能未连通，或所有 IPv4 均被判定为回环 / 链路本地 / 虚拟网卡而过滤。
- 确认 Windows 网络连接正常后重试。

### 4. 已配置但状态显示 `inconsistent`？

- 说明现有 `embedded-board` 的 `command/args` 与当前桥接定义不一致（如 IP / 用户名 / bat 路径已变化）。再次配置时会覆盖更新为当前值。

### 5. 需要备份？

- 每次写入前命令会自动把原文件备份为 `<文件>.bak`（保留首次备份），写入失败会自动回滚，无需手工备份。

---

*本文档由 markdowncli 技能辅助生成*
