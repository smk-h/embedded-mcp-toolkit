---
name: embedded-toolkit
description: 当需要与嵌入式 Linux 板卡通过 SSH 或串口交互时使用。涵盖 embedded-board MCP（SSH 方式：exec、read_file、write_file、list_dir、dmesg、system_info、upload_file）和 board-alpha MCP（串口方式：serial_connect、serial_disconnect、serial_exec、serial_send）的全部工具。仅在用户要求操作远程板卡、查询板卡状态、上传文件、执行 shell 命令、调试内核日志或串口通信时触发。
---

# 嵌入式 MCP 工具包

本技能涵盖两个用于嵌入式 Linux 板卡管理的 MCP 服务器：

- **embedded-board**：基于 SSH 的远程管理（TCP/22，IP: 192.168.16.103）
- **board-beta**：基于 SSH 的远程管理（TCP/22，IP: 192.168.16.105，ssh-rsa 主机密钥算法）
- **board-alpha**：基于串口的板卡通信（UART，COM3, 115200）

## 何时触发

当用户的意图涉及以下任一场景时，自动激活本技能：

- **登录/连接开发板**：用户要求登录、连接、进入开发板或板卡
- 在板卡上执行命令、查看系统信息、编译运行代码
- 读取/写入/上传文件、查看目录结构
- 查看内核日志（dmesg）、调试诊断
- 通过串口连接板卡、发送控制字符（Ctrl+C 等）

常见触发语句：
- "登录开发板"、"连接板卡"、"进入开发板"
- "帮我查一下板卡的 IP 地址"、"板卡上运行了哪些进程"
- "把本机的 xxx 文件上传到板卡上"、"在板卡上编译并运行 xxx.c"
- "查看板卡的 dmesg 日志"、"通过串口连接板卡执行 xxx"

---

## 工具命名规则

MCP 工具的完整名称格式为 `{服务器名}_{工具名}`：

| 完整工具名 | 用途 | 必填参数 |
|-----------|------|---------|
| `embedded-board_exec` | 执行 shell 命令 | `command`, `timeout?`(秒) |
| `embedded-board_read_file` | 读取文件 | `path` |
| `embedded-board_write_file` | 写入文件 | `path`, `content` |
| `embedded-board_list_dir` | 列出目录 | `path` |
| `embedded-board_dmesg` | 内核日志 | `lines?` |
| `embedded-board_system_info` | 系统信息 | 无 |
| `embedded-board_upload_file` | 上传文件 | `local_path`, `remote_path` |
| `board-beta_exec` | 执行 shell 命令 | `command`, `timeout?`(秒) |
| `board-beta_read_file` | 读取文件 | `path` |
| `board-beta_write_file` | 写入文件 | `path`, `content` |
| `board-beta_list_dir` | 列出目录 | `path` |
| `board-beta_dmesg` | 内核日志 | `lines?` |
| `board-beta_system_info` | 系统信息 | 无 |
| `board-beta_upload_file` | 上传文件 | `local_path`, `remote_path` |
| `board-alpha_serial_connect` | 打开串口 | `port?`, `baudRate?`, ... |
| `board-alpha_serial_disconnect` | 关闭串口 | 无 |
| `board-alpha_serial_exec` | 串口执行命令 | `command`, `timeout?`(毫秒) |
| `board-alpha_serial_send` | 发送原始数据 | `data`（支持 `\x03` 等） |
| `{server}_shell_unlock` | 执行解锁序列 | `timeout?`(毫秒) |
| `{server}_shell_detect_state` | 检测 shell 状态 | `timeout?`(毫秒) |

---

## 工具选择指南

### 优先使用 SSH（embedded-board）
- 板卡网络可用、SSH 服务正常
- 文件操作、系统诊断、长时间命令

### 使用串口（board-alpha）
- 板卡无网络或 SSH 不可用
- U-Boot 交互、发送控制字符（`\x03`=Ctrl+C, `\x04`=Ctrl+D, `\x1a`=Ctrl+Z）

