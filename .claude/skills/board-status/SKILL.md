---
name: board-status
description: 查看嵌入式板卡系统状态（系统信息、运行时间、内存、磁盘）。当需要了解板卡健康状况或系统状态时使用。
allowed-tools: mcp__embedded-board__exec mcp__embedded-board__system_info mcp__board-beta__exec mcp__board-beta__system_info mcp__board-alpha__serial_exec mcp__board-alpha__shell_detect_state
---

## 使用说明

查看嵌入式板卡系统状态。默认检查所有可用的 SSH 板卡。

如果参数指定了板卡名称（embedded-board、board-beta、board-alpha），则只检查该板卡。

### 步骤

1. SSH 板卡（embedded-board、board-beta）：先使用 `system_info` 工具，如需更多信息再用 `exec` 执行 `uptime`。
2. 串口板卡（board-alpha）：使用 `serial_exec` 执行 `uname -a && uptime && free -h && df -h /`。
3. 如果某块板卡不可达，明确报告并建议检查网络或串口连接。

### 输出格式

报告每块板卡的：
- 主机名和内核版本
- 运行时间
- 内存使用情况
- 磁盘使用情况
- 遇到的错误
