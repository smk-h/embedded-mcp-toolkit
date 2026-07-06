# src/ 内部分层重组 Plan

## 架构概览

重组后的 `src/` 采用六层顶层结构，按“越靠近入口越上层，越靠近硬件越下层”的原则组织：

```
src/
├── cli/           # 应用入口：命令行解析与命令分发
├── mcp/           # MCP 协议层：server 实例、tools 注册、会话元数据
├── services/      # 业务服务层：PSH 解锁、用户登录、KeyProvider
├── transports/    # 连接实现层：SSH / Serial / ADB / PowerShell Shell
├── shared/        # 共享基础设施：配置加载、日志、常量
└── utils/         # 纯工具函数：终端净化、时间戳等
```

每层只依赖下层或同层，禁止跨层反向依赖。例如 `mcp/tools/serial/shell.ts` 可以依赖 `transports/serial.ts` 和 `services/psh.ts`，但 `transports/` 不应依赖 `mcp/tools/`。

## 核心数据结构

本次重组以目录和模块职责为核心，不新增数据类型。以下列出受影响的关键类型及其新归属：

### `InteractiveShell`（保持不变）

- 当前位于 `src/transport/loop.ts`。
- 重组后仍位于 `src/transports/loop.ts`（作为 transport 通用交互接口）。
- 职责：抽象 `write / read / close`，供 CLI 交互式演示命令统一调用。

### `OutputBuffer`（保持不变）

- 当前位于 `src/transport/output-buffer.ts`。
- 重组后位于 `src/transports/output-buffer.ts`。
- 职责：为 SSH / Serial / PowerShell 等交互式会话维护输出缓冲区。

### `SessionMeta` 与 `SessionRegistry`（保持不变）

- 当前位于 `src/mcp/sessions/registry.ts`。
- 重组后仍位于 `src/mcp/sessions/registry.ts`。
- 职责：记录所有活跃会话的轻量元数据，支持 `session_id → 设备名` 与 `设备名 → sessions` 双向查询。

### `SSHShellConfig` / `SerialShellConfig`（保持不变）

- 当前分别位于 `src/transport/ssh.ts` 和 `src/transport/serial.ts`。
- 重组后分别位于 `src/transports/ssh.ts` 和 `src/transports/serial.ts`。
- 职责：定义对应连接类型的配置接口。

## 模块设计

### `src/cli/`

**职责**：承载所有命令行相关逻辑，是 Node 进程的入口层。

**包含文件**：
- `src/cli/index.ts`：原 `src/index.ts` 中的 Commander 命令注册与路由逻辑。
- `src/cli/commands/init.ts`：`init` / `uninstall` 命令（原 `src/cli/commands/init.ts`）。
- `src/cli/commands/demo/`：演示类子命令（如 `demo ssh interact`、`demo serial unlock`）相关逻辑。

**对外接口**：无，Node 通过 `bin/embedded-mcp-toolkit-cli.js` 加载 `./out/cli/index.js`。

**依赖**：依赖 `src/mcp/server.ts`（启动 MCP server）和 `src/transports/`（演示命令创建交互式 Shell）。

### `src/mcp/`

**职责**：MCP 协议层，负责创建 `McpServer` 实例、注册 tools、管理会话元数据、启动 stdio transport。

**包含文件**：
- `src/mcp/server.ts`：创建 `McpServer`，批量注册 tools，启动 server，注册进程退出清理钩子。
- `src/mcp/tool-registry.ts`：工具定义辅助函数 `mcpDefineTool`、`text`、`getErrorMessage` 等。
- `src/mcp/sessions/registry.ts`：`SessionRegistry` 单例与 `SessionMeta` 类型。
- `src/mcp/tools/`：按领域分组的 tools（adb/basic/serial/ssh/win），每个目录导出一个工具列表数组。

**对外接口**：
- `startMcpServer()`：启动 MCP server。
- `mcpBasicTools` / `mcpSshTools` / `mcpSerialTools` / `mcpWinTools` / `mcpAdbTools`：供 `server.ts` 注册。

