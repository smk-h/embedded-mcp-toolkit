# serial_enter_uboot 配置化与提示符鲁棒性 Plan

## 架构概览

本次改造涉及三个模块，按职责从下到上分层：

```
┌─────────────────────────────────────────────────────────────┐
│  serial_enter_uboot handler (shell.ts)                       │
│  检测流程编排：autoboot → 提示符 → printenv 验证 → 失败返回   │
└───────────────┬─────────────────────────────────────────────┘
                │ 调用
┌───────────────▼─────────────────────────────────────────────┐
│  prompt-detector.ts (扩展现有文件)                            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ PromptDetector 类 (已有，不动) — exec 命令结束判定       │ │
│  │ UbootDetector 类 (新增) — uboot 状态四件套检测           │ │
│  │   matchAutoboot / matchPrompt / matchVerifyKey /         │ │
│  │   matchKernelBoot + UbootDefaults                        │ │
│  │   配置值直接 new RegExp() 构造，不做任何预处理            │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────┬─────────────────────────────────────────────┘
                │ 配置来源
┌───────────────▼─────────────────────────────────────────────┐
│  config.ts (DeviceConfig.serial.uboot + getUbootConfig)      │
│  配置 schema 扩展 + 读取函数                                  │
└─────────────────────────────────────────────────────────────┘
```

**设计原则**：
- **检测逻辑与流程编排分离**：`UbootDetector` 只管"这段输出匹配吗"，不碰串口；handler 只管编排，不直接构造正则。`UbootDetector` 可独立单测，handler 改动最小。
- **shell 状态检测能力归一**：`prompt-detector.ts` 主题从"提示符检测"拓宽为"shell 状态/提示符检测"，`PromptDetector`（exec 用）与 `UbootDetector`（enter uboot 用）并列共存，各管各的配置字段。文件名不改——三处 import（adb/ssh/serial shell.ts）零改动。
- **配置即正则，所见即所得**：yaml 中字段值直接写 JavaScript 正则源码字符串，由 `new RegExp(source)` 构造。不引入模糊化、转义、前缀语法等预处理，正则行为完全可预测，降低实现与调试成本。

## 核心数据结构

### UbootConfig（配置层，config.ts）

```ts
interface UbootYaml {
  autobootPrompts?: string[];   // autoboot 提示字符串数组，自然字符串或 re: 前缀
  prompt?: string;              // 命令提示符，自然字符串或 re: 前缀
  verifyEnvKeys?: string[];     // 事后验证的环境变量键名数组（纯字面量，不做正则转换）
}

// 挂在 DeviceConfig.serial 下：
interface DeviceConfig {
  // ... 现有字段 ...
  serial?: {
    // ... 现有字段 ...
    uboot?: UbootYaml;
  };
}
```

`verifyEnvKeys` 故意不做正则转换——它匹配的是 `printenv` 输出里 `<key>=` 这种结构，键名是固定标识符（`baudrate`、`bootdelay`），用字面量 `indexOf` 即可，正则反而易错。

### UbootDefaults（默认值常量，prompt-detector.ts）

```ts
const UbootDefaults = {
  // 正则源码字符串，由 new RegExp(source, flags) 构造
  autobootPrompts: [
    "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot",  // Ctrl+u 优先（发 \x15）
    "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot", // 次之（发换行）
  ],
  prompt: "(?:=>|U-Boot>)\\s*$",                  // 等价原 UBOOT_PROMPT_RE
  verifyEnvKeys: ["baudrate", "bootdelay"],        // 纯字面量，不走正则
  verifyTimeoutMs: 4000,                            // 验证层窗口（满足 N2 的 ≤5 秒）
  kernelBootPattern: "Starting\\s+kernel|Linux\\s+version",
} as const;
```

默认值与 spec F4 完全对应：作为**合并基准**，用户配置补充其上而非替换。未配置时合并结果等同默认值本身，行为等价于当前硬编码实现（AC1 兼容）。

**flags 处理**（保持与原硬编码一致）：
- 原硬编码 `AUTOBOOT_*_RE` 带 `i` 标志，`UBOOT_PROMPT_RE` 不带——前者文案可能大小写不一，后者 `=>`/`U-Boot>` 是固定大小写
- `UbootDetector` 构造时，autoboot 与 kernelBoot 用 `new RegExp(source, "i")`，prompt 用 `new RegExp(source)`（无 flags）
- 用户配置的 autoboot/prompt 值统一套用上述规则——即 autoboot 自动大小写不敏感，prompt 大小写敏感。这是合理默认，避免用户在 yaml 里还要管 flags

### UbootDetector（检测器，prompt-detector.ts 新增类）

