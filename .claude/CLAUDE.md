# 嵌入式 MCP 工具包

本项目提供用于嵌入式 Linux 板卡管理的 MCP 服务器，支持 SSH、串口和 ADB 三种连接方式。

- **配置文件:** `.embedded/configs/config.yaml`
- **默认设备:** 通过环境变量 `DEVICE` 或配置文件获取

> 工具的参数、必填项、说明均以 `tools/list` 返回的 schema 为准，本文件只记录无法从 schema 推断的约定与决策。

## 设备列表获取规则

| 场景 | 操作 | 工具 |
|------|------|------|
| 用户未指定设备，需列出所有可用设备 | 读取配置文件 | `device_info_tool`（`device: "all"`） |
| 用户明确要求操作 ADB 设备 | 扫描物理连接的 ADB 设备 | `adb_device_list` |
| 用户指定了设备名（如 board-a） | 直接使用，无需查询 | — |

- **配置文件设备**（SSH/串口）：始终通过 `device_info_tool` 或 config.yaml 获取
- **ADB 设备**：仅在用户明确提到 ADB 时，才调用 `adb_device_list` 扫描 USB/TCP 连接；否则从 `device_info_tool` 获取

## 连接优先级

1. **SSH Login（推荐）** → `ssh_shell_login` 一键连接 + PSH 检测 + 解锁
2. **SSH Open** → `ssh_shell_open` 手动控制会话生命周期
3. **Serial Login** → `serial_shell_login` 一键串口登录
4. **Serial Open** → `serial_open` 手动控制串口会话
5. **ADB Shell Open** → `adb_shell_open` 打开持久化 ADB Shell
6. **ADB Exec** → `adb_exec` 一次性 ADB 命令

## 典型工作流

- **简单执行**（一次性）: `ssh_shell_login` / `serial_shell_login` / `adb_exec` → 直接执行并返回
- **交互式**（多步）: `*_open` ⇒ `write` + `read` / `exec` + ... ⇒ `close`
- **远程编译**: `ssh_shell_login` / `ssh_shell_open` ⇒ `ssh_build`（结构化错误/警告反馈）
- **U-Boot 操作**: `serial_shell_login` ⇒ `serial_enter_uboot`
- **本地探测**（Windows 主机）: `port_scan_tool` → `serial_open`；`adb_device_list` → `adb_shell_open`；`subnet_check_tool` → 子网分析

## 参数约定

- `device`: 设备名（board-a / board-b / board-test），不填则用默认设备
- `session_id`: 由 `open` / `login` 返回，后续操作需复用同一 ID
- `clear`: 缓冲区标志，`1`=清空后操作（默认），`0`=追加
- `delay`: 命令发送后的等待时间（毫秒），默认 `1000`

## 文件 IPC 解锁

所有设备均配置了文件 IPC 用于动态密钥交换：

- 挑战信息保存到 `configs/challenge.txt`，供外部工具读取
- 外部工具将密钥写入 `configs/password_input.txt`
- 系统自动轮询并读取密钥，读取后删除密码文件

## 快捷技能（Slash Commands）

| 技能 | 用途 | 调用方式 |
|------|------|---------|
| **dev-upgrade** | 并行编译内核 + 进入 U-Boot 等待升级 | `/dev-upgrade` |
