---
name: dev-upgrade
description: 当用户要给板卡升级内核或固件时触发——典型表述如"升级 board-b"、"帮我把内核刷到板卡"、"重新编译并烧录到板卡"、"更新 board-b 固件"。后台并行编译 board-ubuntu 内核，同时前台串口登录目标板卡并进入 U-Boot 待命；编译成功则采集 U-Boot 信息后重启设备，失败则保持 U-Boot 命令行以便手动排查。
argument-hint: ""
allowed-tools: mcp__embedded-board__serial_shell_login, mcp__embedded-board__serial_exec, mcp__embedded-board__serial_enter_uboot, mcp__embedded-board__serial_write, mcp__embedded-board__serial_read, mcp__embedded-board__serial_close, mcp__embedded-board__device_info_tool, Agent, TaskOutput
---

## 任务

在 board-ubuntu 上编译内核的同时，在 board-b 上通过串口登录并进入 U-Boot 命令行。编译完成后根据结果决定后续操作：成功则在 U-Boot 下获取信息并重启，失败则保持 U-Boot 状态。

## 背景

内核编译是耗时操作。利用 code-build 子 agent 在 board-ubuntu 上后台执行编译，与此同时主 agent 在 board-b 串口上并行完成登录、系统信息采集和 U-Boot 进入，从而最大化并行效率。

## 步骤

> **并行原理（核心）**：Claude Code 的 `Agent` 工具**默认是阻塞的**——会同步等待子 agent 执行完才返回。要实现"编译与串口操作并行"，启动 code-build 时**必须传 `run_in_background: true`**：它调用后立即返回一个 `task_id`，子 agent 在后台编译，主 agent 转身去做串口的活。编译完成后系统自动发 task-notification 通知主 agent，再用 `TaskOutput` 取回结果。

### 第一步：启动编译子 agent（后台异步）

1. **单独调用 `Agent` 工具启动 code-build 子 agent，并设 `run_in_background: true`**

   参数：
   - `description`：`"编译 board-ubuntu 内核"`
   - `subagent_type`：`"code-build"`
   - `run_in_background`：`true`
   - `prompt`（将以下内容整体作为 prompt 参数传入）：

   ```
   请登录 board-ubuntu 并在 ~/workspace/Alpha/kernel 目录下执行编译：
   1. 使用 ssh_shell_login 登录 board-ubuntu（device: "board-ubuntu"）
   2. 使用 ssh_build 在 ~/workspace/Alpha/kernel 目录执行命令：./build.sh alpha -a -c
      - cwd 设为 "~/workspace/Alpha/kernel"
      - command 设为 "./build.sh alpha -a -c"
      - maxWait 设为 1800000（30 分钟，内核编译可能很久）
   3. 编译结束后，使用 ssh_shell_close 关闭会话
   4. 返回编译结果（成功/失败），如果有错误请列出关键错误信息，如果有警告请列出警告摘要
   ```

   调用后 `Agent` 立即返回一个 **`task_id`（务必记下它）**，子 agent 在后台开始编译。**不要同步等待结果，继续执行下一步。**

### 第二步：串口登录 board-b（编译在后台进行中）

2. **单独调用 `serial_shell_login` 登录 board-b**
   - `device` 设为 `"board-b"`
   - 从返回结果中获取 `session_id`（如 `serial_1`）

### 第三步：获取系统信息并进入 U-Boot（编译仍在后台进行）

3. **获取 board-b 系统信息**
   - 单独调用 `serial_exec`，使用步骤 2 的 `session_id`，执行以下命令（`delay` 设为 3000）：

   ```
   echo "=== Hostname ===" && hostname && echo "=== Kernel ===" && uname -a && echo "=== Uptime ===" && uptime && echo "=== Memory ===" && free -h && echo "=== Disk ===" && df -h /
   ```

   - 记录并格式化输出系统信息

4. **进入 U-Boot**
   - 单独调用 `serial_enter_uboot`，使用步骤 2 的 `session_id`
   - `timeout` 设为 120（秒）
   - 确认已进入 U-Boot 命令行（出现 `=>` 或 `U-Boot>` 提示符）

### 第四步：等待编译结果并处理

