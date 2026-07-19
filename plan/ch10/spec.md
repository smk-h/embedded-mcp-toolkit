# serial_enter_uboot 配置化与提示符鲁棒性 Spec

## 背景

`serial_enter_uboot` 工具通过串口重启设备、在 autoboot 倒计时阶段发送中断键进入 U-Boot 命令行。当前实现（`src/mcp/tools/serial/shell.ts` 的 `serialEnterUbootHandler`）将三类检测正则硬编码为局部常量：

- `AUTOBOOT_ANY_KEY_RE`、`AUTOBOOT_CTRL_U_RE`：识别 autoboot 提示，决定发什么中断键
- `UBOOT_PROMPT_RE`：识别命令行提示符，作为"成功进入"的判据

问题在于：U-Boot 的命令提示符由 `CONFIG_SYS_PROMPT` 决定，各厂商普遍定制（`Marvell>>`、`hisilicon#`、自定义菜单等），硬编码正则覆盖不全；而项目已有的设备配置机制（`DeviceConfig` + `PromptDetector`）和 `serial_exec` 走的 `getPromptPattern(deviceName)` 链路并未被本工具使用。

此外，当提示符因厂商定制未命中时，当前实现只能等到总超时（默认 60s）才返回失败，用户体验差。

## 目标

- 让 autoboot 提示与命令提示符的检测规则可由设备配置覆盖，无需改代码即可适配新板子
- 配置项支持普通字符串输入（用户无需懂正则），同时为高级用户保留正则逃生舱
- 引入"事后验证"机制作为提示符未命中时的兜底，用 U-Boot 强特征键快速判定成功
- 失败时快速返回，让用户重试，避免长时间等待
- 不改变现有提示符能命中的板子的行为（兼容性）

## 功能需求

### F1：配置字段

设备配置的 `serial` 段下新增 `uboot` 子段，包含三个可选字段：

- `autobootPrompts`：autoboot 提示正则数组（如 `["Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot"]`）。数组顺序同时决定中断键选择——按约定，含 `Ctrl+u` 字样的条目对应发送 `\x15`，其余对应发送换行
- `prompt`：命令行提示符正则（如 `"=>"`、`"Marvell>>"`）
- `verifyEnvKeys`：事后验证用的环境变量键名数组（如 `["baudrate", "bootdelay"]`），命中任一即判定成功。纯字面量字符串，不走正则

所有字段可选；**配置值与内置默认值合并，而非替换**——详见 F4。

### F2：配置值直接使用正则表达式

配置字段（`autobootPrompts` / `prompt`）的值直接写 JavaScript 正则表达式的**源码字符串**，由程序内部用 `new RegExp(source)` 构造。不引入任何自动转换、模糊化、转义预处理——所见即所得，正则行为完全可预测。

例：
- `prompt: "(?:=>|U-Boot>)\\s*$"` → 构造为 `/(?:=>|U-Boot>)\s*$/`
- `autobootPrompts: ["Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"]` → 构造为 `/Hit\s+any\s+key\s+to\s+stop\s+autoboot/`

注意 YAML 字符串中反斜杠需双写（`\\s` 而非 `\s`），这是 YAML 转义要求，与项目现有 `promptPattern` 字段的处理方式完全一致。

`verifyEnvKeys` 仍是纯字面量字符串数组，不走正则——它匹配的是 `printenv` 输出里 `<key>=` 的固定结构。

为降低用户编写正则的门槛，配套提供一份正则编写指南文档（见 F6）。

### F3：检测流程（提示符优先，未命中才验证）

`serial_enter_uboot` 的检测改为两层：

1. **主层（配置驱动的提示符检测）**：发送中断键后轮询输出，命中配置的 `prompt` 正则（默认 `=>` / `U-Boot>`）即立即成功返回
2. **验证层（事后发命令）**：若主层在短暂窗口内（可配置或固定值，远小于总超时）未命中，发送 `printenv` 命令，轮询其输出，命中 `verifyEnvKeys` 中任一键（如 `baudrate=`）即判定成功
3. **失败**：验证层短超时未命中，或输出中出现内核启动特征（`Starting kernel` / `Linux version`），立即返回失败并提示用户重试

