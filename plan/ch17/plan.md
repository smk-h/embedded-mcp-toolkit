# 远程 MCP 启动时的端点提示 Plan

## 架构概览

新增一个「宿主端点解析」能力,产出两类出口,共用同一份解析结果:

1. **端点解析模块**(纯函数 + 模块级缓存):从 `os.userInfo()` 与 `SSH_CONNECTION` 解析出场景标志 + 端点,进程内只算一次。
2. **instructions 出口**:`new McpServer()` 构造时,依据解析结果决定注入内容。远程场景注入端点,本地场景不注入(或不注入端点相关内容)。
3. **host_info 工具出口**:无参查询工具,返回与 instructions 同源的端点信息,作为兜底。

```
                  ┌─────────────────────────────┐
   os.userInfo()  │  resolveHostEndpoint()       │  缓存
   SSH_CONNECTION ┼─→  scenario: local/remote    ├─(模块级单例)
                  │     username / ip / endpoint  │
                  └──────────┬────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        instructions     host_info      server.ts
        (握手注入)       (工具兜底)     启动日志复用
```

设计要点:三处出口共用一个解析函数,避免逻辑分叉;本地场景所有出口一致地「不提供端点」。

## 核心数据结构

### HostEndpoint（端点解析结果）

```ts
/**
 * @brief 宿主端点解析结果
 * @param scenario  启动场景："local"=本地启动（无 SSH_CONNECTION）；"remote-ssh"=经 ssh 远程启动
 * @param username  本机登录用户名（已剥离 DOMAIN\ 前缀）；解析不到为 null
 * @param hostIp    宿主 IPv4（SSH_CONNECTION 第 3 字段）；非 remote 场景或解析失败为 null
 * @param endpoint  拼好的 "user@ip"；username 与 hostIp 任一缺失为 null
 * @param source    端点来源说明（用于日志/host_info 展示）："ssh_connection" / "local" / "unavailable"
 */
interface HostEndpoint {
  scenario: "local" | "remote-ssh";
  username: string | null;
  hostIp: string | null;
  endpoint: string | null;
  source: "ssh_connection" | "local" | "unavailable";
}
```

### host_info 工具入参/出参

- 入参:无(`Record<string, never>`,同 version_tool)。
- 出参:多行文本(`label : value` 对齐风格,仿 version_tool / session_info)。

## 模块设计

### M1: 端点解析模块 `src/mcp/shared/host-endpoint.ts`

**职责:** 从本机 OS 信息与 SSH 环境变量解析宿主端点;进程内缓存。

**对外接口:**

```ts
/**
 * @brief 解析宿主端点（进程内缓存，首次调用后不再重复计算）
 * @returns HostEndpoint。本地启动返回 scenario:"local"、endpoint:null；
 *          SSH_CONNECTION 格式异常降级为 endpoint:null 但不抛错。
 */
export function resolveHostEndpoint(): HostEndpoint;
```

**依赖:** `os`(userInfo / 剥离 DOMAIN\ 前缀,复用 cli-helpers 同款逻辑)、`process.env.SSH_CONNECTION`。

