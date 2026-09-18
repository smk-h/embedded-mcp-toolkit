<!-- more -->

## 一、 现象与判定

### 1. 现象描述

同一个 MCP Server（`embedded-mcp-toolkit`），停止方式不同，业务日志的收尾结果完全不同（实测环境：Windows + dsh 拉起，2026-09-18）：

| 停止方式 | 业务日志尾部 | 会话资源收尾 |
| -------- | ------------ | ------------ |
| dsh 里按 Ctrl+C（停 host / 停前台） | 有 `cleaning up...` + `all sessions disposed` | MCP 自己走清理流程 |
| `win-stop-mcp.ps1`（`taskkill /T /F`） | 无任何收尾行，日志直接断在半路 | 只能靠内核回收句柄 |
| 控制台直接 `node` 启动后按 Ctrl+C / 关窗 | 多数情况有收尾行（见 2.2） | 同上 |

【**强杀必然没有清理日志**】

这不是脚本漏了清理，而是 Windows 没有可投递的"终止通知"通道（见第二章）；反过来说，只要日志里出现了收尾行，就说明走的不是纯强杀路径。

### 2. 日志 reason 定性法

MCP 的清理入口统一走 `doCleanupAndExit(reason)`，并把 reason 写进业务日志，所以**日志自己会说明是哪条路来的**：