---

## SSH 工具详解

### `embedded-board_exec`

执行 shell 命令。

```json
{"name": "embedded-board_exec", "arguments": {"command": "ps aux", "timeout": 60}}
```

参数：`command`(必填) - shell 命令；`timeout`(可选) - 超时秒数，默认 30

---

### `embedded-board_read_file`

读取文件内容。

```json
{"name": "embedded-board_read_file", "arguments": {"path": "/etc/hostname"}}
```

参数：`path`(必填) - 文件绝对路径

---

### `embedded-board_write_file`

写入文件。

```json
{"name": "embedded-board_write_file", "arguments": {"path": "/root/test.sh", "content": "#!/bin/bash\necho hello"}}
```

参数：`path`(必填) - 文件绝对路径；`content`(必填) - 文件内容

---

### `embedded-board_list_dir`

列出目录内容。

```json
{"name": "embedded-board_list_dir", "arguments": {"path": "/home"}}
```

参数：`path`(必填) - 目录绝对路径

---

### `embedded-board_dmesg`

获取内核日志。

```json
{"name": "embedded-board_dmesg", "arguments": {"lines": 50}}
```

参数：`lines`(可选) - 显示最近 N 行，不指定则显示全部

---

### `embedded-board_system_info`

获取系统信息概览（主机名、内核版本、运行时间、内存、CPU、磁盘）。

```json
{"name": "embedded-board_system_info", "arguments": {}}
```

---

### `embedded-board_upload_file`

上传本地文件到板卡。

```json
{"name": "embedded-board_upload_file", "arguments": {"local_path": "C:/app/bin", "remote_path": "/root/app"}}
```

参数：`local_path`(必填) - 本地文件绝对路径；`remote_path`(必填) - 板卡目标绝对路径

---

## 串口工具详解

### `board-alpha_serial_connect`

打开串口连接。相同配置下连接会自动复用。

```json
{"name": "board-alpha_serial_connect", "arguments": {}}
```

或指定参数：
```json
{"name": "board-alpha_serial_connect", "arguments": {"port": "COM4", "baudRate": 9600}}
```

参数：`port`(可选) - 串口名称；`baudRate`(可选) - 波特率，默认 115200；`dataBits`(可选) - 数据位，默认 8；`stopBits`(可选) - 停止位，默认 1；`parity`(可选) - 校验位 none/even/odd，默认 none

---

### `board-alpha_serial_disconnect`

关闭串口连接。

```json
{"name": "board-alpha_serial_disconnect", "arguments": {}}
```

---

### `board-alpha_serial_exec`

通过串口执行命令。执行前会自动确保连接已建立。

```json
{"name": "board-alpha_serial_exec", "arguments": {"command": "cat /proc/cpuinfo", "timeout": 10000}}
```

参数：`command`(必填) - shell 命令；`timeout`(可选) - 超时**毫秒**数，默认 5000

---

### `board-alpha_serial_send`

发送原始数据（支持 `\xHH` 十六进制转义序列）。

```json
{"name": "board-alpha_serial_send", "arguments": {"data": "\\x03"}}
```

参数：`data`(必填) - 要发送的数据。

**支持的转义序列（仅 `\xHH` 格式）**：

| 转义序列 | 含义 | 字节数 |
|----------|------|--------|
| `\x0a` | LF（换行，0x0A） | 1 |
| `\x0d` | CR（回车，0x0D） | 1 |
| `\x03` | Ctrl+C | 1 |
| `\x04` | Ctrl+D | 1 |
| `\x1a` | Ctrl+Z | 1 |

