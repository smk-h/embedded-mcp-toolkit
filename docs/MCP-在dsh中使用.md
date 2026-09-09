<!-- more -->

## 一、 概述

（1）**配置与启动**：如何在 DeepSeek Harness（下称 DSH，`dsh` CLI）中接入 `embedded-mcp-toolkit` 这台 MCP 服务器，让 DSH 会话里的 AI Agent 能直接使用 `mcp__embedded-board__*` 系列工具操作嵌入式板卡。

（2）**同进程多会话共享分析**：为什么 DSH 的多个会话（对话）共享**同一个** MCP 服务器进程——包括工具调用编号跨会话连续、串口/SSH 会话跨会话存活的完整机制剖析。

> 分析基于本机安装的 `@deepseek-ai/dsh@0.1.1-rc.2`（npm 全局安装）与其捆绑依赖的源码，以及 `embedded-mcp-toolkit` 本仓库源码。不同版本行为可能有差异。

## 二、 背景：DSH 是什么，MCP 如何接入

DSH 是 DeepSeek 官方的 Agent Harness（`dsh` CLI），基于 **cordis 插件架构**。核心概念：

| 概念 | 说明 | 本机实例 |
|------|------|---------|
| host 进程 | `dsh web` 启动的常驻进程，承载 Web GUI 与所有会话 | 监听 `http://127.0.0.1:3080` |
| profile | 一组插件组合（bundle 层 + patch 层） | `%USERPROFILE%\.dsh\profiles\web` |
| 会话（session） | 用户在 GUI 里的一次对话，仅是 host 内的逻辑单元 | 存于 `%USERPROFILE%\.dsh\sessions\--<工作区路径>--\session-*.jsonl.zstd` |
| MCP 接入插件 | `@deepseek-ai/dsh-mcp-client`，每个插件实例 spawn 一个 stdio MCP 子进程 | 见下文 `cordis.patch.yml` |

关键点：**MCP 服务器是 host 启动时由插件 spawn 的一个子进程，其生命周期挂在 host 进程上，与"会话"无关**。这是后文"多会话共享"的根源。

## 三、 配置步骤（DSH 接入 embedded-mcp-toolkit）

### 1. 前置条件

- Windows 已安装 Node.js 与 npm；已全局安装 `dsh`（`npm install -g @deepseek-ai/dsh`）。
- `embedded-mcp-toolkit` 项目已在某目录完成 `init` 初始化，即存在：

```
E:\AI\embedded-mcp-toolkit\
├── remote-start-mcp.bat          # 启动脚本（锚定 cwd + 注入 5 个环境变量）
├── bin\embedded-mcp-toolkit-cli.js
└── .embedded\configs\config.yaml # 设备配置（board-lubancat 等）
```

### 2. 启动脚本 remote-start-mcp.bat

DSH 不直接 `node cli.js`，而是经由 bat 包一层。bat 做两件事：

```bat
cd /d "%~dp0"          REM ① 锚定 cwd 到项目根（无论谁从哪里启动）
set DEVICE=board-b
set BOARD_CONFIG_PATH=./.embedded/configs/config.yaml
set LOG_SAVE=1
set LOG_DIR=./.embedded/log
set SAVE2FILE_PATH=./.embedded/log
node bin\embedded-mcp-toolkit-cli.js   REM ② stdio 方式拉起 MCP 服务器
```

好处：与本地 Claude Code 启动（`.mcp.json`）和 Linux 远程 SSH 启动走**同一个入口**，环境变量、日志目录、设备配置三处完全一致，日志行为可横向对比。

### 3. 写入 DSH profile 的 patch 层

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`（本机为 `C:\Users\<用户>\.dsh\profiles\web\cordis.patch.yml`）：

```yaml
# ── embedded-mcp-toolkit (embedded board MCP server) ─────────────────────────
- insert:
    - id: mcp-embedded-board
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: embedded-board
        transport: stdio
        command: cmd.exe
        args:
          - /d
          - /c
          - 'E:\AI\embedded-mcp-toolkit\remote-start-mcp.bat'
        cwd: 'E:\AI\embedded-mcp-toolkit'
