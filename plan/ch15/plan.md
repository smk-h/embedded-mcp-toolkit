# 远程 MCP 配置命令 Plan

## 架构概览

新增 CLI 命令 `remote-mcp-config`，与 `sshd-config`（ch14 之前）形成对偶：前者在 Windows 上配 Linux 的 MCP 桥接，后者在 Windows 上配 Windows 的 sshd 免密登录。两者共享同一套 SSH + 交互基础设施，但业务逻辑独立。

三个层次：

1. **共享基础设施层（`src/cli/shared/`）**——从 `sshd-config.ts` 抽取的、与新命令共用的 SSH 传输与终端交互能力。本层不依赖任何业务概念，是纯粹的传输 + IO 辅助库。
2. **新命令业务层（`src/cli/commands/remote-mcp-config.ts`）**——登录远程 Linux，在三类落点上配置 / 删除 / 诊断 SSH 桥接形式的 MCP server。本层是本章核心。
3. **命令注册（`src/cli/index.ts`）**——把新命令挂到 commander 顶层。

`sshd-config.ts` 同步改为从共享层 import 基础设施，删除自身的重复实现（机械替换，函数实现不变），消除重复代码。

### 业务流程总览

```
启动命令
  │
  ▼
交互收集 user@host[:port] + 密码（F1）
  │
  ▼  sshConnect
SSH 连接 ──失败──→ 报错中止
  │ 成功
  ▼
┌─── 主菜单循环（F2）─────────────────────┐
│ [1] 配置   [2] 查看状态   [3] 删除   [0] 退出 │
└────────────────────────────────────────┘
   │ 选 [1]/[2]/[3] 都先走：
   ▼
askTarget(): 选 client(claude/zcode) + scope/项目路径（F3）
  → 得到 Target（含 1~2 个 TargetFile 落点描述）
   │
   ▼
buildBridgeServer(): 基于 collectConnectionInfo 构造桥接 server 对象（F8）
   │
   ▼
readStatus(): SFTP 读目标文件 → 本地 JSON 解析 → 三态比对（F4/F6/F7）
   │
   ▼  展示状态 → confirm
配置: 备份 → setAtPath + 使能数组 → 写回（F5）
删除: 备份 → removeAtPath + 使能数组 → 写回（F6）
```

## 核心数据结构

### LinuxServerInfo（移入 shared/ssh.ts）

远程 Linux 连接信息，仅内存，不落盘。

```typescript
interface LinuxServerInfo {
  host: string;
  port: number;       // 默认 22
  username: string;
  password: string;   // 仅内存，不落盘
}
```

### ConnectionInfo / IpEntry（移入 shared/cli-helpers.ts）

本机连接信息采集结果，供拼接 SSH 桥接 server 用。

```typescript
interface IpEntry {
  ip: string;
  iface: string;
}

interface ConnectionInfo {
  sshUser: string;    // 已剥离 DOMAIN\ 前缀
  ipList: IpEntry[];  // 已过滤回环/链路本地/虚拟网卡
}
```

### McpClient / ClaudeScope / MenuChoice（remote-mcp-config.ts）

```typescript
type McpClient = "claude" | "zcode";
type ClaudeScope = "global" | "project";

// 主菜单选项值
type MenuChoice =
  | typeof MENU_CONFIGURE   // "1"
  | typeof MENU_CHECK       // "2"
  | typeof MENU_REMOVE      // "3"
  | typeof MENU_EXIT;       // "0"
```

### TargetFile —— 落点描述符（配置驱动，核心抽象）

一个 `TargetFile` 完整描述"在远端哪个文件、哪个 JSON 路径下、如何读写 embedded-board"。三类落点的所有差异都收敛为该结构的不同字段取值，读写逻辑对三类落点完全通用。