> ⚠️ **关键注意**：`\n` **不是**有效的转义序列！在 `data` 参数值中，`\n` 会被当成字面量 `\` + `n`（2 字节）发送，而非换行符。**必须使用 `\x0a` 表示换行**。同样，`\r` 也不是有效转义序列，应使用 `\x0d`。

---

## 串口与 SSH 解锁流程差异

本技能涉及的保护 Shell（如 PSH）在**串口（board-alpha）**和 **SSH（board-beta）** 上的解锁行为存在本质差异：

| 维度 | SSH（board-beta） | 串口（board-alpha） |
|------|------------------|-------------------|
| 状态检测 | 读取已有 shell buffer，**不发送额外数据** | 需发送数据；若 shell 处于输入等待，任何 `\r\n` 结尾的数据都会被当成输入提交 |
| 交互方式 | `shell_open` → `shell_send` / `shell_unlock` | `serial_connect` → `serial_exec` / `serial_send` / `shell_unlock` |
| 自动追加换行 | `shell_send` 自动在命令后追加 `\n` | `serial_exec` 自动追加 `\r\n`；`serial_send` **不追加**任何换行 |
| echo 标记冲突 | `shell_send` 追加 `echo "__END_MARKER__"` | `serial_exec` 按 prompt 模式读取，无 echo 标记 |

> ⚠️ **关键区别**：串口是独占式物理连接，且状态检测/解锁工具会发送 echo probe（如 `echo __PSH_STATE_PROBE__\r\n`）。**当 PSH 处于 `key>` 解锁输入等待时，这些 probe 会被当成 key 提交，导致 `Invalid key!`**。因此串口解锁必须避免在中间状态调用 `shell_detect_state` 或其他会发送 `\r\n` 的命令。

---

## board-alpha 串口 PSH 解锁流程

board-alpha（串口）的 root 登录 shell 同样为 `/bin/psh`（Protect Shell v2.1）。串口连接后若看到锁定界面，按以下方式解锁：

### 方式一：使用 `shell_unlock` 工具（推荐）

与 SSH 相同，`shell_unlock` 已针对串口做了安全处理：在发送 echo probe 前会先静默读取已有输出，若检测到 `key>` 等待状态则跳过 probe。

**阶段一：获取 Challenge Code**

```json
{"name": "board-alpha_shell_unlock", "arguments": {"timeout": 30000}}
```

响应中包含 `challenge_code`。**AI 必须将 Challenge Code 展示给用户。**

**阶段二：用户提供密钥后完成解锁**

```json
{"name": "board-alpha_shell_unlock", "arguments": {"timeout": 15000, "key": "用户输入的密钥"}}
```

> ⚠️ **严禁在中间调用 `shell_detect_state`！** 在阶段一和阶段二之间，串口 PSH 可能处于 `key>` 等待状态。此时调用 `shell_detect_state` 会发送 `echo __PSH_STATE_PROBE__\r\n`，被当成 key 提交导致解锁失败。

### 方式二：使用 `serial_send` 分步发送（手动，密钥已知）

适用于密钥已知或固定场景。

1. **第一步**：用 `serial_send` 发送 `debug` 命令（末尾必须带 `\x0a` 换行）：
   ```json
   {"name": "board-alpha_serial_send", "arguments": {"data": "debug\\x0a"}}
   ```
   此时 PSH 收到 `debug` 命令，进入解锁模式（显示 Challenge Code 和 `key>` 提示符）。

2. **第二步**：用 `serial_send` 发送密钥（末尾必须带 `\x0a` 换行提交）：
   ```json
   {"name": "board-alpha_serial_send", "arguments": {"data": "123456\\x0a"}}
   ```

3. **第三步**：用 `serial_exec` 执行任意命令验证解锁结果：
   ```json
   {"name": "board-alpha_serial_exec", "arguments": {"command": "id", "timeout": 5000}}
   ```

> ⚠️ **关键**：`debug` 和密钥**必须分两次独立的 `serial_send` 调用来发送**。
>
> **为什么不能合并为一次调用？** 若一次性发送 `debug\x0a123456\x0a`，PSH 在处理 `debug` 命令并打印 DEBUG MODE 界面的过程中，后续的 `123456\x0a` 可能被串口缓冲区提前消费，导致 `fgets` 读不到完整 key 而解锁失败。
>
> **为什么不能使用 `serial_exec` 发送 `debug`？** `serial_exec` 发送 `debug\r\n` 后会等待 shell 提示符。但 PSH 进入解锁模式后显示的是 `key>` 而非 shell 提示符（如 `#`），`serial_exec` 会一直等到超时，然后发送取消信号导致 PSH 返回 `locked>` 模式。

