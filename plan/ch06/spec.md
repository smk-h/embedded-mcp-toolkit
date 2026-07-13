# 会话存储统一 Spec

## 背景

ch05 完成后，传输层的四个类（SSHShell / SerialShell / AdbShell / PowerShellShell）已统一继承 `BaseShell`，获得了 `open/write/read/drain/close` 的统一签名。但**工具层**（`src/mcp/tools/`）仍是重构前的状态：四个通道文件各自维护一套近乎相同的会话存储设施。

当前每个通道的工具文件都独立维护着：

- 一个以 `session_id` 为键、具象 Shell 类型为值的 `Map`
- 一个模块级的自增计数器（用于生成 session ID）
- 各自的"存入会话 + 注册到 registry"逻辑
- 各自的"删除会话 + 注销 registry"逻辑
- 各自的"遍历关闭所有会话 + 清空 + 注销"的退出清理函数

这五项设施在四个文件里重复了四遍，且靠人工保持对中心化注册表的调用约定一致。Serial 通道额外维护了"COM 口 → session_id"的防重映射，当前与通用存储样板混在同一份代码里。

## 目标

- **零功能回归（硬约束）**：重构后所有工具的对外行为不变——工具名、参数 schema、返回结构、session ID 格式、日志前缀均保持现状。AI 客户端和权限配置无需任何调整。
- **统一会话存储**：把四个文件里重复的"会话存储 + 计数器 + registry 协调 + 批量清理"收敛到一个泛型存储设施，以 `BaseShell` 为类型约束，吃下 ch05 的类型统一红利。
- **归位会话基础设施**：存储设施放在会话域（`src/mcp/sessions/`），与已有的中心化注册表成对共存，不落在工具层内部。
- **保留通道差异**：open 工具、通用工具 handler、通道特有工具（login/sftp/build/enter_uboot/device_list 等）仍留在各自通道文件，只复用存储设施查询会话。

## 功能需求

- **F1（存储设施存在）**：提供一个泛型会话存储设施，以 `session_id` 为键存储 `BaseShell` 子类实例，统一承担"生成 ID + 存入 + 注册到 registry"和"删除 + 注销"以及"批量关闭 + 清空 + 注销"三项职责。

- **F2（ID 格式不变）**：各通道实例化存储设施时传入各自前缀，生成的 session ID 格式为 `<前缀>_<自增>`，与现状逐字一致（`ssh_1` / `serial_3` / `adb_2` / `power_1`）。

- **F3（not-found 统一响应）**：存储设施提供"查询会话，不存在时返回统一的 not-found MCP 响应"的便捷能力，消除各 handler 里重复的"查不到就返回 Session xxx not found."样板。文案与现状逐字一致。

- **F4（各通道持有独立实例）**：四个通道各实例化一个自己的存储设施实例（互不共享计数器和 Map），各自导出一个 `disposeAll` 包装函数（`disposeAllSshSessions` / `disposeAllSerialSessions` / `disposeAllAdbShellSessions` / `disposeAllPowerShellSessions`），函数名与现状一致。

- **F5（open / login 改用存储设施）**：各通道的 open 和 login handler 中，原"生成 ID + sessions.set + registry.register"逻辑改为调用存储设施的创建能力；原"sessions.get"改为调用存储设施的查询能力。

- **F6（通用工具 handler 改用存储设施）**：各通道的 close / write / read / exec handler 中，原"sessions.get"改为调用存储设施的查询能力，handler 逻辑本身保留在各通道文件内（不合并、不提取工厂）。

- **F7（通道特有工具改用存储设施）**：SSH 的 build / sftp_upload / sftp_download、Serial 的 enter_uboot 等通过存储设施查询 shell；SSH 的 build.ts / sftp.ts 原本跨文件 `import { sessions }` 的访问改为通过 SSH 存储设施实例查询。

- **F8（Serial portToSession 保留为通道扩展）**：Serial 的"COM 口 → session_id"防重逻辑保留在 serial 目录内（不进通用存储基类），通过存储设施提供的查询能力配合本通道自己的查重逻辑实现。防重行为与文案不变。

- **F9（退出清理委托存储设施）**：各通道的 `disposeAll` 包装函数内部委托存储设施的批量清理能力，日志前缀（`ssh_dispose` / `serial_dispose` / `adb_dispose` / `power_dispose`）与现状逐字一致。

## 非功能需求

- **N1（零功能回归，硬约束）**：重构前后，对同一输入，所有工具的返回值、日志输出（含日志前缀，如 `[ssh_shell_close]`、`[serial_write]`）、session ID 格式、registry 状态必须逐字一致。

- **N2（不改对外工具契约）**：工具名（如 `ssh_shell_close`、`serial_write`、`power_shell_exec`）、参数 schema（`session_id` / `command` / `clear` / `delay`）、返回结构（`{ content: [{ type: "text", text }] }`）保持现状。AI 客户端和 `.claude/settings.local.json` 权限列表无需调整。

