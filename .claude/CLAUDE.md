# 嵌入式 MCP 工具包

本项目提供用于嵌入式 Linux 板卡管理的 MCP 服务器，支持 SSH 和串口两种连接方式。

**配置文件:** `configs/config.yaml`
**默认设备:** board-b

## 设备列表

| 设备名 | SSH | 串口 | 用途 |
|-------|-----|------|------|
| **board-a** | 192.168.16.103:22 root/root | COM4@115200 | 板卡 A |
| **board-b** | 192.168.16.105:22 root/root | COM3@115200 | 板卡 B（默认） |
| **board-test** | 1.1.1.1:22 sumu/sumu | COM3@115200 | 测试设备 |

所有设备均配置了 **文件 IPC 解锁**（`challenge.txt` / `password_input.txt`）。

## MCP 工具总览

### 基本工具（Basic）

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `device_info_tool` | 获取当前设备配置（SSH、串口、KeyProvider） | `device?` |
| `version_tool` | 获取 MCP 服务器版本和工具包信息 | 无 |
| `greet_tool` | 打招呼测试 | `name` |

### SSH 工具（需先 open 获取 session_id）

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `ssh_shell_open` | 打开交互式 SSH Shell 会话，返回初始 banner | `device?`, `timeout?`(秒) |
| `ssh_shell_close` | 关闭 SSH Shell 会话 | `session_id` |
| `ssh_shell_write` | 向 SSH Shell 发送命令 | `session_id`, `command`, `clear?` |
| `ssh_shell_read` | 读取 SSH Shell 输出 | `session_id`, `clear?` |
| `ssh_shell_list` | 列出所有活跃 SSH 会话 | 无 |
| `ssh_shell_exec` | 发送命令 + 等待 + 读取（write+delay+read） | `session_id`, `command`, `delay?`(ms), `clear?` |
| `ssh_shell_connection` | 检查远端板卡上活跃的 SSH 连接 | `session_id` |
| `ssh_shell_login` | **一键登录**（连接 + PSH 检测 + 解锁） | `device?`, `key?`, `timeout?`(ms) |

### 串口工具（需先 open 获取 session_id）

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `serial_open` | 打开串口连接并启动交互式 Shell | `device?`, `port?`, `baudRate?`, `dataBits?`, `stopBits?`, `parity?` |
| `serial_close` | 关闭串口会话 | `session_id` |
| `serial_write` | 向串口发送命令 | `session_id`, `command`, `clear?` |
| `serial_read` | 读取串口输出 | `session_id`, `clear?` |
| `serial_list` | 列出所有活跃串口会话 | 无 |
| `serial_exec` | 发送命令 + 等待 + 读取（write+delay+read） | `session_id`, `command`, `delay?`(ms), `clear?` |
| `serial_shell_login` | **一键登录**（连接 + PSH 检测 + 解锁） | `device?`, `key?`, `timeout?`(ms) |

### Windows 本地工具

| 工具名 | 用途 | 必填参数 |
|-------|------|---------|
| `port_scan_tool` | 扫描 Windows 设备管理器中的 COM/LPT 端口 | 无 |
| `network_scan_tool` | 扫描 Windows 网络适配器信息 | 无 |
| `power_shell_open` | 打开交互式 PowerShell 会话 | `workingDir?` |
| `power_shell_close` | 关闭 PowerShell 会话 | `session_id` |
| `power_shell_write` | 向 PowerShell 发送命令 | `session_id`, `command`, `clear?` |
| `power_shell_read` | 读取 PowerShell 输出 | `session_id`, `clear?` |
| `power_shell_list` | 列出所有活跃 PowerShell 会话 | 无 |
| `power_shell_exec` | 发送命令 + 等待 + 读取 | `session_id`, `command`, `delay?`(ms), `clear?` |

## 使用指南

### 连接优先级
1. **SSH Login（推荐）** → `ssh_shell_login` 一键连接 + 检测 + 解锁
2. **SSH Open** → `ssh_shell_open` 手动控制会话生命周期
3. **Serial Login** → `serial_shell_login` 一键串口登录
4. **Serial Open** → `serial_open` 手动控制串口会话

### 工作流模式
- **简单执行**（一次性）: `ssh_shell_login` / `serial_shell_login` → 直接在返回的 session 中操作
- **交互式**（多步）: `ssh_shell_open` => `write` + `read` + ... => `close`
- **本地探测**（Windows 主机）: `port_scan_tool` → `serial_open`
- **调试串口**（控制字符）: 数据通过 `serial_write` 的 `command` 参数发送，换行符按配置追加

### 参数说明
- `device`: 设备名（board-a / board-b / board-test），不填则用默认设备
- `clear`: 缓冲区标志，1=清空后操作（默认），0=追加
- `delay`: 命令发送后的等待时间（毫秒），默认 1000ms
- `session_id`: 由 open/login 返回，后续操作需使用同一 ID

## 示例用法

### 一键 SSH 登录（推荐）
```json
{"name": "ssh_shell_login", "arguments": {}}
```

指定设备和密钥：
```json
{"name": "ssh_shell_login", "arguments": {"device": "board-a", "key": "my_password"}}
```

### SSH session 多步交互
```json
{"name": "ssh_shell_open", "arguments": {"device": "board-b"}}
```
```json
{"name": "ssh_shell_exec", "arguments": {"session_id": "ssh_1", "command": "cat /proc/cpuinfo", "delay": 2000}}
```
```json
{"name": "ssh_shell_close", "arguments": {"session_id": "ssh_1"}}
```

### 串口登录
```json
{"name": "serial_shell_login", "arguments": {"device": "board-b"}}
```

### 本地端口扫描
```json
{"name": "port_scan_tool", "arguments": {}}
```

### 获取设备配置
```json
{"name": "device_info_tool", "arguments": {}}
```

```json
{"name": "device_info_tool", "arguments": {"device": "board-a"}}
```

### 查看 SSH 连接状态
```json
{"name": "ssh_shell_connection", "arguments": {"session_id": "ssh_1"}}
```

## 快捷技能（Slash Commands）

| 技能 | 用途 | 调用方式 |
|------|------|---------|
| **board-status** | 查看板卡系统状态 | `/board-status [板卡名]` |
| **board-shell** | 打开交互式 shell | `/board-shell <板卡名>` |
| **board-deploy** | 部署文件到板卡 | `/board-deploy <板卡名> <本地路径> <远程路径>` |
| **board-unlock** | 解锁受保护 shell | `/board-unlock <板卡名> [密钥]` |

## 文件 IPC 解锁

所有设备均配置了文件 IPC 用于动态密钥交换：
- 挑战信息保存到 `configs/challenge.txt`，供外部工具读取
- 外部工具将密钥写入 `configs/password_input.txt`
- 系统自动轮询并读取密钥，读取后删除密码文件
