## 一、 概述

串口通道的 U-Boot 支持由三部分构成：设备配置里的 `serial.uboot` 检测规则、[`src/sdk/tools/serial/sessions.ts`](../src/sdk/tools/serial/sessions.ts) 中按会话维护的「U-Boot 标记」，以及 [`src/sdk/tools/serial/uboot.ts`](../src/sdk/tools/serial/uboot.ts) 提供的两个 MCP 工具（`serial_enter_uboot` / `serial_uboot_state`）。标记本身只是一个 `Set<string>` 里的 `session_id`，但它决定了 `serial_exec` 的 marker 包装风格与 2 级回落检测器选型，是整个 U-Boot 命令执行可靠性的中枢。

本文分析以下问题：

- 配置如何加载、与默认值如何合并（merge 而非 replace）
- 标记在何时被设置、查询、同步、清理，各自的判断逻辑
- 为什么刻意不用「提示符排除法」清理标记（2026-08-27 事故复盘）

![标记生命周期总览](./MCP-U-Boot标记机制分析/img/mark-set-clear-lifecycle.svg)

## 二、 配置体系：serial.uboot 子段

### 1. 配置字段

`UbootYaml` 接口在 [`src/sdk/shared/config.ts`](../src/sdk/shared/config.ts#L37) 中声明，全部字段可选：

```typescript
// src/sdk/shared/config.ts
export interface UbootYaml {
  autobootPrompts?: string[]; // autoboot 提示正则数组，数组顺序即优先级
  prompt?: string;            // 命令提示符正则，命中即判成功（主层）
  verifyEnvKeys?: string[];   // printenv 验证键名（纯字面量，不走正则）
}
```

- 字段值直接写 JavaScript 正则源码字符串，由 `new RegExp(source, flags)` 构造，不做任何预处理，所见即所得
- YAML 双引号字符串中反斜杠必须双写（`"\\s+"`），单引号字符串可免双写，详见 [regex-guide.md](regex-guide.md)
- `getUbootConfig()` 在 [`src/sdk/shared/config.ts`](../src/sdk/shared/config.ts#L334) 中按设备名读取 `serial.uboot` 子段，未配置时返回空对象 `{}`，由检测器回退默认值

### 2. 默认值与合并规则

内置默认值 `UbootDefaults` 定义在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L143)：

- `autobootPrompts`（2026-08-31 扩充，按优先级）：`Hit Ctrl+u to stop autoboot`（发 `\x15`）→ `Hit/Press Ctrl+c … stop/interrupt/abort autoboot`（发 `\x03`）→ `Hit/Press any key|a key|key …`（发换行）→ `Hit/Press SPACE …`（发空格）。覆盖 Hit/Press × any key/SPACE/Ctrl 类按键 × stop/interrupt/abort 动词的主流组合
- `prompt`：`(?:=>|U-Boot>)\s*$`，无 flags（`=>` 和 `U-Boot>` 固定大小写）
- `verifyEnvKeys`：`baudrate`、`bootdelay`
- `verifyTimeoutMs`：4000；`kernelBootPattern`：`Starting kernel|Linux version`（带 `i` 标志，不可配置）

合并策略是「并集互补」，而非覆盖替换（autobootPrompts 自 2026-09-03 起改为用户优先）：

- `autobootPrompts`：用户值在前、默认值在后兜底，字面相等去重时保留用户条目、删默认副本，数组顺序即匹配优先级
- `prompt`：仅当用户值与默认值**字面不同**时才联合——剥离两者尾部 `\s*$` 后拼成 `(?:(?:A)|(?:B))\s*$`；用户照抄默认值时跳过合并，避免 `(?:A|A)` 冗余
- `verifyEnvKeys`：默认 ∪ 用户，去重后全部小写化，匹配时走 `key=` 字面量包含判断

![配置合并规则](./MCP-U-Boot标记机制分析/img/config-merge.svg)

【**容错原则**】配置含非法正则时 `new UbootDetector()` 在构造期抛错，调用方捕获后快速返回配置错误，不进入轮询；`serial_exec` / `serial_read` 内的检查则降级为跳过，不阻断主流程。

## 三、 UbootDetector 四件套检测

`UbootDetector` 类在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L176) 中定义，只做匹配、不操作串口，时序编排由工具 handler 负责。四个 match 方法对应进入 U-Boot 的四种判据。

