# MCP 工具超时机制

## 一、问题

使用 `ssh_build` 执行耗时超过 60 秒的命令（如内核编译）时，报错：

```text
MCP error -32001: Request timed out
```

尽管 `ssh_build` 内部 `maxWait` 已设为 `600000` ms（10 分钟），仍然超时。

## 二、MCP 协议超时机制

### 1. 架构

```text
┌───────────────────────────────┐      ┌──────────────────────────────────┐
│  opencode (MCP Client)        │      │  embedded-mcp-toolkit (Server)   │
│                               │      │                                  │
│  @modelcontextprotocol/sdk    │ stdio│  McpServer                       │
│    └─ Client                  │◄────►│    ├─ ssh_build   (maxWait=600s) │
│       └─ Protocol             │      │    ├─ ssh_exec    (delay=1s)     │
│          └─ _requestWithSchema│      │    └─ serial_open (...)          │
│             timeout = 60s     │      │                                  │
└───────────────────────────────┘      └──────────────────────────────────┘
```

- **Client 端:** 发起请求、设置超时、接收响应
- **Server 端:** 接收请求、执行逻辑、返回结果
- 超时由 **Client 端** 控制，Server 端无法自行延长

### 2. 超时触发流程

```text
Client._requestWithSchema()
  │
  ├─ 构造 JSON-RPC 请求: { method: "tools/call", params: {...} }
  │
  ├─ transport.send() ─────────── stdio ──────────► Server 收到请求
  │
  ├─ setTimeout(60s)                              Server 开始执行...
  │                                                 编译中...
  │
  ├─ 60s 到期, 没有收到响应                       编译仍在进行中...
  │
  ├─ cancel()
  │   ├─ transport.send("notifications/cancelled")─►  Server 收到取消
  │   │                                               编译被终止
  │   └─ reject(SdkError("Request timed out"))
  │
  └─ opencode 封装 → MCP error -32001
```

### 3. 源码分析

超时在 `@modelcontextprotocol/sdk` 的 `Protocol` 类中实现。

#### 3.1 常量定义

```js
// dist/esm/shared/protocol.js
const DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4;  // 60,000 ms
```

#### 3.2 请求入口 `_requestWithSchema()`

```js
_requestWithSchema(request, resultSchema, options) {
    return new Promise((resolve, reject) => {
        // ... 消息 ID 分配、JSON-RPC 封装 ...

        const cancel = (reason) => {
            // 发送 notifications/cancelled 给 Server
            this._transport.send({
                method: "notifications/cancelled",
                params: { requestId: messageId, reason: String(reason) }
            });
            reject(reason);
        };

        // ★ 超时核心: 取 options.timeout, 否则用默认 60s
        const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
        const timeoutHandler = () => cancel(
            new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", { timeout })
        );
        this._setupTimeout(messageId, timeout,
            options?.maxTotalTimeout, timeoutHandler,
            options?.resetTimeoutOnProgress ?? false);

        // 发送请求
        this._transport.send(jsonrpcRequest);
    });
}
```

- 定时器管理

```js
_setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetOnProgress) {
    this._timeoutInfo.set(messageId, {
        timeoutId: setTimeout(onTimeout, timeout),  // 挂起定时器
        startTime: Date.now(),
        timeout,
        maxTotalTimeout,
        resetOnProgress,
        onTimeout
    });
}

_resetTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    const total = Date.now() - info.startTime;
    if (info.maxTotalTimeout && total >= info.maxTotalTimeout) {
        throw new SdkError(RequestTimeout, "Maximum total timeout exceeded");
    }
    clearTimeout(info.timeoutId);
    info.timeoutId = setTimeout(info.onTimeout, info.timeout);  // 重设
}
```

#### 3.3 超时选项接口

```typescript
type RequestOptions = {
    timeout?: number;              // 单次超时 (ms), 默认 60_000
    maxTotalTimeout?: number;      // 总超时上限 (ms), 不受进度刷新重置
    resetTimeoutOnProgress?: boolean; // 收到 progress 通知时刷新定时器
    signal?: AbortSignal;          // 外部取消信号
};
```

### 4. 两层超时对比

| 层级 | 来源 | 默认值 | 作用对象 |
|------|------|--------|---------|
| MCP 协议 | `@modelcontextprotocol/sdk` | **60s** | 单次 `tools/call` 往返 |
| Server 实现 | `ssh_build.maxWait` | 600s | build 完成等待上限 |

MCP 协议超时在 Client 端，Server 端 `maxWait` 只有在 Client 不主动掐断的情况下才有意义。`ssh_build` 的问题就是 60s 协议超时先于 600s Server 超时触发。

## 三、解决方案

### 1. 方案一：opencode 端配置

opencode 通过 `.opencode/opencode.json` 控制 MCP Client 行为，配置项由 `https://opencode.ai/config.json` JSON Schema 定义。

#### 1.1 全局超时