```ts
class UbootDetector {
  constructor(config?: UbootYaml);

  /** 匹配 autoboot 提示，返回对应中断键或 null */
  matchAutoboot(output: string): "\n" | "\x15" | null;

  /** 匹配命令提示符（输出末尾） */
  matchPrompt(output: string): boolean;

  /** 匹配事后验证的环境变量键 */
  matchVerifyKey(output: string): boolean;

  /** 匹配内核启动特征（用于即判失败） */
  matchKernelBoot(output: string): boolean;

  /** 验证层超时窗口（毫秒） */
  readonly verifyTimeoutMs: number;

  /** 导出合并后实际生效的正则字符串快照（供 regex-verify -v 调试用） */
  getDebugState(): {
    autobootPatterns: ReadonlyArray<{ source: string; flags: string; interruptKey: "\n" | "\x15" }>;
    prompt: { source: string; flags: string };
    verifyKeys: readonly string[];
    kernelBoot: { source: string; flags: string };
    verifyTimeoutMs: number;
  };
}
```

**中断键选择规则**（与现有硬编码逻辑等价）：遍历 `autobootPrompts` 数组，命中含 `Ctrl+u` 字样（大小写不敏感）的条目返回 `\x15`，命中其余返回 `\n`。**数组顺序即优先级**——若把 `Ctrl+u` 条目放前面，优先返回 `\x15`。

### UbootDetector 构造逻辑

```
config (UbootYaml)
  → 三字段分别与 UbootDefaults 合并（非替换）+ 去重：
      autobootPrompts: dedupPreserveOrder(默认数组 + 用户数组)  按字面去重保持顺序
      verifyEnvKeys:   Array.from(new Set([...默认, ...用户]))   Set 去重
      prompt:          用户值 === 默认值 ? 默认值
                       : mergePromptPattern(默认, 用户)         字面相等则跳过联合
  → 用 new RegExp(source, flags) 构造（autoboot/kernelBoot 带 i，prompt 无 flags）
  → 缓存 RegExp 实例，match* 方法直接 test()
```

**去重的意义**：用户照抄默认值时（常见场景），合并不应产生冗余条目或嵌套正则（如 `(?:A|A)`）。去重只做字面相等判断，不做正则语义等价——覆盖"用户抄默认"场景即可，复杂等价判断不在范围。

**合并语义的关键不变量**：用户未配置时，合并结果等同默认值本身（`默认 + []` = `默认`），保证 AC1 兼容。

**prompt 合并的具体策略**（保守，避免边界 case）：
1. 用户值与默认值字面相等 → 直接用默认值（跳过联合，避免 `(?:A|A)` 嵌套冗余）
2. 否则用正则 `/\s*\$$/` 剥离默认值和用户值的尾部 `\s*$`，得到核心部分
3. 剥离成功 → 联合为 `(?:<默认核心>|<用户核心>)\s*$`
4. 剥离失败（用户值末尾没有 `\s*$`）→ 退化为 `(?:<默认原值>|<用户原值>)`，各自保留原锚

正则构造失败的错误处理：`new RegExp` 抛错（如括号不闭合）时，让错误向上传播，由 handler 捕获并返回明确配置错误响应（满足 N4）。

## 模块设计

### 模块 A：config.ts 扩展

**职责**：扩展 `DeviceConfig.serial` 增加 `uboot` 子段；新增 `getUbootConfig(name?)` 读取函数。

**对外接口**：

```ts
export function getUbootConfig(name?: string): UbootYaml;
```

返回值合并规则（与 `getSerialConfig` 风格一致）：

- 取 `device.serial?.uboot ?? {}`
- 不做"环境变量覆盖"——uboot 配置只从 yaml 读（无对应环境变量的现实需求）
- 空对象 `{}` 由 `UbootDetector` 构造时回退默认值

**依赖**：仅依赖现有 `getDeviceConfig`。

### 模块 B：prompt-detector.ts 扩展（新增 UbootDetector 类）

**职责**：在现有文件中新增 `UbootDetector` 类与 `UbootDefaults` 常量，`PromptDetector` 类**不动**。

**对外接口**：导出 `UbootDetector` 类。

**依赖**：`UbootYaml` 类型（从 config.ts import）。

**正则构造方式**：配置值（`autobootPrompts` / `prompt`）是 JavaScript 正则源码字符串，由 `new RegExp(source, flags)` 构造，不做任何预处理。flags 规则见上方「UbootDefaults」段（autoboot/kernelBoot 带 `i`，prompt 无 flags）。

**决策**：并入 `prompt-detector.ts` 而非新建文件——
- `UbootDetector` 的 prompt 检测与 `PromptDetector` 同属"shell 状态/提示符检测"主题
- 避免 `=>` 默认值在两个文件里各有身影（`PromptDetector.DEFAULT_PATTERN` 已含 `=>`）
- 零新增文件，三处 import（adb/ssh/serial shell.ts）无需改动

