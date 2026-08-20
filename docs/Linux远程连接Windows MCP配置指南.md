<!-- more -->

## 一、 文档说明

本指南用于在「远程 Agent + 本地 MCP」场景下，搭建 **Linux 编译服务器运行 Claude Code / ZCode、并远程连接 Windows 上的 MCP 服务** 的完整环境。

整体方案由 `embedded-mcp-toolkit` 的两个**对偶命令**配合完成：

| 命令 | 角色 | 作用 |
|------|------|------|
| `sshd-config` | Windows 当 **SSH 服务器** | 让 Linux 免密登录进 Windows，搭好「桥」 |
| `remote-mcp-config` | Windows 当 **SSH 客户端** | 登录 Linux 后在其上写 MCP 桥接配置 |

### 1. 整体架构

MCP 本体始终运行在 **Windows 本地**（由 `remote-start-mcp.bat` 拉起 `node` 进程），Linux 编译服务器上的 Claude Code / ZCode 通过 `ssh` 免密**反向登录**到 Windows，把 MCP 作为远程工具来调用。整体环境如下图所示：

![Linux 远程连接 Windows MCP 环境架构图](./Linux远程连接Windows%20MCP配置指南/img/architecture.svg)

一次完整的 MCP 环境配置通常分两步（对应架构图中两条链路：① 搭桥 + ② 写入桥接配置）：

1. **先 `sshd-config` 搭桥**：让 Linux 能免密登录进 Windows（反向 SSH 桥）。
2. **再 `remote-mcp-config` 写桥接配置**：把 `embedded-board` 这个桥接 server 按规范写入 Linux 端 Claude / ZCode / opencode 的配置文件。

### 2. 适用场景

- 需要在多台机器间搭建「远程 Agent + 本地 MCP」的分布式开发环境
- 需要从 Linux 编译服务器通过 SSH 免密登录 Windows，以调用 Windows 上运行的 MCP 服务
- 需要为 Linux 端的 Claude / ZCode / opencode 配置 SSH 桥接式 MCP server

---

## 二、 前置工作

使用这两个命令之前，需要先准备好以下环境。**这些前置项缺失会导致命令无法运行或配置失败**，务必逐项确认。

### 1. 运行平台：Windows

- 两个命令均在 **Windows** 上运行。
- `sshd-config` **仅支持 Windows**，在 Linux / macOS 上运行会直接提示 `本命令仅支持 Windows` 并退出；且需要**管理员权限**（自动 UAC 提权），建议以管理员身份运行。
- `remote-mcp-config` 在本机只做 SSH/SFTP 客户端操作，**不需要管理员权限**，不校验平台。
- 支持的 Windows 版本：Windows 10 / 11 及对应的 Windows Server（需支持 OpenSSH Server）。

### 2. Node.js 与 npm

- 需要已安装 Node.js（推荐 LTS 版本）与 npm，用于安装本工具。

### 3. 安装本工具

通过 npm 全局安装（推荐）：

```bash
npm install -g embedded-mcp-toolkit
```

或源码安装（克隆仓库后）：

```bash
git clone <仓库地址>
cd embedded-mcp-toolkit
npm install
npm run build
```

### 4. 先初始化 MCP 项目（生成启动脚本与配置）

两个命令生成的 MCP 模板 / 桥接 server 里，`remote-start-mcp.bat` 的路径均取自**运行命令时的当前工作目录（cwd）**。因此建议先运行 `init` 命令初始化项目，在项目根目录生成 `remote-start-mcp.bat` 及 `.embedded/configs/` 等配置：

```bash
embedded-mcp-toolkit init
```

> **重要**：请**在初始化后的项目根目录**下运行后续两个命令，这样生成的模板 / 桥接配置才能正确指向 `remote-start-mcp.bat`。

> `remote-start-mcp.bat` 的作用：锚定工作目录并注入 `DEVICE`、`BOARD_CONFIG_PATH`、`LOG_SAVE` 等环境变量，确保无论本地启动还是经 Linux 通过 SSH 远程启动，`node` 进程都能拿到与本地 Claude 启动一致的运行环境。

### 5. Linux 编译服务器（对端）

- 目标 Linux 服务器需**已安装并启动 sshd**。
- 若未安装，可在 Linux 端先执行：

```bash
# Debian / Ubuntu
sudo apt install openssh-server && sudo systemctl start sshd

# RHEL / CentOS
sudo dnf install openssh-server && sudo systemctl start sshd
```

- 需要知道 Linux 服务器的登录账号、IP 与密码（命令会交互收集）。

### 6. 网络连通性