### 1. matchAutoboot()

识别 autoboot 倒计时提示并返回应发送的中断键，该函数在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L287) 文件中定义：

【**函数作用**】

按配置数组顺序逐条测试 autoboot 提示正则（构造时统一带 `i` 标志），命中即返回应发送的中断键（两层选键：命中行文本优先，条目静态映射回退，2026-09-03 起）

【**参数含义**】

- `output`：累积的串口输出（全程累积，非增量）

【**返回值**】

- 命中返回中断键，两层决定（命中行文本优先）：命中所在行出现 `Ctrl+u` / `Ctrl+c` / `SPACE` 字样（大小写与 `+`/`-` 分隔符不敏感）时优先发对应控制键 `\x15` / `\x03` / 空格——覆盖 Rockchip `Hit key to stop autoboot('CTRL+C')` 这类按键藏在括号后缀的文案；行内无提示字样再按条目正则源码字样回退（含 `Ctrl+c` 发 `\x03`、含 `Ctrl+u` 发 `\x15`、含 `SPACE` 发空格、其余如 any key 发 `\n`）
- 未命中返回 `null`

### 2. matchPrompt()

识别 U-Boot 命令提示符，该函数在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L301) 文件中定义：

【**函数作用**】

用合并后的 prompt 正则测试输出，默认锚定末尾（`\s*$`），作为主层成功判据

【**参数含义**】

- `output`：中断键发送之后累积的 U-Boot 阶段输出

【**返回值**】

- 命中返回 `true`，未命中返回 `false`

### 3. matchVerifyKey()

验证 `printenv` 输出中的环境变量键，该函数在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L314) 文件中定义：

【**函数作用**】

`printenv` 输出形如 `baudrate=115200\nbootdelay=3`，用字面量 `key=` 做大小写不敏感包含判断。刻意不走正则——键名是固定标识符，正则转换无收益反增错

【**参数含义**】

- `output`：`printenv` 命令发出后累积的输出

【**返回值**】

- 任一验证键命中返回 `true`，否则返回 `false`

### 4. matchKernelBoot()

