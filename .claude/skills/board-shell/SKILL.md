---
name: board-shell
description: 在板卡上打开交互式 shell 会话，用于多步骤交互操作。当需要运行共享状态（cd、环境变量）的多个命令或需要 TTY 时使用。
allowed-tools: mcp__embedded-board__shell_open mcp__embedded-board__shell_send mcp__embedded-board__shell_close mcp__embedded-board__shell_detect_state mcp__embedded-board__shell_unlock mcp__board-beta__shell_open mcp__board-beta__shell_send mcp__board-beta__shell_close mcp__board-beta__shell_detect_state mcp__board-beta__shell_unlock mcp__board-alpha__serial_connect mcp__board-alpha__serial_exec mcp__board-alpha__serial_send mcp__board-alpha__shell_detect_state mcp__board-alpha__shell_unlock
---

## 使用说明

在板卡上打开交互式 shell，用于多步骤操作。参数为板卡名称。

用法：`/board-shell embedded-board` 或 `/board-shell board-beta` 或 `/board-shell board-alpha`

### 步骤

1. SSH 板卡：使用 `shell_open` 启动会话，然后用 `shell_send` 执行每条命令。
2. 串口板卡：先使用 `serial_connect` 连接，然后用 `serial_exec` 执行命令。
3. 打开后，用 `shell_detect_state` 检查 shell 状态。如果被锁定，使用 `shell_unlock` 解锁。
4. 完成后，用 `shell_close`（SSH）或 `serial_disconnect`（串口）关闭会话。

### 注意事项

- 交互式 shell 在命令之间保持状态（cd、环境变量等）
- 需要使用 `shell_send` 运行需要 TTY 的交互式程序
- 单次非交互命令优先使用 `exec`，而非 `shell_open`+`shell_send`
- 完成后务必关闭 shell 会话以释放资源