- Windows 与 Linux 之间需网络互通。
- 尤其要保证 Linux 能反向 SSH 到 Windows 的 IP（即 `sshd-config` 搭的桥），否则桥接 server 无法工作。
- Windows 防火墙需放行 **22 端口入站**（安装 OpenSSH 后，`sshd-config` 会自动处理相关配置）。
- 若 Windows 多网卡，命令会交互式让你选择 **Linux 可路由的那个 IP** 作为反向连接地址。

---

## 三、 第一步：用 `sshd-config` 搭桥

`sshd-config` 负责把「桥」建好：安装 Windows OpenSSH 服务、生成 MCP 专用密钥对、把公钥写入 Windows 的 `authorized_keys`，并最终生成一份 Linux 端可直接使用的 `.mcp.json` 模板。

### 1. 如何运行命令

在 Windows 上以管理员身份打开终端，在**初始化后的项目根目录**执行：

```bash
embedded-mcp-toolkit sshd-config
```

命令会先做平台校验与管理权限检查，通过后展示交互式主菜单。

#### 1.1 主菜单选项

| 编号 | 功能 | 说明 |
|------|------|------|
| `1` | 一键完成全流程 | 依次执行安装 → 密钥 → 配置 → 模板 |
| `2` | 安装 Windows SSH 服务 | 在线 / MSI 双途径安装 OpenSSH Server |
| `3` | 编译服务器生成密钥对 | 登录 Linux 生成 `id_mcp_server` 密钥对并拉取公钥 |
| `4` | 配置 Windows 中 sshd 服务 | 写 `authorized_keys`、改 `sshd_config` |
| `5` | 检查 sshd 配置状态 | 只读诊断，不修改任何文件 |
| `6` | 卸载 Windows SSH 服务 | 卸载并清理 |
| `7` | 查看本机连接信息 | 展示用户名与可用 IPv4 地址 |
| `8` | 生成 Linux 端 MCP 配置模板 | 生成 `.mcp.json` 模板 |
| `0` | 退出 | 结束命令 |

### 2. 一键完成全流程（推荐）

在菜单选择 `[1]`，命令会自动按顺序执行四个步骤：

```
安装 SSH 服务 → 生成密钥对 → 配置 sshd → 生成 MCP 模板
```

任一步骤失败会中止并提示，可修复后重新进入对应菜单项单独执行。下面按步骤说明每个环节做了什么，以及需要准备什么。

#### 2.1 步骤一：安装 Windows SSH 服务（菜单 `[2]`）

命令先检测 sshd 是否已安装，已安装则跳过。未安装时让你选择安装方式：

- **MSI 离线安装（默认）**：从 GitHub 下载 `OpenSSH-Win64.msi` 并静默安装。安装包会缓存到 `.embedded/ssh/OpenSSH-Win64.msi`，可重复使用。
- **在线安装**：调用 `Add-WindowsCapability` 安装，依赖 Windows Update，国内网络可能较慢。

安装完成后命令会**启动 sshd 并设为开机自启**。

> **前置要求**：本步骤需要管理员权限。

#### 2.2 步骤二：编译服务器生成密钥对（菜单 `[3]`）

命令交互式收集 Linux 服务器地址（`user@host[:port]`）与登录密码，SSH 登录后：

1. 采集对端用户名、主机 IP、家目录用于核对。
2. 检测远端 sshd 是否运行，未运行则提示安装命令。
3. 在 Linux 端生成 MCP 专用密钥对 `~/.ssh/id_mcp_server`（RSA 4096，免密）。
4. 通过 SFTP 把公钥 `id_mcp_server.pub` 拉取到本地 `.embedded/ssh/id_mcp_server.pub`。

> **说明**：使用专用密钥名 `id_mcp_server`，避免覆盖你原有的通用密钥。若已存在会询问是否覆盖。

#### 2.3 步骤三：配置 Windows sshd（菜单 `[4]`）

命令在 Windows 端完成三件事：

1. 把上一步拉取的公钥追加到 `~/.ssh/authorized_keys`（自动去重）。
2. 备份并修改 `C:\ProgramData\ssh\sshd_config`：开启 `PubkeyAuthentication`、指定 `AuthorizedKeysFile`、禁用 `Match Group administrators` 分组规则。
3. 重启 sshd 使配置生效。

> **前置要求**：必须先执行步骤二（生成了公钥）、步骤一（安装了 sshd），否则会提示缺少公钥或 sshd_config。

#### 2.4 步骤四：生成 Linux 端 MCP 配置模板（菜单 `[8]`）

