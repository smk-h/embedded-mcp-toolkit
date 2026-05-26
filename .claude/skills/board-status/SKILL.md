---
name: board-status
description: 查看板卡系统状态，包括主机名、内核版本、运行时间、内存和磁盘使用情况
argument-hint: "[板卡名]"
disable-model-invocation: true
allowed-tools: mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__device_info_tool
---

## 任务

查看板卡的系统状态信息。

## 步骤

1. 如果用户提供了板卡名参数（$ARGUMENTS），则使用 `ssh_shell_login` 并指定 `device` 参数；否则使用 `ssh_shell_login` 不带参数登录默认设备
2. 登录成功后，使用 `ssh_shell_exec` 执行以下命令获取系统状态：

```
echo "=== Hostname ===" && hostname && echo "=== Kernel ===" && uname -a && echo "=== Uptime ===" && uptime && echo "=== Memory ===" && free -h && echo "=== Disk ===" && df -h / && echo "=== CPU ===" && cat /proc/cpuinfo | head -20
```

3. 将 `delay` 设置为 3000（3 秒），因为命令较多需要等待
4. 读取并格式化输出结果，以清晰的格式呈现给用户
5. 使用 `ssh_shell_close` 关闭会话

## 注意事项

- 如果 SSH 连接失败，提示用户检查板卡是否在线
- 如果板卡名不在配置中，使用 `device_info_tool` 查看可用设备列表
