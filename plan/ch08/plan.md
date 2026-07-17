<!-- more -->

## 一、 架构概览

本次改造在现有「传输层 BaseShell + 工具层 handler」两层架构上,新增一层**共享 exec 编排逻辑**,把三个通道复制粘贴的 exec 主体抽出来统一实现,各通道 handler 只保留差异。

改造后分三层:

- **传输层(小改)**:`BaseShell` 及 `AdbShell`/`SSHShell`/`SerialShell`,提供 `write`/`read`/`drain`。仅 `AdbShell` 的 spawn 参数从 `shell` 改为 `shell -t -t`(强制 PTY 回显提示符),`SSHShell`/`SerialShell` 不动
- **共享编排层(新增)**:封装「前置冲刷 + 轮询 + 提示符检测 + 超时熔断」的统一逻辑,以及「发送控制字符」的统一动作。三个通道共用
- **工具层(修改 + 新增)**:三个通道的 `*_shell_exec` handler 改为调用共享编排层;各新增一个 `*_shell_send_ctrl`(serial 为 `serial_send_ctrl`)handler

各组件职责:

- **PromptDetector**:封装 shell 提示符识别,支持默认正则与设备配置覆盖
- **ExecRunner**:封装 exec 的完整流程(前置冲刷 → 发命令 → PTY 回显剥离 → 轮询 buffer 检测提示符 → 超时熔断),对三个通道统一
- **sendControlChar**:封装发送控制字符的统一动作(不追加换行 + 清空 buffer + 短暂等待),三个通道的 send_ctrl handler 共用
- **config 扩展**:在 `DeviceConfig` 增加可选的提示符正则字段

## 二、 核心数据结构

### 1. PromptDetector

提示符检测器,负责判断「命令是否结束」。不直接持有 buffer,由调用方传入当前累积输出。

```typescript
// src/mcp/shared/prompt-detector.ts

/**
 * @brief 支持的控制字符类型
 */
export type ControlChar = "c" | "u" | "d" | "z";

/**
 * @brief 控制字符到字节的映射
 */
export const CONTROL_CHAR_MAP: Readonly<Record<ControlChar, string>> = {
  c: "\x03", // Ctrl+C → SIGINT
  u: "\x15", // Ctrl+U → 清行
  d: "\x04", // Ctrl+D → EOF
  z: "\x1a", // Ctrl+Z → 挂起
};

/**
 * @brief shell 提示符检测器
 *
 * 判断一段累积输出是否已出现 shell 提示符(命令结束信号)。
 * 支持默认提示符集 + 设备配置覆盖。
 */
export class PromptDetector {
  /**
   * @brief 默认提示符正则(覆盖 Android 与常见 Linux)
   *
   * 匹配形如以下结尾的提示符:
   *   - Android:  / $  、  :/ $  、  :/ #
   *   - Linux  :  $  、  #  、  >
   *   - U-Boot :  =>  、  U-Boot>
   *
   * 锚定行尾,避免命令输出中偶然出现的 # / $ 误判。
   */
  static readonly DEFAULT_PATTERN =
    /(?:[^\r\n]*[:/]?\s*[/~]\s*[#$]\s*|[^\r\n]*[#>$]\s*|[^\r\n]*=>\s*)$/;

  private readonly pattern: RegExp;

  constructor(customPattern?: string) {
    // 配置覆盖优先;未配置时用默认
    this.pattern = customPattern
      ? new RegExp(customPattern)
      : PromptDetector.DEFAULT_PATTERN;
  }

  /**
   * @brief 检测累积输出是否以提示符结尾
   *
   * 注意:PTY 回显的命令行本身不以提示符结尾,只有命令执行完返回
   * 到交互态时才会出现提示符。因此检测「输出末尾」即可。
   *
   * @param accumulated 当前累积的全部输出
   * @returns true 表示已检测到提示符,命令结束
   */
  detect(accumulated: string): boolean {
    return this.pattern.test(accumulated);
  }
}
```

### 2. ExecRunner

exec 的统一编排逻辑。输入是「shell 实例 + 命令 + 参数」,输出是结构化结果。

