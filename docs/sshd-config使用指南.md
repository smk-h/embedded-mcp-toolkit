<!-- more -->

## 一、 命令概述

`sshd-config` 是 `embedded-mcp-toolkit` 提供的一个**交互式配置命令**，用于在 Windows 端搭建「Linux 编译服务器 → Windows 本地」的 SSH 免密登录环境。

它的核心价值，在于配合 MCP 服务实现「**远程 Agent + 本地 MCP**」的部署场景：MCP 本体运行在 Windows 本地（`remote-start-mcp.bat` 拉起 `node` 进程），而 Linux 编译服务器上的 Claude / ZCode 通过 `ssh` 免密反向登录到 Windows，把 MCP 作为远程工具来调用。

### 1. 命令与 MCP 环境的关系

一次完整的 MCP 环境配置，通常涉及两个对偶命令：

| 命令 | 角色 | 作用 |
|------|------|------|
| `sshd-config` | Windows 当 **SSH 服务器** | 让 Linux 免密登录进 Windows，搭好「桥」 |
| `remote-mcp-config` | Windows 当 **SSH 客户端** | 登录 Linux 后在其上写 MCP 桥接配置 |

> 本指南重点讲解 **`sshd-config`** 这一侧。它负责把「桥」建好：安装 Windows OpenSSH 服务、生成 MCP 专用密钥对、把公钥写入 Windows 的 `authorized_keys`，并最终生成一份 Linux 端可直接使用的 `.mcp.json` 模板。

### 2. 适用场景

- 需要从 Linux 编译服务器通过 SSH 免密登录 Windows，以调用 Windows 上运行的 MCP 服务
- 需要在多台机器间搭建「远程 Agent + 本地 MCP」的分布式开发环境
- 需要为 Claude / ZCode 配置 SSH 桥接式 MCP server

### 3. 命令位置与源码

- 命令入口：[`src/cli/commands/sshd-config/index.ts`](../src/cli/commands/sshd-config/index.ts)
- 主菜单与主入口：[`src/cli/commands/sshd-config/run.ts`](../src/cli/commands/sshd-config/run.ts)
- 命令注册：[`src/cli/index.ts`](../src/cli/index.ts)

---

## 二、 前置工作

使用 `sshd-config` 之前，需要先准备好以下环境。**这些前置项缺失会导致命令无法运行或配置失败**，务必逐项确认。

### 1. 运行平台：Windows

- `sshd-config` **仅支持 Windows**。在 Linux / macOS 上运行会直接提示 `本命令仅支持 Windows` 并退出。
- 支持的 Windows 版本：Windows 10 / 11 及对应的 Windows Server（需支持 OpenSSH Server）。

### 2. 管理员权限

- 命令启动后会**自动检查管理员权限**，非管理员时会通过 UAC 提权重启本进程。
- 因此建议直接以「管理员身份」打开 PowerShell / CMD 运行，避免中途提权打断交互。

### 3. Node.js 与 npm

- 需要已安装 Node.js（推荐 LTS 版本）与 npm，用于安装本工具。

### 4. 安装本工具

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

### 5. 先初始化 MCP 项目（生成启动脚本与配置）

`sshd-config` 生成 MCP 模板时，`remote-start-mcp.bat` 的路径取自**运行命令时的当前工作目录（cwd）**。因此建议先运行 `init` 命令初始化项目，在项目根目录生成 `remote-start-mcp.bat` 及 `.embedded/configs/` 等配置：

```bash
embedded-mcp-toolkit init
```

> **重要**：请**在初始化后的项目根目录**下运行 `sshd-config`，这样生成的模板才能正确指向 `remote-start-mcp.bat`（MCP 启动脚本），Linux 端才能通过它拉起 Windows 上的 MCP 服务。

### 6. Linux 编译服务器（对端）

- 目标 Linux 服务器需**已安装并启动 sshd**。
- 若未安装，命令会在生成密钥步骤中提示，可在 Linux 端先执行：

```bash
# Debian / Ubuntu
sudo apt install openssh-server && sudo systemctl start sshd

# RHEL / CentOS
sudo dnf install openssh-server && sudo systemctl start sshd
```

- 需要知道 Linux 服务器的登录账号、IP 与密码（用于本命令远程生成密钥）。

### 7. 网络连通性

- Windows 与 Linux 之间需网络互通。
- 建议 Linux 端先能 `ping` 通 Windows 的 IP，Windows 防火墙需放行 **22 端口入站**（安装 OpenSSH 后，命令会自动处理相关配置，必要时手动添加防火墙规则）。

---

## 三、 如何运行命令

在 Windows 上以管理员身份打开终端，执行：

```bash
embedded-mcp-toolkit sshd-config
```

命令会先做平台校验与管理权限检查，通过后展示交互式主菜单。

### 1. 主菜单选项

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

---

## 四、 使用命令配置 MCP 环境的完整流程

