---
name: setup-file-utils-remote
description: 当用户要为 file_utils_remote MCP 做免密接入配置时触发——典型表述如"帮 board-ubuntu 配置远程文件操作 mcp"、"给编译服务器配免密"、"配置 file_utils_remote"。流程：检查本地 SSH 密钥对（无则生成）→ 用嵌入式 MCP 的 ssh_shell_login 一键登录用户指定的编译服务器 → 推送公钥完成免密，并趁 session 开着（带 PTY）顺带查 npm 全局 bin 路径 → 检测目标客户端配置：已配则逐项校验格式并报告，缺失才写入（连接目标与 bin 路径均用前序解析值替换占位符）→ 验证连通。免密走专用密钥 id_file_utils_remote（与默认密钥隔离），仅对带 -i 的 ssh/MCP 通道生效。编译服务器设备名作为参数传入（如 /setup-file-utils-remote board-ubuntu），host/username 等连接信息从设备配置动态解析。
argument-hint: "[编译服务器设备名] 例如: board-ubuntu"
arguments: device
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__device_info_tool
---

# 配置 file_utils_remote 远程文件 MCP

## 目标

为 `file_utils_remote` MCP server 做免密接入配置。核心思路：**借嵌入式 MCP 的密码登录能力（ssh2）打通一次性免密，之后系统 ssh 走密钥无头接入**。

之所以分两层 SSH：
- **嵌入式 MCP 的 SSH**（`ssh_shell_login`，走 `ssh2` 库）：可用账号密码登录，但每次会话现连，不适合给无头 MCP client 用。
- **系统 SSH**（`ssh ... file-utils-mcp-toolkit`）：MCP client spawn 时不分配 PTY、stdin/stdout 被 JSON-RPC 占用，**无法交互输密码，必须提前配好密钥免密**。

本技能用前者（密码登录）引导后者（密钥免密）。

## 解析设备参数

设备名通过**框架参数替换**注入：frontmatter 声明 `arguments: device`，用户调用 `/setup-file-utils-remote board-ubuntu` 时，下文所有 `$device` 在 Claude 读到 skill 前就被替换为 `board-ubuntu`。

> 若 `$device` 仍是占位符（用户未带参数调用），先调 `device_info_tool`（`device: "all"`）列出全部设备，询问用户要配哪台，拿到设备名后代入后续步骤。

拿到设备名后，调 `device_info_tool`（`device: "$device"`）解析出该设备的 **host、port、username**，后续步骤全部用这些动态值，**不依赖硬编码 IP 或用户名**。

> 设备配置位于 `.embedded/configs/devices/<设备名>.yaml`，由嵌入式 MCP 加载。本技能不直接读 yaml，一律通过 `device_info_tool` 取值。host/username 无法用参数占位符（不是用户传的，是查出来的），只能动态解析。

## 密钥约定

file_utils_remote 使用**专用密钥对**（与其它用途的默认密钥 `id_ed25519` 隔离，避免相互影响）：

- 私钥：`~/.ssh/id_file_utils_remote`（Windows: `C:\Users\<用户名>\.ssh\id_file_utils_remote`）
- 公钥：`~/.ssh/id_file_utils_remote.pub`
- 免密 passphrase 留空（否则每次连接都要输，无头场景必失败）

> 专用密钥的好处：file_utils_remote 的信任关系独立，不影响其它已配免密的服务器；密钥泄露/轮换时只波及这一个用途。

## 步骤

> 本技能工作目录为项目根（`E:\AI\embedded-mcp-toolkit`）。本地 SSH 密钥位于用户家目录 `~/.ssh/`，与项目无关。
>
> 下文用 **`$device`** 表示框架参数替换注入的设备名，**`<HOST>`** / **`<USER>`** 表示 device_info_tool 解析出的值（这两项是查出来的，不是用户传的，故仍用角括号占位符由 AI 替换）。
>
> 全流程会收集两类动态值，**在最后写配置（第六步）时替换占位符**，之前各步先拿值、存值、不写配置：
> - **`<USER>@<HOST>`**：第一步从 device_info_tool 解析（连接目标），如 `sumu@192.168.164.128`。
> - **`<BIN_DIR_REL>`**：第四步从嵌入式 session（带 PTY）查到的 bin 目录相对家目录的路径，如 `.npm-global/bin`，用于拼 `PATH=$HOME/<BIN_DIR_REL>:$PATH`。
>
> 专用密钥路径固定 `~/.ssh/id_file_utils_remote`（非动态值）。