**实现要点:**
- 模块级 `let cached: HostEndpoint | null = null`,首次计算后缓存,后续直接返回。
- scenario 判定:`process.env.SSH_CONNECTION` 存在(非空且非 `"(unset)"` 字面量)→ `remote-ssh`,否则 `local`。
- username:`os.userInfo().username`,剥离 `\` 前缀(兼容 `DOMAIN\user`);取不到为 null。
- hostIp:`SSH_CONNECTION` 按空白拆分,取第 3 字段(索引 2);字段不足或非 IP 形态(可选地用简单点分十进制校验)→ null。
- endpoint:`username` 与 `hostIp` 均非 null 时拼 `${username}@${hostIp}`,否则 null。
- source:local 场景 → `"local"`;remote 场景解析成功 → `"ssh_connection"`;remote 场景解析失败 → `"unavailable"`。

### M2: host_info 工具 `src/mcp/tools/basic/host-info.ts`

**职责:** 无参查询工具,返回端点信息(兜底通道)。

**对外接口:**
- `hostInfoConfig`:`{ description, inputSchema: fromJsonSchema<Record<string, never>>({type:"object", properties:{}}) }`。
- `hostInfoHandler(): Promise<{ content: [text(string)] }>`。

**依赖:** `resolveHostEndpoint`、`text`、`logger`。

**返回文本格式(对齐缩进,仿 version_tool):**

remote-ssh 场景:
```
Host:       remote-ssh started
Endpoint:   20380@192.168.10.109
Username:   20380
Host IP:    192.168.10.109
Source:     ssh_connection
```

local 场景:
```
Host:       local started
Endpoint:   (local, no scp needed)
Source:     local
```

`endpoint` 为 null 的 remote 场景(解析失败,对应 N2):
```
Host:       remote-ssh started
Endpoint:   (unavailable)
Source:     unavailable
```

### M3: server.ts 接入(instructions 注入 + 日志复用)

**职责:** 在 `new McpServer()` 构造时注入 instructions;启动日志复用解析结果。

**改动点:**
1. `import { resolveHostEndpoint } from "./shared/host-endpoint.js";`
2. `new McpServer()` 前,取 `const endpoint = resolveHostEndpoint();`。
3. 构造 `instructions` 文本:
   - `scenario === "remote-ssh"` 且 `endpoint` 非空:注入一句场景说明 + 端点(只给数据,不给 scp 模板)。
   - 否则:`instructions` 为 `undefined`(本地场景完全不注入端点相关内容,对应 F5/N4)。
4. `new McpServer({name,version}, { capabilities:{logging:{}}, instructions })`。
5. `startMcpServer()` 中现有的 sshEnv 日志块改用 `resolveHostEndpoint()` 的结果打印(避免与解析逻辑分叉);USER/SSH_CONNECTION/SSH_CLIENT/SSH_TTY 原始值仍可保留(诊断用),但 username/endpoint 用解析结果。

**instructions 文本(remote-ssh,极简,只给数据):**

```
This MCP server runs on Windows and is invoked over SSH from a remote AI client (Linux). MCP host endpoint: 20380@192.168.10.109. Use this endpoint (username@host) when you need to transfer files between your local machine (Linux) and the MCP host (Windows).
```

（中文版备选,见 task.md;instructions 实际措辞在 task 阶段定稿。）

### M4: basic/index.ts 注册 host_info

**职责:** 把 host_info 加入核心工具列表。

**改动:** import host-info.ts,在 `mcpBasicTools` 数组追加 `mcpDefineTool("host_info", hostInfoConfig, hostInfoHandler)`。

## 模块交互

```
模块加载阶段:
  server.ts 顶层 import host-endpoint.ts
  → new McpServer() 前: resolveHostEndpoint() [首次, 缓存]
  → 按 scenario 构造 instructions → 注入构造函数

启动阶段 (startMcpServer):
  server.ts → resolveHostEndpoint() [命中缓存] → 日志打印端点

运行阶段 (AI 调用 host_info 工具):
  host-info.ts → resolveHostEndpoint() [命中缓存] → 返回文本
```

三次调用共享同一缓存实例,无重复解析。

## 文件组织

```
src/mcp/
├── shared/
│   └── host-endpoint.ts      ← 新增:端点解析(纯函数 + 缓存)
├── tools/basic/
│   ├── host-info.ts          ← 新增:host_info 工具
│   └── index.ts              ← 修改:注册 host_info
└── server.ts                 ← 修改:注入 instructions + 日志复用
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 端点解析放哪 | `src/mcp/shared/host-endpoint.ts` | 与 exec-runner/prompt-detector 同级,是跨工具(server + host_info)共享的纯逻辑,不属于任一具体工具 |
| 缓存策略 | 模块级单例变量 | `SSH_CONNECTION`/`userInfo` 进程内不变,重复解析无意义;且 server.ts 启动时与 host_info 运行时各取一次,缓存避免重复计算 |
| instructions 是否动态 | 静态注入(构造时定值) | SDK 的 instructions 在 `new McpServer` 构造时传入;`process.env` 模块加载时已可用,无需动态计算 |
| 本地场景 instructions 处理 | 传 `undefined` | 本地场景完全不注入端点相关内容,保证原有行为零改变(F5/N4);McpServer 的 instructions 是 optional 字段 |
| host_info 文本风格 | `label : value` 对齐 | 复用 version_tool / session_info 已有风格,保持工具输出一致性 |
| 端点解析失败处理 | 降级 null,不抛错 | 对应 N2;SSH_CONNECTION 格式异常时 MCP 仍正常启动 |
| 是否复用 cli-helpers 的 collectConnectionInfo | 否 | 那是为交互式多 IP 选择设计的(返回 ipList),MCP 启动非交互且只需 SSH_CONNECTION 单一宿主 IP;逻辑简单,独立实现更清晰,避免引入 cli 层依赖到 mcp 层 |

