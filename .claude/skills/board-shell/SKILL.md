---
name: board-shell
description: 在板卡上打开交互式 shell 会话，用于多步骤交互操作
argument-hint: "<板卡名>"
disable-model-invocation: true
allowed-tools: mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_open, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_write, mcp__embedded-board__ssh_shell_read, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__serial_shell_login, mcp__embedded-board__serial_open, mcp__embedded-board__serial_exec, mcp__embedded-board__serial_write, mcp__embedded-board__serial_read, mcp__embedded-board__serial_close, mcp__embedded-board__device_info_tool
---

## 任务

在板卡上打开交互式 shell 会话，允许用户通过自然语言执行多步操作。

## 步骤

1. 获取板卡名参数（$ARGUMENTS），如果没有提供则使用默认设备
2. 使用 `device_info_tool` 查看设备配置，判断连接方式（SSH 或串口）
3. 根据连接方式选择登录方法：
   - **SSH 设备**：使用 `ssh_shell_login` 一键登录
   - **串口设备**：使用 `serial_shell_login` 一键登录
4. 登录成功后，告知用户会话已就绪，等待用户输入命令
5. 用户每次输入命令时，使用对应的 `exec` 工具执行：
   - SSH：`ssh_shell_exec`
   - 串口：`serial_exec`
6. 对于需要精细控制的场景（如长时间运行的命令），使用 write + read 分步操作
7. 用户说"退出"或"关闭"时，使用对应的 `close` 工具关闭会话

## 注意事项

- 保持会话打开，不要在每条命令后自动关闭
- 串口设备支持发送控制字符：`\x03`(Ctrl+C)、`\x04`(Ctrl+D)、`\x1a`(Ctrl+Z)
- 如果 PSH 解锁需要密钥，提示用户提供
