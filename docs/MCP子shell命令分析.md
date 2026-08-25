<!-- more -->

## 一、 子shell简介

### 1. 什么是子shell

在 POSIX shell（Bash / sh / ash 等）中，用一对圆括号 `( command )` 包裹的命令会在一个独立的 **子 shell** 环境中执行。子 shell 是当前 shell 环境的副本，拥有独立的环境状态：

- 子 shell 内部的 `cd`、变量赋值、`export`、文件描述符重定向、`umask`、信号陷阱（trap）等状态变更**不会泄漏**到父 shell
- 子 shell 执行结束后，父 shell 状态恢复原样
- 圆括号是合法的复合命令，可以和其他语法（`;`、`&&`、`||`）组合成一行

配合两个基础语法，即可在一行内完成「执行命令 → 报告结果」的完整序列：

- `;`：无条件顺序分隔符，前一条命令无论成败都继续执行下一条
- `$?`：上一条命令的退出码

```sh
(cmd); echo "exit code: $?"
```

上面这行中，`cmd` 在子 shell 内运行，退出码通过 `$?` 传入父 shell 的 `echo`，输出形如 `exit code: 0`。

并不是所有 shell 都有子 shell 语法。U-Boot 的 hush shell 就没有圆括号复合命令，也不支持后台任务符 `&`，在这种环境下只能退化为 `cmd; echo ...` 的顺序拼接写法（详见第三章）。

### 2. 为什么MCP要用子shell执行命令

MCP 工具的 `*_exec` 系列（`serial_exec` / `ssh_exec` / `adb_shell_exec`）是在**长生命周期**的交互式 shell 会话里执行命令，会话会被反复复用。执行用户任意命令后，框架还要可靠地判定「命令是否执行完」，因此命令尾部必须拼接一个完成标记（marker）。如果只做最简单的拼接：

```sh
cmd; echo "MARKER:$?"
```

把命令**直接**放进外层会话执行，会引入一系列破坏性风险：

| 威胁 | 直接拼接的后果 |
| --- | --- |
| `exit` / `logout` | 终止外层 shell，整个会话死亡，后续所有 exec 全部无响应 |
| `exec` | 用新进程替换外层 shell，会话被换掉，连接基本失效 |
| 尾部 `&`（后台任务） | 拼接成 `cmd &; echo ...`，`&;` 是语法错误，**整行被 shell 拒绝**，命令根本不执行 |
| `cd` / 环境变量 / `PS1` / fd 劫持 | 改变会话的持久状态（工作目录、提示符、描述符），污染后续命令的输出与结束判定 |

而用子 shell 把命令包起来 `(cmd); echo ...` 后，上述威胁全部化解：

- `exit` / `exec` 只在子 shell 内生效，杀不掉外层会话
- 尾部 `&` 变成 `(cmd &); echo ...`，括号内后台任务是合法语法，命令照常执行
- `cd`、`PS1`、fd 等状态变更被子 shell 隔离，不外泄到长生命周期会话
- 子 shell 结束返回父 shell，尾部 marker `echo` **必然执行**，命令结束判定得以保证

因此子 shell 是「在可复用的交互式会话里安全执行任意命令 + 可靠判定命令结束」的最小、最稳妥的包装方式。

## 二、 命令怎么封装的

### 1. 两种封装风格

统一编排器 `runExec()` 按目标环境从两种封装风格中二选一：

```sh
# subshell（POSIX shell：Linux / Android，默认）
(cmd); echo "___MCP_EXEC_DONE_<rand>___:$?"

# plain（U-Boot hush，serial_enter_uboot 标记的会话自动切换）
cmd; echo "___MCP_EXEC_DONE_<rand>___:$?"
```

两种风格的共同点：

- `;` 为无条件顺序分隔符，无论 `cmd` 成败，`echo` 都必然执行
- marker 带 6 位随机后缀（`___MCP_EXEC_DONE_a3f7b2___`），避免命令输出中偶然出现相同字符串导致误判
- marker 后拼接退出码 `$?`，随命令结果一并回传

### 2. 封装代码位置