```typescript
// src/mcp/shared/exec-runner.ts

/**
 * @brief 统一 exec 的输入参数
 */
export interface ExecInput {
  /** 目标 shell 实例(任意通道的 BaseShell 子类) */
  shell: InteractiveShell;
  /** 要执行的命令字符串 */
  command: string;
  /** 旧 delay 参数(保留向后兼容,作为最小轮询时长下限) */
  delay?: number;
  /** 旧 clear 参数(保留向后兼容) */
  clear?: number;
  /** 最大执行时长,默认 10000ms。超时则熔断 */
  maxDuration?: number;
  /** 轮询间隔,默认 200ms */
  pollInterval?: number;
  /** 提示符检测器(已根据设备配置初始化) */
  promptDetector: PromptDetector;
  /** 控制字符发送函数(由各通道注入,封装差异) */
  sendCtrl: (key: ControlChar) => void;
  /** 日志前缀,如 "[adb_shell_exec]" */
  logPrefix: string;
}

/**
 * @brief 统一 exec 的输出结果
 *
 * 三态语义:
 *   - 正常完成(检测到提示符): interrupted=false, timedOut=false
 *   - 超时熔断(到 maxDuration 未现提示符): interrupted=false, timedOut=true
 *     —— 中性语义。常用于「故意取 N 秒输出」(如 logcat 取 5 秒日志),
 *        是预期的行为,不是异常。
 *   - 异常(发命令即无响应等): 走错误路径,不在此结构返回
 */
export interface ExecResult {
  /** 累积的全部输出文本 */
  output: string;
  /** 是否因异常被中断(保留字段,当前实现恒为 false;预留给未来异常路径) */
  interrupted: boolean;
  /** 是否因到达 maxDuration 超时熔断(中性语义,非异常) */
  timedOut: boolean;
  /** 实际执行时长(毫秒),用于格式化标注 */
  elapsedMs: number;
}

/**
 * @brief 执行交互式 shell 命令的统一流程
 *
 * 流程:
 *   1. 前置冲刷:drain() 丢弃缓冲区残留
 *   2. 发命令:shell.write(command, clear)
 *   3. 轮询 buffer(最长 maxDuration):
 *      - 检测到提示符 → 立即返回(interrupted=false, timedOut=false)
 *      - 超过 maxDuration 仍未现提示符 → 发 Ctrl+C 熔断
 *        返回(interrupted=false, timedOut=true),标注为中性「timed-out」
 *   4. 至少轮询满 minDelay(兼容旧 delay 语义),保证短命令也有输出
 *
 * timed-out 与 interrupted 的区别:
 *   - timed-out:到达时间上限的预期行为(logcat 取 N 秒、top 采样),输出已收集,
 *     LLM 应视为正常采样结果,不是出错。
 *   - interrupted:命令因异常被强行打断。当前 runExec 不会产生此状态(恒为 false),
 *     保留字段供未来异常路径(如进程崩溃、连接断开)使用。
 *
 * @returns 结构化结果,由各通道 handler 格式化为 MCP 响应
 */
export async function runExec(input: ExecInput): Promise<ExecResult>;
```

### 3. sendControlChar

发送控制字符的统一动作。三个通道的 send_ctrl handler 各自注入「如何从 session_id 取 shell」,但发送逻辑共用。

```typescript
// src/mcp/shared/send-ctrl.ts

/**
 * @brief 发送控制字符的统一流程
 *
 * 流程:
 *   1. 查映射表得到字节(如 "c" → "\x03")
 *   2. 以 appendLineEnding=false 调用 shell.write,保证不追加换行
 *   3. 清空缓冲区(丢弃残留 + 控制字符可能的回显)
 *   4. 短暂 sleep(默认 200ms)让信号生效
 *   5. 返回发送确认
 *
 * @param shell       目标 shell 实例
 * @param key         控制字符类型
 * @param settleMs    信号生效等待时长,默认 200ms
 * @returns 发送的字节字符串
 */
export async function sendControlChar(
  shell: InteractiveShell,
  key: ControlChar,
  settleMs?: number
): Promise<string>;
```

## 三、 模块设计

### 1. 共享编排模块(src/mcp/shared/)

**职责:** 提供三个通道共用的 exec 编排、控制字符发送、提示符检测能力。

**对外接口:** `runExec`、`sendControlChar`、`PromptDetector`、`CONTROL_CHAR_MAP`、`ControlChar` 类型。

**依赖:** `InteractiveShell` 接口(类型)、`logger`。不依赖任何具体传输类,保持通道无关。

### 2. config 扩展(src/shared/config.ts)

**职责:** 在设备配置中增加可选的提示符正则字段,供 PromptDetector 初始化时读取。

**改动:** `DeviceConfig` 增加设备级可选字段 `promptPattern?: string`。新增导出函数 `getPromptPattern(deviceName?: string): string | undefined`。

