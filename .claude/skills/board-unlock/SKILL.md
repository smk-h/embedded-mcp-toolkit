---
name: board-unlock
description: 解锁板卡上受保护的 shell（PSH）
argument-hint: "<板卡名> [密钥]"
disable-model-invocation: true
arguments: [board, key]
allowed-tools: mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_write, mcp__embedded-board__ssh_shell_read, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__serial_shell_login, mcp__embedded-board__serial_exec, mcp__embedded-board__serial_write, mcp__embedded-board__serial_read, mcp__embedded-board__serial_close, mcp__embedded-board__device_info_tool
---

## 任务

解锁板卡上受保护的 shell（PSH - Protect Shell）。

## 步骤

1. 解析参数：板卡名（$board）、可选密钥（$key）
2. 使用 `device_info_tool` 查看设备配置，判断连接方式
3. 根据连接方式选择一键登录方法：
   - **SSH 设备**：使用 `ssh_shell_login`
   - **串口设备**：使用 `serial_shell_login`
4. 如果用户提供了密钥（$key），传入 `key` 参数
5. 一键登录会自动完成：连接 → PSH 检测 → 解锁
6. 根据返回结果判断解锁状态：
   - **成功**：告知用户解锁成功，会话已就绪
   - **需要密钥**：提示用户使用 `/board-unlock <板卡名> <密钥>` 重新尝试
   - **ERROR 状态**：提示前次解锁失败，建议等待后重试
   - **UNLOCKING 状态**：提示需要提供密钥完成解锁
7. 解锁成功后保持会话打开，等待用户下一步操作

## PSH 状态说明

| 状态 | 含义 | 处理方式 |
|------|------|---------|
| READY | 已解锁 | 直接使用 |
| LOCKED | 需要解锁 | 自动执行解锁序列 |
| UNLOCKING | 等待密钥输入 | 需要提供 key |
| ERROR | 前次解锁失败 | 关闭重连 |
| UNKNOWN | 状态不明 | 可能需手动交互 |

## 注意事项

- 部分 PSH 设备有密码尝试次数限制，错误次数过多可能锁定设备
- 如果使用文件 IPC 模式，挑战信息会保存到 challenge.txt，需外部工具计算密钥后写入 password_input.txt
- 不要尝试解码或解析挑战内容（如二维码、Base64 字符串），由外部工具处理