### 第一步：解析设备连接信息

设备名 `$device` 已由框架参数替换注入（如 `board-ubuntu`）。若仍是占位符（用户未带参数），调 `device_info_tool`（`device: "all"`）列出全部并询问。

随后调 `device_info_tool`（`device: "$device"`）取 SSH 配置，提取并记录两个值，后续步骤全部使用：

- `<HOST>`：ssh.host
- `<USER>`：ssh.username

> 派生出 **`<USER>@<HOST>`**（如 `sumu@192.168.164.128`）——这是写配置时的连接目标，记下备用（第六步替换占位符用）。

### 第二步：检查本地密钥对（无则生成）

用 Bash 检查专用密钥是否存在：

```bash
ls ~/.ssh/id_file_utils_remote ~/.ssh/id_file_utils_remote.pub 2>/dev/null
```

**分支判断**：

- **已存在**（两个文件都有）→ 直接复用，跳到第三步。**绝不覆盖**（会破坏已配好的免密信任）。
- **不存在** → 用 ssh-keygen 生成（passphrase 必须留空，`-N ""`）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_file_utils_remote -N "" -C "file-utils-remote"
```

生成后读取公钥内容：

```bash
cat ~/.ssh/id_file_utils_remote.pub
```

应输出形如 `ssh-ed25519 AAAA... file-utils-remote` 的一行，记下完整内容用于第四步。

### 第三步：用嵌入式 MCP 一键登录 `$device`

调用 `ssh_shell_login` 登录设备（设备名就是参数注入的 `$device`）：

- `device`：`"$device"`
- `timeout`：`30`（秒）

从返回结果中获取 **`session_id`**（如 `ssh_2`）。

> 这一步走嵌入式 MCP 的 ssh2 密码登录，不需要系统 ssh 免密。登录成功说明设备可达、账号密码正确。
>
> **这个 session 带 PTY，登录 shell 的 PATH 已加载全局 bin 目录**——第四步要趁它开着把 bin 路径一并查到，关闭后就没这个便利了。

### 第四步：推送公钥 + 查 bin 路径（同一 session）

用上一步的 `session_id`，**先推送公钥**（调 `ssh_shell_exec`，**把 `<PUBKEY>` 替换为第二步读到的完整公钥内容**，单引号包裹避免 shell 解析）：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '<PUBKEY>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && echo PUBKEY_OK
```

- `sort -u` 去重，避免重复运行时公钥重复追加。
- 末尾 `echo PUBKEY_OK` 便于确认执行成功。
- 若返回失败，重试 `ssh_shell_exec`（增大 `delay`，如 2000ms）取输出排查。

**紧接着，在同一 session 内查 bin 路径**（调 `ssh_shell_exec`）。此时 session 带 PTY、PATH 已加载，`which` 能直接命中——这是把查询放在此处的关键原因；若留到后面用系统 ssh 无 PTY 查，PATH 未加载会查不到：

```bash
which file-utils-mcp-toolkit; echo "---"; echo $HOME
```

解析输出，记录 **`<BIN_DIR_REL>`**：

- `which` 输出完整 bin 路径，如 `/home/<USER>/.npm-global/bin/file-utils-mcp-toolkit`。
- `echo $HOME` 输出家目录，如 `/home/<USER>`。
- 把 bin 路径去掉可执行文件名得到 bin 目录（`dirname`），再去掉家目录前缀，得到相对家目录的路径 **`<BIN_DIR_REL>`**（如 `.npm-global/bin`）。记下备用（第六步拼 `PATH=$HOME/<BIN_DIR_REL>:$PATH` 用）。
- 若 bin 不在家目录下（如 `/usr/local/bin`），直接用绝对目录，配置里写 `PATH=<绝对目录>:$PATH`。
- **`which` 无输出（未命中）** → 远端未安装，提示用户在服务器上执行 `npm install -g @smai-kit/file-utils-mcp-toolkit`，装完重跑本步。