[`src/mcp/server.ts`](../src/mcp/server.ts#L188-L194)：

```ts
// src/mcp/server.ts
async function doCleanupAndExit(reason: string) {
  if (cleanupRunning) return;
  cleanupRunning = true;
  logger.info(`[mcp] ${reason}, cleaning up...`);
  await cleanupAllSessions();
  process.exit(0);
}
```

对应到日志尾部，四种可能的收尾形态：

```text
[mcp] SIGINT received, cleaning up...                      ← 控制台控制事件直达（Ctrl+C）
[mcp] stdin closed (client disconnected), cleaning up...   ← stdin 断流（管道被关 / 控制台句柄失效）
[mcp] stdin error: ..., cleaning up...                     ← stdin 报错（断流的另一个分支）
[mcp] all sessions disposed                                ← 清理完成（以上任一条都会打）
```

#### 2.1 四个清理入口

| 入口 | 代码位置 | 触发条件 | 依赖 Windows 控制台 |
| ---- | -------- | -------- | ------------------- |
| `stdin` 断流 | [`src/mcp/server.ts`](../src/mcp/server.ts#L198-L206) | 客户端关闭 stdio 管道；或控制台 TTY 句柄失效 | 否 |
| `SIGINT` / `SIGTERM` | [`src/mcp/server.ts`](../src/mcp/server.ts#L208-L213) | 控制台广播 Ctrl+C；或收到可投递的信号 | 是（Windows 上仅控制台场景有效） |
| `uncaughtException` + EPIPE | [`src/mcp/server.ts`](../src/mcp/server.ts#L227-L235) | 管道已断但仍在写 stdout | 否 |
| 外部强杀 | —— | `taskkill /F`、`Stop-Process`、`process.kill()` | 路径不存在，无任何事件 |

#### 2.2 触发源对照

| 触发源 | Windows 上是否有此通道 | 日志 reason | 能否清理 |
| ------ | ---------------------- | ----------- | -------- |
| `taskkill /PID x /F`、任务管理器"结束任务"、`Stop-Process`、`process.kill()` | 无（只调 `TerminateProcess`） | 无 | 不能 |
| 目标所在控制台里按 Ctrl+C | 有：`CTRL_C_EVENT` 广播给控制台前台进程组 | `SIGINT received` | 能 |
| 目标所在控制台里按 Ctrl+Break | 有：`CTRL_BREAK_EVENT` | 无（当前未监听 `SIGBREAK`） | 不能 |
| 关闭目标所在控制台窗口 | 有：`CTRL_CLOSE_EVENT`，同时 TTY stdin 句柄失效 | 无（未监听 `SIGHUP`）或 `stdin error` / `stdin closed` | 视 stdin 断流是否先发生 |
| 客户端主动关 stdio 管道（host 退出、插件 HMR） | 有（与控制台无关） | `stdin closed (client disconnected)` | 能 |

## 二、 根因：Windows 没有可投递的终止通知

### 1. 进程结束手段只有两类

Windows 没有 POSIX 信号，进程间终止只有两条路：

- **强行终止**：`TerminateProcess`。内核直接把进程标记为终止，**目标进程不执行任何用户态代码**——libuv 回调、`stdin` 事件、信号处理器全部没有机会运行。
- **请求关闭**：向窗口发 `WM_CLOSE`、向控制台发 `CTRL_CLOSE_EVENT`。只对有窗口或挂在控制台上的进程有效，且不是"信号投递"。

### 2. Node 的信号只是"长得像"

Node 官方文档明确：Windows 上 `process.kill()` 与 `subprocess.kill()` 对 `SIGINT`、`SIGTERM`、`SIGKILL`、`SIGQUIT` 等一律表现为**无条件强制终止**（语义等同 `SIGKILL`）。也就是说：

- 代码里写 `process.on("SIGTERM")` 在 Windows 上可以注册，但系统**永远不会投递**它；
- 杀进程的一方即使也是 Node 脚本，走 `process.kill(pid, "SIGTERM")` 依然是 `TerminateProcess`，与 `taskkill /F` 没有任何区别。

### 3. 唯一能真正触发清理的通道

只有**控制台控制事件**能真正投递给进程并触发处理器，且必须同时满足两个条件：

（1）目标进程挂在那个控制台上（未被 `CREATE_NEW_PROCESS_GROUP` / `DETACHED_PROCESS` 隔离）；

（2）有人能在那个控制台里产生事件（按键、关窗），或调用方与目标共享控制台并调用 `GenerateConsoleCtrlEvent`。

外部清理脚本不满足条件（2）：它既不能替用户按键，也不能对"别人拉起的、与 host 同进程组的 MCP"安全地投递事件（会连 host 一起打断，且 Node 不暴露该 API）。

## 三、 为什么 `/F` 参数不能删

### 1. 实测：去掉 `/F` 的两条连锁报错

用 `win-stop-mcp.ps1` 命中进程树后，若把 `taskkill` 的 `/F` 去掉，实测会连续撞两条错误（PID 为当次示例，每次不同）：

#### 1.1 `node.exe`：无窗口无消息循环，收不到温和关闭请求

```text
node.exe（PID 19744）：控制台程序，没有窗口和消息循环，根本收不到温和关闭请求，
所以系统直接拒绝并提示"只能强行终止这个进程(带 /F 选项)"。
```

英文原文含 `(with /F option)` 字样。含义很清楚：**温和路径对控制台程序没有落脚点**。

#### 1.2 `cmd.exe`：子进程未退，父进程拒绝结束

```text
cmd.exe（PID 6508）：不带 /F 时 taskkill 在子进程还活着的情况下拒绝结束它，
于是报"一个或多个此进程的子进程仍然在运行"。
```

node 没先死 → cmd 就也死不了，**两条错误是连锁的，根子都在缺 `/F`**。

### 2. 删 `/F` 与脚本自身的设计意图相悖

`win-stop-mcp.ps1` 头部注释（第 21～23 行）本来就写明了设计：整树结束统一用 `taskkill /T /F`，并专门解释了为什么不能用温和方式：

[`scripts/win-stop-mcp.ps1`](../scripts/win-stop-mcp.ps1#L21-L23)：

```powershell
# scripts/win-stop-mcp.ps1
#   靠命令行认；结束统一用 taskkill /T /F 按进程树递归——Node 的 proc.kill()
#   只杀本体，命令里起的子进程会变成孤儿（同 src/sdk/tools/win/powershell.ts、
#   cloudflared 停止逻辑的结论）。
```

实际执行处同样是 `/T /F`：

[`scripts/win-stop-mcp.ps1`](../scripts/win-stop-mcp.ps1#L241)：

```powershell
# scripts/win-stop-mcp.ps1
& taskkill /PID $p.ProcessId /T /F | Out-Null
```

同一结论在代码里还有两处：[`src/sdk/tools/win/powershell.ts`](../src/sdk/tools/win/powershell.ts#L245-L253) 的 `killProcessTree()`、[`src/cli/commands/cloudflared/tunnel-process.ts`](../src/cli/commands/cloudflared/tunnel-process.ts#L101-L108) 的 `stopProcessTree()`，都是 `taskkill /T /F`。

因此：**不要为了拿到清理日志而删 `/F`**。删了既撞上面两条连锁报错，也与脚本（以及整个项目）的既定设计相悖；"拿不到清理日志"是 Windows 能力边界，不是参数选错。

## 四、 强杀后的资源释放边界

### 1. 内核一定回收

COM 口在 Windows 上表现为内核文件对象（`\\.\COM3` 的句柄）。进程销毁时内核拆除整张句柄表，**不依赖进程自己调用 `CloseHandle`**，所以 `taskkill /T /F` 之后：

- 串口、socket、管道、文件、命名 mutex 的句柄都会被释放；
- 树的**每个**进程都如此（`/T` 覆盖进程树，`/F` 保证每个都真的被终止）。

### 2. 用户态收尾一定丢

内核回收 ≠ 优雅收尾，以下三类代价必须认：

（1）**数据未落盘**：日志缓冲区里的尾部内容丢失，这正是"没有收尾行"的直接原因；

（2）**DTR 时序不可控**：串口由内核关闭，多数 USB 转串口会拉低 DTR，可能复位板子（见 [`docs/项目简介.md`](./项目简介.md) 中端口反复开关导致设备复位一节）；

（3）**本地产物残留**：`.embedded/tmp/` 下的传输中间件不会被清理。

### 3. 例外与后续影响

- **树外持有者**：`/T` 只向下递归，不影响树外进程。手工开的串口工具、IDE 的串口监视器仍会占着端口，新 MCP 打开时报 `Access denied`（同一串口只能被一个进程独占）；
- **驱动卡死**：若 USB 转串口驱动异常（拔线、IRP 卡死），端口可能一段时间内无法打开，需重新枚举设备（拔插、`devmgmt.msc` 停用/启用、`pnputil /restart-device`）。此时"进程已死但端口忙"是设备状态，不是句柄泄漏；
- **复查的 300ms 只是尽力而为**：[`scripts/win-stop-mcp.ps1`](../scripts/win-stop-mcp.ps1#L259-L270) 结束后的复查等 300ms，是为了让内核把句柄收完；真要稳，应在重新打开端口处做"失败重试 N 次"。

## 五、 实操指引

### 1. 需要清理日志时怎么做

按性价比排序，前两条都不依赖信号，确定性最高：

（1）**先停客户端，再跑清理脚本**：在 dsh 那边 Ctrl+C 停 host（或触发插件重载）→ MCP 收到管道 EOF → 走 `stdin closed` 清理 → 再跑 `win-stop-mcp.ps1` 兜底清残留。

（2）**先让 MCP 自己归还资源再强杀**：在会话里调 `session_info` 看有哪些活跃会话，再调 `serial_close` / `ssh_shell_close` / `adb_shell_close`。适合在意"数据 flush、避免复位板子、端口立刻可用"的场景。

（3）**加旁路停机通道**（状态文件轮询 / 本地管道 / 看门狗壳）：能让外部脚本"请求"而非"强杀"，但引入常驻监控逻辑，除非有刚需不划算。

### 2. 强杀前后的注意事项

- `cmd.exe /d /c remote-start-mcp.bat` 这条链路上，`/T` 不会杀到 dsh host，而 `dsh-mcp-client` 在断线时会 **reconnect 重新 spawn** MCP：杀完可能几秒内又冒出新进程，脚本复查会报"仍有 N 个进程存活（权限不足或正处于启动竞态）"——"启动竞态"就是这种情形；
- 因此正确顺序是**先停 host，再跑清理脚本**，否则永远在和重连赛跑；
- 控制台直接 `node` 启动时，stdin 是控制台 TTY（不是管道），控制台一消失就会断流，天然多一条触发通道；这与 dsh 场景（stdin 是管道、由客户端控制开合）不同，但两者都**不能**让 `/F` 产生清理。

### 3. 自检与复现实验

看最近一次运行的收尾：

```powershell
# PowerShell（Windows 端）：<进程启动时刻> 换成 .embedded\log\ 下最新那个文件名
Get-Content .embedded\log\<进程启动时刻>.log -Tail 5
```

三个对照实验（node 那个控制台不要动，另开窗口执行前两项）：

（1）纯强杀：`taskkill /PID <node-pid> /F` → 预期无任何收尾行；

（2）目标控制台里按 Ctrl+C → 预期 `SIGINT received, cleaning up...` + `all sessions disposed`；

（3）目标控制台里按 Ctrl+Break → 预期无收尾行（`SIGBREAK` 未监听），进程结束。

## 六、 代码索引与结论

### 1. 关键代码索引

| 关注点 | 位置 |
| ------ | ---- |
| 清理总入口与 reason 日志 | [`src/mcp/server.ts`](../src/mcp/server.ts#L188-L194) |
| `stdin` / 信号 / EPIPE 钩子 | [`src/mcp/server.ts`](../src/mcp/server.ts#L196-L236) |
| 会话资源释放 | [`src/sdk/tools/serial/sessions.ts`](../src/sdk/tools/serial/sessions.ts#L60-L70) |
| Windows 侧强杀与复查 | [`scripts/win-stop-mcp.ps1`](../scripts/win-stop-mcp.ps1#L241) |
| Linux 侧两段式结束（`TERM` → `KILL`） | [`scripts/linux-stop-mcp.sh`](../scripts/linux-stop-mcp.sh) |
| 工具层关闭会话 | `serial_close` / `ssh_shell_close` / `adb_shell_close` / `session_info` |

### 2. 结论

（1）**强杀没有清理日志是必然结果**：`taskkill /F` 只调 `TerminateProcess`，不投递任何事件，MCP 的四个清理入口一个都进不去。

（2）**`/F` 参数必须保留**：去掉它会连锁撞上"控制台程序只能强行终止"与"子进程仍在运行"两条报错，且与脚本既定设计意图相悖。

（3）**Linux 与 Windows 的差异是能力差异**：Linux 上 `SIGTERM` 可直接投递给任意进程，所以"先 `TERM` 后 `KILL`"能给 MCP 收尾机会；Windows 没有这个能力，只能靠客户端主动关管道（stdin EOF）或控制台事件。

（4）**想要干净收尾就改流程**：先停客户端（或先用工具关闭设备会话）再跑强杀脚本；强杀路径下的唯一保证是内核回收句柄。

---
*本文档由 markdowncli 技能辅助生成*