```typescript
interface TargetFile {
  remotePath: string;        // 远端绝对路径
  label: string;             // 用户可见的落点描述（如 "Claude 全局"）
  serverPath: string[];      // server 容器的 JSON 路径
                             //   claude: ["mcpServers"]
                             //   zcode:  ["mcp", "servers"]
  withTypeEnabled: boolean;  // zcode 的 server 对象需带 type:"stdio" / enabled:true
  enableArrayPath?: string[];// 使能数组的 JSON 路径（仅 claude 项目: ["enabledMcpjsonServers"]）
  enableValue?: string;      // 使能数组中追加/移除的值（"embedded-board"）
}

interface Target {
  client: McpClient;
  files: TargetFile[];       // claude 项目 = 2 个(.mcp.json + settings.local.json)；其余 = 1 个
}
```

三类落点的 `TargetFile` 配置：

| 落点 | remotePath | serverPath | withTypeEnabled | enableArrayPath |
|---|---|---|---|---|
| Claude 全局 | `~/.claude.json`（展开 ~） | `["mcpServers"]` | false | — |
| Claude 项目-定义 | `<proj>/.mcp.json` | `["mcpServers"]` | false | — |
| Claude 项目-使能 | `<proj>/.claude/settings.local.json` | —（无 server） | — | `["enabledMcpjsonServers"]` |
| ZCode 项目 | `<proj>/.zcode/config.json` | `["mcp","servers"]` | true | — |

> 注：Claude 项目的"使能"文件不含 server 定义，其 `serverPath` 留空，仅用 `enableArrayPath` 做数组增删。

### ServerStatus —— 状态判定三态（F8）

```typescript
type ServerStatus = "absent" | "consistent" | "inconsistent" | "error";

interface StatusResult {
  status: ServerStatus;
  detail: string;        // 给用户看的状态说明
  existing?: Record<string, unknown>; // 现有 server 对象（展示用）
}
```

### BridgeServer —— SSH 桥接 server 对象

```typescript
interface BridgeServer {
  command: string;        // "ssh"
  args: string[];         // ["-i","~/.ssh/id_mcp_server","<user>@<ip>","<batpath>"]
  type?: string;          // zcode: "stdio"
  enabled?: boolean;      // zcode: true
}
```

## 模块设计

### 模块 A：`src/cli/shared/ssh.ts`（新建，从 sshd-config 抽取）

**职责：** 纯 SSH 传输层——地址解析、连接、命令执行、文件上传/下载、断开。不依赖任何业务概念，不依赖 @clack。

**对外接口：**

```typescript
// 解析 user@host[:port]，非法返回 null
function parseServerAddress(input: string): { host: string; port: number; username: string } | null;

// 建立 SSH 连接（基于 ssh2 Client）
function sshConnect(info: LinuxServerInfo): Promise<Client>;

// 在连接上执行一条命令，返回 stdout
function sshExec(client: Client, command: string): Promise<string>;

// SFTP 下载远端文件到本地（原有）
function sshDownload(client: Client, remotePath: string, localPath: string): Promise<void>;

// SFTP 上传本地文件到远端（新增，与 sshDownload 对称）
function sshUpload(client: Client, localPath: string, remotePath: string): Promise<void>;

// 关闭连接
function sshDisconnect(client: Client): void;
```

**依赖：** ssh2、LinuxServerInfo 类型。`sshUpload` 基于 `sftp.fastPut` 实现，与现有 `sshDownload`（fastGet）对称。

**不纳入本模块：** Windows 命令执行（runPowerShell/runCmd/execToResult）、管理员检测、MSI 下载等 sshd 业务专用逻辑——留在 sshd-config.ts。

### 模块 B：`src/cli/shared/cli-helpers.ts`（新建，从 sshd-config 抽取）

**职责：** 终端交互辅助 + 本机 OS 信息采集。供 sshd-config 与 remote-mcp-config 共用，保证两者交互范式一致（N7）。

**对外接口：**

```typescript
// 同步问答（readline，问完即关）
function prompt(questionText: string): Promise<string>;

// 清屏（ANSI \x1Bc，非 TTY 跳过）
function clearScreen(): void;

// step 完毕暂停（Enter 回菜单 / q 退出）
function pauseForMenu(): Promise<boolean>;

// 安全密码输入（raw mode 不回显，非 TTY 回退可见）
function askPassword(questionText: string): Promise<string>;

// 采集本机连接信息（用户名 + 过滤后的 IPv4 列表）
function collectConnectionInfo(): ConnectionInfo;
```

