---
name: embedded-toolkit
description: 当需要与嵌入式 Linux 板卡通过 SSH 或串口交互时使用。涵盖 embedded-board MCP（SSH 方式：exec、read_file、write_file、list_dir、dmesg、system_info、upload_file）和 board-alpha MCP（串口方式：serial_connect、serial_disconnect、serial_exec、serial_send）的全部工具。仅在用户要求操作远程板卡、查询板卡状态、上传文件、执行 shell 命令、调试内核日志或串口通信时触发。
---

# 嵌入式 MCP 工具包

本技能涵盖两个用于嵌入式 Linux 板卡管理的 MCP 服务器：

- **embedded-board**：基于 SSH 的远程管理（TCP/22，IP: 192.168.16.103）
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
| `board-alpha_serial_connect` | 打开串口 | `port?`, `baudRate?`, ... |
| `board-alpha_serial_disconnect` | 关闭串口 | 无 |
| `board-alpha_serial_exec` | 串口执行命令 | `command`, `timeout?`(毫秒) |
| `board-alpha_serial_send` | 发送原始数据 | `data`（支持 `\x03` 等） |

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