以下是「使用 `sshd-config` 配置 MCP 环境」的**推荐流程**。首次使用建议直接选择菜单 `[1]` 一键完成；也可按需分步执行。

### 1. 一键完成全流程（推荐）

在菜单选择 `[1]`，命令会自动按顺序执行四个步骤：

```
安装 SSH 服务 → 生成密钥对 → 配置 sshd → 生成 MCP 模板
```

任一步骤失败会中止并提示，可修复后重新进入对应菜单项单独执行。

下面按步骤说明每个环节做了什么，以及需要准备什么。

### 2. 步骤一：安装 Windows SSH 服务（菜单 `[2]`）

命令先检测 sshd 是否已安装，已安装则跳过。未安装时让你选择安装方式：

- **MSI 离线安装（默认）**：从 GitHub 下载 `OpenSSH-Win64.msi` 并静默安装。安装包会缓存到 `.embedded/ssh/OpenSSH-Win64.msi`，可重复使用。
- **在线安装**：调用 `Add-WindowsCapability` 安装，依赖 Windows Update，国内网络可能较慢。

安装完成后命令会**启动 sshd 并设为开机自启**。

> **前置要求**：本步骤需要管理员权限。

### 3. 步骤二：编译服务器生成密钥对（菜单 `[3]`）

命令交互式收集 Linux 服务器地址（`user@host[:port]`）与登录密码，SSH 登录后：

1. 采集对端用户名、主机 IP、家目录用于核对。
2. 检测远端 sshd 是否运行，未运行则提示安装命令。
3. 在 Linux 端生成 MCP 专用密钥对 `~/.ssh/id_mcp_server`（RSA 4096，免密）。
4. 通过 SFTP 把公钥 `id_mcp_server.pub` 拉取到本地 `.embedded/ssh/id_mcp_server.pub`。

> **说明**：使用专用密钥名 `id_mcp_server`，避免覆盖你原有的通用密钥。若已存在会询问是否覆盖。

### 4. 步骤三：配置 Windows sshd（菜单 `[4]`）

命令在 Windows 端完成三件事：

1. 把上一步拉取的公钥追加到 `~/.ssh/authorized_keys`（自动去重）。
2. 备份并修改 `C:\ProgramData\ssh\sshd_config`：开启 `PubkeyAuthentication`、指定 `AuthorizedKeysFile`、禁用 `Match Group administrators` 分组规则。
3. 重启 sshd 使配置生效。

> **前置要求**：必须先执行步骤二（生成了公钥）、步骤一（安装了 sshd），否则会提示缺少公钥或 sshd_config。

### 5. 步骤四：生成 Linux 端 MCP 配置模板（菜单 `[8]`）

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

## 五、 配置 MCP 环境的收尾步骤

`sshd-config` 的四个步骤完成后，「桥」已经建好。要让 MCP 真正在 Linux 端生效，还需完成以下收尾：

### 1. 复制模板到 Linux 项目根目录

将生成的 `mcp-remote-template.json` 复制到 Linux 端项目根目录，并**重命名为 `.mcp.json`**。

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

> **可选进阶**：如需在 Linux 端做更精细的 MCP 桥接配置（如 Claude 全局 / 项目、ZCode 项目落点），可配合使用对偶命令 `remote-mcp-config`，它通过 SFTP 直接在 Linux 端写 `~/.claude.json`、`.mcp.json`、`.zcode/config.json`。

---

## 六、 常见问题

### 1. 命令提示「本命令仅支持 Windows」？

- `sshd-config` 仅能在 Windows 上运行。请确认是在 Windows 的 PowerShell / CMD 中执行。

### 2. 命令自动退出或需要提权？

- 非管理员运行时会触发 UAC 提权重启。建议直接以「管理员身份」打开终端再执行。

### 3. 安装 SSH 服务时下载慢或失败？

- 默认走 MSI 离线安装，从 GitHub 下载。网络不佳时可改选「在线安装」，或手动下载 MSI 放到 `.embedded/ssh/OpenSSH-Win64.msi` 复用。

### 4. Linux 端 SSH 免密登录 Windows 失败？

- 确认已依次完成：安装 SSH（菜单 `[2]`）→ 生成密钥（`[3]`）→ 配置 sshd（`[4]`）。
- 用菜单 `[5]` 检查 sshd 配置状态（只读诊断），确认 `PubkeyAuthentication`、`AuthorizedKeysFile` 等关键项正确。
- 检查 Windows 防火墙是否放行 22 端口入站，以及 Windows 的 IP 是否可从 Linux 路由可达。

### 5. 配置模板生成的 IP 不通？

- 多网卡时默认取首个 IP，可能并非 Linux 可路由的那一个。用菜单 `[7]` 查看所有可用 IP，在模板中改用候选 IP。

---

*本文档由 markdowncli 技能辅助生成*
