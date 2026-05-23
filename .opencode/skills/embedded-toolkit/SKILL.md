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

发送原始数据（支持控制字符）。

```json
{"name": "board-alpha_serial_send", "arguments": {"data": "\\x03"}}
```

参数：`data`(必填) - 要发送的数据，常用控制字符：`\x03`=Ctrl+C, `\x04`=Ctrl+D, `\x1a`=Ctrl+Z

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

### echo 标记冲突说明

`shell_send` 自动追加 `echo "__END_MARKER__"` 作为输出边界标记。发送 `debug` 后，PSH 进入 `key>` 等待状态，此标记会被当作密钥读入，导致 `[PSH] Invalid key!`。

| 方法 | echo 标记冲突 | 推荐场景 |
|------|:---:|------|
| `shell_unlock`（无 key）→ `shell_unlock`（带 key） | 无 | 需要显示 Challenge Code |
| `shell_send "debug\n{key}"` 合并发送 | 无（合并后 marker 在 key 后面） | 密钥已知 |
| `shell_send "debug"` 单独发送 | **有** | 不推荐 |

**安全规则：AI 永远不得自动发送解锁密钥。** 密钥必须由用户通过以下方式提供：
1. AI 通过 `shell_unlock` 获取 Challenge Code，展示给用户
2. 使用 `question` 工具询问用户输入密钥
3. 用户提供密钥后，AI 调用 `shell_unlock {"key": "用户输入的密钥"}` 完成解锁

### 自定义保护 Shell 配置

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
5. 控制字符 → `serial_send`
6. 交互 shell 解锁（board-beta）→ `shell_open` → `shell_send "debug\n{key}"` 合并发送（不可分两次 `shell_send` 发送 debug 和 key，否则 echo 标记抢占 key> 输入窗口）

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
