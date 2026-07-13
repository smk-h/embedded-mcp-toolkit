---
name: setup-file-utils-remote
description: 为编译服务器配置 file_utils_remote 远程文件操作 MCP 的免密接入。触发表述如"配置 file_utils_remote"、"给编译服务器配免密"、"帮 board-ubuntu 配置远程文件 mcp"。完成 SSH 密钥免密、远端工具安装、MCP 客户端配置。设备名作为参数传入。
argument-hint: "[编译服务器设备名] 例如: board-ubuntu"
arguments: device
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__ssh_sftp_upload, mcp__embedded-board__device_info_tool
---

# 配置 file_utils_remote 远程文件 MCP

## 核心思路

**两层 SSH 各司其职**：用嵌入式 MCP（`ssh_shell_login`，密码登录，带 PTY）一次性引导配好密钥免密 + 顺带查 bin 路径；之后系统 ssh（密钥免密，无 PTY）才是 MCP client 的长期通道。MCP client spawn ssh 时不分配 PTY、stdin/stdout 被 JSON-RPC 占用，无法交互输密码，必须提前配好免密。

## 动态值收集

全流程收集以下值，**第六步写配置时一次性替换占位符**，之前各步只拿值不写配置：

- **`<USER>@<HOST>`**：第一步从 `device_info_tool` 解析（连接目标）。
- **`<BIN_DIR_REL>`**：第四步从嵌入式 session（带 PTY）查到的 bin 目录相对家目录的路径，如 `.npm-global/bin`。
- **`<INSTALL_FAILED>`**：第四步安装失败时置 `true`（初始 `false`），用于第七步末尾提示。

专用密钥路径固定 `~/.ssh/id_file_utils_remote`（非动态值）。

## 步骤

### 第一步：解析设备连接信息

设备名 `$device` 由框架参数替换注入。若仍是占位符（用户未带参数），调 `device_info_tool`（`device: "all"`）列出全部并询问。

调 `device_info_tool`（`device: "$device"`）取 SSH 配置，记录 `<HOST>`（ssh.host）、`<USER>`（ssh.username），派生 `<USER>@<HOST>`。

### 第二步：检查本地密钥对（无则生成）

```bash
ls ~/.ssh/id_file_utils_remote ~/.ssh/id_file_utils_remote.pub 2>/dev/null
```

- 已存在 → 复用，**绝不覆盖**（会破坏已配好的免密信任）。不存在 → 生成（passphrase 留空）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_file_utils_remote -N "" -C "file-utils-remote"
```

读取公钥内容备用（`cat ~/.ssh/id_file_utils_remote.pub`）。

### 第三步：用嵌入式 MCP 登录 `$device`

调 `ssh_shell_login`（`device: "$device"`, `timeout: 30`），取 `session_id`。

> 此 session 带 PTY，PATH 已加载全局 bin——第四步要趁它开着查 bin 路径，关闭后用系统 ssh 无 PTY 查会落空。

### 第四步：推送公钥 + 查 bin 路径（同一 session）

**先推送公钥**（`ssh_shell_exec`，`<PUBKEY>` 替换为第二步读到的公钥，单引号包裹）：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '<PUBKEY>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && echo PUBKEY_OK
```

**查 bin 路径**（同一 session）：

```bash
which file-utils-mcp-toolkit; echo "---"; echo $HOME
```

- `which` 命中 → bin 路径去掉文件名、再去掉 `$HOME` 前缀，得 `<BIN_DIR_REL>`（如 `.npm-global/bin`）；bin 不在家目录下则用绝对目录。
- `which` 无输出 → 远端未安装，走 4a/4b，装完重查。

### 第四步分支：远端未安装时自动安装（不中断）

**优先用本地离线包**（SFTP 上传 + `offline_install.sh`），离线包不存在才 `npm i -g` 在线兜底。**安装失败只记 `<INSTALL_FAILED>=true`、不中断**——免密与配置不依赖远端是否已装好，第五~七步照走。

离线包路径（固定）：`.embedded/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz`。

**4a. 本地离线包存在 → SFTP 上传 + `offline_install.sh` 安装**

```bash
ls .embedded/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz 2>/dev/null
```