**依赖：** readline、os、@clack/prompts（仅 askPassword 内部不直接用 clack，但 pauseForMenu 用 prompt；collectConnectionInfo 用 os）。

### 模块 C：`src/cli/commands/remote-mcp-config.ts`（新建，本章主体）

**职责：** 远程 MCP 桥接配置命令的全部业务——登录、菜单、落点路由、状态判定、配置/删除/诊断。

**对外接口：**

```typescript
export type RemoteMcpConfigOptions = Record<string, never>;
export async function runRemoteMcpConfig(opts: RemoteMcpConfigOptions): Promise<void>;
```

**内部函数分组：**

#### C1. SFTP 文件操作（远端整文件读写）

```typescript
// 读取远端文本文件；exists=false 表示不存在
function sftpReadText(client: Client, remotePath: string): Promise<{ exists: boolean; content?: string }>;

// 写入远端文本文件（自动递归创建父目录）
function sftpWriteText(client: Client, remotePath: string, content: string): Promise<void>;

// 递归创建远端目录（mkdir -p，SFTP mkdir 不递归）
function sftpEnsureDir(client: Client, dirPath: string): Promise<void>;

// 备份远端文件为 <path>.bak（已存在不覆盖）；返回是否产生了新备份
function sftpBackup(client: Client, remotePath: string): Promise<boolean>;
```

实现策略：优先用 ssh2 SFTPWrapper 的 `readFile`/`writeFile`（回调包 Promise）；若该 API 不可用，回退到 `fastGet`→本地 tmp 文件→解析→改写→`fastPut`。`sftpEnsureDir` 逐级 stat 检查 + mkdir。

#### C2. JSON 按 path 操作（本地内存，对下载内容）

```typescript
// 按 path 取嵌套对象（如 getAtPath(root, ["mcp","servers"])）
function getAtPath(obj: Record<string, unknown>, path: string[]): Record<string, unknown> | null;

// 在 path 指向的容器中设置 serverKey（保留同容器其它 key）
function setServerAtPath(obj: Record<string, unknown>, path: string[], key: string, server: object): void;

// 从 path 指向的容器中删除 serverKey；返回是否实际删除
function removeServerAtPath(obj: Record<string, unknown>, path: string[], key: string): boolean;

// 使能数组去重追加；返回是否新增
function ensureInArray(arr: unknown[], value: string): boolean;

// 使能数组移除；返回是否移除
function removeFromArray(arr: unknown[], value: string): boolean;
```

> 这些函数操作的是 SFTP 读下来、本地解析后的 JSON 对象，改完再序列化写回。绝不整文件覆盖原结构（N2）。

#### C3. 状态判定

```typescript
// 构造本次的 SSH 桥接 server 对象（复用 collectConnectionInfo）
function buildBridgeServer(withTypeEnabled: boolean): BridgeServer;

// 读取单个 TargetFile 的状态（三态）
function readStatus(client: Client, file: TargetFile, bridge: BridgeServer): Promise<StatusResult>;

// 比较现有 server 与桥接定义是否一致（仅比 command + args，F8）
function compareServer(existing: Record<string, unknown>, bridge: BridgeServer): "consistent" | "inconsistent";
```

`buildBridgeServer` 复用 `sshd-config [8]` 的拼接逻辑：`command:"ssh"`，`args:["-i","~/.ssh/id_mcp_server",`${sshUser}@${primaryIp}`, batPath]`（batPath = cwd/remote-start-mcp.bat 转正斜杠）。`primaryIp` 取 `collectConnectionInfo().ipList[0]`，多网卡时提示其它 IP。无可用 IP 时中止（N6）。zcode 版额外带 `type:"stdio"`、`enabled:true`。

#### C4. 业务流程