- **N3（不动传输层）**：`BaseShell` 及四个子类保持 ch05 后的状态，本章只动 `src/mcp/tools/` 和新增 `src/mcp/sessions/` 下的文件。

- **N4（不改基础构件）**：不改 `src/mcp/tool-registry.ts`（`mcpDefineTool` / `ToolEntry` 等）、不改 `src/mcp/server.ts`（工具注册循环和 cleanup 钩子）、不改 `src/mcp/sessions/registry.ts`（中心化元数据管理）。

- **N5（不改各通道 index.ts 的注册方式）**：各通道 `index.ts` 仍逐条 `mcpDefineTool` 注册工具，工具集与顺序与现状一致。

- **N6（无新依赖）**：不引入新依赖，仅使用项目已有设施。

- **N7（SSH sessions export 解耦）**：SSH 的 `sessions` 当前是 `export` 的（build.ts / sftp.ts 跨文件访问）。重构后这些特有工具改为通过存储设施实例查询，不再依赖模块级 export 的 Map。

## 不做的事

- 不合并通用工具 handler（close/write/read/exec 当前虽结构相同，但属于"巧合的一致"，保留各通道独立演化空间）。
- 不提取工具工厂、不做 handler 层去重。
- 不改传输层（`BaseShell` 及四个子类）。
- 不改 `tool-registry.ts`、`server.ts`、`registry.ts`。
- 不重构 `open` 工具（参数差异大，各自保留）。
- 不统一各通道的日志前缀格式（保持各自的 `[ssh_shell_close]` / `[serial_close]` / `[adb_shell_close]` / `[power_shell_close]` 现状）。
- 不抽 SSH/Serial 的 login 工具（PSH 状态机逻辑重，且与各自配置耦合，保留在各自文件）。
- 不引入 alerts / 持续监听（独立章节 ch08）。
- 不改工具名、参数 schema、返回结构。

## 验收标准

- **AC1（F1 存储设施）**：泛型会话存储设施存在，以 `BaseShell` 为类型约束，提供创建/查询/查询并返回 not-found/删除/批量清理能力。

- **AC2（F2 ID 格式）**：四个通道实例化存储设施时传入各自前缀，生成的 session ID 格式为 `<prefix>_<自增>`，与现状一致（如 `ssh_1`、`serial_3`）。

- **AC3（F3 not-found 文案）**：存储设施的 not-found 查询返回 `{ content: [text("Session xxx not found.")] }`，与现状逐字一致。

- **AC4（F4 独立实例 + disposeAll 导出）**：`disposeAllSshSessions` / `disposeAllSerialSessions` / `disposeAllAdbShellSessions` / `disposeAllPowerShellSessions` 四个函数仍以同名导出，`server.ts` 的 cleanup 钩子无需改动。

- **AC5（F5 open/login 注册）**：各通道 open 和 login 创建会话后，registry 中出现对应条目，session ID 格式正确。

- **AC6（F6 通用工具查询）**：close/write/read/exec 通过存储设施查询 shell，不存在的 session_id 返回 `Session xxx not found.`，文案逐字一致。

- **AC7（F7 特有工具查询）**：SSH 的 `ssh_shell_login` / `ssh_build` / `ssh_sftp_upload` / `ssh_sftp_download` 正常工作；Serial 的 `serial_shell_login` / `serial_enter_uboot` 正常工作；ADB 的 `adb_device_list` / `adb_exec` 正常工作。

- **AC8（F8 Serial 防重）**：对已打开的 COM 口再次 `serial_open`，返回 `Serial port xxx is already open as session serial_N.`，文案和行为与重构前一致。

- **AC9（F9 退出清理日志）**：进程退出时各通道的 dispose 日志前缀（`[ssh_dispose]` / `[serial_dispose]` / `[adb_dispose]` / `[power_dispose]`）保持现状。

- **AC10（N1 零回归-PowerShell）**：通过 MCP 工具执行 `power_shell_open → power_shell_write → power_shell_read → power_shell_exec → power_shell_close`，输出与重构前一致。

- **AC11（N1 零回归-ADB）**：通过 MCP 工具执行 `adb_shell_open → adb_shell_exec → adb_shell_close`，输出与重构前一致（若有连机设备）。

- **AC12（N1 零回归-SSH）**：通过 MCP 工具执行 `ssh_shell_open → ssh_shell_exec → ssh_shell_close`，输出与重构前一致（若有设备）。

- **AC13（N1 零回归-Serial）**：通过 MCP 工具执行 `serial_open → serial_exec → serial_close`，输出与重构前一致（若有设备）。

- **AC14（编译）**：`npm run build` 编译通过，无 TypeScript 错误。

- **AC15（N6 无新依赖）**：`git diff package.json` 无新增依赖条目。

- **AC16（N4 server 不改）**：`server.ts` 的工具注册循环和 cleanup 钩子代码无改动。
