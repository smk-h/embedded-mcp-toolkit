<!-- more -->

## 一、 问题描述

无论是通过 `spawnSync` 这种一次性命令执行（如 `adb_exec`）还是通过交互式 shell（如 `adb_shell_exec`），当执行 `logcat`、`ping`、`top` 这类需要按下控制字符（Ctrl+C 等）才能终止的前台常驻命令时，通过 MCP 来操作都会出现以下问题：

- 工具虽然拿到了输出并返回，但命令本身并没有退出，仍在后台持续运行
- 命令持续往输出缓冲区灌数据，导致下一次执行命令时输出与残留数据混在一起，出现异常
- 发送 Ctrl+C（`\x03`）或 Ctrl+U（`\x15`）等控制字符时，并不是每次都能成功

## 二、 根因分析

### 1. 所有 `*_exec` 都是「盲式 write → sleep → read」

经核查，adb、ssh、serial 三个通道的 `*_exec` 处理逻辑完全一样，都是固定三步：

```typescript
// src/mcp/tools/adb/shell.ts
shell.write(args.command, args.clear ?? 1);                     // 1. 发命令
await new Promise((r) => setTimeout(r, args.delay ?? 1000));    // 2. 盲等固定时长
const output = shell.read(1);                                   // 3. 读缓冲区
```

这套机制对 `ls`、`getprop` 这类「瞬时返回后立即退出」的命令没有问题，但对 `logcat`、`ping`、`top` 这类前台常驻命令会彻底失效。

### 2. 失效的具体链路

对于 `logcat`/`ping`/`top`，命令进入 shell 后开始持续输出，永远不会返回提示符：

| 时刻 | 发生了什么 |
|------|-----------|
| `write("logcat")` | 命令进入 shell，`logcat` 开始持续输出，永远不会返回提示符 |
| `sleep(1000)` | 等 1 秒，`logcat` 仍在刷屏，输出堆在 buffer 里 |
| `read(1)` | 拿到这 1 秒的输出，MCP 工具返回 |
| 返回后 | `logcat` 进程仍在后台跑，持续往 buffer 灌数据 |
| 下一次 exec | `write("ls")` 的输出被混进还在刷的 `logcat` 输出里 → 输出错乱 |

「工具返回了但命令没退出」「下一次执行异常」都是这同一个根因的表现。

### 3. 为什么 Ctrl+C「不是每次都成功」

当前工具体系没有给调用方（包括 LLM）任何正确发送控制字符的入口：