命令拼接发生在 [`exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L294-L302) 的 `runExec()` 中：

```ts
// src/sdk/exec/exec-runner.ts
const marker: string = generateMarker();
const markerRegex: RegExp = buildMarkerRegex(marker);
const fullCommand: string =
  markerStyle === "plain"
    ? `${input.command}; echo "${marker}:$?"`
    : `(${input.command}); echo "${marker}:$?"`;
logger.info(
  `${input.logPrefix} command (${markerStyle} marker): ${fullCommand}`
);
input.shell.write(fullCommand, clear);
```

- `MarkerStyle` 类型定义在 [`exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L130)：`"subshell"`（默认）与 `"plain"` 两种取值
- `ExecInput.markerStyle` 字段由各通道 handler 注入，SSH 与 ADB 恒为默认 `subshell`；串口在 U-Boot 态会话注入 `plain`（见第三章）

### 3. marker 检测与防误判

marker 的匹配正则构造于 [`exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L91-L93)：

```ts
// src/sdk/exec/exec-runner.ts
function buildMarkerRegex(marker: string): RegExp {
  return new RegExp(`(?<!")${marker}:(\\d+|\\$\\?)`);
}
```

- 捕获退出码支持两种形态：`\d+`（shell 展开后的数字退出码）与 `\$?`（U-Boot 老 simple parser 不展开、原样输出的字面量，此时退出码未知，按 null 处理）
- 负向后行断言 `(?<!")` 排除 PTY 回显行里的字面 marker：注入的命令是 `echo "<marker>:$?"`，回显行中 marker 前紧邻双引号；真实输出的 marker 前是行首或换行。即使回显剥离失败，回显行残留也不会被误判为命令完成

检测采用两级策略（[`exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L350-L394)）：

| 级别 | 检测方式 | 特点 |
| --- | --- | --- |
| 1级 | marker 子串匹配 | 确定性、首选，不受刷屏影响，附带退出码 |
| 2级 | 提示符末尾锚定（`PromptDetector.detect`） | 无刷屏设备快路径，marker 未出现时的回落 |

命中后按 marker 命中位置截断输出，只返回命令输出（不含 marker 行）。

### 4. 完整执行流程

`runExec()` 的完整流程（[`exec-runner.ts`](../src/sdk/exec/exec-runner.ts#L249-L431)）：

1. **常驻分类**：判定命令是否常驻（`ping` / `logcat` / `top` 等永不返回提示符的命令），据此选择超时时长与超时动作
2. **前置冲刷**：`shell.drain()` 丢弃缓冲区残留，避免上次未终止的输出污染本次结果
3. **发命令**：拼接好的 `(cmd); echo "MARKER:$?"` 一次性写入
4. **PTY 回显剥离**：丢弃首行（提示符 + 命令回显），`\n` 之后才是真实输出
5. **轮询检测**：以 200 ms 间隔 `drain()` 累积输出，依次做 1级 marker、2级 提示符末尾锚定
6. **超时熔断**：deadline 到期仍未结束，按常驻性分支——常驻命令发 Ctrl+C 采样终止，普通命令不发中断仅返回兜底超时

### 5. 子shell 兜底能力一览

| 场景 | subshell（`(cmd); echo ...`） | plain（`cmd; echo ...`） |
| --- | --- | --- |
| `exit` / `logout` | 只退出子 shell，外层会话存活 | U-Boot 无此类命令，无威胁 |
| `exec` | 只替换子 shell，外层会话存活 | U-Boot 无此类命令，无威胁 |
| 尾部 `&` | `(cmd &); echo ...` 合法，照常执行 | U-Boot 无后台任务语法，无威胁 |
| `cd` / 环境变量 / `PS1` / fd | 隔离在子 shell 内，不外泄 | U-Boot 无 cd / 环境变量状态可污染 |

## 三、 uboot下的处理

### 1. U-Boot hush shell 与 POSIX shell 的差异

U-Boot 的命令行解释器是 hush shell 的一个精简实现，与 POSIX shell 存在明显差异：

- **没有子 shell 语法**：`( cmd )` 会被当作非法命令整行拒绝
- **没有后台任务语法**：不支持 `&`
- **没有** `exit` / `exec` / `logout` 这类会终止或替换会话的命令
- **没有** `cd`、环境变量、`PS1` 等可污染的状态（shell 状态不随命令残留）

因此第一章列出的子 shell 要解决的威胁，在 U-Boot 环境下全部不存在，**去掉圆括号的 `cmd; echo ...` 就是同等安全等级的等价写法**。

### 2. U-Boot 会话标记机制

既然 plain 与 subshell 二选一，框架必须知道当前会话处于哪种环境。串口通道用一套「U-Boot 会话标记」来记录：

| 环节 | 行为 | 代码位置 |
| --- | --- | --- |
| `serial_enter_uboot` | 成功进入 U-Boot 后 `markUbootSession(session_id)` 置位 | [`shell.ts`](../src/sdk/tools/serial/shell.ts#L1269) |
| `serial_uboot_state` | `detect` 自动同步（检测到 uboot 置位 / 检测到系统清除），`set` / `clear` 强制设置 | [`shell.ts`](../src/sdk/tools/serial/shell.ts#L1541-L1545) |
| `serial_exec` | 读取 `isUbootSession()`，据此注入 `markerStyle: "plain"` | [`shell.ts`](../src/sdk/tools/serial/shell.ts#L509) |
| `serial_close` / 进程退出 | 清理标记，避免残留 | [`sessions.ts`](../src/sdk/tools/serial/sessions.ts#L46) |

标记的增删统一收敛在 [`sessions.ts`](../src/sdk/tools/serial/sessions.ts#L36-L48) 的 `markUbootSession()` / `clearUbootSession()` 两个函数，任何路径的置位与清理都会打印日志：

```ts
// src/sdk/tools/serial/sessions.ts
export function markUbootSession(sessionId: string): void {
  ubootSessions.add(sessionId);
  logger.info(`[serial] U-Boot mark set for session ${sessionId}`);
}

export function clearUbootSession(sessionId: string): void {
  ubootSessions.delete(sessionId);
  logger.info(`[serial] U-Boot mark cleared for session ${sessionId}`);
}
```

### 3. plain 风格在 U-Boot 下的执行

U-Boot 态的 `serial_exec` 以 `markerStyle: "plain"` 调用 `runExec()`，实际写入串口的命令为：

```sh
cmd; echo "___MCP_EXEC_DONE_<rand>___:$?"
```

执行与检测要点：

- **1级 marker 检测照常生效**：`;` 无条件分隔，`echo` 必然执行，marker 出现即命令结束
- **退出码分两种**：hush 会展开 `$?`，输出 `marker:0` 等数字；U-Boot 老 simple parser 不做变量展开，原样输出字面量 `marker:$?`，此时框架无法得知退出码，`exitCode` 按 `null` 处理
- **2级提示符检测固定用默认正则**：U-Boot 态不走设备配置的 `promptPattern`——`promptPattern` 是为 Linux PS1 配置的，在 `=>` 提示符下可能永不命中。默认正则同时覆盖 U-Boot（`=>`、`U-Boot>`）与常见 Linux/Android 提示符，命令执行完既能锚定 U-Boot 提示符，也能在离开 U-Boot 落到 Linux 提示符时尽快返回

### 4. 离开 U-Boot 的自校正

U-Boot 会话标记并非一成不变。`serial_exec` 在 U-Boot 态执行完命令后，会做一次自校正（[`shell.ts`](../src/sdk/tools/serial/shell.ts#L519-L537)），检测本次执行是否表明设备已离开 U-Boot：

- 输出出现内核启动特征（`Starting kernel` / `Linux version`）→ 清除标记
- 2级提示符锚定正常结束、且末尾提示符**已不是** U-Boot 提示符 → 清除标记
- 1级 marker 完成（输出截断于 marker、不含末尾提示符）→ **不判定**，标记保留：plain 包装在 Linux 下同样可用，仅失去子 shell 防护，无功能性破坏

### 5. 边界与注意

- **命令被 hush 拒绝**：U-Boot 遇到不认识的命令（如 `cd`）会整行报错但不终止会话，marker 不出现，靠 2级 提示符末尾锚定返回，不会等满兜底超时
- **`serial_uboot_state` detect 的探测回车**：检测环境时会发送一个空回车让设备重绘提示符；若此时有命令仍在运行或等待交互输入（如 Y/N），探测回车可能替它作答，需在命令执行完毕后再 detect
- **simple parser 无退出码**：老 U-Boot 下 `serial_exec` 返回结果不含 `[exit code: N]` 标注，属于预期行为，不表示命令失败

---

*本文档由 markdowncli 技能辅助生成*