存在则用 `ssh_sftp_upload`（复用当前 `session_id`）上传到 `/tmp/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz`。

上传后用 `ssh_shell_exec` 解压并运行离线包自带的 `offline_install.sh`（压缩包扁平结构无外层目录，故先建目录再 `-C` 解压）：

```bash
mkdir -p /tmp/fum-install && tar -xzf /tmp/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz -C /tmp/fum-install && bash /tmp/fum-install/offline_install.sh && rm -rf /tmp/fum-install /tmp/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz && echo INSTALL_OK || (rm -rf /tmp/fum-install /tmp/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz; echo INSTALL_FAIL)
```

> 脚本内置权限检查：`npm prefix -g` 不可写时报错并提示用 `sudo bash offline_install.sh`。

- `INSTALL_OK` → 重查 `which`/`echo $HOME` 拿 `<BIN_DIR_REL>`，继续第五步。
- `INSTALL_FAIL` → 记 `<INSTALL_FAILED>=true`，继续第五步。

**4b. 本地离线包不存在 → 在线安装兜底**

```bash
npm i -g @smai-kit/file-utils-mcp-toolkit && echo INSTALL_OK || echo INSTALL_FAIL
```

- `INSTALL_OK` → 重查 `which`/`echo $HOME` 拿 `<BIN_DIR_REL>`，继续第五步。
- `INSTALL_FAIL` → 记 `<INSTALL_FAILED>=true`，`<BIN_DIR_REL>` 用默认 `.npm-global/bin`，继续第五步。

最后用 `ssh_shell_close` 关闭会话。至此免密配置完成，后续全部走系统 ssh。

### 第五步：验证系统 ssh 免密

```bash
ssh -i ~/.ssh/id_file_utils_remote -o BatchMode=yes -o ConnectTimeout=10 <USER>@<HOST> "echo OK_$(whoami)"
```

期望输出 `OK_<USER>`。失败则检查公钥追加、`~/.ssh`/`authorized_keys` 权限、服务器 `PubkeyAuthentication`。

> **免密作用域（务必向用户说明）**：仅对专用密钥 `id_file_utils_remote` 生效（即 `ssh -i ...`）。用户日常裸 `ssh <USER>@<HOST>` 仍会要密码——这是专用密钥隔离的预期行为，不是故障。若需手动免密，建议在 `~/.ssh/config` 加 `Host` 别名绑定该专用密钥。

### 第六步：写出 / 校验 MCP 配置文件

**先查后写**：读取目标配置文件，查找 `file_utils_remote` 键（`.mcp.json` 在 `mcpServers`；zcode 在 `mcp.servers`；opencode 在 `mcp`）。

- **已存在** → 校验格式并报告，不重复写（除非有问题且用户同意修）。
- **不存在** → 按模板写入。

**6a. 目标客户端**

| 客户端 | 文件路径 | schema 风格 |
|--------|---------|-------------|
| Claude / Cursor | `<repo>/.mcp.json` | `command` + `args` 分体 |
| zcode | `<repo>/.zcode/config.json` | `command` + `args`，包在 `mcp.servers` 下 |
| opencode | `<repo>/.opencode/opencode.json` | `command` 为数组 |

> 若用户未指定，询问"配到哪个客户端"。

**6b. 已存在 → 校验**

逐项核对（占位符替换为本轮实际值）：

| 检查项 | 要求 |
|--------|------|
| `command` | 为 `ssh` |
| 指定专用密钥 | args 含 `-i ~/.ssh/id_file_utils_remote` |
| 连接目标 | 指向 `<USER>@<HOST>` |
| 内联 PATH | `PATH=$HOME/<BIN_DIR_REL>:$PATH file-utils-mcp-toolkit` |
| 未用 login shell | 不含 `bash -lc` |
| `$HOME`/`$PATH` 未转义 | 配置里是 `$HOME`/`$PATH`，不是 `\$HOME` |

报告后，即使配置正确仍执行第七步。

**6c. 不存在 → 按模板写入**

占位符替换为实际值，私钥路径固定 `~/.ssh/id_file_utils_remote`。

**Claude / Cursor 风格**（`.mcp.json`）：