识别内核启动特征，该函数在 [`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L328) 文件中定义：

【**函数作用**】

匹配 `Starting kernel` / `Linux version` 特征（带 `i` 标志）。主层与验证层都应检查：设备可能在中断失败后越过 U-Boot 进入内核，命中即立即判失败，不等超时。该判据同时被 `serial_exec` / `serial_read` 复用为「已离开 U-Boot」的自校正证据

【**参数含义**】

- `output`：累积输出（可含前置冲刷残留）

【**返回值**】

- 命中内核启动特征返回 `true`，否则返回 `false`

## 四、 标记的设置：serial_enter_uboot 预检 + 两层检测

`serialEnterUbootHandler()` 在 [`src/sdk/tools/serial/uboot.ts`](../src/sdk/tools/serial/uboot.ts#L78) 中实现：发 `reboot` 前先做一次零副作用的被动预检，之后是 500ms 步进的轮询循环，内分三个阶段，总超时兜底。

### 1. 预检 + 三阶段流程

1. 构造 `UbootDetector`：配置非法立即返回错误，不进入轮询
2. **预检（发 reboot 前，2026-08-31 新增）**：对缓冲区尾部做 `classifyUbootEnv()` 分类——已在 U-Boot（尾部 `=>`/`U-Boot>`）直接置标记返回成功，免掉一整轮重启（多数 U-Boot 的重启命令是 `reset`，盲发 `reboot` 只会得到 Unknown command 后空等）；停在 `login:`/`Password:` 直接失败并提示先登录（`reboot` 会被当作凭据吞掉，设备根本不重启）
3. 发送 `reboot`，进入 500ms 轮询；`drain()` 增量取走新到数据做累积
4. **全程判定（不设「已中断」门槛，2026-08-31 调整）**：每轮先查内核启动特征（命中即失败），再查 `matchPrompt()`（命中即成功，via prompt）——`bootdelay=0` 秒过、`bootdelay=-2` 禁用 autoboot、厂商文案变体等 autoboot 提示未命中的设备也能快速出结论，不再干等到总超时
5. 阶段 1（未中断时）：`matchAutoboot()` 命中即发对应中断键（两层选键，2026-09-03 起：命中行文本优先——行内 Ctrl+u/Ctrl+c/SPACE 字样发 `\x15`/`\x03`/空格，覆盖 Rockchip 括号后缀 `('CTRL+C')` 文案；行内无提示再按正则源码字样回退，其余发换行），记录 `interruptedAt` 并清空累积输出，之后只收集 U-Boot 阶段输出
6. 阶段 3（验证层）：已中断且主层窗口（4s）耗尽仍未命中提示符时，发一次 `\nprintenv\n`（仅发一次），4s 窗口内 `matchVerifyKey()` 命中即成功（via verify）；窗口耗尽或命中内核特征则快速失败，建议重试

### 2. 时序图

![serial_enter_uboot 两层检测时序](./MCP-U-Boot标记机制分析/img/enter-uboot-sequence.svg)

### 3. 设计要点

- **预检拦截**：盲发 reboot 有两类注定空等总超时的场景（已在 U-Boot、停在登录提示），缓冲区尾部锚点在发送前直接拦下，要么免重启成功、要么快速失败给出登录指引
- **双窗口计时**：主层与验证层各自以 `interruptedAt` / `verifyStartedAt` 为起点的 4s 窗口，与总超时 `timeoutMs`（毫秒，默认 60000 即 60s，秒数 × 1000 换算）相互独立；验证层只在已中断场景触发——未中断时设备可能仍在重启路上（DDR 训练/慢关机），盲发 printenv 会落在未就绪的控制台上被丢弃，白耗窗口制造假失败
- **输出分段与增量累积**：命中 autoboot 与发出 `printenv` 两处都会清空累积输出，保证各阶段判定材料干净，不被上一阶段的引导日志污染；轮询用 `drain()` 增量取数，`read(0)` 返回全量再累加会随轮次平方级膨胀
- **失败快速化**：内核启动特征是「越过 U-Boot」的确定性证据，判定不设「已中断」门槛——autoboot 文案未命中导致中断键发不出去时，同样立即返回失败，不傻等超时；配置非法构造期抛错，不进轮询

## 五、 标记的查询与同步：serial_uboot_state

`serialUbootStateHandler()` 在 [`src/sdk/tools/serial/uboot.ts`](../src/sdk/tools/serial/uboot.ts#L321) 中实现，提供四个动作。

### 1. 四个动作

- `status`：只读标记，无设备 I/O
- `set` / `clear`：强制覆盖标记，是自动检测失同步时的权威手动入口
- `detect`（默认）：分类当前真实环境并同步标记，两级策略——被动优先（缓冲区尾部的高置信锚点直接结论：U-Boot 提示符 / 登录提示；内核启动 / autoboot 特征报过渡态并兼作探测护栏，全部零副作用），主动兜底（两段式行为探测：先 `printenv`，无键命中再 `echo $$`）

【**注意**】不要在命令可能仍在运行、或等待交互输入（如 Y/N）时 detect——每个探测命令消耗一行输入，可能替用户回答挂起的提示。

### 2. classifyUbootEnv() 分类逻辑与主动探测

`classifyUbootEnv()` 在 [`src/sdk/tools/serial/uboot.ts`](../src/sdk/tools/serial/uboot.ts) 中定义，只保留**高置信锚点与探测护栏**，判定顺序即优先级：

1. `matchPrompt()` 命中（尾部锚定 `=>`/`U-Boot>`/设备配置）→ `uboot`
2. 尾部锚定正则 `/(?:login|password):\s*$/i` 命中 → `login`（系统侧未登录）
3. `matchKernelBoot()` 命中 → `booting`（过渡态）
4. `matchAutoboot()` 命中 → `autoboot`（过渡态）
5. 均未命中 → `null`（进入主动探测）

**为何没有 "system" 形态判据**：通用提示符在 U-Boot 与 Linux 间无形态区分度——定制 U-Boot（`CONFIG_SYS_PROMPT`）大量使用 `#`，Linux root shell 也是 `#`，sh 续行提示符（PS2）又是 `>`。形态判定会系统性误判（`#` 尾部被通用正则判成 system 并错误清标记），故 `system` 结论只能由主动行为探测得出。

**主动探测（行为判据兜底）**：被动判据全未命中时执行，探测前先 `drain()` 排空历史缓冲（`printenv` 键是子串匹配，历史残留的 `baudrate=` 会造成假命中）：

1. **探测 1：`printenv`** —— `countVerifyKeys()`（`verifyEnvKeys` 默认 `baudrate`/`bootdelay`）命中 **≥2 键** → `uboot`。单键可能是 Linux 侧环境变量的巧合，≥2 键才足以定论；窗口复用 `verifyTimeoutMs`（env 输出可能很长）。
2. **探测 2：`echo $$`** —— printenv 无键时区分 Linux 与 U-Boot：**整行纯数字**（POSIX shell 把 `$$` 展开为 PID）→ `system`；**整行 `$` 或 `$$`**（U-Boot 无 PID 概念，不展开或 `$$` 转义为单个 `$`）或 **Unknown command**（老 U-Boot 无 echo；`echo` 是 POSIX 强制内建，Linux 侧不会 not found）→ `uboot`。判据必须整行锚定（`m` 标志）：串口回显的输入行 `echo $$` 本身含字面 `$$`，子串匹配会把 Linux 误判成 U-Boot。

3/4 级过渡态判据同时是**探测护栏**：autoboot 倒计时期间探测命令的回车会打断引导进入 U-Boot（状态改变事故），booting 期间探测无消费者纯浪费，故必须先于探测判定。

![detect 分类判定流程](./MCP-U-Boot标记机制分析/img/detect-classify-flow.svg)

### 3. 标记同步规则

只有**结论性结果**才动标记，过渡态与未知态保持原值：

- `uboot` → `markUbootSession()`
- `system` / `login` → `clearUbootSession()`
- `booting` / `autoboot` / `unknown` → 不动标记

## 六、 标记的消费：serial_exec 的 marker 包装

标记的消费点在 [`src/sdk/tools/serial/shell.ts`](../src/sdk/tools/serial/shell.ts) 的 `serial_exec` handler，入口先采样 `wasUboot = isUbootSession()`，据此做两个分支决策。

### 1. marker 包装风格

在 [`src/sdk/exec/exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L303) 中按 `markerStyle` 二选一：

```typescript
// src/sdk/exec/exec-runner.ts
const fullCommand: string =
  markerStyle === "plain"
    ? `${input.command}; echo "${marker}:$?"`
    : `(${input.command}); echo "${marker}:$?"`;
```

- `subshell`（未标记，POSIX shell）：子 shell 兜住 `exit`/`exec`、尾部 `&` 等会破坏外层 `echo` 的命令，并隔离 fd/PS1 等 shell 状态污染
- `plain`（已标记，U-Boot hush）：hush 无子 shell / 后台任务语法，上述威胁不存在，去掉括号即等价；`;` 为无条件顺序分隔，`echo` 必然执行，1 级 marker 检测照常生效

### 2. 2 级回落检测器收窄

U-Boot 态会话的 2 级回落检测器收窄为「仅 U-Boot 提示符集」——由 `createUbootPromptDetector()`（[`src/sdk/exec/prompt-detector.ts`](../src/sdk/exec/prompt-detector.ts#L403)）构造，而非通用默认正则。原因：U-Boot 下 TFTP/升级类命令用连续 `#` 刷进度条，通用正则「行尾 `#`」分支会把进度帧误判为 Linux root 提示符导致提前返回（实测 alg 升级 42s 的命令 406ms 即被截胡）。U-Boot 会话 plain 包装必有 marker，真结束由 1 级 marker 确定性判定，无需通用提示符参与。

![serial_exec 标记消费决策](./MCP-U-Boot标记机制分析/img/exec-marker-decision.svg)

## 七、 标记的清理

标记的存取由 [`src/sdk/tools/serial/sessions.ts`](../src/sdk/tools/serial/sessions.ts) 中三个函数完成：`markUbootSession()`（L43）、`isUbootSession()`（L49）、`clearUbootSession()`（L54）。清理路径有四条。

### 1. serial_exec 自校正（证据驱动）

U-Boot 态会话执行命令后，对「本次输出 + 前置冲刷残留（`flushed`）」做 `matchKernelBoot()` 检查，命中即判定已离开 U-Boot（`reset`/`boot`/`bootm` 或设备自行重启），清除标记，后续 `serial_exec` 恢复 subshell 包装。

证据合并是关键细节：`reset` 后内核日志晚于 exec 返回时会滞留 buffer，被下次 exec 的前置冲刷带出——合并检查避免证据随冲刷丢弃导致标记永久残留。冲刷发生在本次 `wasUboot` 采样之后，只影响自校正、不影响本次包装风格；plain 包装在 Linux sh 下照常展开，晚一拍无功能性破坏。

【**刻意不为**】不用「提示符排除法」（completedBy=prompt 且尾部非 U-Boot 提示符）清标记：负向证据不可靠，`#` 进度帧等垃圾尾部同样能触发误判（2026-08-27 事故即由此误清）。权威同步入口是 `serial_uboot_state` 的 detect/clear。

### 2. serial_read 同步清理

手动 `serial_read` 读到的内容若含内核启动特征，同样清标记。覆盖「用户手动 read 读到 reset/bootm 后内核日志」的场景——证据若被 read 取走而未判定，下次 exec 前置冲刷已无可回收材料。检测器构造失败（配置非法）时跳过检查，不阻断 read 主流程。

### 3. serial_uboot_state 手动清理

`action=clear` 强制清除；`detect` 得出 `system`/`login` 结论时自动同步清除。这是自动机制失同步时的权威人工入口。

### 4. 会话销毁

`serial_close`（[`src/sdk/tools/serial/shell.ts`](../src/sdk/tools/serial/shell.ts#L219)）在关闭会话后清标记；MCP Server 进程退出时 `disposeAllSerialSessions()`（[`src/sdk/tools/serial/sessions.ts`](../src/sdk/tools/serial/sessions.ts#L65)）对整个 `ubootSessions` Set 做 `clear()`，无泄漏。

## 八、 设计要点总结

- **单一事实源**：标记只存 `session_id`，环境真相在设备端；检测（detect）负责同步，exec/read 负责自校正，close 负责回收
- **正向证据驱动**：设置靠提示符/环境变量键（阳性），清理解靠内核启动特征（阳性）；负向证据（提示符不在）一律不作为清理依据
- **失败快速化**：任一层命中内核特征立即失败；配置非法构造期抛错，不进轮询
- **合并而非覆盖**：用户配置只增不减，保证默认行为始终兜底；字面相等判断避免语义等价的复杂分析
- **零副作用优先**：detect 先读缓冲区尾部锚点，能不动串口就不动串口；形态无区分度的场景（`#` 等）由两段式行为探测兜底（printenv ≥2 键 → echo $$），探测命令消耗一行输入且有明确警告