### 3. 三个通道的 exec handler 改造

**职责:** 各通道的 `*_shell_exec` handler 改为构造 `ExecInput` 后调用 `runExec`,并把 `ExecResult` 格式化为 MCP 响应。

**依赖:** 共享编排模块 + 各自的 session store + `getPromptPattern`。

**响应格式约定(三态):**
- 正常完成(`timedOut=false`):返回原始输出,无额外标注
- 超时熔断(`timedOut=true`):在输出末尾追加中性标注 `\n[timed-out: collected ${elapsedMs}ms of output, Ctrl+C sent]`。这是中性语义——告诉调用方「到时间了,输出已收集」,而非「命令异常被杀」,避免 LLM 误判 logcat 取 N 秒这类预期采样为错误

### 4. 三个通道的 send_ctrl handler(新增)

**职责:** 各通道新增一个发送控制字符工具,handler 从各自 store 取 shell,调用 `sendControlChar`。

| 通道 | 工具名 | handler |
|------|--------|---------|
| adb | `adb_shell_send_ctrl` | `adbShellSendCtrlHandler` |
| ssh | `ssh_shell_send_ctrl` | `sshShellSendCtrlHandler` |
| serial | `serial_send_ctrl` | `serialSendCtrlHandler` |

**输入参数:** `{ session_id: string; key: "c" | "u" | "d" | "z" }`。

**依赖:** 共享编排模块 + 各自 session store。

## 四、 模块交互

### 1. send_ctrl 调用链

```
LLM 调用 adb_shell_send_ctrl(session_id, key="c")
  → adbShellSendCtrlHandler
    → adbStore.getOrNotFound(session_id) → 取 AdbShell 实例
    → sendControlChar(shell, "c")
      → shell.write("\x03", clear=1, appendLineEnding=false)
      → shell.drain() 丢弃回显/残留
      → sleep(200ms)
    → 返回 "Ctrl+C sent (0x03)"
```

### 2. exec 调用链(以 adb 为例)

```
LLM 调用 adb_shell_exec(session_id, command="logcat")
  → adbShellExecHandler
    → adbStore.getOrNotFound(session_id) → 取 AdbShell 实例
    → getPromptPattern(deviceName) → 取设备配置的提示符正则(可能为空)
    → new PromptDetector(pattern)
    → 构造 sendCtrl 闭包: (key) => shell.write(CONTROL_CHAR_MAP[key], 1, false)
    → runExec({ shell, command, promptDetector, sendCtrl, logPrefix })
      → shell.drain()  前置冲刷
      → shell.write(command, clear)
      → PTY 回显剥离:轮询找首行 \n,丢弃回显行,保留其后内容
      → while (elapsed < maxDuration):
          sleep(pollInterval)
          accumulated += shell.drain()
          if promptDetector.detect(accumulated): return { output, interrupted:false, timedOut:false, elapsedMs }
      → 超时:sendCtrl("c") + sleep(300ms) + accumulated += shell.drain()
      → return { output: accumulated, interrupted:false, timedOut:true, elapsedMs }
    → handler 格式化:正常完成返回 output;超时熔断返回 output + "\n[timed-out: collected ${elapsedMs}ms of output, Ctrl+C sent]"
```

### 3. 提示符配置数据流

```
config.yaml (devices.board-b.promptPattern)
  → loadConfig() (已有,缓存)
  → getPromptPattern(deviceName)  [新增]
  → adbShellExecHandler 调用时传入 PromptDetector
```

## 五、 文件组织

```
src/
├── mcp/
│   ├── shared/                         [新增目录]
│   │   ├── prompt-detector.ts          — PromptDetector、CONTROL_CHAR_MAP、ControlChar
│   │   ├── exec-runner.ts              — runExec、ExecInput、ExecResult
│   │   └── send-ctrl.ts                — sendControlChar
│   └── tools/
│       ├── adb/
│       │   ├── shell.ts                — [修改] adbShellExecHandler 改调 runExec
│       │   └── index.ts                — [修改] 注册 adb_shell_send_ctrl
│       ├── ssh/
│       │   ├── shell.ts                — [修改] sshShellExecHandler 改调 runExec
│       │   └── index.ts                — [修改] 注册 ssh_shell_send_ctrl
│       └── serial/
│           ├── shell.ts                — [修改] serialExecHandler 改调 runExec
│           └── index.ts                — [修改] 注册 serial_send_ctrl
├── shared/
│   └── config.ts                       — [修改] DeviceConfig 加 promptPattern、新增 getPromptPattern
└── transports/
    ├── adb.ts                          — [修改] spawn 参数 shell → shell -t -t(强制 PTY 回显提示符)
    ├── base-shell.ts                   — [不动]
    ├── ssh.ts                          — [不动] 本就有 PTY
    └── serial.ts                       — [不动] 物理串口天然有终端
```

