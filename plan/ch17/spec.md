# 远程 MCP 启动时的端点提示 Spec

## 背景

本工具链支持"MCP 本体跑在 Windows、AI 客户端（claude code / zcode）跑在 Linux"的跨机部署：Linux 上的 AI 通过 SSH 桥接（`ssh -i ~/.ssh/id_mcp_server <winuser>@<winip> <remote-start-mcp.bat>`）远程启动 Windows 上的 MCP Server 进程。

在这种跨机部署下，AI 客户端在 Linux 上需要与 Windows 之间搬运文件（例如把 Linux 编译出的 ko 固件搬到 Windows 中转、再经串口 ZMODEM 推进设备）。搬运手段是 AI 客户端自己执行 scp 命令——但 scp 需要目标端点（MCP 宿主的 `username@ip`），而 AI 客户端**无从得知** Windows 的用户名和 IP（这是 MCP 宿主机的属性，不是 AI 客户端所在 Linux 的属性）。

当前状态：
- MCP 启动日志已记录 `SSH_CONNECTION` / `USER` 等环境变量（ch16 之前加入 `src/mcp/server.ts`），已验证可从中解析出 `username`（`os.userInfo().username`）与 `ip`（`SSH_CONNECTION` 第 3 字段 = 宿主 IP）。
- 但这些信息**只写进日志，没有传达给 AI 客户端**。AI 客户端读不到，也就无法构造正确的 scp 命令。

同时存在一个必须规避的副作用：MCP 也支持 Windows 本地直接启动（不经过 ssh）。本地启动时，AI 客户端与 MCP 在同一台 Windows 机器上，文件本就在本地，**无需 scp**。若此时也注入"端点提示"，会误导 AI 以为自己要 scp 到一个"远端"（其实是自己这台机器），破坏原有的本地协作流程。

## 目标
- 让"经 SSH 远程启动的 MCP"把宿主端点（username + ip）传达给 AI 客户端，使其能正确构造 scp 命令。
- 让"本地启动的 MCP"完全不受到本功能影响，保持原有行为零改变。

## 功能需求
- F1: MCP 启动时区分两种场景——"远程 SSH 启动"（存在 `SSH_CONNECTION` 环境变量）与"本地启动"（不存在该变量）。区分标志为该环境变量是否存在。
- F2: 远程 SSH 启动场景下，解析出宿主端点：username 取本机登录用户名，ip 取 `SSH_CONNECTION` 第 3 字段（宿主 IP），拼成 `<username>@<ip>`。
- F3: 远程 SSH 启动场景下，通过 MCP 协议的 `instructions` 字段，在握手时把端点信息（username + ip + 一句"MCP 在 Windows、AI 客户端在 Linux"的场景说明）注入给 AI 客户端。
- F4: 提供一个无参查询工具（host_info），返回与 F3 相同的端点信息，作为 `instructions` 未被客户端采纳时的兜底通道。
- F5: 本地启动场景下，不注入端点相关的 instructions 内容；host_info 工具返回"本地启动"状态，不提供端点。

## 非功能需求
- N1: 进程内端点解析只做一次并缓存（`SSH_CONNECTION` 等环境变量在进程生命周期内不变，重复解析无意义）。
- N2: 端点解析失败（如 `SSH_CONNECTION` 存在但格式异常）时不得导致 MCP 启动失败，降级为"端点不可用"。
- N3: 不暴露任何凭据（password / privateKey）。端点信息只含 username + ip。
- N4: 本地启动场景的行为（工具注册、会话管理、日志输出）与改动前逐字一致。

## 不做的事
- 不修改 `config.yaml` / 设备板端点逻辑（那是 MCP 的 SSH/串口工具连接板卡用的，与"AI 客户端 ↔ MCP 宿主"的 scp 无关）。
- 不在 instructions / host_info 中给出 scp 命令模板或文件传输方向指引（AI 客户端拿到端点自己就会 scp，这是多余的）。
- 不做交互式多 IP 选择（MCP 启动非交互；`SSH_CONNECTION` 只有一个宿主 IP，天然无歧义）。
- 不改动 sshd-config / remote-mcp-config 等 CLI 命令。
- 不做"本地启动也提示端点"的反向需求。