```json
{
  "mcpServers": {
    "file_utils_remote": {
      "command": "ssh",
      "args": [
        "-i", "~/.ssh/id_file_utils_remote",
        "-o", "ServerAliveInterval=60",
        "<USER>@<HOST>",
        "PATH=$HOME/<BIN_DIR_REL>:$PATH file-utils-mcp-toolkit"
      ]
    }
  }
}
```

**zcode 风格**（`.zcode/config.json`）：

```json
{
  "mcp": {
    "servers": {
      "file_utils_remote": {
        "type": "stdio",
        "command": "ssh",
        "args": [
          "-i", "~/.ssh/id_file_utils_remote",
          "-o", "ServerAliveInterval=60",
          "<USER>@<HOST>",
          "PATH=$HOME/<BIN_DIR_REL>:$PATH file-utils-mcp-toolkit"
        ],
        "enabled": true,
        "timeout": 600000
      }
    }
  }
}
```

**opencode 风格**（`.opencode/opencode.json`）：

```json
{
  "mcp": {
    "file_utils_remote": {
      "type": "local",
      "command": [
        "ssh",
        "-i", "~/.ssh/id_file_utils_remote",
        "-o", "ServerAliveInterval=60",
        "<USER>@<HOST>",
        "PATH=$HOME/<BIN_DIR_REL>:$PATH file-utils-mcp-toolkit"
      ],
      "enabled": true,
      "timeout": 600000
    }
  }
}
```

> bin 目录在家目录下用 `$HOME/<BIN_DIR_REL>`；不在则用绝对路径。`$HOME`/`$PATH` 由远端 shell 展开，写进 JSON 不转义。

文件已存在 → `Read` 后 `Edit` 合并（只更新 `file_utils_remote` 段）；不存在 → `Write` 新建。

### 第七步：连通性验证

```bash
ssh -i ~/.ssh/id_file_utils_remote -o BatchMode=yes <USER>@<HOST> "PATH=\$HOME/<BIN_DIR_REL>:\$PATH file-utils-mcp-toolkit"
```

进程应启动并等待 stdin（stdio MCP），无报错即手动中断。

提示用户重载 MCP，确认 `file_utils_remote` 工具出现。可选调 `greet` 或 `remote_file_glob` 确认。

> **若 `<INSTALL_FAILED>=true`**：配置无误，但远端未装好，连通性大概率报 `command not found`。向用户给出手动安装命令：
> - 离线（先传包到服务器）：`mkdir -p /tmp/fum-install && tar -xzf /tmp/file-utils-mcp-toolkit-1.0.0-linux-x64-offline.tar.gz -C /tmp/fum-install && bash /tmp/fum-install/offline_install.sh`
> - 在线：`npm i -g @smai-kit/file-utils-mcp-toolkit`
>
> 装好后无需重跑本技能，直接重载 MCP。

## 关键约束

- **专用密钥 `id_file_utils_remote`**：存在则复用、绝不覆盖；passphrase 留空。所有系统 ssh 命令和 MCP 配置都必须带 `-i ~/.ssh/id_file_utils_remote`（ssh 默认不试非标准密钥名，漏带会回退到默认密钥→无头下要密码→失败）。
- **免密作用域仅限专用密钥**：裸 `ssh <USER>@<HOST>`（不带 `-i`）仍要密码，是预期行为，务必向用户说明。
- **bin 路径在嵌入式 session 内查（带 PTY）**：系统 ssh 无 PTY 时 PATH 不加载用户级全局 bin，`which` 常落空。
- **MCP 配置绝不用 `bash -lc`**：无 PTY 时 login profile 可能 hang。一律用内联 `PATH=... cmd`。
- **远端 `$HOME`/`$PATH` 由远端 shell 展开**：写进 JSON 不转义；写进本地 Bash 命令行转义 `\$`。
- **离线安装用 `offline_install.sh`，不走 `npm install`**：离线包自带，复刻 `npm install -g` 落位但不联网、不触发 `prepare`。
- **安装失败不中断**：只记 `<INSTALL_FAILED>=true`，第五~七步照走，失败提示留到第七步末尾。
- **配置先查后写**：已存在则校验报告，缺失才写入。