```typescript
async function mainMenu(): Promise<MenuChoice | null>;
async function askTarget(): Promise<Target | null>;          // F3 落点路由
async function doConfigure(client: Client, bridge: BridgeServer): Promise<void>;  // F5
async function doRemove(client: Client, bridge: BridgeServer): Promise<void>;     // F6
async function doCheckStatus(client: Client, bridge: BridgeServer): Promise<void>; // F7
function printBanner(): void;
```

- `askTarget`：select(client) → 若 claude 则 select(全局/项目)，项目则 text(路径)；若 zcode 直接 text(路径)。组装 `Target`（含展开 `~`、拼接项目路径为绝对路径）。
- `doConfigure`/`doRemove`/`doCheckStatus` 共享前半段：`askTarget` → 对每个 `TargetFile` 调 `readStatus` 展示 → confirm。
- 配置：对每个 file 先 `sftpBackup`，再读→本地 `setServerAtPath`（+ 使能数组 `ensureInArray`）→序列化（2 空格 + 尾换行，N4）→ `sftpWriteText`；写失败用 .bak 回滚（N3/N5）。回显路径与关键字段。
- 删除：同上但用 `removeServerAtPath`（+ `removeFromArray`）。目标文件/项不存在提示"无需删除"（F6）。
- 诊断：只读，不改文件。

#### C5. 主入口

```typescript
export async function runRemoteMcpConfig(opts: RemoteMcpConfigOptions): Promise<void>;
```

流程：`text`(地址)→解析→`askPassword`→`sshConnect`（失败报错中止，F1）→菜单循环（F2，clearScreen + banner + mainMenu + dispatch + pauseForMenu）。**不做**管理员权限检查（区别于 sshd-config，本命令是 SSH 客户端角色，无 Windows 管理操作，N6）。

### 模块 D：`src/cli/index.ts`（修改）

在 commander 顶层注册新命令，参照 sshd-config 的注册方式：

```typescript
program
  .command("remote-mcp-config")
  .description("登录远程 Linux 配置 claude/zcode 的 MCP 桥接（交互式菜单）")
  .action(() => { runRemoteMcpConfig({}); });
```

并在顶部 import 与文件头命令层级注释中补充新命令。

### 模块 E：`src/cli/commands/sshd-config.ts`（修改，机械重构）

删除被抽走的函数实现（prompt/clearScreen/pauseForMenu/askPassword/parseServerAddress/sshConnect/sshExec/sshDownload/sshDisconnect/collectConnectionInfo）与类型（LinuxServerInfo/ConnectionInfo/IpEntry），改为从 `shared/ssh.ts` 与 `shared/cli-helpers.ts` import。函数实现不变，仅迁移位置。

## 模块交互

### 启动与登录（F1）

```
runRemoteMcpConfig
  → text(地址) → parseServerAddress (shared/ssh) ─非法→ 报错重输
  → askPassword (shared/cli-helpers)
  → sshConnect (shared/ssh) ─失败→ 报错中止
  → 进入菜单循环
```

### 配置流程（F3/F4/F5/F8）数据流

```
doConfigure(client)
  → askTarget()                                   → Target{files: TargetFile[]}
  → buildBridgeServer(withTypeEnabled)             → BridgeServer  [collectConnectionInfo]
  ┌─ for each TargetFile:
  │   → readStatus(client, file, bridge)
  │       → sftpReadText(client, file.remotePath)   → {exists, content}
  │       → JSON.parse(content)
  │       → getAtPath(json, file.serverPath)[bridge.key] → 比对 → StatusResult
  │   → 展示状态
  ├─ confirm
  └─ for each TargetFile:
      → sftpBackup(client, file.remotePath)         → .bak
      → sftpReadText → JSON.parse
      → setServerAtPath(json, serverPath, "embedded-board", bridge)   [保留其它 server]
      → 若 enableArrayPath: ensureInArray(json[...], "embedded-board")
      → JSON.stringify(2空格)+尾换行
      → sftpWriteText(client, remotePath, content)  ─失败→ 用 .bak 回滚
  → 回显
```

