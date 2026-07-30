# 远程 MCP 启动时的端点提示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/shared/host-endpoint.ts` | 端点解析(纯函数 + 模块级缓存) |
| 新建 | `src/mcp/tools/basic/host-info.ts` | host_info 工具(config + handler) |
| 修改 | `src/mcp/tools/basic/index.ts` | 注册 host_info 到 mcpBasicTools |
| 修改 | `src/mcp/server.ts` | 注入 instructions + 启动日志复用解析结果 |

## 编码基线(实测,修改已有文件须逐字保持)

| 文件 | BOM | 换行 |
|------|:---:|:---:|
| `src/mcp/server.ts` | **有 BOM** (EF BB BF) | CRLF |
| `src/mcp/tools/basic/index.ts` | 无 BOM | CRLF |
| 新建文件(host-endpoint.ts / host-info.ts) | 以 ts-lang-spec 为准,默认 UTF-8 无 BOM + LF | LF |

> 硬规则:修改 `server.ts` / `index.ts` 时,Edit 工具按原文件原样写回;`server.ts` 的 BOM 与 CRLF 不得丢失或转换。新建文件遵循 ts-lang-spec(开发阶段加载该技能后以其规定为准,默认无 BOM + LF)。

## T1: 端点解析模块

**文件:** `src/mcp/shared/host-endpoint.ts`
**依赖:** 无
**步骤:**
1. 按 ts-lang-spec 风格写文件头注释(模块职责说明)。
2. `import { userInfo } from "os";`
3. 定义 `HostEndpoint` 接口(plan.md 「核心数据结构」定义的 5 个字段:`scenario` / `username` / `hostIp` / `endpoint` / `source`)。
4. 定义模块级缓存变量 `let cached: HostEndpoint | null = null;`。
5. 实现 `resolveHostEndpoint(): HostEndpoint`:
   - 若 `cached` 非空,直接返回。
   - 读 `const sshConn = process.env.SSH_CONNECTION;`
   - scenario 判定:`sshConn` 存在且非空、非字面量 `"(unset)"` → `"remote-ssh"`,否则 `"local"`。
   - username:`userInfo().username`,剥离 `\` 前缀(若含 `\` 取其后的部分);取不到(空串)→ null。
   - hostIp:`scenario === "remote-ssh"` 时,将 `sshConn` 按空白(正则 `/\s+/`)拆分,取索引 2(第 3 字段);字段不足 3 个 → null。可选:简单校验点分十进制(4 段、每段 0-255),不通过 → null。
   - endpoint:`username` 与 `hostIp` 均非 null → `${username}@${hostIp}`,否则 null。
   - source:local → `"local"`;remote-ssh 且 endpoint 非空 → `"ssh_connection"`;remote-ssh 且 endpoint 为 null → `"unavailable"`。
   - 组装 HostEndpoint,赋给 `cached` 并返回。
6. 导出 `HostEndpoint` 类型与 `resolveHostEndpoint` 函数。

**验证:** `npm run build` 编译通过(此时尚无调用方,仅类型检查)。手动核验逻辑(可临时在 node REPL 调用):本地(无 SSH_CONNECTION)返回 scenario:"local"、endpoint:null。

## T2: host_info 工具

**文件:** `src/mcp/tools/basic/host-info.ts`
**依赖:** T1(host-endpoint)
**步骤:**
1. `import { fromJsonSchema } from "@modelcontextprotocol/server";`
2. `import { text } from "../../tool-registry.js";`
3. `import { logger } from "../../../shared/logger.js";`
4. `import { resolveHostEndpoint } from "../../shared/host-endpoint.js";`
5. 定义 `hostInfoConfig`:`description` 说明用途(查询 MCP 宿主端点,用于 AI 客户端构造跨机文件传输命令);`inputSchema: fromJsonSchema<Record<string, never>>({ type:"object", properties:{} })`(仿 version.ts:18-24)。
6. 定义 `hostInfoHandler()`:
   - `logger.info("[host_info]");`
   - `const ep = resolveHostEndpoint();`
   - 按 ep 的状态构造多行文本(对齐缩进,仿 version.ts:30-36 的 `Label: value` 风格):
     - `remote-ssh` 且 endpoint 非空:
       ```
       Host:       remote-ssh started
       Endpoint:   <endpoint>
       Username:   <username>
       Host IP:    <hostIp>
       Source:     ssh_connection
       ```
     - `local`:
       ```
       Host:       local started
       Endpoint:   (local, no scp needed)
       Source:     local
       ```
     - `remote-ssh` 但 endpoint 为 null(unavailable):
       ```
       Host:       remote-ssh started
       Endpoint:   (unavailable)
       Source:     unavailable
       ```
   - `return { content: [text(lines.join("\n"))] };`
7. 导出 `hostInfoConfig` 与 `hostInfoHandler`。

**验证:** `npm run build` 编译通过。文本格式与 version_tool 输出风格一致(对齐的 Label)。

## T3: 注册 host_info

**文件:** `src/mcp/tools/basic/index.ts`(保持原编码:无 BOM + CRLF)
**依赖:** T2
**步骤:**
1. 在 import 区追加 `import { hostInfoConfig, hostInfoHandler } from "./host-info.js";`
2. 在 `mcpBasicTools` 数组末尾追加:`mcpDefineTool("host_info", hostInfoConfig, hostInfoHandler),`

**验证:** `npm run build` 编译通过。改动仅追加 import 与一行注册,不动既有条目。

## T4: server.ts 接入 instructions + 日志复用

**文件:** `src/mcp/server.ts`(保持原编码:**有 BOM** + CRLF)
**依赖:** T1、T2(实际依赖 T1 的 resolveHostEndpoint;host_info 已在 T3 注册,本任务无需直接引用)
**步骤:**
1. 顶部 import 区追加 `import { resolveHostEndpoint } from "./shared/host-endpoint.js";`
2. 在 `new McpServer(...)` 构造**之前**,插入端点解析与 instructions 构造:
   ```ts
   const hostEndpoint = resolveHostEndpoint();
   // 远程 SSH 启动时,把宿主端点(username@ip)通过 instructions 告知对端 AI 客户端,
   // 供其构造跨机文件传输(scp)命令。本地启动不注入端点,保持原有行为不变。
   const instructions =
     hostEndpoint.scenario === "remote-ssh" && hostEndpoint.endpoint
       ? `This MCP server runs on Windows and is invoked over SSH from a remote AI client. MCP host endpoint: ${hostEndpoint.endpoint}. Use this endpoint (username@host) when you need to transfer files between your local machine and the MCP host (Windows).`
       : undefined;
   ```
3. 修改 `new McpServer` 构造,把 instructions 加入第二参数:
   ```ts
   export const server = new McpServer(
     { name: pkg.name, version: pkg.version },
     { capabilities: { logging: {} }, instructions }
   );
   ```
4. 在 `startMcpServer()` 中,现有 sshEnv 日志块(server.ts:170-177)改用 `resolveHostEndpoint()` 的结果打印端点;保留 USER/SSH_CONNECTION/SSH_CLIENT/SSH_TTY 原始值用于诊断。形如追加一行:
   ```ts
   logger.info(`MCP server endpoint: ${JSON.stringify(hostEndpoint)}`);
   ```
   (复用 `hostEndpoint` 变量——注意它是模块级,`startMcpServer` 内可直接引用;或重新调用 `resolveHostEndpoint()` 命中缓存,二者等价。)
5. 不改动 server.ts 其他逻辑(工具注册循环、清理钩子、错误处理全部原样保留)。

**验证:**
- `npm run build` 编译通过。
- 核对 server.ts 的 BOM 仍在(改后再 `head -c 3 server.ts | od -An -tx1` 应仍为 `efbbbf`)、换行仍为 CRLF。
- 本地启动(`node` 直接跑或 claude 本地连接):instructions 为 undefined,行为与改动前一致。

## 执行顺序

```
T1 (端点解析) → T2 (host_info 工具) → T3 (注册) → T4 (server 接入)
```

线性依赖:T2 依赖 T1 的导出;T3 依赖 T2 的导出;T4 依赖 T1 的导出(host_info 经 T3 已注册,无需 T4 直接引用)。每步后跑 `npm run build` 验证编译。

---

## 迭代 2 任务（对应 spec F6/F7/F8，措辞强化）

### T5: host_info 远程场景文本追加"使用指引"

**文件:** `src/mcp/tools/basic/host-info.ts`(保持原编码:无 BOM + LF)
**依赖:** 无(基于已实现的 formatHostEndpoint)
**步骤:**
1. 修改 `formatHostEndpoint` 中"远程 SSH 启动且端点解析成功"分支:在原有 5 行字段后,追加空行 + "Usage:" 使用指引块。指引块内容见 plan.md 迭代 2「host_info 返回文本」,要点:
   - 明确 claude(AI client)在 Linux、MCP 在 Windows
   - 跨机传输用 claude 自己的 shell 跑 scp,给出 pull/push 两个方向骨架(端点填实、路径占位)
   - **骨架必须含免密私钥 `-i ~/.ssh/id_mcp_server`**(F8,sshd-config 在 Linux 端生成的那把,不带则 scp 失败)
   - 明示勿用 power_shell_* 跨机(那会在 Windows 本机跑、scp 给自己)
2. local 分支、unavailable 分支**不变**(保持迭代 1 文本)。
3. 因文本含模板插值(endpoint/username/hostIp),用模板字符串构造。

**验证:** `npm run build` 编译通过。远程场景(host_info)输出含 "Usage:"、scp pull/push 骨架、"Do NOT use power_shell"。local 场景输出不含 Usage(不变)。

### T6: server.ts instructions 措辞强化

**文件:** `src/mcp/server.ts`(保持原编码:**有 BOM** + CRLF)
**依赖:** 无(基于 T4 已实现的 instructions 三元)
**步骤:**
1. 定位 server.ts 中 instructions 三元表达式的远程分支字符串(server.ts 改动 2 插入的 instructions 构造块)。
2. 将该字符串从迭代 1 的单句端点,替换为 plan.md 迭代 2「instructions 文本」的完整执行框架(claude 在 Linux、MCP 在 Windows、scp 正确方向含 `-i ~/.ssh/id_mcp_server`、勿用 power_shell 跨机),端点用 `${hostEndpoint.endpoint}` 插值。
3. local 分支(`: undefined`)不变。
4. 其余逻辑不动。

**验证:**
- `npm run build` 编译通过。
- server.ts BOM 仍在、CRLF 仍在(Node 精确检测:CRLF 行数 == 总行数、纯LF 0、双CR 0)。
- 本地启动 instructions 为 undefined(不变);远程启动 instructions 含完整执行框架。

### 执行顺序(迭代 2)

```
T5 (host_info 文本) → T6 (instructions 文本)
```

两者独立,可任意顺序;都基于迭代 1 已实现代码,改动仅字符串内容。每步后 `npm run build` + Node 字节核验编码。