```json
{
  "experimental": {
    "mcp_timeout": 600000
  }
}
```

- **作用范围:** 所有 MCP Server 的全部请求  
- **字段来源:** JSON Schema `experimental.mcp_timeout`（v2 SDK）

#### 1.2 单 Server 超时

```json
{
  "mcp": {
    "embedded-board": {
      "type": "local",
      "command": ["node", "./bin/embedded-mcp-toolkit-cli.js"],
      "enabled": true,
      "timeout": 600000
    }
  }
}
```

- **作用范围:** 仅 `embedded-board` 这一个 MCP Server 的请求  
- **字段来源:** JSON Schema `McpLocalConfig.timeout`（v1 起即支持）  
- **Schema 描述:** *"Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."*

#### 1.3 配置作用域对比

```text
experimental.mcp_timeout ───────────────► 全局所有 MCP Server
    │
    └── mcp.server-a.timeout ───────────► 单个 Server
    └── mcp.server-b.timeout ───────────► 单个 Server
    └── ...                              （暂无工具级配置）
```

**本项目当前使用:** 方案 2（`embedded-board` 局部配置 600s），只影响这一个 Server。

### 2. 方案二：Progress Notification 机制

#### 2.1 基本原理

MCP 协议支持 Server 在执行过程中向 Client 发送进度通知，Client 可据此刷新超时定时器。

```text
Client:
  timeout = 60s
  resetTimeoutOnProgress = true       ← 关键开关
  maxTotalTimeout = 600s              ← 硬上限，不可刷新

Server:
  程序启动 ─────────────────────────────► setTimeout(60s)
  编译中...
  30s 后: send notifications/progress ──► _resetTimeout()
                                          检查 total < 600s
                                          清旧定时器, 重设 60s
  编译中...
  30s 后: send notifications/progress ──► _resetTimeout()  ...
  ...
  编译完成 ─────────────────────────────► resolve(result)
```

#### 2.2 server 实现示例

```typescript
// 在 ssh_build 等长时工具的 handler 中
async function executeBuild(sessionId, command, maxWait) {
    const taskId = generateProgressToken(sessionId);
    const deadline = Date.now() + maxWait;

    // 每 30 秒发送进度通知
    const progressTimer = setInterval(async () => {
        await server.sendNotification({
            method: "notifications/progress",
            params: {
                progressToken: taskId,
                progress: Date.now(),
                total: undefined  // 未知总进度
            }
        });
    }, 30_000);

    try {
        // 原有编译逻辑...
        return await pollForCompletion(sessionId, command, deadline);
    } finally {
        clearInterval(progressTimer);  // 完成后停止发送
        // 发送最终完成通知
        await server.sendNotification({
            method: "notifications/progress",
            params: { progressToken: taskId, progress: Date.now() }
        });
    }
}
```

#### 2.3 限制

该方案依赖 Client 端传入 `resetTimeoutOnProgress: true`：

```js
// 需要 opencode 内部这样调用:
client.callTool({ name: "ssh_build", arguments: {...} },
    resultSchema,
    { timeout: 60000, resetTimeoutOnProgress: true, maxTotalTimeout: 600000 }
);
```

**opencode 和 Claude Code 均未支持此方案：**

- **opencode:** 未暴露 `resetTimeoutOnProgress` 配置项
- **Claude Code:** 官方文档明确表示 *"progress notifications from the server do not extend it"*，超时是硬截止，不可刷新

### 3. 方案对比

| 方案 | 是否可用 | 粒度 | 改动量 |
|------|---------|------|--------|
| `mcp.<server>.timeout` | ✅ 当前生效 | 按 Server | 仅配置 |
| `experimental.mcp_timeout` | ✅ 可用 | 全局 | 仅配置 |
| Progress Notification | ❌ 需 opencode 支持 | 按请求 | 需改 Server + opencode |
| 工具级超时配置 | ❌ 不存在 | — | — |

### 5. 相关文件

| 文件 | 说明 |
|------|------|
| `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js` | `DEFAULT_REQUEST_TIMEOUT_MSEC` 及超时逻辑 |
| `.opencode/opencode.json` | 项目 MCP 超时配置 |
| `https://opencode.ai/config.json` | opencode JSON Schema，含字段描述 |
| `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` | v1 SDK 类型（无 `mcp_timeout`） |
| `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` | v2 SDK 类型（有 `experimental.mcp_timeout`） |

## 四、Claude Code