> 为什么在这里查而不是后面：嵌入式 session 有 PTY，登录 shell 的 PATH 包含 `~/.npm-global/bin` 等用户级全局 bin；系统 ssh 无头执行时是非交互非登录 shell，PATH 不加载这些目录，`which` 常落空（表现为"装了却 command not found"）。趁 session 开着一次拿全，后面写配置直接用。

最后用 `ssh_shell_close` 关闭嵌入式 MCP 的 SSH 会话（释放连接）。至此免密配置完成，后续全部走系统 ssh。

### 第五步：验证系统 ssh 免密

用 Bash 验证系统 ssh 已免密（**这一步走系统 ssh，是 MCP client 实际用的通道**）。把 `<HOST>` / `<USER>` 替换为第一步解析出的值：

```bash
ssh -i ~/.ssh/id_file_utils_remote -o BatchMode=yes -o ConnectTimeout=10 <USER>@<HOST> "echo OK_$(whoami)"
```

- **必须带 `-i ~/.ssh/id_file_utils_remote`**：本技能配的是专用密钥，而 ssh 默认只尝试标准密钥名（`id_rsa`/`id_ed25519` 等），不会自动尝试 `id_file_utils_remote`。不带 `-i` 会回退到要密码，导致"免密看似没打通"的误判。
- `-o BatchMode=yes` 禁止任何交互式密码提示，强制走密钥。若免密失败会立即报错而非挂起。
- 期望输出 `OK_<USER>`，说明专用密钥通道免密已打通。
- 若失败（`Permission denied (publickey)`），检查：公钥是否真的追加成功、`~/.ssh` 与 `authorized_keys` 权限、服务器是否开启 `PubkeyAuthentication`。

> **免密的作用域（重要，务必向用户说明）**：此处打通的免密**仅对专用密钥 `id_file_utils_remote` 生效**——即只有 `ssh -i ~/.ssh/id_file_utils_remote ...`（MCP 配置实际用的方式）才免密。用户日常手动 `ssh <USER>@<HOST>`（不带 `-i`）**仍会要密码，这是"专用密钥隔离"的预期行为，不是故障**。原因是专用密钥名 `id_file_utils_remote` 不在 ssh 的默认密钥尝试列表里。
>
> 若用户希望手动登录也免密，可建议在 `~/.ssh/config` 加一段 `Host` 别名绑定该专用密钥（如 `Host board-ubuntu` / `HostName <HOST>` / `IdentityFile ~/.ssh/id_file_utils_remote`），之后 `ssh board-ubuntu` 即免密，且不必改动默认密钥的信任面。

### 第六步：写出 / 校验 MCP 配置文件

> **先查后写**：本技能可能被多次运行，配置文件也常已由用户或其它流程预先配好。本步先检测每个目标客户端是否已存在 `file_utils_remote` 配置——**已存在则校验格式并报告，不重复写**；仅在确实缺失时才新建/合并。**占位符 `<USER>@<HOST>` / `<BIN_DIR_REL>` 用第一步、第四步解析出的实际值替换。**

**6a. 确定目标客户端**

根据用户要配的目标客户端，确定配置文件路径与 schema：

| 客户端 | 文件路径 | schema 风格 |
|--------|---------|-------------|
| Claude / Cursor（通用） | `<repo>/.mcp.json` | `command` + `args` 分体 |
| zcode | `<repo>/.zcode/config.json` | `command` + `args`，包在 `mcp.servers` 下 |
| opencode | `<repo>/.opencode/opencode.json` | `command` 为数组 |

> 若用户未指定目标客户端，询问一句"配到哪个客户端"。

**6b. 对每个目标客户端，先检测是否已配**

