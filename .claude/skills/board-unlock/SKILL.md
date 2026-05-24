---
name: board-unlock
description: 解锁嵌入式板卡上受保护的 shell（如 psh 锁定 shell）。当板卡 shell 被锁定需要认证才能访问时使用。
allowed-tools: mcp__embedded-board__shell_detect_state mcp__embedded-board__shell_unlock mcp__embedded-board__shell_open mcp__board-beta__shell_detect_state mcp__board-beta__shell_unlock mcp__board-beta__shell_open mcp__board-alpha__serial_connect mcp__board-alpha__serial_exec mcp__board-alpha__shell_detect_state mcp__board-alpha__shell_unlock
---

## 使用说明

解锁嵌入式板卡上受保护的 shell。部分板卡使用 psh（受保护 shell），需要认证才能访问。

用法：`/board-unlock <板卡名> [密钥]`

- 不带密钥：检测状态并尝试自动解锁
- 带密钥：使用提供的密钥解锁

### 步骤

1. SSH 板卡：如果尚未打开 shell 会话，先用 `shell_open` 打开。
2. 串口板卡：如果尚未连接，先用 `serial_connect` 连接。
3. 用 `shell_detect_state` 检测当前 shell 状态。
4. 如果状态为 "locked" 或 "unlocking"：
   - 如果提供了密钥：使用 `shell_unlock` 并传入 key 参数
   - 如果没有密钥：不带 key 调用 `shell_unlock`，可能会：
     - 自动解锁（如果 profile 有非交互式解锁序列）
     - 返回 `awaiting_key`（需要用户输入，挑战-响应模式）
5. 如果返回 `awaiting_key`，告知用户挑战信息已保存到 `challenge.txt`，等待用户提供密钥。

### 文件 IPC（board-beta）

部分板卡配置了基于文件的 IPC 用于动态密钥交换：
- 挑战信息保存到 `challenge.txt`
- 外部工具可将解锁密钥写入 `password_input.txt`
- 系统会自动轮询密码文件

如果板卡使用文件 IPC，告知用户外部工具可能会处理密钥交换。

### psh 解锁流程（board-beta）

运行 psh（Protect Shell / davinci 系统）的板卡遵循以下解锁流程：

1. **打开 shell** → 出现 psh 横幅：
   ```
   BusyBox vx.x.x Protect Shell (psh) ver: xxxxxxxxxx
   Enter 'help' for a list of davinci system commands.
   #
   ```
   状态：**locked** — 仅可使用有限的 davinci 命令。

2. **发送 `debug` 命令** → 触发解锁挑战：
   - 挑战信息保存到 `challenge.txt`（原始输出，不做解码）
   - 出现 `Password:` 提示
   - 状态：**unlocking** — 等待解锁密码

3. **提交密码** → 两种结果：
   - **成功**：出现 `Enter Debug Mode.` 横幅 + BusyBox ash shell 提示符（`#`）
     ```
     BusyBox v1.37.0 (2026-05-20 19:30:10 CST) built-in shell (ash)
     #
     ```
     状态：**ready** — 完整的 Linux shell 访问权限。
   - **失败**：出现 `Access denied` 或类似错误，返回 psh 锁定状态。

#### 密钥来源

第 3 步的密码可以来自：
- **用户提供的密钥**：通过 `shell_unlock` 的 `key` 参数传入
- **文件 IPC**：外部工具将密码写入 `password_input.txt`，系统自动轮询读取
- **手动输入**：如果没有自动来源，告知用户挑战信息在 `challenge.txt` 中，等待用户提供密钥

**不要**尝试解码或解析挑战内容（如二维码、Base64 字符串）。原始输出保存到 `challenge.txt`，由外部工具或用户自行处理。