5. **取回后台编译结果**
   - 此时主 agent 已完成串口端的所有准备工作（已进入 U-Boot）
   - 调用 `TaskOutput` 取回第一步的 `task_id` 对应的结果：`task_id` 传入后台任务 id，`block` 设为 `true` 阻塞等待编译完成，`timeout` 设为 600000（10 分钟）。
   - 若一次 `TaskOutput` 返回任务仍未结束（编译超 10 分钟），**再次调用 `TaskOutput` 继续等待**，直到拿到 code-build 的最终汇报文本。
   - 也可在收到该 `task_id` 的 task-notification 通知后，再调用一次 `TaskOutput`（`block` 可为 `false`）取回完整结果。

6. **根据编译结果分支处理**

   ### 编译成功

   - 在 U-Boot 下获取 U-Boot 信息：
     - 调用 `serial_exec`，执行 `version`（获取 U-Boot 版本，`delay` 设为 2000）
     - 调用 `serial_exec`，执行 `printenv`（获取 U-Boot 环境变量，`delay` 设为 3000）
   - 格式化展示 U-Boot 版本信息和关键环境变量
   - 重启设备：
     - 调用 `serial_exec`，执行 `reset`（重启设备，`delay` 设为 2000）
   - 调用 `serial_close` 关闭串口会话
   - 向用户报告完整结果：编译成功 + board-b 系统信息 + U-Boot 信息 + 设备已重启

   ### 编译失败

   - **保持 U-Boot 状态，不执行任何操作**
   - 向用户报告：
     - 编译失败，列出关键错误信息
     - board-b 系统信息
     - board-b 当前处于 U-Boot 命令行状态（等待用户手动处理）
   - **不要关闭串口会话**，保持 U-Boot 命令行可用，以便用户排查问题
   - 提示用户：串口会话已保持打开，可继续在 U-Boot 下操作

## 流程图

```
步骤1: Agent(code-build, run_in_background:true) ──> 立即返回 task_id，编译在后台异步执行
         │
         │  [编译在后台进行中... 可能很久]
         │
步骤2: serial_shell_login(board-b) ──> 返回 session_id
         │
步骤3: serial_exec: 获取系统信息 ──> 返回系统信息
         │
步骤4: serial_enter_uboot ──> 进入 U-Boot 命令行
         │
         │  [编译仍在后台进行中...]
         │
步骤5: TaskOutput(task_id, block:true) ──> 取回编译结果
         │
   ┌─────┴─────┐
   ↓           ↓
编译成功      编译失败
   │           │
serial_exec: version   保持 U-Boot 状态
serial_exec: printenv 报告错误信息
serial_exec: reset    (不关闭串口)
serial_close
```

## 注意事项

- **并行的关键在 `run_in_background: true`（核心）**：Claude Code 的 `Agent` 工具默认阻塞同步等待。**只有**显式传 `run_in_background: true`，子 agent 才会在后台异步编译、调用立即返回 `task_id`，主 agent 才能在编译期间继续调用串口工具实现真正并行。Claude Code 不支持在子 agent frontmatter 里设"默认后台"开关，该参数只能由主会话在每次调用 `Agent` 时传入。
- **记下 `task_id`**：`Agent(run_in_background:true)` 返回的 `task_id` 是后续 `TaskOutput` 取回结果的唯一凭据，务必在第一步保留。
- **后台结果用 `TaskOutput` 取回**：后台 agent 不会把结果直接写进主对话，需在第四步用 `TaskOutput(task_id, block:true)` 阻塞等待并取回；编译超 10 分钟则多次调用直至拿到最终汇报文本。
- **串口工具按序调用**：`serial_shell_login` 先拿到 `session_id`，后续的 `serial_exec` 和 `serial_enter_uboot` 依赖该 `session_id`，必须串行调用。它们与后台编译是并行的。
- **子 agent 是独立上下文**：prompt 中必须包含完整的登录、编译、关闭会话指令，因为子 agent 无法访问主 agent 的对话历史。
- **maxWait**：内核编译可能耗时很久，ssh_build 的 maxWait 建议设为 1800000（30 分钟），如果编译通常更久可适当增加。
- **U-Boot 命令**：U-Boot 下使用 `version` 和 `printenv` 获取信息，使用 `reset` 重启。
- **失败处理**：编译失败时保持串口会话打开，方便用户在 U-Boot 下手动调试。
- **编译成功后**：获取 U-Boot 信息再重启，确保升级前的环境状态已记录。