### 方式三：`serial_exec` 自动解锁

当 `serial_exec` 检测到 shell 处于 LOCKED 状态时，会自动尝试匹配内置 PSH 配置文件并执行解锁序列。若 key 未提供，会返回包含 Challenge Code 的错误信息供手动处理。

> **实现原理**：`serial_exec` 内部会从命令输出中检测 PSH 特征字符串（如 `Protect Shell`），匹配成功后自动升级 `ShellStateManager` 为内置 `psh` profile（含完整 `debug`→`key>`→`key` 解锁序列），无需手动设置 `BOARD_SHELL_PROFILE=psh` 环境变量。

同样，`shell_unlock` 工具在 heuristic 模式下也会先尝试从串口输出中识别 PSH 再执行解锁。



---

## board-beta 交互 shell 解锁流程

board-beta 的 root 登录 shell 为 `/bin/psh`（Protect Shell v2.1），打开交互 shell 后会显示锁定界面：

```
╔════════════════════════════════════════╗
║         Protect Shell v2.1             ║
╠════════════════════════════════════════╣
║  System is LOCKED                      ║
║  Type 'help' for available commands    ║
║  Type 'debug' to unlock full shell     ║
╚════════════════════════════════════════╝
locked>
```

输入 `debug` 后，PSH 会生成一个 Challenge Code：

```
╔════════════════════════════════════════╗
║             DEBUG MODE                 ║
╠════════════════════════════════════════╣
║  Challenge Code:                       ║
║  PSH-A4BB-9166-E413-71B4             ║
╠════════════════════════════════════════╣
║  Contact your admin to get the key     ║
╚════════════════════════════════════════╝
Enter key to unlock: key>
```

### 解锁方式

#### 方式一：自动解锁（推荐，使用 `shell_unlock` 工具）

此为两阶段解锁流程：

**阶段一：获取 Challenge Code 并展示给用户**