命令自动采集本机用户名与 IPv4 地址，结合专用密钥名（`id_mcp_server`）与 `remote-start-mcp.bat` 路径，生成一份 Linux 端可直接使用的 `.mcp.json` 模板，写入：

```
.embedded/ssh/mcp-remote-template.json
```

生成内容大致如下：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "mcpServers": {
    "embedded-board": {
      "command": "ssh",
      "args": [
        "-i",
        "~/.ssh/id_mcp_server",
        "<win_user>@<win_ip>",
        "<path>/remote-start-mcp.bat"
      ]
    }
  }
}
```

> 多网卡时取首个 IP 作为默认值，其余候选 IP 会在提示中列出，供手动选用。

---

## 四、 第二步：用 `remote-mcp-config` 写桥接配置

`remote-mcp-config` 负责把「桥接配置」写到 Linux 端正确的位置：它登录 Linux、通过 SFTP 读写几个 JSON 文件，自动把 `embedded-board` 这个 MCP 桥接 server 写入 Claude 全局 / Claude 项目 / ZCode 项目 / opencode 全局 / opencode 项目。

### 1. 命令能做什么（五类落点）

`remote-mcp-config` 把 MCP 桥接 server（固定 key 名 `embedded-board`）写入 Linux 端的五类落点之一。**它的本质是「Windows 通过 SSH/SFTP 登录 Linux，读写 Linux 上几个 JSON 文件」**。Linux 端不需要安装 node、不需要本工具包、不需要设备配置——MCP 本体始终由 Windows 的 `remote-start-mcp.bat` 启动。

#### 1.1 Claude 全局

- 写入文件：`~/.claude.json`
- 写入位置：顶层 `mcpServers.embedded-board`
- 效果：所有 Claude Code 项目都可用该桥接

#### 1.2 Claude 项目

- 写入文件一：`<项目路径>/.mcp.json`
- 写入位置：`mcpServers.embedded-board`（server 定义）
- 写入文件二：`<项目路径>/.claude/settings.local.json`
- 写入位置：`enabledMcpjsonServers` 使能数组中追加 `embedded-board`
- 效果：仅指定项目可用该桥接

#### 1.3 ZCode 项目

- 写入文件：`<项目路径>/.zcode/config.json`
- 写入位置：`mcp.servers.embedded-board`（额外带 `type: "stdio"` / `enabled: true`）
- 效果：指定 ZCode 项目可用该桥接（ZCode 全局本期不做）

#### 1.4 opencode

opencode 支持全局与项目两级落点：

- **全局**：写入文件 `~/.config/opencode/opencode.json`
- **项目**：写入文件 `<项目路径>/.opencode/opencode.json`
- 写入位置：顶层 `mcp.embedded-board`（opencode 风格：`command` 为数组，额外带 `type: "local"` / `enabled: true` / `timeout: 600000`）；文件缺 `$schema` 时自动补齐 `"$schema": "https://opencode.ai/config.json"`
- 效果：全局对所有项目可用，项目仅指定项目可用（opencode 全局与项目配置会**合并**，非覆盖）

#### 1.5 桥接 server 的定义

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

含义：Linux 端用专用密钥 `~/.ssh/id_mcp_server` 免密反向登录 Windows 的 `<win_user>@<win_ip>`，执行 `remote-start-mcp.bat` 拉起 Windows 上的 MCP 服务。ZCode 落点额外带 `type: "stdio"` / `enabled: true`；opencode 落点把 `command`+`args` 合并为 `command` 数组，额外带 `type: "local"` / `enabled: true` / `timeout: 600000`。

### 2. 如何运行命令

在 Windows 上打开终端，在**初始化后的项目根目录**执行：

```bash
embedded-mcp-toolkit remote-mcp-config
```

命令启动后会交互收集连接信息，连接成功后再展示交互式主菜单。

#### 2.1 连接信息交互

1. **远程 Linux 服务器地址**：输入 `user@host[:port]` 格式，如 `sumu@1.2.3.4` 或 `root@1.2.3.4:2222`。
2. **登录密码**：输入密码（不回显）。

命令尝试 SSH 连接 Linux。连接失败会报错并中止（请检查地址/端口/凭据，以及远端 sshd 是否可达）；成功后打开一个贯穿整个菜单循环复用的 SFTP 会话（避免反复开 channel 触发远端会话限制）。

#### 2.2 主菜单选项

| 编号 | 功能 | 说明 |
|------|------|------|
| `1` | 配置 MCP 桥接 | 采集本机端点 → 选择落点 → 展示状态 → 确认写入 |
| `2` | 查看远端当前 MCP 配置状态 | 只读诊断，不修改任何文件 |
| `3` | 删除已配置的 MCP | 从选中的落点移除 `embedded-board` |
| `0` | 退出 | 结束命令 |

### 3. 配置 MCP 桥接的完整流程

以下以菜单 `[1]`「配置 MCP 桥接」为例，说明一次完整配置做了什么。

#### 3.1 第一步：采集本机端点

命令自动采集 Windows 本机的 SSH 登录用户名与可用 IPv4 地址（已过滤回环、链路本地 `169.254`、以及 VirtualBox / VMware / Hyper-V / WSL / Docker 等虚拟网卡），并拼接 `remote-start-mcp.bat` 的绝对路径（取当前 cwd）：

- 仅 1 个 IP：直接采用，无需介入
- 多个 IP：交互式让你选择「Windows 主 IP（远程反连地址）」，避免取到 Linux 路由不可达的网段
- 无可用 IP：提示「未检测到本机可用 IPv4 地址」并中止

#### 3.2 第二步：选择落点（客户端类型 + 范围）

命令交互式引导你选择写入到哪里：

- **选择客户端类型**：`Claude Code` / `ZCode` / `opencode`
- 若选 **Claude Code**：再选**全局**（`~/.claude.json`，所有项目可用）或**项目**（需输入远端项目绝对路径）
- 若选 **ZCode**：直接输入远端项目绝对路径（本期仅项目级）
- 若选 **opencode**：再选**全局**（`~/.config/opencode/opencode.json`，所有项目可用）或**项目**（`.opencode/opencode.json`，需输入远端项目绝对路径）

> 项目路径需为远端 Linux 上的**绝对路径**，如 `/home/sumu/my-project`。

#### 3.3 第三步：展示当前状态并确认

命令会**先读取并展示**各落点文件的当前状态（只读，不写入）：

- `absent`：未配置（文件不存在 / 无该 server / 未使能）
- `consistent`：已配置且与当前桥接定义一致
- `inconsistent`：已配置但 `command/args` 与当前定义不一致（将覆盖更新）
- `error`：文件存在但 JSON 解析失败（会中止）

确认无误后，选择「确认写入」才会真正落盘。

#### 3.4 第四步：写入配置

命令通过 SFTP 对每个落点文件执行「**备份 → 读 → 本地 JSON 改写 → 写回**」的原子流程：

1. 将原文件备份为 `<文件>.bak`（若 `.bak` 已存在则保留首次备份）
2. 读取原文件（不存在则当作空 `{}`）
3. 在本地对象上写入 `embedded-board` server 定义，并追加使能数组项
4. 序列化（2 空格缩进 + 尾换行）后写回远端
5. 写入失败自动用 `.bak` 回滚

> 所有文件读写都走 **SFTP 整文件**方式，不通过 shell 改文件，规避 JSON 引号转义与远端编码问题。

#### 3.5 第五步：回显与生效

写入完成后命令回显最终写入的桥接定义（按落点渲染后的 server 对象），并提示**需重启对应 client（Claude / ZCode / opencode）使配置生效**。

### 4. 查看与删除配置

#### 4.1 查看当前配置状态（菜单 `[2]`）

只读诊断：选择落点后，命令读取并展示各文件当前状态（`absent` / `consistent` / `inconsistent` / `error`），**不修改任何文件**。即使本机无可反连的 IP，也允许用占位端点做展示。

#### 4.2 删除已配置的 MCP（菜单 `[3]`）

选择落点后，命令展示各文件是否「已配置，可删除」，确认后从各文件中移除 `embedded-board`（server 定义 + 使能数组项）。文件不存在或未配置时会提示「无需删除」而非报错。同样带备份与失败回滚保护。

---

## 五、 配置收尾步骤

两个命令完成后，「桥」和「桥接配置」都已就绪。要让 MCP 真正在 Linux 端生效，还需完成以下收尾：

### 1. 复制模板到 Linux 项目根目录（如走 `sshd-config` 模板方式）

将 `sshd-config` 生成的 `mcp-remote-template.json` 复制到 Linux 端项目根目录，并**重命名为 `.mcp.json`**。

### 2. 按需修改模板

- `ssh` 连接的 IP：当前为模板中的主 IP，若不通换用其它候选 IP。
- `remote-start-mcp.bat` 的绝对路径：确保与 Windows 端实际路径一致。

### 3. 首次连接信任主机密钥

MCP 客户端首次连接 Windows 会触发主机密钥确认。**需先在 Linux 端手动执行一次 SSH 连接并输入 `yes` 完成信任**：

```bash
ssh -i ~/.ssh/id_mcp_server <win_user>@<win_ip>
```

完成后客户端即可自动免密连接。

### 4. 重启客户端使配置生效

在 Linux 端重启 Claude Code（或对应 MCP 客户端），即可通过 `embedded-board` 调用 Windows 上的 MCP 工具。

> **可选进阶**：如需在 Linux 端做更精细的 MCP 桥接配置（如 Claude 全局 / 项目、ZCode 项目、opencode 全局 / 项目落点），可配合使用 `remote-mcp-config`，它通过 SFTP 直接在 Linux 端写 `~/.claude.json`、`.mcp.json`、`.zcode/config.json`、`~/.config/opencode/opencode.json`、`.opencode/opencode.json`。

---

## 六、 使用流程小结（推荐顺序）

要在「远程 Agent + 本地 MCP」场景下完整配置好 MCP 环境，推荐按以下顺序操作：

```
1.  Windows 项目根目录执行 init              → 生成 remote-start-mcp.bat 与配置
2.  Windows 执行 sshd-config 搭桥            → Linux 免密反向登录进 Windows
3.  Windows 执行 remote-mcp-config           → 在 Linux 端写 Claude/ZCode/opencode 的 MCP 桥接配置
4.  Linux 端重启 Claude / ZCode / opencode   → 即可通过 embedded-board 调用 Windows 上的 MCP 工具
```

第 3 步 `remote-mcp-config` 的五种落点按需选择其一（Claude 全局 / Claude 项目 / ZCode 项目 / opencode 全局 / opencode 项目），可重复执行对不同落点或不同项目写入。

---

## 七、 常见问题

### 1. 命令提示「本命令仅支持 Windows」？

- `sshd-config` 仅能在 Windows 上运行。请确认是在 Windows 的 PowerShell / CMD 中执行。

### 2. 命令自动退出或需要提权？

- 非管理员运行 `sshd-config` 时会触发 UAC 提权重启。建议直接以「管理员身份」打开终端再执行。

### 3. 安装 SSH 服务时下载慢或失败？

- 默认走 MSI 离线安装，从 GitHub 下载。网络不佳时可改选「在线安装」，或手动下载 MSI 放到 `.embedded/ssh/OpenSSH-Win64.msi` 复用。

### 4. Linux 端 SSH 免密登录 Windows 失败？

- 确认已依次完成：安装 SSH（菜单 `[2]`）→ 生成密钥（`[3]`）→ 配置 sshd（`[4]`）。
- 用 `sshd-config` 菜单 `[5]` 检查 sshd 配置状态（只读诊断），确认 `PubkeyAuthentication`、`AuthorizedKeysFile` 等关键项正确。
- 检查 Windows 防火墙是否放行 22 端口入站，以及 Windows 的 IP 是否可从 Linux 路由可达。

### 5. 连接 Linux（写桥接配置时）失败？

- 检查地址格式是否为 `user@host[:port]`、密码是否正确。
- 确认远端 Linux sshd 已启动且 Windows 能路由到达该 IP。

### 6. 桥接配置写好了，但 Linux 端调用 MCP 失败？

- 检查「Linux → Windows」免密桥是否已搭好：先用 `sshd-config` 完成安装 SSH + 生成密钥 + 配置 sshd 三步。
- 确认 Windows 防火墙放行 22 端口入站，Linux 能 `ssh` 反向登录 Windows。
- 确认 `remote-start-mcp.bat` 的路径在桥接定义中与 Windows 实际路径一致（运行命令的 cwd 需在项目根目录）。
- 多网卡时确认选择的「Windows 主 IP」是 Linux 可路由的那一个。

### 7. 配置模板生成的 IP 不通？

- 多网卡时默认取首个 IP，可能并非 Linux 可路由的那一个。用 `sshd-config` 菜单 `[7]` 查看所有可用 IP，在模板中改用候选 IP。

### 8. 提示「未检测到本机可用 IPv4 地址」？

- 本机网络可能未连通，或所有 IPv4 均被判定为回环 / 链路本地 / 虚拟网卡而过滤。
- 确认 Windows 网络连接正常后重试。

### 9. 已配置但状态显示 `inconsistent`？

- 说明现有 `embedded-board` 的 `command/args` 与当前桥接定义不一致（如 IP / 用户名 / bat 路径已变化）。再次配置时会覆盖更新为当前值。

### 10. 需要备份？

- 每次写入前命令会自动把原文件备份为 `<文件>.bak`（保留首次备份），写入失败会自动回滚，无需手工备份。

---

*本文档由 markdowncli 技能辅助生成*
