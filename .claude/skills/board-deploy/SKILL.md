---
name: board-deploy
description: 将本地文件或脚本部署到嵌入式板卡。当需要上传文件并在板卡上执行时使用。
allowed-tools: mcp__embedded-board__upload_file mcp__embedded-board__exec mcp__embedded-board__write_file mcp__board-beta__upload_file mcp__board-beta__exec mcp__board-beta__write_file mcp__board-alpha__serial_connect mcp__board-alpha__serial_exec mcp__board-alpha__serial_send
---

## 使用说明

将本地文件部署到嵌入式板卡。参数：`<板卡名> <本地路径> <远程路径>`

示例：`/board-deploy embedded-board ./build/app /usr/local/bin/app`

### 步骤

1. 解析参数：板卡名称、本地文件路径、远程目标路径。
2. SSH 板卡：使用 `upload_file` 传输文件，如果是脚本或二进制文件，用 `exec` 执行 `chmod +x`。
3. 串口板卡：使用 `write_file` 在板卡上创建文件（串口不支持 upload_file）。
4. 上传后，用 `exec ls -la <远程路径>` 验证文件是否存在。

### 注意事项

- 大文件优先使用 SSH 的 `upload_file`
- 文本/配置文件可使用 `write_file`，SSH 和串口均支持
- 部署后务必验证文件是否上传成功