删除流程同构，`setServerAtPath` 换 `removeServerAtPath`，`ensureInArray` 换 `removeFromArray`。

### 依赖关系（无环）

```
shared/ssh.ts          ← ssh2
shared/cli-helpers.ts  ← readline, os, (内部用 prompt)
        ↑                    ↑
        └──────┬─────────────┘
               │
   ┌───────────┴────────────┐
   │                        │
commands/remote-mcp-config  commands/sshd-config   ← shared
   │
cli/index.ts (注册)
```

## 文件组织

```
src/cli/
├── index.ts                          [修改] 注册 remote-mcp-config 命令
├── shared/
│   ├── ssh.ts                        [新建] SSH 传输层 + 地址解析 + LinuxServerInfo
│   └── cli-helpers.ts                [新建] 交互辅助 + 连接信息采集 + ConnectionInfo/IpEntry
└── commands/
    ├── remote-mcp-config.ts          [新建] 远程 MCP 配置命令主体（本章核心）
    └── sshd-config.ts                [修改] 改用 shared import，删重复实现
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 复用 sshd-config 的能力 | 抽取 `shared/` 共享模块，sshd-config 同步重构 | sshd-config 与新命令共享 ~200 行 SSH+交互基础设施。复制粘贴导致重复维护；从业务命令文件 import 基础设施语义不干净。抽取为独立 shared 层是正确结构，sshd-config 的改动是机械 import 替换（实现不变），回归可控 |
| 远端文件读写方式 | SFTP 整文件读写 + 本地 JSON 改写 | spec 明令"不通过 shell exec 改文件"（N8/不做的事）。SFTP 直接拿原文，本地 JSON.parse 改字段再写回，规避 shell 引号转义与编码问题，且天然支持"按字段更新保留其它内容"（N2） |
| 三落点的差异处理 | 配置驱动的 `TargetFile` 描述符 | 三落点的差异仅是路径/serverPath/是否带 type-enabled/是否有使能数组。用描述符收敛差异，读写逻辑对三落点通用，避免 switch-case 三套分支，新增落点只加描述符配置 |
| 一致性比较基准 | 仅比 command + args（F8） | command/args 决定实际连接行为（密钥/IP/bat 路径）；type/enabled 是开关不影响桥接定义。比 args 深度相等即可判断"是否需更新" |
| 命令命名 | `remote-mcp-config` | 直白表达"远程配置 MCP"，与 sshd-config（配 sshd）对称，避免与 `config`（打印设备配置）混淆 |
| 是否做管理员检查 | 不做 | 本命令是 SSH 客户端角色，无任何 Windows 管理操作（不动 sshd/服务/注册表）。sshd-config 需要 admin 是因它改 Windows 系统服务，本命令无需（N6） |
| bat 路径来源 | cwd/remote-start-mcp.bat | 与 sshd-config [8] 模板、init 命令生成的 remote-start-mcp.bat 一致；用户在项目根运行命令时 cwd 即项目根 |
| bridge server key | 固定 "embedded-board" | spec「不做的事」明确不可配置，与现有 .mcp.json / sshd-config 模板一致 |
| SFTP 读写 API 选型 | 优先 readFile/writeFile，回退 tmp+fastGet/fastPut | ssh2 的 SFTPWrapper 提供类 fs 的 readFile/writeFile；若运行时版本不支持，用临时文件 fastGet/fastPut 兜底。task 实现阶段先验证 ssh2 版本支持情况再定 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（ts-lang-spec 优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本任务修改 `sshd-config.ts` 与 `index.ts` 时，写回前先识别其原编码（本项目源码为 UTF-8/LF），按原样写回，绝不转换编码。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求（与现有 sshd-config.ts / init.ts 的风格保持一致：JSDoc `@brief`/`@details` 注释、中文注释、分节注释块）。开发执行者应在开始编码前调用 `ts-lang-spec` 技能，并严格遵守上述文件编码规则。