send_ctrl 的 handler 放哪里:三个通道的 send_ctrl handler 分别写在各自通道的 `shell.ts` 中(与该通道的 open/write/read/exec handler 同文件),保持通道内聚。共享逻辑(发送动作)在 `mcp/shared/send-ctrl.ts`。

## 六、 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| send_ctrl 工具数量 | 每通道一个(共 3 个) | session store 通道隔离 + MCP 工具命名按通道前缀,通用工具需改 store 层(违反 N2)且破坏 LLM 工具选择心智 |
| exec 主体逻辑复用 | 抽到共享层 `runExec`,三通道调用 | 消除复制粘贴(F5);各通道差异(取 shell、取配置)通过参数注入 |
| 提示符检测位置 | 工具/编排层;传输层仅 adb.ts 加 `-t -t` | 检测逻辑属于工具层职责;adb 需 PTY 才回显提示符,改动仅 spawn 参数(见下方 PTY 决策) |
| adb PTY 分配 | `shell -t -t` 强制 PTY | 真机验证发现:adb 默认无 PTY 不回显提示符,提示符检测完全失效;单 `-t` 因 stdin 非 terminal 被拒,需两个 `-t` 强制;ssh/serial 本就有终端,不动 |
| PTY 回显剥离 | runExec 发命令后丢弃首行(到第一个 `\n`) | PTY 会原样回显命令行(如 `:/ $ echo hi`),不剥离会污染输出;借鉴 ssh_build 步骤 4 同一解法,最多重试 10 次找 `\n` |
| 提示符正则配置粒度 | 设备级(`DeviceConfig.promptPattern`) | 同一台设备的 adb/ssh/serial 提示符通常一致;放设备级避免三处重复配置 |
| 提示符检测策略 | 锚定输出末尾 + 默认正则覆盖常见 prompt + 配置覆盖 | 锚定末尾降低误判(命令输出中间的 `#`/`$` 不匹配);不追求完美,靠熔断兜底(spec 不做的事第 5 条) |
| 熔断动作 | 超时发 Ctrl+C + 短暂等待 + 返回中性标注 timed-out(非 interrupted) | 超时是「到时间上限」的预期行为(如 logcat 取 N 秒),用中性 timed-out 标注避免 LLM 误判为异常;`interrupted` 字段保留但当前恒为 false,供未来异常路径 |
| maxDuration 默认值 | 10000ms | 你已确认(阶段一澄清);对瞬时命令富余,对 logcat 10 秒熔断 |
| 轮询机制 | sleep + drain 累积(底层模式借鉴 ssh_build) | ssh_build 已验证「drain 轮询 + deadline」模式可行;但结束检测与超时处理与 ssh_build 不同——ssh_build 用注入 marker(确定性、不杀命令),runExec 用提示符正则(启发式、超时发 Ctrl+C),两者机制不同,仅轮询骨架复用 |
| 前置冲刷实现 | drain()(保留 collecting) | 清掉残留但不停止数据收集,发命令后能正常接收新输出 |
| send_ctrl 是否等待生效 | sleep 200ms | 给 SIGINT 传递 + 远端响应留时间;不可靠场景由调用方再调一次 |
| 旧 delay 参数语义 | 保留作为「最小轮询时长」下限 | 向后兼容(N1);避免新逻辑让原本等 1000ms 的短命令反而瞬间返回空 |
| 控制字符回显处理 | send_ctrl 后 drain() 丢弃 | 控制字符本身可能在 PTY 下回显(如 `^C`),丢弃避免污染下次 read |

## 七、 编码规范

**编程语言:** TypeScript

**适用的语言规范技能:** ts-lang-spec

**文件编码规则:**
- **新建文件**:`mcp/shared/` 下三个新文件(prompt-detector.ts、exec-runner.ts、send-ctrl.ts)使用 UTF-8 无 BOM、LF 换行
- **修改已有文件**(config.ts、三个 shell.ts、三个 index.ts):保持原文件编码与换行符不变

开发阶段编写代码时,必须遵循 ts-lang-spec 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用 ts-lang-spec 技能,并严格遵守上述文件编码规则。

---
*本文档由 code-spec 技能辅助生成*