```

要点：

- **`id: mcp-embedded-board`**：插件实例 ID，一实例一 MCP 连接。
- **`serverName: embedded-board`**：决定工具的公开名前缀 `mcp__embedded-board__<工具名>`；同一 host 内必须唯一。
- **`command` + `cwd`**：用 `cmd.exe /d /c` 包住 bat，`cwd` 指向项目根，与 `.mcp.json`（Claude Code 用，见下表）效果对等。
- 插件包随 dsh 安装自带（位于 dsh 包自己的 `node_modules` 内），本机实测无需额外安装；若加载器报找不到，可执行 `dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`。

三种接入方式对等关系（同一台 MCP 服务器，三种拉起路径）：

| 接入方 | 配置文件 | 启动命令 | 备注 |
|--------|---------|---------|------|
| Claude Code（本地） | 项目根 `.mcp.json` | `node ./bin/embedded-mcp-toolkit-cli.js` | env 写在 JSON 里 |
| Linux 编译服务器（远程） | 远端 AI 工具的桥接配置 | `ssh ... remote-start-mcp.bat` | 见 [Linux远程连接Windows MCP配置指南](./Linux远程连接Windows%20MCP配置指南.md) |
| **DSH（本篇）** | `~\.dsh\profiles\web\cordis.patch.yml` | `cmd.exe /d /c remote-start-mcp.bat` | env 由 bat 注入 |

### 4. 启动与验证

```bash
dsh web          # 或 dsh --profile web
```

浏览器打开 GUI（本机为 `http://127.0.0.1:3080`，以启动输出为准）。验证两处：

1. **GUI 内**：对 Agent 说"有哪些设备可用"，Agent 调用 `mcp__embedded-board__device_info_tool` 并列出全部设备，即接入成功。
2. **业务日志**：`.embedded\log\` 下出现新日志文件（文件名形如 `2026-09-09_HHMMSS.log`），首行是：

```
=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log 2026.09.09 18:06:00 =~=~=~=~=~=~=~=~=~=~=~=
[...] [INFO] [mcp] MCP server starting... cwd: E:\AI\embedded-mcp-toolkit
```

随后每次工具调用都有成对的编号行：

```
[...] [INFO] ┌─ #1 BEGIN [device_info_tool] args={"device":"all"}
[...] [INFO] └─ #1 END/SUCCESS [device_info_tool] elapsed=41ms
```

## 四、 启动链路剖析

从命令行到工具可用，完整链路如下：

```
dsh web                                    （bin.js 解析 --profile web）
  └─ 加载 profile：bundles（dsh-base、dsh-web-app）→ cordis.patch.yml 追加
       └─ mcp-client 插件实例（id=mcp-embedded-board）apply(ctx, config)
            └─ StdioClientTransport spawn：cmd.exe /d /c remote-start-mcp.bat（cwd=项目根）
                 └─ bat：cd /d 项目根 + set 5 个 env
                      └─ node bin\embedded-mcp-toolkit-cli.js   ← MCP 服务器子进程
                           ├─ 首次写日志 → .embedded/log/2026-09-09_HHMMSS.log
                           ├─ 响应 tools/list → 工具以 mcp__embedded-board__* 注册
                           └─ 进入常驻，等待各会话的 tools/call
```

时间线（本机实测一次冷启动）：

| 时刻 | 事件 |
|------|------|
| 18:06:00 | host 启动 → MCP 服务器子进程起来，日志文件创建（此时还没有任何会话） |
| 18:06:05 | 用户创建第一个会话（session1） |
| 18:06:17 | session1 第一次工具调用 → 日志 `#1 BEGIN` |
| 18:09:22 | 用户另开新会话，该会话第一次调用 → 日志 `#5 BEGIN`（中间近 3 分钟零日志） |

## 五、 同进程多会话共享一个 MCP：现象与机制

### 1. 现象

同一 host 先后两个会话（session1 → session2），业务日志里编号**连续**、无断档、无第二个 server 头：

```
#1~#2  device_info_tool / adb_device_list      ← session1 的调用（18:06:17-20）
#3     serial_shell_login {"device":"board-lubancat"}  ← session1（18:06:40）
#4     serial_exec echo READY && pwd && id     ← session1（18:06:45）
#5     session_info                            ← session2（18:09:22，查活跃会话）
```

且 session2 从未登录过任何设备，`session_info` 却能看到 session1 建立的 `serial_1`（COM4）仍为活跃——因为**会话注册表活在 MCP 进程里，而 MCP 进程没死**。

### 2. 机制（源码级，四处证据闭环）

**① `#N` 是 MCP 进程内的单调计数器，与 DSH 会话无关**

`src/mcp/tool-registry.ts`：

```ts
/** 工具调用序号：进程内单调递增，用于配对同一次调用的开始/结束行 */
let invocationSeq = 0;
...
const seq = ++invocationSeq;
logger.info(`┌─ #${seq} BEGIN [${name}] args=${raw}`);
```

所以换会话不换进程 ⇒ 编号不重置。`#5` 从 5 开始，正是"上一会话用了 4 次 + 本会话第 1 次"。

**② 业务日志文件名 = MCP 进程启动时刻（首写时刻），一个进程一个文件**

`src/sdk/shared/logger.ts`：