读取目标配置文件，在对应的层级查找 `file_utils_remote` 键（层级随客户端不同：`.mcp.json` 在 `mcpServers`；zcode 在 `mcp.servers`；opencode 在 `mcp`）。据此走分支：

- **已存在** → 走 **6c 校验**，不动文件（除非校验发现问题且用户同意修）。
- **不存在** → 走 **6d 写入**。

**6c. 已存在 → 校验格式并报告**

逐项核对现有配置是否满足无头免密要求（**把 `<USER>@<HOST>` / `<BIN_DIR_REL>` 替换为本轮解析出的实际值**）：

| 检查项 | 要求 | 典型反例 |
|--------|------|---------|
| `command` / `command[0]` | 为 `ssh` | 写成了 `file-utils-mcp-toolkit` 本体 |
| 指定专用密钥 | args 含 `-i ~/.ssh/id_file_utils_remote` | 缺 `-i`（会回退到默认密钥，无头下要密码→失败） |
| 连接目标正确 | 指向 `<USER>@<HOST>`（本轮解析值） | 旧 IP/用户名未更新 |
| 内联 PATH 启动 | 启动参数形如 `PATH=$HOME/<BIN_DIR_REL>:$PATH file-utils-mcp-toolkit`（`<BIN_DIR_REL>` 为第四步查到的值） | 裸 `file-utils-mcp-toolkit`（远端非交互 shell PATH 无该 bin→command not found） |
| 未用 login shell | 启动参数不含 `bash -lc` / `bash -l -c` | 用了 `bash -lc`（无头无 PTY 会 hang） |
| `$HOME`/`$PATH` 未被转义 | 配置里是 `$HOME`/`$PATH`（远端展开），不是 `\$HOME` | 写本地 Bash 时误转义带进了 JSON |

校验后向用户报告，格式如下（用 ✅/⚠️/❌ 标注每项）：

```
[<客户端>] file_utils_remote 已配置 — 校验结果：
  ✅ command=ssh  ✅ 含专用密钥 -i  ✅ 目标 sumu@192.168.164.128
  ✅ 内联 PATH 启动  ✅ 未用 bash -lc
  → 配置正确，无需改动。
```

若发现问题：列出有问题的项 + 建议改为的值，**询问用户是否修正**；同意后再用 `Edit` 精确替换有问题的那一行/段（只动出错部分，保留其余）。

> 即使配置已存在且正确，也**继续执行第七步连通性验证**——格式对不等于进程真能拉起。

**6d. 不存在 → 按模板写入**

用 **内联 PATH 写法**（远端非交互 shell 的 PATH 没加载全局 bin，裸命令名会 `command not found`）。把模板中的占位符替换为已解析的实际值：

- `<USER>@<HOST>` → 第一步解析值，如 `sumu@192.168.164.128`
- `<BIN_DIR_REL>` → 第四步查到的值，如 `.npm-global/bin`
- 私钥路径固定 `~/.ssh/id_file_utils_remote`

**Claude / Cursor 风格**（`.mcp.json`，无 type 字段）：

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

**zcode 风格**（`.zcode/config.json`，嵌套在 `mcp.servers`，带 `type`/`enabled`/`timeout`）：

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

**opencode 风格**（`.opencode/opencode.json`，`command` 为数组）：

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

> **PATH 写法说明**：第四步查到的 bin 目录若在家目录下（常见，如 `~/.npm-global/bin`），配置里用 `$HOME/<BIN_DIR_REL>`（如 `$HOME/.npm-global/bin`）使命名更通用、可移植；若 bin 目录不在家目录下，直接用绝对路径替换 `$HOME/<BIN_DIR_REL>`。`$HOME`/`$PATH` 由远端 shell 展开，**写进 JSON 不转义**。验证方式见第七步。

写文件前：

- **若目标文件已存在** → 先 `Read`，用 `Edit` 合并（只追加/更新 `file_utils_remote` 这一段，保留其它配置），**不要整文件覆盖**。
- **若不存在** → 用 `Write` 新建。

### 第七步：连通性验证