autoboot 提示检测（决定发什么中断键）保持现有逻辑，仅改为从 `autobootPrompts` 配置读取，匹配优先级遵循数组顺序。

### F4：默认值与用户配置合并（非替换）

三个字段都遵循"**用户配置补充默认值**"语义：

- **`autobootPrompts`**：用户数组**追加**到默认数组之后（默认在前，优先级更高；用户在后，作为补充识别）。合并后**按字面去重**，保持首次出现顺序。空数组或不配置等同只用默认值
- **`verifyEnvKeys`**：用户数组与默认数组合并去重（`Set` 去重）。空数组或不配置等同只用默认值
- **`prompt`**：用户正则与默认正则联合成"任一命中即算"的大正则。具体策略——**用户值与默认值字面相等时直接用默认**（避免嵌套冗余）；否则剥离两条正则末尾的 `\s*$`，用 `(?:A|B)` 联合核心部分后重新追加 `\s*$`。若剥离失败（用户正则末尾无 `\s*$`），退化为 `(?:默认|用户)` 简单联合（各自保留原锚）

去重规则只判断**字面字符串相等**，不判断正则语义等价——覆盖"用户照抄默认值"的常见场景，复杂等价判断不在范围内。

合并后内置默认值仍生效（spec N1 兼容性）：

- 默认 `autobootPrompts`：`["Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot", "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"]`（Ctrl+u 在前优先）
- 默认 `prompt`：`"(?:=>|U-Boot>)\\s*$"`（匹配 `=>` 或 `U-Boot>` 结尾，与原硬编码 UBOOT_PROMPT_RE 等价）
- 默认 `verifyEnvKeys`：`["baudrate", "bootdelay"]`

**关键不变量**：未配置 `uboot` 子段时，合并结果等同默认值本身，行为与原硬编码完全等价（AC1 兼容）。

### F5：配置模板更新

在 `.embedded/configs/config.example.yaml` 及分文件设备配置示例中，于 `serial` 段下补充 `uboot` 子段的注释示例，说明各字段含义、YAML 中正则字符串的写法（反斜杠双写）、并给出常见厂商提示符示例。

### F6：正则编写指南文档

在 `docs/` 目录下新增 `regex-guide.md`，面向不熟悉正则的设备配置用户，内容覆盖：

- 为什么配置用正则（识别 U-Boot 各类输出特征）
- 最小必备正则语法（字面量、`\s+`、`$` 锚、`(?:A|B)` 联合、`i` 标志）
- YAML 中写正则的注意点（反斜杠双写、单引号 vs 双引号）
- 常见 U-Boot 场景的正则示例（autoboot 提示、命令提示符、厂商定制）
- 合并语义与去重规则说明
- 调试建议（含 regex-verify 命令用法）

### F7：regex-verify CLI 命令

新增 `embedded-mcp-toolkit regex-verify` CLI 命令，让用户在不连真机的情况下自测 yaml 正则配置：

- **位置参数 `<device>`**：设备名（对应 `.embedded/configs/devices/<device>.yaml`）
- **选项 `-s, --sample <text>`**：追加自定义测试样本（可多次使用）
- **选项 `-v, --verbose`**：展示合并默认值后实际生效的正则（合并结果的可见性）
- **行为**：加载设备配置 → 构造 `UbootDetector`（自动合并默认值，与 `serial_enter_uboot` 同源）→ 跑标准样本矩阵 → 展示每条 ✅/❌ 与期望/实际对比 → 汇总 pass/fail
- **退出码契约**：所有标准样本通过返回 0，任一失败返回 1（便于 CI 串联）
- **错误处理**：找不到设备文件时列出可用设备名；正则非法时显示具体错误（如 `Unterminated group`）

命令实现遵循项目现有 CLI 风格（参考 `split` 命令：`console.log` + emoji 输出、Commander 解析参数、`runXxx` 函数签名）。

### F8：UbootDetector.getDebugState() 调试接口

`UbootDetector` 类新增公共方法 `getDebugState()`，返回合并默认值后**实际生效**的正则字符串快照（不暴露 RegExp 实例，避免外部修改内部状态）：