```ts
this.logFile = join(dir, `${fileTimestamp()}.log`);  // YYYY-MM-DD_HHMMSS.log（北京时间）
```

文件在进程首次写日志时惰性创建，之后只追加。跨会话追加、文件里仅一个 `Mcp Server log ...` 头、间隙期零日志，都印证"同一进程持续存活"。

**③ MCP 连接的生命周期 = 插件实例生命周期 = host 级，不随会话创建/销毁**

`@deepseek-ai/dsh-mcp-client/lib/index.js`：

```js
async function apply(ctx, config) {
    ...
    const connection = startConnection(ctx, config, reconnect);
    ctx.effect(() => {
        return () => connection.dispose();      // 仅插件卸载 / HMR / host 退出时销毁
    }, "mcp-client.connection");
    const outcome = await connection.ready;      // host 启动时连接并同步工具列表
}
```

插件由 `cordis.patch.yml` 声明，在 **host 引导期**加载一次；DSH"会话"只是 host 内的逻辑对话，从不触发插件的加载/卸载。断线时插件走 reconnect 策略重连，也不按会话 spawn 新进程。

**④ 插件注册的工具落在全局工具层，所有会话/Agent 共见**

`@deepseek-ai/dsh-tools/lib/index.js` 的 `tools.register()` 文档：*"Register globally or in the calling agent scope. Scoped tools shadow globals."* mcp-client 在根作用域 ctx 上调用 `ctx.tools.register()`，工具进入**全局层**；`restrict()` 的文档反向印证全局层的影响面：*"a context-global restriction would mask every agent"*。dsh-agent 虽有 per-agent scoped context，但那只是叠加 shadow 层，全局层不动。

### 3. 生命周期对照表

| 对象 | 生命周期 | 何时变化 |
|------|---------|---------|
| DSH 会话（对话） | 用户创建/删除 | 与 MCP 完全解耦 |
| **MCP 服务器进程** | **= host 进程** | host 启动时 spawn；host 退出 / 插件 HMR / MCP 崩溃重连时换新 |
| 设备会话（serial_1、ssh_1…） | = MCP 进程 | 登录类工具创建；`*_close` 或进程退出时销毁 |
| `#N` 调用编号、业务日志 | = MCP 进程 | 同上，换进程即从 `#1`、新日志文件重来 |

### 4. 推论与实践意义

- **跨会话复用**：会话 A 打开的串口/SSH/ADB 会话，会话 B 直接可用（`session_info` 可查，不必重新登录）——前提是没人显式 `close`。
- **排障视角统一**：一份业务日志按 `#N` 配对即可精确还原任意会话的每一次调用边界；配合 `.embedded/log/<设备>/serial_1_*.log`（原始字节级会话日志）可做二次核对。
- **找"最新日志"**：日志文件名是进程启动时刻，不是当前时刻；按修改时间排序取最新即可。

### 5. 边界与失效场景（重要）

共享范围是**单个 host 进程**，以下情况会打破共享（进程一换，`#N` 重置、设备会话全丢）：

| 场景 | 后果 |
|------|------|
| host 退出/重启（重开 `dsh web`） | 旧 MCP 子进程被 dispose，新 host spawn 新进程：新日志文件、编号从 `#1`、serial_1 等会话全部消失 |
| 修改 `cordis.patch.yml` 触发插件 HMR | 插件热替换：旧连接 dispose + 新子进程 spawn，同上 |
| MCP 子进程自身崩溃 | 插件按 reconnect 策略重连（重新 spawn），会话注册表随旧进程一起丢失 |
| 并开第二个独立 `dsh` 实例（另一个 host） | 各自 spawn 各自的 MCP 子进程：日志、编号、设备会话表互不相通 |

> 排障提示：dsh-mcp-client 在连接异常时的日志原话是 *"reload the plugin or restart the Host to retry"*——即该插件认为连接不可恢复时，宿主级重启是恢复手段。

## 六、 速查

```bash
# 启动 DSH Web GUI
dsh web                                # 默认 http://127.0.0.1:3080

# 查看 MCP 业务日志里的调用编号轨迹
Get-Content .embedded\log\*.log -Encoding UTF8 | Select-String '#\d+ (BEGIN|END)'

# Agent 侧（GUI 内）常用操作
#   有哪些设备可用        → mcp__embedded-board__device_info_tool
#   看活跃会话            → mcp__embedded-board__session_info
#   串口一键登录 board-lubancat → mcp__embedded-board__serial_shell_login

# 会话落盘位置（DSH 自有存储，与 MCP 无关）
#   %USERPROFILE%\.dsh\sessions\--<工作区路径转义>--\session-*.jsonl.zstd
```