模拟无 PTY 环境验证 MCP 进程能拉起（Bash，**带 `-i`**；命令行里 `$` 要转义成 `\$` 避免本地 shell 展开；`<BIN_DIR_REL>` 替换为第四步查到的值）。Ctrl+C 退出，确认不 hang 不报错：

```bash
ssh -i ~/.ssh/id_file_utils_remote -o BatchMode=yes <USER>@<HOST> "PATH=\$HOME/<BIN_DIR_REL>:\$PATH file-utils-mcp-toolkit"
```

- 进程应启动并等待 stdin（stdio MCP），无报错即可，手动中断。

最后提示用户在 AI 客户端重载 MCP（重启会话或刷新 MCP 连接），确认 `file_utils_remote` 的工具出现。可选调一次 `greet`（探活）或 `remote_file_glob` 列目录确认。

## 关键约束

- **设备名走框架参数替换**：frontmatter `arguments: device` + 正文 `$device`，用户 `/setup-file-utils-remote board-ubuntu` 时框架自动替换，不靠 AI 从自然语言里猜。host/username 不是用户传的，仍需 `device_info_tool` 动态解析（参数占位符只能承载用户输入）。
- **bin 路径在嵌入式 session 内查（带 PTY）**：第四步推送公钥后，趁 `ssh_shell_exec` 的 session 还开着查 `which file-utils-mcp-toolkit`——此时 PATH 已加载，能直接命中；查到的 `<BIN_DIR_REL>` 存起来，到第六步写配置时替换占位符。**不要改用系统 ssh 在无 PTY 下查**（PATH 未加载，常表现为"装了却 command not found"）。
- **先收集值、最后替换占位符**：`<USER>@<HOST>`（第一步）、`<BIN_DIR_REL>`（第四步）在前序步骤解析并存好，第六步写配置时一次性替换；不在收集阶段就动配置文件。
- **绝不用 `bash -lc` 写进 MCP 配置**：无头 MCP client 不分配 PTY，login profile 在无 TTY 时可能 hang 或 PATH 不加载。一律用内联 `PATH=...:bin cmd`。
- **密钥 passphrase 必须留空**：MCP client 无头，弹不出 passphrase 输入。
- **`-o BatchMode=yes` 验证免密**：禁止交互式密码提示，失败立即报错而非挂起，最能真实反映无头场景。
- **公钥追加用 `sort -u` 去重**：技能可能重跑，避免 authorized_keys 里堆积重复公钥。
- **专用密钥名固定为 `id_file_utils_remote`**：存在则复用、不存在才生成，**绝不覆盖**（覆盖会破坏已配好的免密信任）。与默认密钥 `id_ed25519` 隔离，互不影响。
- **免密作用域仅限专用密钥**：本技能配的免密只对 `ssh -i ~/.ssh/id_file_utils_remote ...`（即 MCP 配置用的方式）生效。**用户日常裸 `ssh <USER>@<HOST>`（不带 `-i`）仍会要密码，这是预期行为，不是故障**——ssh 默认只试标准密钥名，不会自动试 `id_file_utils_remote`。向用户报告时务必说明这一点，避免"免密看似没打通"的误判。手动免密可选配 `~/.ssh/config` 的 `Host` 别名绑定该专用密钥。
- **所有走系统 ssh 的步骤都必须带 `-i ~/.ssh/id_file_utils_remote`**：第五/七步的 Bash 命令、MCP 配置的启动参数均如此。漏带会回退到默认密钥，无头场景下要密码→失败。
- **远端命令的 `$HOME`/`$PATH` 由远端 shell 展开**：写进 JSON 配置不转义；写进本地 Bash 命令行则转义 `\$`。
- **两层 SSH 各司其职**：嵌入式 MCP（密码登录，带 PTY）用于一次性引导配免密 + 顺带查 bin 路径；之后系统 ssh（密钥免密，无 PTY）才是 MCP client 长期通道。
- **配置先查后写**：第六步先检测目标客户端是否已配 `file_utils_remote`——已存在则按校验表逐项核对并报告（✅/⚠️/❌），发现问题询问后再改；仅缺失时才按模板新建/合并。即使配置已存在且正确，仍要执行第七步连通性验证。