\```json
{"name": "board-beta_shell_unlock", "arguments": {"timeout": 30000}}
\```

响应中包含 `challenge_code`（格式 `PSH-XXXX-XXXX-XXXX-XXXX`）和 `challenge_raw`（板卡调试输出）。**AI 必须将 Challenge Code 展示在 opencode 交互窗口中，让用户据此生成解锁密钥。**

**阶段二：用户提供密钥后完成解锁**

\```json
{"name": "board-beta_shell_unlock", "arguments": {"timeout": 15000, "key": "用户输入的密钥"}}
\```

用户看到 Challenge Code 后，联系管理员获取对应的解锁密钥（或使用 keygen 工具生成），然后 AI 将密钥传入 `shell_unlock` 完成解锁。

#### 方式二：手动解锁（一次性发送 debug + key）

**注意**：`shell_send` 工具在每条命令后自动追加 echo 结束标记（`echo "__END_MARKER_xxx__"`）。若单独发送 `debug`，echo 标记将在 PSH 进入 `key>` 等待时被当作密钥读入，导致 `Invalid key!`。**必须将 `debug` 和密钥合并到一次 `shell_send` 调用中发送。**

1. `shell_open` 打开交互会话
2. 使用 `question` 工具向用户索要解锁密钥
3. **单次** `shell_send` 合并发送 `debug\n{key}`（不可分两次调用）

此方式适用于密钥已知/固定的场景，不展示 Challenge Code。

#### 方式三：SSH exec 绕过（无 TTY）

`board-beta_exec` 通过 SSH exec（无 TTY）执行命令，可绕过 psh 直接执行命令，无需解锁。适用于无需交互 shell 的场景。

### shell_unlock 响应字段说明

| 字段 | 含义 |
|------|------|
| `result` | `"awaiting_key"` / `"unlocked"` / `"already_unlocked"` / `"error"` |
| `state` | `"locked"` / `"unlocking"` / `"ready"` / `"error"` / `"unknown"` |
| `challenge_code` | Challenge Code（如 `PSH-A4BB-9166-E413-71B4`），仅在 `result=awaiting_key` 时出现 |
| `challenge_raw` | `debug` 步骤的板卡原始输出，包含完整的 DEBUG MODE 界面 |
| `steps` | 已执行的解锁步骤日志 |
| `message` | 人类可读的状态描述 |
| `verifyState` | 解锁后的状态验证结果（`result=unlocked` 时） |

### echo 标记冲突与串口输入污染说明

#### SSH（board-beta）

`shell_send` 自动追加 `echo "__END_MARKER__"` 作为输出边界标记。发送 `debug` 后，PSH 进入 `key>` 等待状态，此标记会被当作密钥读入，导致 `[PSH] Invalid key!`。

| 方法 | echo 标记冲突 | 推荐场景 |
|------|:---:|------|
| `shell_unlock`（无 key）→ `shell_unlock`（带 key） | 无 | 需要显示 Challenge Code |
| `shell_send "debug\n{key}"` 合并发送 | 无（合并后 marker 在 key 后面） | 密钥已知 |
| `shell_send "debug"` 单独发送 | **有** | 不推荐 |

#### 串口（board-alpha）

串口没有 echo 标记问题，但存在 **输入污染** 问题：

| 场景 | 风险 | 说明 |
|------|------|------|
| PSH 处于 `key>` 时调用 `shell_detect_state` | **高** | 发送 `echo __PSH_STATE_PROBE__\r\n`，被当成 key 提交 |
| PSH 处于 `key>` 时调用 `serial_exec` | **高** | 发送 `cmd\r\n`，被当成 key 提交 |
| `serial_send` 发送 key 但**不带 `\x0a`** | **高** | key 悬停在缓冲区，后续任何 `\r\n` 操作都会污染输入 |
| `serial_send` 分两次发送 `debug\x0a` 再发 `key\x0a` | 无 | 正确流程，PSH 在两次 `fgets` 调用间完成状态切换 |
| `serial_send` 一次发送 `debug\x0a{key}\x0a` | **低** | 存在时序风险：PSH 打印 DEBUG 界面时数据可能被缓冲截断 |
| `shell_unlock` 两阶段解锁 | 无 | 已内置串口安全检测，自动跳过 echo probe；自动匹配 PSH 内置配置文件 |



**安全规则：AI 永远不得自动发送解锁密钥。** 密钥必须由用户通过以下方式提供：
1. AI 通过 `shell_unlock` 获取 Challenge Code，展示给用户
2. 使用 `question` 工具询问用户输入密钥
3. 用户提供密钥后，AI 调用 `shell_unlock {"key": "用户输入的密钥"}` 完成解锁

> ⚠️ **串口特别警告**：在阶段一（已获取 Challenge Code）到阶段二（用户提供 key）之间，**严禁调用任何其他串口工具**（尤其是 `shell_detect_state` 和 `serial_exec`），否则会导致 key 输入窗口被污染。

### 自定义保护 Shell 配置

**方法一：使用内置 PSH 配置文件**（推荐）

PSH（Protect Shell v2.1）已内置在源码中，无需自定义环境变量。设置以下环境变量即可启用：

```
BOARD_SHELL_PROFILE=psh
```

该配置文件自动包含完整的解锁序列（`debug` → `key>` → 输入密钥）、状态检测模式和 Challenge Code 提取规则。

> 即使不设置 `BOARD_SHELL_PROFILE`，当 `serial_exec` 或 `shell_unlock` 从串口输出中检测到 PSH 特征字符串（`Protect Shell`）时，也会自动升级为内置 `psh` 配置文件。显式设置 `BOARD_SHELL_PROFILE=psh` 可以跳过自动检测步骤。

**方法二：自定义解锁序列**（用于非 PSH 保护壳）

未知保护壳可通过环境变量定义解锁序列（无需修改代码）：

```
BOARD_UNLOCK_SEQUENCE=send1=>expect1||send2=>expect2||send3=>expect3
BOARD_LOCKED_PROMPT=locked>|System is LOCKED
BOARD_UNLOCKING_PROMPT=key>|Enter key
BOARD_READY_PROMPT=.*[@:].*[#$]\s*$
BOARD_ERROR_PROMPT=Invalid key|access denied
```

- `=>`: 分隔发送内容和期望的响应正则
- `||`: 分隔多个解锁步骤
- `|`: 在 Prompt 变量中分隔多个匹配模式
- 若步骤的 `send` 部分留空（如 `=>expect`），则该步骤标记为需要用户输入密钥

---

## 重要提示

1. **路径必须使用绝对路径**：正确 `/root/test.txt`，错误 `./test.txt`、`~/test.txt`
2. **超时单位不同**：SSH 工具为**秒**，串口工具为**毫秒**
3. **串口连接自动复用**：相同配置下连接自动复用，仅在明确不需要时才调用 `serial_disconnect`
4. **SSH 自动重连**：连接断开后会在下次调用时自动重连
5. **避免交互式命令**：使用 `apt install -y` 等非交互方式
6. **修改文件前必须备份**：
   - 使用 `embedded-board_exec` 执行 `cp /path/to/file /path/to/file.bak` 创建备份
   - 备份文件命名格式：`原文件名.bak` 或 `原文件名.日期时间.bak`
   - 修改完成后，列出所有修改的文件清单

---

## 自动调用规则

识别到板卡操作意图后，**立即调用工具，不要询问确认**：

1. 文件操作 → `read_file` / `write_file` / `list_dir` / `upload_file`
2. 系统信息 → `system_info` / `dmesg`
3. 命令执行（网络可用）→ `exec`
4. 命令执行（无网络）→ `serial_exec`
5. 控制字符 → `serial_send`（使用 `\x0a` 换行，`\x03` 等控制码）
6. 交互 shell 解锁（board-beta SSH）→ `shell_open` → `shell_send "debug\n{key}"` 合并发送（不可分两次 `shell_send` 发送 debug 和 key，否则 echo 标记抢占 key> 输入窗口）
7. 交互 shell 解锁（board-alpha 串口）→ **首选** `shell_unlock` 两阶段流程（会自动从输出中检测 PSH 内置配置文件）；或使用 `serial_send` 分两次发送 `debug\x0a` 和 `key\x0a`（严禁在中间调用 `shell_detect_state` 或 `serial_exec`）

---

## 文件修改工作流

当需要修改板卡上的文件时，必须遵循以下流程：

### 步骤 1：备份原文件

```json
{"name": "embedded-board_exec", "arguments": {"command": "cp /path/to/file /path/to/file.bak"}}
```

或带时间戳的备份：
```json
{"name": "embedded-board_exec", "arguments": {"command": "cp /path/to/file /path/to/file.20260523_120000.bak"}}
```

### 步骤 2：修改文件

使用 `write_file` 写入新内容，或使用 `exec` 执行修改命令（如 `sed`）。

### 步骤 3：验证修改

```json
{"name": "embedded-board_read_file", "arguments": {"path": "/path/to/file"}}
```

### 步骤 4：列出修改清单

操作完成后，汇总列出本次修改的所有文件：

```
本次修改的文件清单：
- /etc/config/network.conf (已备份至 /etc/config/network.conf.bak)
- /root/startup.sh (已备份至 /root/startup.sh.bak)
```