文件名 `prompt-detector` 语义拓宽为"shell 状态/提示符检测"，不改名——改名将牵动三处 import，放大改动面。

### 模块 C：serialEnterUbootHandler 改造

**职责**：编排检测流程，串联模块 A（config）与模块 B（UbootDetector）。

**新流程**（对应 spec F3）：

```
1. shell.write("reboot")
2. deviceName = shell.getDeviceName()
3. detector = new UbootDetector(getUbootConfig(deviceName))
   └─ 构造失败 → 立即返回配置错误响应
4. while (未超总超时):
     读输出累积到 allOutput
     if 未中断:
       key = detector.matchAutoboot(allOutput)
       if key: shell.sendRaw(key); enteredUboot=true; allOutput=""
     if 已中断:
       if detector.matchKernelBoot(allOutput): 返回失败（kernel 已启动）
       if detector.matchPrompt(allOutput): 返回成功   ← 主层命中
       if 主层窗口耗尽（首次进入此分支后开始计时）:
         仅一次: shell.sendRaw("printenv\n")
         进入验证层计时
       if 验证层:
         if detector.matchKernelBoot(allOutput): 返回失败
         if detector.matchVerifyKey(allOutput): 返回成功
         if 验证层超时（verifyTimeoutMs）: 返回失败（提示重试）
5. 总超时: 返回失败
```

**关键决策点**：

- **主层窗口**：从"已中断"开始算，给主层一个窗口（建议等于验证层窗口，4000ms）等提示符。窗口耗尽才触发验证层，避免无谓发 printenv。
- **printenv 只发一次**：发过后进入验证层，靠 `matchVerifyKey` 和验证层超时收尾，不重复发。
- **kernel 特征双重检查**：主层和验证层都查，因为设备可能在任何时候越过 uboot 进 kernel。
- **返回结构不变**：成功/失败仍是 `{ content: [text(...)] }`，仅文本内容微调（成功标注是提示符命中还是验证命中；失败提示重试）。

### 模块 D：regex-verify CLI 命令

**职责**：让用户不连真机就能自测 yaml 正则配置——加载设备配置、构造 `UbootDetector`、跑标准样本矩阵。

**对外接口**：`runRegexVerify(opts: RegexVerifyOptions): void`，由 `src/cli/index.ts` 的 Commander action 调用。

**关键依赖**：`UbootDetector`（模块 B，静态 import）、`getDebugState()`（用于 `-v` 模式展示合并后的正则）。

**实现风格**：参考 `split` 命令——`console.log` + emoji 输出（批处理类命令轻量风格），Commander 解析 `<device>` 位置参数 + `-s/--sample`（多次收集）+ `-v/--verbose`。

**核心流程**：
1. 从 `.embedded/configs/devices/<device>.yaml` 加载 `serial.uboot`
2. `new UbootDetector(uboot)` 构造（与 `serial_enter_uboot` 同源，自动合并默认值）
3. 跑 15 条标准样本矩阵，每条标注 ✅/❌ 与期望/实际对比
4. `-v` 模式调 `getDebugState()` 展示合并后实际生效的正则
5. `-s` 模式追加用户自定义样本（只展示识别结果，不判期望）
6. 退出码：全过 0、失败 1

## 模块交互

### 时序：成功进入（主层命中）

```
handler ──reboot──> shell
        <──output── shell (含 autoboot 提示)
handler ──matchAutoboot──> detector ──"\n"──> handler
handler ──sendRaw("\n")──> shell
        <──output── shell (含 "=>")
handler ──matchPrompt──> detector ──true──> handler
handler ──返回成功──> MCP
```

### 时序：成功进入（验证层命中，提示符未匹配）

```
handler ──reboot + sendRaw("\n")──> shell
        <──output── shell (含 "Marvell>>"，但配置默认 prompt 是 "=>")
handler ──matchPrompt──> detector ──false──> handler   ← 主层窗口耗尽
handler ──sendRaw("printenv\n")──> shell
        <──output── shell (含 "baudrate=115200")
handler ──matchVerifyKey──> detector ──true──> handler
handler ──返回成功（via verify）──> MCP
```

### 时序：失败（未进 uboot）

```
handler ──reboot──> shell
        <──output── shell (含 "Starting kernel...")   ← autoboot 没中断成功
handler ──matchKernelBoot──> detector ──true──> handler
handler ──立即返回失败（提示重试）──> MCP
```

或验证层超时：