## 验收标准
- AC1（对应 F1/F5）：Windows 本地启动 MCP，启动日志、工具列表、各工具行为与改动前完全一致；调用 host_info 返回"本地启动"状态而非端点。
- AC2（对应 F2）：经 SSH 远程启动 MCP，日志中解析出的端点 `<username>@<ip>` 与 `SSH_CONNECTION` / `USER` 一致。
- AC3（对应 F3）：经 SSH 远程启动 MCP，AI 客户端通过协议握手（initialize）能读到 instructions 中的端点信息。
- AC4（对应 F4）：经 SSH 远程启动 MCP，调用 host_info 工具返回的端点与 AC2/AC3 的端点一致。
- AC5（对应 N2）：`SSH_CONNECTION` 格式异常时，MCP 正常启动，端点解析降级为"不可用"，不崩溃。

---

## 迭代 2（真机验收发现，2026-07-30）

### 背景：迭代 1 真机验收暴露的认知偏差

迭代 1 实现后真机测试（日志 `.embedded/log/2026-07-30_233433.log`）发现：AI 客户端（claude）确实主动调用了 `host_info`（23:37:00），成功拿到端点 `20380@192.168.10.109`。但拿到端点后，claude 的行为偏离预期：

- 23:37:44 调用 `power_shell_open`（**在 Windows 上**开 PowerShell 会话）
- 23:37:50 在该 PowerShell 里执行 `scp "E:\...\adb_1.log" sumu@192.168.10.109:/home/sumu/...`

两个根本性错误：
1. **用错了 shell**：claude 误以为"自己在 Windows"，于是用 MCP 的 `power_shell`（Windows 本机 shell）跑 scp。实际 claude 跑在 Linux，跨机文件传输应该用它**自己的 Linux shell** 跑 scp，不该碰 power_shell。
2. **方向反了**：scp 的目标 `sumu@192.168.10.109` 恰是 Windows 自己——等于自己 scp 给自己。正确方向应是 claude 在 Linux 执行 `scp <winuser>@<win-ip>:"E:/path" ~/` 把 Windows 文件拉到 Linux。

根因：仅提供端点（user@ip）不足以让 claude 建立正确的执行框架。claude 被众多 MCP 工具（含 power_shell）包围，容易把"MCP 宿主"当成"自己"。此外，`instructions` 字段疑似未被该 zcode 采纳（否则 claude 应已知自己是 remote client、用 Linux shell），更依赖 `host_info` 的文本把话说透。

### 目标补充
- 端点信息之外，必须显式传达：claude 自己在 Linux、MCP 在 Windows、跨机传输用 claude 自己的 Linux shell 跑 scp、**不要用 power_shell 工具做跨机传输**。

### 新增功能需求
- F6: host_info 工具返回的文本（远程场景）必须包含"使用指引"——明确 claude 当前在 Linux、应用自己的 shell 执行 scp 把 Windows 文件拉到 Linux（给出正确方向的命令骨架），并提示 power_shell 仅用于 Windows 本机操作、不要用于跨机传输。
- F7: instructions 文本（远程场景）同步强化为同样的执行框架描述（claude 在 Linux、MCP 在 Windows remote、scp 方向、勿用 power_shell 跨机）。
- F8: host_info 与 instructions 的 scp 命令骨架必须指明免密私钥 `-i ~/.ssh/id_mcp_server`。该私钥由 sshd-config 命令在 Linux 端生成（路径 `~/.ssh/id_mcp_server`，与 remote-mcp-config 写入 MCP 桥接配置用的 `SSH_KEY_PATH` 同一把），是 Linux→Windows 免密登录的唯一凭据。claude 不带此 `-i` 会因无密码而 scp 失败。

### 验收标准补充
- AC6（对应 F6）：远程 SSH 启动场景，host_info 返回的文本明确指出 claude 在 Linux、应用自己的 shell 跑 scp、给出 `scp <winuser>@<win-ip>:... ~/` 方向骨架，且提示勿用 power_shell 跨机。
- AC7（对应 F7）：远程 SSH 启动场景，instructions 文本包含 claude 位置（Linux）、MCP 位置（Windows remote）、scp 正确方向、勿用 power_shell 跨机的描述。
- AC8（对应 F8）：远程 SSH 启动场景，host_info 与 instructions 的 scp 命令骨架均含 `-i ~/.ssh/id_mcp_server`。