---

## 迭代 2 措辞设计（对应 spec F6/F7）

真机验收发现 claude 拿到端点后仍误用 Windows power_shell 跑 scp、且方向反了。根因是端点之外缺少"执行框架"信息。本迭代在端点数据基础上，增加四要素：**claude 位置 / MCP 位置 / scp 正确方向 / 勿用 power_shell 跨机**。

### host_info 返回文本（远程场景，F6）

在原有端点字段后追加一段"使用指引"块（空行分隔），措辞定稿：

```
Host:       remote-ssh started
Endpoint:   20380@192.168.10.109
Username:   20380
Host IP:    192.168.10.109
Source:     ssh_connection

Usage: You (the AI client) are running on Linux; this MCP server runs on Windows (the endpoint above). To transfer files between your Linux machine and Windows, run scp in YOUR OWN shell (not via the power_shell tool, which only operates on the Windows host itself). Always pass the passwordless key -i ~/.ssh/id_mcp_server:
  - Linux <- Windows (pull):  scp -i ~/.ssh/id_mcp_server 20380@192.168.10.109:"E:/path/to/file" ~/local/path
  - Linux -> Windows (push):  scp -i ~/.ssh/id_mcp_server ~/local/file 20380@192.168.10.109:"E:/path/"
Do NOT use power_shell_* tools for cross-machine transfers — those run on Windows and would scp Windows to itself.
```

local 场景与 unavailable 场景文本不变（迭代 1 已定，不涉及使用指引）。

### instructions 文本（远程场景，F7）

由迭代 1 的单句端点，强化为完整执行框架：

```
This MCP server runs on Windows and is invoked over SSH from a remote AI client running on Linux. You (the AI client) are on Linux; the MCP host (Windows) endpoint is 20380@192.168.10.109. To transfer files between your Linux machine and the Windows MCP host, run scp in your own Linux shell (NOT via the power_shell_* tools, which execute on the Windows host and would only scp Windows to itself). Always pass the passwordless key -i ~/.ssh/id_mcp_server. To pull a file from Windows: scp -i ~/.ssh/id_mcp_server 20380@192.168.10.109:"E:/path" ~/local/. To push to Windows: scp -i ~/.ssh/id_mcp_server ~/local/file 20380@192.168.10.109:"E:/path/".
```

### 技术决策（迭代 2 追加）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 指引措辞放 host_info 文本还是单独工具 | 放 host_info 文本 | 避免新增工具;claude 查端点时顺带读到指引,单次调用即获得完整执行框架 |
| 指引语言 | 英文 | instructions 经 SDK 传递、host_info 文本面向 LLM;英文跨客户端兼容性最好(避免中文在某些 client 渲染/编码问题) |
| 是否给完整 scp 命令(含真实路径) | 给命令骨架(端点已填,路径占位) | 端点是 claude 不知道的唯一信息(填实),路径由 claude 按用户需求填;不臆造具体文件路径 |
| local 场景是否加指引 | 否 | local 场景无跨机传输需求;保持迭代 1 文本不变,符合 F5/N4 零影响 |
| scp 是否指明私钥 `-i ~/.ssh/id_mcp_server` | 是,骨架中显式写出 | 该私钥由 sshd-config 在 Linux 端生成(`~/.ssh/id_mcp_server`,与 remote-mcp-config 的 SSH_KEY_PATH 同一把),是 Linux→Windows 免密唯一凭据;claude 不带 -i 会 scp 失败 |

## 编码规范

**编程语言:** TypeScript

**适用的语言规范技能:** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本次涉及的已有文件 `server.ts` / `basic/index.ts`，修改前先识别其原编码（当前为 UTF-8 with BOM + CRLF），写回时按原编码原样写回，绝不转换。

开发阶段编写代码时，必须遵循 ts-lang-spec 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
