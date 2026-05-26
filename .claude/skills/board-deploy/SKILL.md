---
name: board-deploy
description: 将本地文件部署到板卡
argument-hint: "<板卡名> <本地路径> <远程路径>"
disable-model-invocation: true
arguments: [board, local_path, remote_path]
allowed-tools: mcp__embedded-board__ssh_shell_login, mcp__embedded-board__ssh_shell_exec, mcp__embedded-board__ssh_shell_close, mcp__embedded-board__serial_shell_login, mcp__embedded-board__serial_exec, mcp__embedded-board__serial_close, mcp__embedded-board__device_info_tool, Read, Bash
---

## 任务

将本地文件部署到板卡的指定路径。

## 步骤

1. 解析参数：板卡名（$board）、本地路径（$local_path）、远程路径（$remote_path）
2. 使用 `device_info_tool` 查看设备配置，判断连接方式
3. 先读取本地文件内容（使用 Read 工具或 Bash 的 base64 编码）
4. 根据连接方式选择部署方法：

### SSH 设备

1. 使用 `ssh_shell_login` 登录
2. 对于文本文件，使用 `ssh_shell_exec` 执行：

```
cat > $remote_path << 'DEPLOY_EOF'
<文件内容>
DEPLOY_EOF
```

3. 对于二进制文件，先 base64 编码再解码写入：

```
echo "<base64内容>" | base64 -d > $remote_path
```

4. 验证文件：`ssh_shell_exec` 执行 `ls -la $remote_path`

### 串口设备

1. 使用 `serial_shell_login` 登录
2. 使用 `serial_exec` 执行同样的写入命令
3. 验证文件是否存在

5. 部署完成后关闭会话
6. 报告部署结果（文件路径、大小、权限）

## 注意事项

- 文件内容中的特殊字符需要正确转义
- 大文件建议分块传输
- 部署后验证文件完整性（md5sum 或文件大小）
- 如果远程路径的父目录不存在，先创建目录