- `autobootPatterns`：每条的 source、flags、对应中断键
- `prompt`：source + flags
- `kernelBoot`：source + flags
- `verifyKeys`：键名数组
- `verifyTimeoutMs`

供 regex-verify 命令的 `-v` 模式使用，让用户看到"我的配置 + 默认值合并、去重后最终构造出的正则"。

## 非功能需求

### N1：兼容性

- 未配置 `uboot` 字段的设备，行为与当前实现完全一致（同样的提示符命中、同样的中断键、同样的成功/超时返回结构）
- 不修改 `PromptDetector` 类的现有行为（`serial_exec` / `ssh_exec` / `adb_exec` 不受影响）
- 不修改 session 结构、不修改 `serial_open` 流程

### N2：失败快速

验证层的超时窗口应显著小于总超时（建议 3~5 秒），让用户重试的等待感可控。成功路径仍要求快（提示符命中或特征键命中即返回）。

### N3：可观测性

检测各阶段（autoboot 提示匹配、中断键发送、提示符命中、printenv 发送、特征键命中、失败返回）保留 INFO 级日志，便于排查"为什么没进去"。

### N4：配置错误处理

配置值非法（如 `re:` 后跟无效正则、数组元素为空字符串）时，给出明确错误信息而非静默失败。空数组视为"未配置"走默认值。

## 不做的事

- **不处理 silent console 场景**：`CONFIG_SILENT_CONSOLE` + `silent=1` 下 autoboot 提示和 printenv 输出都被压制，属于整个 `serial_enter_uboot` 工具的前提失败，不在本次范围
- **不引入"行为签名反向证明"**（已发中断键 + 无倒计时刷新 + 无 kernel 日志）：可行但需要"等 N 秒输出稳定"，与"失败也要快"原则冲突
- **不处理厂商自定义菜单 UI**：菜单态不走标准 CLI，本工具不负责菜单导航
- **不修改 autoboot 中断键发送逻辑**：仅改为从配置读取提示，发送 `\x15` 还是换行的规则保持现有约定（含 `Ctrl+u` 字样发 `\x15`，否则发换行）
- **不给 adb / ssh 通道加 uboot 检测**：uboot 只从串口进，本工具是 serial 专属
- **不持久化 uboot 配置到 session**：handler 通过 `getDeviceName()` + 配置读取函数实时拿，session 结构不动

## 验收标准

### AC1：默认值兼容

未配置 `uboot` 字段的设备，运行 `serial_enter_uboot`，对能命中标准 `=>` 提示符的板子，行为与改动前完全一致：同样的中断键、同样的成功返回文本格式、同样的超时返回文本格式。

验证：用现有测试板（提示符为 `=>`）跑 `serial_enter_uboot`，对比改动前后输出。

### AC2：autobootPrompts 合并

在 `serial.uboot.autobootPrompts` 配置自定义提示（如厂商改写的 `"Press\\s+SPACE\\s+to\\s+abort"`），运行工具，能识别该提示**且仍识别默认的** `Hit any key` / `Hit Ctrl+u`（合并语义，非替换）。

验证：配置自定义提示后，模拟串口输出含该字符串、以及含默认 `Hit any key` 字符串，观察两者都触发中断。

### AC3：prompt 合并

在 `serial.uboot.prompt` 配置非默认提示符（如 `"Marvell>>\\s*$"`），模拟串口输出该提示符结尾，工具判定成功；**同时**模拟输出 `=>` 结尾（默认提示符），工具也判定成功（合并语义，非替换）。

验证：配置自定义 prompt 后，分别构造末尾为 `Marvell>>` 和 `=>` 的输出，观察两者都判定成功。

### AC4：正则直接生效

配置字段值按 JavaScript 正则源码直接构造 `RegExp`，不做任何预处理。例：配置 `autobootPrompts: ["Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"]`，实际串口输出多空格（`Hit  any   key to stop autoboot`）能命中；配置 `prompt: "3\\.14"` 匹配字面 `3.14`（`.` 被转义），而 `prompt: "3.14"` 匹配 `3X14`（`.` 未转义）。