**依赖**：依赖 `src/transports/`（创建具体连接）、`src/services/`（PSH/登录/KeyProvider）、`src/shared/`（配置、日志）。

### `src/services/`

**职责**：业务协议与状态机，介于 MCP tools 和底层 transport 之间，封装设备解锁、认证等通用业务逻辑。

**包含文件**：
- `src/services/psh.ts`：原 `src/transport/psh.ts`，定义 `PshState` 与 `PshStateMachine`，用于检测并解锁 PSH 锁定状态。
- `src/services/user-login.ts`：原 `src/transport/user-login.ts`，定义串口用户登录状态机。
- `src/services/key-provider.ts`：原 `src/utils/key-provider.ts`，负责动态口令/密钥的文件 IPC 与终端交互。

**对外接口**：
- `PshStateMachine`：检测输出流中的 PSH 状态并触发解锁。
- `UserLoginStateMachine`：处理串口登录流程。
- `KeyProvider`：按配置模式（file/terminal）获取密钥。

**依赖**：依赖 `src/shared/`（配置、日志）。不依赖 `src/mcp/` 和 `src/transports/`。

### `src/transports/`

**职责**：连接实现层，封装与设备或本地 Shell 的交互式会话。

**包含文件**：
- `src/transports/ssh.ts`：`SSHShell` 类与 `SSHShellConfig`。
- `src/transports/serial.ts`：`SerialShell` 类与 `SerialShellConfig`。
- `src/transports/adb.ts`：ADB 连接与 shell 实现。
- `src/transports/powershell.ts`：本地 PowerShell 交互式会话实现。
- `src/transports/output-buffer.ts`：通用输出缓冲区。
- `src/transports/loop.ts`：交互式终端循环（CLI 演示用）。

**对外接口**：各 Shell 类（`SSHShell`、`SerialShell` 等）及其配置类型。

**依赖**：依赖 `src/services/`（PSH 解锁、KeyProvider、用户登录状态机）和 `src/shared/`（日志、常量）。

### `src/shared/`

**职责**：跨模块共享的基础设施，不含业务状态。

**包含文件**：
- `src/shared/config.ts`：原 `src/infra/config.ts`，加载 `config.yaml`、解析设备配置。
- `src/shared/logger.ts`：原 `src/infra/logger.ts`，日志接口。
- `src/shared/file-logger.ts`：原 `src/infra/file-logger.ts`，文件日志实现。
- `src/shared/constants.ts`：原 `src/infra/constants.ts`，全局常量（如 `MAX_BUFFER_SIZE`）。

**对外接口**：
- `getSSHConfig()`、`getSerialConfig()`、`getAdbConfig()`、`resolveDeviceName()` 等。
- `logger` 对象。
- `FileLogger` 类。
- `MAX_BUFFER_SIZE`。

**依赖**：无上层依赖。

### `src/utils/`

**职责**：纯工具函数，不依赖项目业务类型。

**包含文件**：
- `src/utils/terminal-sanitizer.ts`：终端输出清理。
- `src/utils/timestamp.ts`：时间戳格式化。

**对外接口**：导出对应工具函数。

**依赖**：无上层依赖。

## 模块交互

CLI 启动 MCP server 的调用链：

```
bin/embedded-mcp-toolkit-cli.js
  └── import('../out/cli/index.js')
        └── src/cli/index.ts
              └── startMcpServer()
                    └── src/mcp/server.ts
                          └── 注册 tools（src/mcp/tools/*）
                                └── tool handler
                                      ├── src/transports/ssh.ts 等（创建/操作会话）
                                      ├── src/services/psh.ts 等（解锁/认证）
                                      └── src/shared/config.ts（读取配置）
```

演示命令的调用链：

```
src/cli/index.ts
  └── demo ssh interact
        └── src/transports/loop.ts
              └── SSHShell（src/transports/ssh.ts）
```

## 文件组织