Claude Code 也是 MCP Client，其对超时的处理方式与 opencode 有显著不同。本章节基于 [官方文档](https://code.claude.com/docs/en/mcp) 详细说明 Claude Code 的 MCP 超时机制。

### 1. 三层超时控制

Claude Code 提供了**三层超时控制**，从粗到细覆盖不同场景：

#### 1.1 `MCP_TIMEOUT` — Server 启动超时

> *"Configure MCP server startup timeout using the MCP_TIMEOUT environment variable (for example, `MCP_TIMEOUT=10000 claude` sets a 10-second timeout)"*

配置 MCP server 启动超时时间（例如 `MCP_TIMEOUT=10000 claude` 设置 10 秒超时），用于控制单个 MCP Server 的启动/连接阶段。

- **单位:** 毫秒
- **作用范围:** 单个 MCP Server 启动/连接阶段
- **用法:** `MCP_TIMEOUT=10000 claude`

#### 1.2 `MCP_TOOL_TIMEOUT` — 全局工具调用超时

`MCP_TOOL_TIMEOUT` 环境变量控制所有 MCP Server 的**全局工具调用超时**。文档中未给出此变量单独的引文描述，但多处提及它的回退行为：

> *"Values below 1000 are ignored and fall through to `MCP_TOOL_TIMEOUT`, or to its default of about 28 hours when that variable is unset."*

低于 1000 的值会被忽略，回退到 `MCP_TOOL_TIMEOUT`；如果该变量未设置，则使用默认值约 28 小时。

- **单位:** 毫秒
- **作用范围:** 所有 MCP Server 的所有工具调用
- **默认值:** 约 **28 小时**（远大于 opencode 的 60 秒）
- **用法:** `MCP_TOOL_TIMEOUT=300000 claude`

#### 1.3 `.mcp.json` 中 `"timeout"` — 按 Server 工具调用超时（本项目使用）

> *"Set a per-server tool execution timeout by adding a `timeout` field in milliseconds to that server's `.mcp.json` entry, for example `"timeout": 600000` for ten minutes. This overrides the `MCP_TOOL_TIMEOUT` environment variable for that server only."*

通过在对应 server 的 `.mcp.json` 条目中添加 `timeout` 字段（单位毫秒），为每个 server 单独设置工具执行超时。例如 `"timeout": 600000` 表示十分钟。这会覆盖该 server 的 `MCP_TOOL_TIMEOUT` 环境变量。

> *"The per-server `timeout` is a hard wall-clock limit per tool call, and progress notifications from the server do not extend it. Values below 1000 are ignored and fall through to `MCP_TOOL_TIMEOUT`, or to its default of about 28 hours when that variable is unset."*

按 server 设置的 `timeout` 是每次工具调用的硬性墙钟截止时间（*hard wall-clock limit*），来自 server 的进度通知（progress notifications）**不会延长**它。低于 1000 的值会被忽略，回退到 `MCP_TOOL_TIMEOUT`；若该变量未设置，则回退到默认约 28 小时。

- **单位:** 毫秒
- **作用范围:** 仅当前 Server 的工具调用
- **默认值:** 无（未设置时回退到 `MCP_TOOL_TIMEOUT`，约 28h）

#### 1.4 优先级图示

```text
MCP_TIMEOUT（启动超时）
    │
    └── MCP_TOOL_TIMEOUT（全局工具超时，默认 ~28h）
            │
            └── .mcp.json 中 "timeout"（按 Server 工具超时） ← 最高优先
                 覆盖 MCP_TOOL_TIMEOUT，仅影响当前 Server
```

### 2. 本项目配置

```json
{
  "mcpServers": {
    "embedded-board": {
      "command": "node",
      "args": ["./bin/embedded-mcp-toolkit-cli.js"],
      "env": {
        "DEVICE": "board-b",
        "BOARD_CONFIG_PATH": "./.embedded/configs/config.yaml",
        "LOG_SAVE": "1",
        "LOG_DIR": "./.embedded/log",
        "SAVE2FILE_PATH": "none"
      },
      "timeout": 600000
    }
  }
}
```

- `"timeout": 600000` = 600,000 毫秒 = **10 分钟**
- 低于 1000 的值（如 `600`）会被**忽略**，回退到 `MCP_TOOL_TIMEOUT`（默认 ~28h），文档明确声明 *"Values below 1000 are ignored"*
- 此超时是硬截止（*hard wall-clock limit*），无法通过 Server 端的 progress notification 刷新
- **注意:** 不配置 `timeout` 字段时，默认约 28 小时，实际几乎不会触发超时。**配置 10 分钟反而比默认更严格**，如果 `ssh_build` 等编译耗时可能超过 10 分钟，应考虑增大此值或直接去掉该配置（用默认 28h）

## 五、对比总结

|                       | opencode                          | Claude Code                                                  |
| --------------------- | --------------------------------- | ------------------------------------------------------------ |
| 默认超时              | 60s                               | ~28 小时                                                     |
| 按 Server 设超时      | ✅ `mcp.<name>.timeout`            | ✅ `"timeout"` in `.mcp.json`                                 |
| 全局超时环境变量      | ❌                                 | ✅ `MCP_TOOL_TIMEOUT`                                         |
| Progress Notification | ❌ 未实现                          | ❌ 明确不支持                                                 |
| 配置文档来源          | `https://opencode.ai/config.json` | [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp) |

Claude Code 默认 28 小时超时，大多数场景下根本不会触发超时，是最务实的方案。