验证：单测覆盖"配置值 → RegExp 构造 → 匹配行为"三类 case（字面量、`\s+` 容忍空格、`(?:A|B)` 联合）。

### AC5：YAML 反斜杠双写

YAML 双引号字符串中反斜杠需双写：配置文件里写 `prompt: "(?:=>|U-Boot>)\\s*$"`，加载到内存后字符串为 `(?:=>|U-Boot>)\s*$`，构造的正则能匹配 `=>` 和 `U-Boot>` 结尾。文档（F6）需明确说明此约定。

验证：读 docs/regex-guide.md 确认有专门章节说明 YAML 反斜杠双写；用实际 yaml 加载后验证字符串值正确。

### AC6：事后验证成功与 verifyEnvKeys 合并

配置 `verifyEnvKeys: ["mykey"]`，模拟主层提示符未命中 → 发送 printenv → 输出含 `mykey=42`，工具判定成功；**同时**输出含 `baudrate=115200`（默认键）也判定成功（合并语义）。

验证：配置自定义 verifyEnvKeys 后，分别构造含 `mykey=` 和 `baudrate=` 的 printenv 输出，观察两者都判定成功。

### AC7：失败快速返回

主层未命中且验证层短超时（≤5 秒）内无特征键命中，工具返回失败并提示用户重试，不等到总超时（60 秒）。

验证：构造"提示符不匹配 + printenv 输出无任何特征键"的场景，观察返回时间 ≤5 秒且文本含"重试"字样。

### AC8：内核启动特征即判失败

输出中出现 `Starting kernel` 或 `Linux version`，立即判定失败返回（即便验证层窗口未超时）。

验证：构造"输出含 Starting kernel"的场景，观察是否立即失败。

### AC9：配置错误处理

配置值是无效正则（如 `prompt: "((invalid"`，括号不闭合）时，工具返回明确的配置错误信息，而非崩溃或静默失败。配置 `autobootPrompts: []`（空数组）走默认值。

验证：单测非法正则的报错路径。

### AC10：配置模板更新

`.embedded/configs/config.example.yaml` 的 `serial` 段下出现 `uboot` 子段示例，含三个字段的注释说明、YAML 正则写法说明（反斜杠双写）、常见厂商提示符示例。

验证：阅读模板文件，确认示例完整且与 F1/F2/F5 一致。

### AC11：正则编写指南文档

`docs/regex-guide.md` 存在且内容覆盖 F6 列出的所有要点：为什么用正则、最小语法、YAML 反斜杠双写、U-Boot 场景示例、合并语义与去重规则、调试建议（含 regex-verify 命令用法）。

验证：阅读文档，对照 F6 的要点清单逐项确认。

### AC12：合并去重

用户配置与默认值字面相等时，合并结果不产生冗余：

- `autobootPrompts`：用户抄了一份与默认字面相同的提示，合并后该条只出现一次（不重复）
- `verifyEnvKeys`：用户配了默认已有的键，合并后该键只出现一次
- `prompt`：用户值与默认值字面相等时，直接用默认值（不产生 `(?:A|A)` 嵌套冗余）

验证：用 `regex-verify <device> -v` 查看"合并后实际生效"的正则，确认无重复条目、无嵌套冗余。

### AC13：regex-verify CLI 命令

`embedded-mcp-toolkit regex-verify <device>` 命令可用且行为符合 F7：

- 能加载指定设备的 yaml，构造 UbootDetector，跑 15 条标准样本矩阵
- `-s` 可追加自定义样本（可多次）
- `-v` 能展示合并默认值后实际生效的正则（含 autoboot 各条中断键、prompt、kernelBoot、verifyKeys、verifyTimeoutMs）
- 退出码契约：全过 0、失败 1
- 找不到设备时列出可用设备名；正则非法时显示具体错误

验证：分别跑 `regex-verify board-example`（有配置）、`regex-verify <未配置 uboot 的设备>`（用默认）、`regex-verify board-example -v`（看合并正则）、`regex-verify board-xxx`（错误处理）四个场景。