重组前 `src/`：

```
src/
├── cli/commands/init.ts
├── index.ts
├── infra/
│   ├── config.ts
│   ├── constants.ts
│   ├── file-logger.ts
│   └── logger.ts
├── mcp/
│   ├── server.ts
│   ├── sessions/registry.ts
│   ├── tool-registry.ts
│   └── tools/
│       ├── adb/
│       ├── basic/
│       ├── serial/
│       ├── ssh/
│       └── win/
├── transport/
│   ├── adb.ts
│   ├── loop.ts
│   ├── output-buffer.ts
│   ├── powershell.ts
│   ├── psh.ts
│   ├── serial.ts
│   ├── ssh.ts
│   └── user-login.ts
└── utils/
    ├── key-provider.ts
    ├── terminal-sanitizer.ts
    └── timestamp.ts
```

重组后 `src/`：

```
src/
├── cli/
│   ├── index.ts              # 原 src/index.ts 中的 Commander 逻辑
│   └── commands/
│       └── init.ts           # 原 src/cli/commands/init.ts
├── mcp/
│   ├── server.ts
│   ├── sessions/registry.ts
│   ├── tool-registry.ts
│   └── tools/
│       ├── adb/
│       ├── basic/
│       ├── serial/
│       ├── ssh/
│       └── win/
├── services/
│   ├── key-provider.ts       # 原 src/utils/key-provider.ts
│   ├── psh.ts                # 原 src/transport/psh.ts
│   └── user-login.ts         # 原 src/transport/user-login.ts
├── transports/
│   ├── adb.ts                # 原 src/transport/adb.ts
│   ├── loop.ts               # 原 src/transport/loop.ts
│   ├── output-buffer.ts      # 原 src/transport/output-buffer.ts
│   ├── powershell.ts         # 原 src/transport/powershell.ts
│   ├── serial.ts             # 原 src/transport/serial.ts
│   └── ssh.ts                # 原 src/transport/ssh.ts
├── shared/
│   ├── config.ts             # 原 src/infra/config.ts
│   ├── constants.ts          # 原 src/infra/constants.ts
│   ├── file-logger.ts        # 原 src/infra/file-logger.ts
│   └── logger.ts             # 原 src/infra/logger.ts
└── utils/
    ├── terminal-sanitizer.ts # 原 src/utils/terminal-sanitizer.ts
    └── timestamp.ts          # 原 src/utils/timestamp.ts
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| `infra/` 改名 | `shared/` | `shared` 比 `infra` 更直观地表达“跨模块共享的基础设施”。 |
| `transport/` 改名 | `transports/` | 复数形式与 `services/`、`utils/` 等顶层目录命名风格一致。 |
| PSH/登录/KeyProvider 归属 | `services/` | 这些是“业务协议/状态机”，不是“建立连接”本身，与 transport 解耦后职责更清晰。 |
| CLI 入口下沉 | `src/cli/index.ts` | 避免 `src/index.ts` 同时承载 CLI 和 MCP server 启动，降低入口文件复杂度。 |
| 工具分组保留 | `src/mcp/tools/{adb,basic,serial,ssh,win}/` | 现有分组已被 `server.ts` 和消费者接受，保持不变可减少外部影响。 |
| 引用更新方式 | 批量 `sed`/正则 + 编译验证 | 文件移动后所有相对 import 路径都需要同步更新，通过 `npm run build` 兜底检查遗漏。 |
| 文件历史保留 | 使用 `git mv` | 保留 Git blame 和文件历史，便于后续追溯。 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

开发阶段编写代码时，必须遵循 `ts-lang-spec` 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能。

本次重构的额外约定：
- 目录名使用小写，单词间用连字符分隔（与现有风格一致）。
- 文件移动时保持原有文件名不变，仅调整目录。
- import 路径统一使用相对路径 `./xxx.js`，与现有 `src/` 代码保持一致。
- 不删除、不精简原有注释；仅在逻辑因移动而必须调整时更新注释。