```
handler ──sendRaw("printenv\n")──> shell
        <──4 秒内无 baudrate=── shell
handler ──验证层超时──> 返回失败（提示重试）──> MCP
```

## 文件组织

```
src/
├── shared/
│   └── config.ts                          ← 修改：DeviceConfig.serial.uboot + getUbootConfig
├── mcp/
│   ├── shared/
│   │   └── prompt-detector.ts             ← 修改：新增 UbootDetector 类 + UbootDefaults + getDebugState
│   │                                          + dedupPreserveOrder；PromptDetector 类不动
│   └── tools/serial/
│       └── shell.ts                       ← 修改：serialEnterUbootHandler 改造
├── cli/
│   ├── index.ts                           ← 修改：注册 regex-verify 命令（import + .command）
│   └── commands/
│       └── regex-verify.ts                ← 新建：runRegexVerify（CLI 自测命令，spec F7）

docs/
└── regex-guide.md                         ← 新建：uboot 配置正则编写指南（含合并语义、去重、CLI 用法）

test/
└── scripts/
    └── uboot-detector-test.mjs            ← 已存在：UbootDetector 离线验证脚本

.embedded/configs/
├── config.example.yaml                    ← 修改：serial 段加 uboot 子段示例（正则字符串写法）
└── devices/board-example.yaml             ← 修改：同步 uboot 子段示例
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| `UbootDetector` 归属 | 并入 `prompt-detector.ts`，与 `PromptDetector` 并列 | 主题相关（都是 shell 状态/提示符检测）；零新增文件、零 import 牵动；`PromptDetector.DEFAULT_PATTERN` 已含 `=>`，归一后默认值不再两处 |
| 配置值是否做自动正则转换 | **不做**，直接用 `new RegExp(source, flags)` | 所见即所得，正则行为完全可预测；自动转换（模糊化/escape/re: 前缀）增加实现与调试成本，且用户难以理解转换后的实际正则；与项目已有 `promptPattern` 字段的"直接写正则"风格一致 |
| 用户配置与默认值的关系 | **合并**，非替换 | 用户加提示/键不丢失默认识别能力，体验更符合"补充"直觉；autoboot/verifyEnvKeys 用 concat/union，prompt 用联合正则（剥离尾部 `\s*$` 后 `(?:A\|B)` 合并，失败退化简单 `\|`）；未配置时合并结果等同默认值，AC1 兼容 |
| 合并时是否去重 | **去重**，字面相等判断 | 用户照抄默认值时不应产生冗余（autoboot 重复条目、prompt `(?:A\|A)` 嵌套）；autobootPrompts 用 `dedupPreserveOrder` 保持顺序，verifyEnvKeys 用 Set，prompt 字面相等则跳过联合。仅做字面相等，不做正则语义等价（覆盖常见场景即可） |
| 是否提供 CLI 自测命令 | **提供**，`regex-verify <device>` | 让用户不连真机就能验证 yaml 配置；与 `serial_enter_uboot` 同源（直接 import `UbootDetector`），结果可信；`-v` 暴露 `getDebugState()` 让合并结果可见，是调试合并/去重的核心工具 |
| `verifyEnvKeys` 是否走正则转换 | 不走，纯字面量 `indexOf` 匹配 | 键名是固定标识符（baudrate/bootdelay），正则转换无收益反增错；匹配 `<key>=` 结构用字符串包含即可 |
| flags 处理策略 | autoboot/kernelBoot 默认带 `i`，prompt 无 flags | 与原硬编码完全一致：autoboot 文案可能大小写不一需 `i`；prompt 是 `=>`/`U-Boot>` 固定大小写不需 `i`。用户无需在 yaml 里管 flags |
| 主层窗口与验证层窗口是否合并 | 分开，但取相同值（4000ms） | 语义不同（等提示符 vs 等命令输出），分开便于后续独立调参；当前同值避免引入新配置项 |
| `printenv` 命令是否可配置 | 不可配置，硬编码 `printenv` | `printenv` 在 U-Boot proper 无条件编译（spec 已核实），无配置必要；YAGNI |
| 配置错误处理位置 | 在 `UbootDetector` 构造时抛错，handler 捕获 | 配置解析一次即可，不必每次 match 都校验；handler 是 MCP 响应边界，适合转友好错误 |
| 中断键选择规则 | 数组顺序即优先级，含 `Ctrl+u` 字样发 `\x15` | 与现有硬编码逻辑等价（现有是"先查 Ctrl+u 再查 any key"），数组化后顺序即优先级 |
| 失败返回是否新增 error 字段 | 不新增，仍是 `{ content: [text(...)] }` | 保持与现有 handler 返回结构一致，避免改 MCP schema |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变（如原为 GB2312/GBK 则仍按原编码写回，绝不转换）。

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
