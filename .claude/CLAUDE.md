# 嵌入式 MCP 工具包

本项目提供用于嵌入式 Linux 板卡管理的 MCP 服务器，支持 SSH 和串口两种连接方式。

## MCP 服务器

| 服务器名 | 连接方式 | 用途 |
|---------|---------|------|
| **embedded-board** | SSH (192.168.16.103:22) | 远程命令执行、文件操作 |
| **board-beta** | SSH (192.168.16.105:22) | 远程命令执行、文件操作（ssh-rsa 主机密钥，文件 IPC 解锁） |
| **board-alpha** | 串口 (COM12, 115200) | U-Boot 交互、底层调试 |

## 可用工具

### SSH 工具（embedded-board / board-beta）

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `exec` | 执行 shell 命令 | `command`, `timeout?`(秒) |
| `read_file` | 读取文件 | `path` |
| `write_file` | 写入文件 | `path`, `content` |
| `list_dir` | 列出目录 | `path` |
| `dmesg` | 内核日志 | `lines?` |
| `system_info` | 系统信息 | 无 |
| `upload_file` | 上传文件 | `local_path`, `remote_path` |
| `shell_unlock` | 执行解锁序列 | `timeout?`(毫秒) |
| `shell_detect_state` | 检测 shell 状态 | `timeout?`(毫秒) |
| `ssh_shell_login` | 一键登录（连接+检测+解锁） | `device?`, `key?`, `timeout?`(毫秒) |

### 串口工具（board-alpha）

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `serial_connect` | 打开串口 | `port?`, `baudRate?`, ... |
| `serial_disconnect` | 关闭串口 | 无 |
| `serial_exec` | 串口执行命令 | `command`, `timeout?`(毫秒) |
| `serial_send` | 发送原始数据 | `data`（支持 `\x03` 等） |
| `shell_unlock` | 执行解锁序列 | `timeout?`(毫秒) |
| `shell_detect_state` | 检测 shell 状态 | `timeout?`(毫秒) |

## 使用指南

### 优先使用 SSH
- 板卡网络可用、SSH 服务正常
- 文件操作、系统诊断、长时间命令

### 使用串口
- 板卡无网络或 SSH 不可用
- U-Boot 交互、发送控制字符
  - `\x03` = Ctrl+C
  - `\x04` = Ctrl+D
  - `\x1a` = Ctrl+Z

## 示例用法

### 执行命令
```json
{"name": "exec", "arguments": {"command": "ps aux", "timeout": 60}}
```

### 读取文件
```json
{"name": "read_file", "arguments": {"path": "/etc/hostname"}}
```

### 写入文件
```json
{"name": "write_file", "arguments": {"path": "/tmp/test.sh", "content": "#!/bin/sh\necho hello"}}
```

### 列出目录
```json
{"name": "list_dir", "arguments": {"path": "/home"}}
```

### 串口执行命令
```json
{"name": "serial_exec", "arguments": {"command": "ls", "timeout": 5000}}
```

### 发送控制字符
```json
{"name": "serial_send", "arguments": {"data": "\x03"}}
```

### 一键登录（自动连接+PSH检测+解锁）
```json
{"name": "ssh_shell_login", "arguments": {}}
```

带密钥一键登录：
```json
{"name": "ssh_shell_login", "arguments": {"key": "my_unlock_password"}}
```

指定设备一键登录：
```json
{"name": "ssh_shell_login", "arguments": {"device": "board-b", "key": "my_unlock_password"}}
```

## 快捷技能（Slash Commands）

| 技能 | 用途 | 调用方式 |
|------|------|---------|
| **board-status** | 查看板卡系统状态 | `/board-status [板卡名]` |
| **board-shell** | 打开交互式 shell | `/board-shell <板卡名>` |
| **board-deploy** | 部署文件到板卡 | `/board-deploy <板卡名> <本地路径> <远程路径>` |
| **board-unlock** | 解锁受保护 shell | `/board-unlock <板卡名> [密钥]` |

## 文件 IPC 解锁

board-beta 配置了文件 IPC 用于动态密钥交换：
- 挑战信息保存到 `challenge.txt`，供外部工具读取
- 外部工具将密钥写入 `password_input.txt`
- 系统自动轮询并读取密钥，读取后删除密码文件