- `adb_shell_write`/`ssh_shell_write` 内部调用 [`shell.write`](../../src/transports/base-shell.ts#L97-L105)，第三个参数 `appendLineEnding` 默认为 `true`，会在命令后补一个 `\n`。即使调用方写入 `\x03`，实际发出的是 `\x03\n`，控制字符的语义被破坏
- `serial` 通道虽然有 [`sendRaw`](../../src/transports/serial.ts#L148-L150) 方法（`appendLineEnding=false`），但这个能力没有暴露成任何 MCP 工具
- adb、ssh 通道连 `sendRaw` 都没有，只能靠 `write(data, clear, false)`，同样未暴露

所以现状是：调用方就算想发 Ctrl+C，也没有正确的工具可用，只能硬着头皮用 `write`，这就是「不是每次都成功」的原因。

### 4. 非交互式通道为何不在改造范围

前述问题聚焦的是**交互式 shell exec**（`adb_shell_exec` / `ssh_shell_exec` / `serial_exec`）——它们共享同一会话的输出缓冲区，才是「常驻命令污染下一次调用」的重灾区。其他命令执行路径不在此列，原因各有不同。

#### 4.1 adb_exec（spawnSync）机制上不产生 buffer 污染

`adb_exec` 用 spawnSync 启动**独立的本地 adb 子进程**，子进程的输出绑定在自己的 stdout/stderr 管道上，**不进任何共享 buffer**：

```
adb_exec("logcat")  →  spawnSync("adb", ["shell","logcat"])  →  独立子进程 A（管道 A）
adb_exec("ls")      →  spawnSync("adb", ["shell","ls"])      →  独立子进程 B（管道 B）
```

跑常驻命令时它的真实行为是：

1. logcat 持续输出，被 Node 读进子进程 A 自己的管道
2. 到 timeout（15 秒）→ spawnSync 强制终止本地 adb 子进程
3. 本地 adb 进程退出时给远端 adb daemon 发 EOF/断开信号，远端 logcat 通常跟着结束
4. 管道 A 被回收，下次调用是新子进程 B，互不干扰

所以 adb_exec **也会一直输出，只是被 timeout 兜底杀掉**——这正是它「不污染下一次调用」的根源。

#### 4.2 但 adb_exec 不是「好用」，只是「机制上安全」

「安全」不等于「好用」，timeout 兜底的代价是：

| 代价 | 说明 |
|------|------|
| 浪费 15 秒 | 整整卡满 timeout 才返回，且 spawnSync 同步阻塞整个 Node 事件循环，期间 MCP server 无法响应其他工具 |
| 丢输出 | 超时后 `execAdb` 走 `status !== 0` 分支返回空字符串，15 秒的 logcat 日志全丢 |
| 远端不一定干净 | 个别情况下本地 adb 被杀但远端 logcat 没收到断开信号会残留，下次 adb 调用时通常自愈 |

这些属于「同步阻塞 + 超时丢输出」的另一问题域，与本次 A+B 方案（依赖交互式 shell 会话）机制对不上，故不在本次范围，可另立项优化（如改异步、超时返回部分输出）。adb_exec 本就为一次性短命令（devices/install/push）设计，拿它跑 logcat 属于误用。

#### 4.3 ssh/serial 没有独立非交互式工具

ssh 和 serial **没有**像 `adb_exec` 那样的 spawnSync 非交互式工具。它们所有的一次性命令执行（含 `ssh_build`）都走交互式 shell 会话，因此本就落在本次改造覆盖范围内。

唯一例外是 `ssh_build`——它虽然复用交互式 shell 会话，但内部已自带完成标记（`___MCP_BUILD_DONE___:$?`）检测、`shell.drain()` 残留排空、`maxWait` 超时轮询，等价于本次方案 B 的能力，已自洽，无需重复改造。

#### 4.4 改造范围小结

| 命令执行路径 | 是否改造 | 理由 |
|------|---------|------|
| `adb_shell_exec` / `ssh_shell_exec` / `serial_exec` | 改 | 共享 buffer + 盲式 write→sleep→read，本次目标 |
| `adb_exec` | 不改 | 进程隔离不产生 buffer 污染；同步阻塞/丢输出属另一问题域 |
| `ssh_build` | 不改 | 自带 marker + drain + maxWait，已自洽 |
| `*_shell_write/read/close` | 不改 | 原子操作，无轮询逻辑 |

### 5. adb shell 无 PTY 不回显提示符（真机验证发现）

在真机验证提示符检测方案时，发现一个关键事实：**adb shell 默认不分配 PTY，设备侧 shell 不会回显提示符**。

`AdbShell` 用 `spawn("adb", [..., "shell"])` 启动持久化子进程，注释里说「保持交互模式」——但「交互模式」仅指进程不退出、持续等待 stdin 输入，**不等于 PTY 模式**。没有 PTY 时，设备侧 `/system/bin/sh` 不会输出 PS1 提示符（`:/ $` 等），buffer 末尾只有命令输出 + `\n`。

这导致最初设计的「提示符检测」方案在 adb 通道完全失效——正则锚定 `[#$]$` 永远不会命中，每个命令都会跑满 maxDuration 然后误发 Ctrl+C（包括 `echo`、`ls` 这类瞬时命令）。

#### 5.1 修复：`adb shell -t -t` 强制分配 PTY

- 单个 `-t` 无效：adb 检测到 stdin 非 terminal（Node 管道）会拒绝，提示 `Remote PTY will not be allocated because stdin is not a terminal`
- **两个 `-t`**（`-t -t`）强制分配，设备侧 shell 回显完整提示符 `rk3568_lubancat_2_v3_mipi1080p:/ $`
- 真机实测：`spawn("adb", [..., "shell", "-t", "-t"])` 后，buffer 结构变为

```
[提示符][命令回显]\r\r\r\n    ← 首行：PTY 回显的命令行
[命令输出]\r\r\n              ← 真实输出
[提示符]                      ← 结束提示符（检测器命中）
```

#### 5.2 PTY 回显剥离

PTY 模式的副作用：设备会原样回显输入的命令行（如 `rk3568:/ $ echo hi`）。若不剥离，exec 返回的输出会带上这行回显，污染结果。因此 runExec 发命令后需先丢弃首行（到第一个 `\n`），`\n` 之后才是真实输出。这与 ssh_build 步骤 4 的「剥离 PTY 回显」是同一问题、同一解法。

#### 5.3 对方案选型的影响

原 spec 的 N2「不改动传输层」被这一发现打破：为了让 adb 通道的提示符检测生效，**必须修改 `transports/adb.ts` 加 `-t -t`**。这是真机验证暴露的真实约束，非事先可预见。ssh 通道本就有 PTY（`client.shell({ term: "xterm" })`），serial 通道走物理串口天然有终端，两者不受影响。

### 6. LLM 能否自主判断需要发 Ctrl+C

知识层面，LLM 知道 `logcat`/`top` 是常驻命令、终止它们要发 Ctrl+C。但在当前 MCP 工具体系里正确执行有四道坎：

- LLM 收到 `adb_shell_exec` 的返回后，单看返回结果不一定意识到命令还在后台跑，因为工具已经「返回」了
- 即便意识到，也没有正确的工具能发出 `\x03`
- 即使发出去了，前面可能还堆着未消费的字节，存在时序竞争
- 即使杀掉了命令，之前累积的输出还残留在 buffer 里，下次读取会读到残留

结论是：不能把「判断并停止常驻命令」完全交给 LLM，必须有工具层的兜底机制。

## 三、 解决方案

### 1. 方案 A：暴露发送控制字符工具 + exec 前置冲刷

核心思路是给调用方一个确定可用的「停止当前命令」入口，并消除上次的残留污染。

具体做法：

- 为每个通道新增一个工具，如 `adb_shell_send_ctrl(session_id, key)`，内部以 `appendLineEnding=false` 调用 `write`，保证 `\x03`、`\x15`、`\x04`、`\x1a` 等控制字符语义正确，补上当前 adb/ssh 完全缺失、serial 有但未暴露的能力
- 在 `*_exec` 开头加一步「前置冲刷」，先 `read(1)` 丢掉残留输出，避免上次未终止命令的污染混入本次结果

解决的问题：

- 调用方能可靠地发 Ctrl+C / Ctrl+U，不再靠 `write` 碰运气
- 下一次 exec 不被上次残留污染

未解决的问题：

- 如果调用方忘了主动发 Ctrl+C，常驻命令仍会留在后台（进程还在，只是下次 exec 前冲刷掉可见污染）

改动量：小，集中在工具层，不动传输层。

### 2. 方案 B：给 exec 加提示符检测与超时熔断

核心思路是让 exec 自己判断命令是否真的结束，常驻命令自动熔断，不依赖调用方觉悟。

具体做法是给 `*_exec` 加一个 `maxDuration` 参数（默认值兜底，可配），逻辑变成：

- `write(command)` 后在 `maxDuration` 内轮询 buffer
- 检测到 shell 提示符（`#`、`$`、`:/ $` 等）→ 判定命令结束，立即返回，不必等满 `delay`
- 超过 `maxDuration` 仍无提示符 → 自动发 `\x03` → 返回已有输出并标注 `interrupted`

解决的问题：

- 常驻命令（`logcat`/`top`/`ping`）自动熔断，不留僵尸，是唯一能兜住「调用方没判断出常驻命令」的机制
- 普通命令（`ls`/`getprop`）能更快返回，不必傻等满 `delay`
- 「误杀长命令」用 `maxDuration` 可配置解决（如 `make` 传大值）

未解决的问题：

- 调用方想提前终止一个还没超时的命令，B 做不到，得靠 A
- 提示符检测有误判风险（PS1 自定义、命令输出里含 `#`/`$`），正则需要谨慎设计，不同设备提示符也不同

改动量：中等，要改 exec 的轮询逻辑，并处理提示符检测的鲁棒性。

### 3. 方案 C：为常驻命令提供专门的有限采样工具

核心思路是 `logcat`/`top` 这类本质不会结束的命令，用语义明确的专用工具，跑够时间自动杀掉。

具体做法是新增一个工具：

- `adb_shell_capture(command, duration_ms)` → 发命令 → 精确采样 `duration_ms` 时长的输出 → 采样结束强制发 `\x03` 终止命令 → 清空 buffer，返回采样结果

解决的问题：

- 从根本上消除僵尸命令
- 语义清晰，不易误用

未解决的问题：

- 仍然依赖调用方选对工具（知道用 `capture` 而不是 `exec`），没完全摆脱对调用方判断的依赖
- 提示符/熔断这类通用问题它不管，普通 exec 还是老样子

改动量：较大，新增工具并需要文档引导调用方何时用 exec、何时用 capture。

## 四、 方案对比

| 维度 | 方案 A | 方案 B | 方案 C |
|------|--------|--------|--------|
| 解决 Ctrl+C 不可靠 | 直接解决 | 不解决 | 不解决 |
| 解决僵尸命令污染 | 需调用方主动发 | 自动兜底 | 专用场景根治 |
| 依赖调用方判断 | 高（不发就不停） | 低（自动熔断） | 中（要选对工具） |
| 改动量 | 小 | 中 | 大 |
| 误杀长命令风险 | 无 | 有（用 maxDuration 缓解） | 无 |

三个方案各有侧重：方案 A 解决「发不出控制字符」这个硬伤，方案 B 解决「常驻命令不结束」这个根本问题，方案 C 为 logcat 这类场景提供更精确的语义。

## 五、 选型结论：A + B

综合对比后选择 A + B 组合：

- 方案 B 是必须的：它是唯一能兜住「调用方没判断出常驻命令」这个失败模式的机制，不依赖调用方觉悟，常驻命令必然会被自动熔断，不会无限挂起污染后续操作
- 方案 A 是强烈推荐的：它让「调用方想停就能停」成为确定性能力，补上当前 adb/ssh 发不了控制字符、serial 有但没暴露的硬伤
- 两者结合后形成分层防御：调用方判断出来 → 方案 A 干净停掉；调用方没判断出来 → 方案 B 自动兜底

方案 C 可作为未来的增强项，在 logcat 场景特别多、需要更精确的采样语义时再做，当前不急。

---
*本文档由 markdowncli 技能辅助生成*
