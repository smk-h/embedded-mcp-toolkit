# U-Boot 配置正则编写指南

`serial_enter_uboot` 工具通过设备配置的 `serial.uboot` 子段识别 U-Boot 的各类输出特征（autoboot 提示、命令提示符等）。这些字段的值是 **JavaScript 正则表达式源码字符串**，由程序内部 `new RegExp(source, flags)` 构造。

本指南面向不熟悉正则的设备配置用户，只覆盖本项目实际用到的最小语法集，配合常见 U-Boot 场景示例，并对每个示例做逐部分拆解，让你能快速写出可用的配置。

## 一、 为什么配置用正则

U-Boot 启动过程中的输出不是固定字符串，而是存在变化：

- **autoboot 提示**：`Hit any key to stop autoboot: 3` 后面跟的数字每秒递减
- **命令提示符**：不同板子不一样（`=>` / `Marvell>>` / `hisilicon#`）
- **空格数量**：终端输出中空格数量可能不固定（一个、多个、制表符）

正则提供"模糊匹配"能力，能识别这类有变化的输出，比精确字符串匹配更鲁棒。

## 二、 最小必备语法

本项目实际用到的正则语法很少，掌握下面这些就够用。每一节先讲语法含义，再给最小可运行示例。

### 1. 字面量字符

绝大多数字符就按字面意思匹配。`H`、`i`、`t` 三个字符依次出现，就匹配 `Hit` 里的对应位置。

```
Hit
```

- `H` 匹配字母 `H`
- `i` 匹配字母 `i`
- `t` 匹配字母 `t`

最终能匹配任何含 `Hit` 的字符串，如 `Hit any key`、`U-Boot Hit Ctrl+u`。

### 2. `\s+` —— 匹配一个或多个空白

`\s` 匹配任何空白字符（空格、制表符、换行），`+` 表示"前面的元素出现一次或多次"。两者组合 `\s+` 表示"至少一个空白字符"。

```
Hit\s+any
```

逐部分拆解：

- `Hit` 匹配字面量 `Hit`
- `\s+` 匹配至少一个空白字符
- `any` 匹配字面量 `any`

最终能匹配：

- `Hit any`（中间一个空格）
- `Hit  any`（中间两个空格）
- `Hit\tany`（中间一个制表符）
- `Hit \t \tany`（混合空白）

但不匹配 `Hitanys`（`Hit` 和 `any` 之间没有空白）。

这是 U-Boot 提示匹配**最常用**的语法，因为终端输出的空格数量往往不固定。

### 3. `\s*` —— 匹配零个或多个空白

`*` 表示"前面的元素出现零次或多次"。`\s*` 比 `\s+` 更宽松——允许没有空白：

```
=>\s*
```

- `=>` 匹配字面量 `=>`
- `\s*` 匹配零个或多个空白

最终能匹配 `=>`（无尾随空白）、`=> `（一个空格）、`=>  `（多个空格）。提示符正则常在末尾用它，因为提示符后面可能有空格也可能没有。

### 4. `$` —— 锚定字符串末尾

`$` 不匹配任何字符，它是一个"位置断言"，表示"字符串必须在这里结束"。检测命令提示符时，要确认提示符出现在输出末尾（而不是命令输出的中间）：

```
=>$
```

- `=>` 匹配字面量 `=>`
- `$` 断言此位置是字符串末尾

最终只匹配**正好以 `=>` 结尾**的字符串，如 `U-Boot 2016.03\n=>`。但**不匹配** `=> something`（`=>` 后面还有内容，不在末尾）。

这个锚用于避免"命令输出中间偶然出现 `=>` 被误判为提示符"。

### 5. `\s*$` —— 末尾允许任意空白后结束

组合 3 和 4，提示符正则最常用的结尾模式：

```
=>\s*$
```

- `=>` 匹配字面量 `=>`
- `\s*` 匹配零个或多个空白
- `$` 断言字符串末尾

最终匹配 `=>`、`=> `、`=>  ` 等以 `=>` 结尾、后面可跟任意空白的字符串。不匹配 `=> x`（`=>` 后面跟了非空白字符）。

本项目内置的默认 prompt 就是 `(?:=>|U-Boot>)\s*$`，用的就是这个模式。

### 6. `x|y` —— 或（任选其一）

`|` 表示"或"，左右两侧任一匹配即可。优先级较低，必要时用分组（下一节）控制范围：

```
=>|U-Boot>
```

- `=>` 左侧选项
- `|` 或
- `U-Boot>` 右侧选项

最终匹配 `=>` 或 `U-Boot>`，两者其一出现即可。

### 7. `(?:...)` —— 非捕获分组

括号 `(...)` 在正则里用于分组，控制 `|`、`+`、`*` 等量词的作用范围。前置 `?:` 表示"非捕获"——只分组不提取（本项目都用非捕获，性能略好且语义清晰）：

```
(?:=>|U-Boot>)\s*$
```

逐部分拆解：

- `(?:=>|U-Boot>)` 非捕获分组，把 `=>` 和 `U-Boot>` 联合，匹配两者其一
- `\s*` 匹配零个或多个空白
- `$` 断言字符串末尾

最终匹配以 `=>` 或 `U-Boot>` 结尾、后面可跟任意空白的字符串。例如：

- `=>` ✅
- `U-Boot>` ✅
- `=>  ` ✅
- `U-Boot 2016.03\n=>` ✅（只要末尾是 `=>` 即可）
- `=>x` ❌（`=>` 后跟非空白）
- `STM32MP>` ❌（不在联合范围内）

### 8. `\.` —— 转义元字符（匹配字面点）

正则里 `.` 本来是"任意字符"。要匹配字面 `.` 时，要在前面加 `\` 转义：

```
3\.14
```

- `3` 匹配字面量 `3`
- `\.` 匹配字面量 `.`（转义后的点不再是"任意字符"）
- `14` 匹配字面量 `14`

最终只匹配 `3.14`，**不匹配** `3X14` 或 `3 14`（点被转义后失去"任意字符"含义）。

本项目用到的元字符还有 `* + ? ( ) [ ] { } ^ $ | \`，要匹配它们的字面量时都得加 `\` 转义。例如 `Ctrl\+u` 里的 `+` 是量词，要匹配字面加号必须写成 `\+`。

## 三、 YAML 中写正则的注意点

这是最容易踩坑的地方，务必读完本节。

### 1. 双引号字符串：反斜杠必须双写

YAML 双引号字符串会处理转义序列。`\s` 在 YAML 双引号里会被解析成 `s`（反斜杠被当作转义符吃掉），导致正则失效。**必须双写反斜杠**：

```yaml
# 正确（双引号 + 双反斜杠）
prompt: "(?:=>|U-Boot>)\\s*$"
autobootPrompts:
  - "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"

# 错误（双引号 + 单反斜杠，\s 会被吞成 s）
prompt: "(?:=>|U-Boot>)\s*$"
```

### 2. 单引号字符串：不转义，所见即所得

YAML 单引号字符串**不处理转义**，反斜杠原样保留。如果你嫌双写麻烦，可以用单引号：

```yaml
# 正确（单引号 + 单反斜杠，更直观）
prompt: '(?:=>|U-Boot>)\s*$'
autobootPrompts:
  - 'Hit\s+any\s+key\s+to\s+stop\s+autoboot'
```

### 3. 双引号 vs 单引号怎么选

- 简单提示符，无反斜杠 → 双引号，如 `"=>"` 最简洁
- 含 `\s` `\.` 等转义 → 单引号，不用双写，更不易错
- 含变量插值（本项目用不到）→ 双引号

**本项目默认示例用双引号 + 双反斜杠**，因为这与项目其他配置字段（`promptPattern`）的风格一致。你按自己喜好选即可，两者等价。

## 四、 常见 U-Boot 场景的正则示例

### 1. autoboot 提示（autobootPrompts 字段）

U-Boot 启动时会打印倒计时提示，让用户按键中断自动引导。两种常见文案。

#### 1.1 标准 any key 文案

```yaml
autobootPrompts:
  - "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"
```

源码字符串（YAML 加载后内存中的实际值）是：

```
Hit\s+any\s+key\s+to\s+stop\s+autoboot
```

逐部分拆解：

- `Hit` 字面量 `Hit`
- `\s+` 至少一个空白
- `any` 字面量 `any`
- `\s+` 至少一个空白
- `key` 字面量 `key`
- `\s+` 至少一个空白
- `to` 字面量 `to`
- `\s+` 至少一个空白
- `stop` 字面量 `stop`
- `\s+` 至少一个空白
- `autoboot` 字面量 `autoboot`

最终匹配类似以下的实际输出（注意倒计时数字 `: 3` 不在正则范围内，所以不影响）：

- `Hit any key to stop autoboot: 3` ✅（标准输出，末尾倒计时数字被忽略）
- `Hit  any   key  to  stop  autoboot: 1` ✅（多空格容忍）
- `Hit\tany\tkey\tto\tstop\tautoboot: 2` ✅（制表符分隔）
- `HIT ANY KEY TO STOP AUTOBOOT: 3` ✅（本项目 autoboot 自动带 `i` 标志，大小写不敏感）

不匹配：

- `Hitankey to stop autoboot` ❌（前几个词之间无空白）
- `Press SPACE to stop autoboot` ❌（文案完全不同）

#### 1.2 厂商 Ctrl+u 文案

```yaml
autobootPrompts:
  - "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot"
```

源码字符串：

```
Hit\s+Ctrl\+u\s+to\s+stop\s+autoboot
```

逐部分拆解：

- `Hit` 字面量 `Hit`
- `\s+` 至少一个空白
- `Ctrl` 字面量 `Ctrl`
- `\+` 字面量 `+`（`+` 是正则量词，必须转义才能匹配字面加号）
- `u` 字面量 `u`
- `\s+` 至少一个空白
- `to` 字面量 `to`
- `\s+` 至少一个空白
- `stop` 字面量 `stop`
- `\s+` 至少一个空白
- `autoboot` 字面量 `autoboot`

最终匹配：

- `Hit Ctrl+u to stop autoboot` ✅
- `Hit Ctrl+u  to  stop autoboot` ✅（多空格）

【**注意**】本项目中，`autobootPrompts` 数组里**含 `Ctrl+u` 字样**的条目（正则源码里是 `Ctrl\+u`）会自动发送 `\x15`（即 Ctrl+u），其余条目发送换行。这是约定行为，无需额外配置。

### 2. 命令提示符（prompt 字段）

成功进入 U-Boot 命令行后，会显示提示符。不同厂商提示符不同。

#### 2.1 标准 U-Boot 提示符

```yaml
prompt: "=>"
```

源码字符串就是字面量 `=>`。最终匹配任何含 `=>` 的字符串。

【**注意**】直接写 `"=>"` 不锚末尾，命令输出中间偶然出现 `=>` 会被误判。**推荐**写法是带末尾锚（见 2.3）。

#### 2.2 厂商定制提示符

```yaml
prompt: "Marvell>>"     # Marvell 平台
prompt: "hisilicon#"    # 海思
prompt: "sunxi#"        # 全志
prompt: "STM32MP>"      # STM32MP1
prompt: "ZynqMP>"       # Xilinx
prompt: "rk35xx#"       # Rockchip
```

这些简单提示符不含特殊字符（`#` `>` 不是正则元字符），直接写字面量即可，无需 `\s+` 等语法。

【**注意**】`#` `>` 不是元字符，但 `.` `*` `+` `?` `(` `)` `[` `]` `{` `}` `^` `$` `|` `\` 是。如果提示符里含这些字符，必须转义。

#### 2.3 带末尾锚的提示符（推荐）

为了避免命令输出中间的 `=>` 被误判，**推荐**所有 prompt 都锚定末尾：

```yaml
prompt: "(?:=>|U-Boot>)\\s*$"
```

源码字符串：

```
(?:=>|U-Boot>)\s*$
```

逐部分拆解：

- `(?:` 非捕获分组开始
- `=>` 选项一：字面量 `=>`
- `|` 或
- `U-Boot>` 选项二：字面量 `U-Boot>`
- `)` 非捕获分组结束
- `\s*` 零个或多个空白
- `$` 字符串末尾断言

最终匹配**以 `=>` 或 `U-Boot>` 结尾**、后面可跟任意空白的字符串：

- `=>` ✅
- `U-Boot>` ✅
- `=> ` ✅（末尾一个空格）
- `U-Boot 2016.03\n=>` ✅（前面内容任意，只要末尾是 `=>`）
- `=> something` ❌（`=>` 不在末尾）
- `Marvell>>` ❌（不在联合范围内）

本项目内置默认 prompt 就是这条正则——未配置 `prompt` 字段时自动套用。

### 3. 多板子共用配置

一份配置要适配多种板子时，用 `(?:A|B|C)` 联合多种提示符，**务必锚末尾**：

```yaml
prompt: "(?:=>|Marvell>>|hisilicon#)\\s*$"
```

源码字符串：

```
(?:=>|Marvell>>|hisilicon#)\s*$
```

逐部分拆解：

- `(?:` 非捕获分组开始
- `=>` 选项一
- `|` 或
- `Marvell>>` 选项二
- `|` 或
- `hisilicon#` 选项三
- `)` 非捕获分组结束
- `\s*` 零个或多个空白
- `$` 字符串末尾

最终匹配以 `=>`、`Marvell>>`、`hisilicon#` 任一结尾的字符串。例如 `Marvell>>` ✅、`hisilicon#` ✅、`STM32MP>` ❌（不在范围内）。

### 4. 内核日志识别（内置，用户无需配置）

工具内置识别内核启动特征，用于"设备越过 U-Boot 进入内核"时立即判定失败。源码字符串是：

```
Starting\s+kernel|Linux\s+version
```

逐部分拆解：

- 左侧选项 `Starting\s+kernel`：
  - `Starting` 字面量
  - `\s+` 至少一个空白
  - `kernel` 字面量
- `|` 或
- 右侧选项 `Linux\s+version`：
  - `Linux` 字面量
  - `\s+` 至少一个空白
  - `version` 字面量

最终匹配含 `Starting kernel` 或 `Linux version` 的字符串（本项目自动带 `i` 标志）。这个正则不需要用户配置，仅供理解原理。

## 五、 合并语义

本项目的 `serial.uboot` 配置与内置默认值是**合并**关系，不是替换：

- **autobootPrompts**：用户数组**追加**到默认数组之后。默认在前（优先级更高），用户在后（补充识别）。即使用户只配了一条自定义提示，默认的 `Hit any key` / `Hit Ctrl+u` 仍能识别
- **verifyEnvKeys**：用户数组与默认数组合并去重
- **prompt**：用户正则与默认正则联合成"任一命中即算"的大正则。例如用户配 `Marvell>>\s*$`，合并后能识别 `Marvell>>`、`=>`、`U-Boot>` 三种

### 1. 去重规则（避免冗余）

当用户配置与默认值**字面相等**时，会自动去重，避免合并后产生冗余正则：

- **autobootPrompts**：按字符串字面去重，保持首次出现顺序（默认在前）。例如默认有 `Hit\s+Ctrl\+u...`，用户又抄了一份相同的，合并后只保留一条
- **verifyEnvKeys**：用 `Set` 去重。例如默认有 `baudrate`，用户也配了 `baudrate`，合并后只有一个
- **prompt**：用户值与默认值**字面相等**时直接用默认值，不联合（避免产生 `(?:(?:=>|U-Boot>)|(?:(?:=>|U-Boot>)))` 这种嵌套冗余）

【**注意**】去重只判断**字面字符串相等**，不判断正则语义等价。即 `=>` 和 `=>\s*$` 不会被判为相等（虽然语义上有重叠）。这覆盖了"用户照抄默认值"的常见场景，复杂等价判断不在范围内。

### 2. 关键不变量

未配置 `uboot` 子段时，合并结果等同默认值本身，行为与改动前完全一致。你**不需要**为了"保留默认行为"而把默认值抄进配置。

## 六、 调试建议

写好正则后，可以用以下方式快速验证。**首选** `regex-verify` 命令——它直接复用 `serial_enter_uboot` 的检测逻辑（包括合并默认值），结果最贴近实际行为。

### 1. regex-verify 命令（推荐）

项目内置了 `regex-verify` 命令，一键加载设备配置、构造 UbootDetector、跑标准样本矩阵：

```bash
# 基本用法：跑 15 条标准样本矩阵（autoboot/prompt/verify/kernel）
embedded-mcp-toolkit regex-verify board-example

# 追加自定义样本（可多次 -s，测你板子的真实输出片段）
embedded-mcp-toolkit regex-verify board-example -s "Hit any key to stop autoboot: 3"
embedded-mcp-toolkit regex-verify board-example -s "Marvell>>" -s "Starting kernel..."

# 显示合并后实际生效的正则（调试必备）
embedded-mcp-toolkit regex-verify board-example -v

# 查看帮助
embedded-mcp-toolkit regex-verify --help
```

命令会：

- 自动定位 `.embedded/configs/devices/<设备名>.yaml`，提取 `serial.uboot` 段
- 用与 `serial_enter_uboot` 完全一致的逻辑构造 UbootDetector（自动合并默认值）
- 跑 15 条标准样本，每条标注 ✅/❌ 与期望、实际识别结果对比
- 如有 `-s`，追加用户自定义样本（只展示识别结果，不判期望）

退出码契约：所有标准样本通过返回 0，任一失败返回 1，便于在 CI 或脚本中串联调用。

【**注意**】找不到设备文件时会列出可用设备名；正则非法时会显示具体错误（如 `Unterminated group`）并提示检查括号/转义。

### 2. -v 详细模式：查看合并后的最终正则

`-v` 选项会展示 UbootDetector 内部**实际生效的正则**——即"我的配置 + 默认值合并、去重后最终构造出的正则"。这是调试合并行为的核心工具：

```bash
embedded-mcp-toolkit regex-verify board-example -v
```

输出形如：

```
构造的 UbootDetector 内部状态（合并默认值后实际生效）：
  autoboot 正则（按数组顺序匹配，命中即返回对应中断键）：
    [0] /Hit\s+Ctrl\+u\s+to\s+stop\s+autoboot/ / flags: "i"  →  中断键: \x15 (Ctrl+u)
    [1] /Hit\s+any\s+key\s+to\s+stop\s+autoboot/ / flags: "i"  →  中断键: \n (换行)
  prompt 正则: /(?:=>|U-Boot>)\s*$/
  kernelBoot 正则: /Starting\s+kernel|Linux\s+version/ / flags: "i"
  verifyKeys: ["baudrate", "bootdelay"]
  verifyTimeoutMs: 4000ms
```

通过 `-v` 可以确认：

- 你的自定义提示是否成功合并到 autoboot 列表
- prompt 联合正则有没有冗余（去重是否生效）
- verifyKeys 是否包含了你期望的所有键
- autoboot 条目的中断键（`\x15` 还是 `\n`）是否正确

### 2. 浏览器开发者工具

快速验证单个正则——按 F12 打开开发者工具，在 Console 里：

```javascript
/Hit\s+any\s+key/.test("Hit any key to stop autoboot: 3");
// 返回 true 说明正则能匹配
```

### 3. Node 命令行

```bash
node -e "console.log(/Hit\s+any\s+key/.test('Hit  any   key'))"
# 输出 true
```

### 4. 在线工具

[regex101.com](https://regex101.com/) 提供可视化正则解释。**注意选 ECMAScript (JavaScript) flavor**，避免不同正则方言的差异。

## 七、 常见错误

### 1. 忘了双写反斜杠（最常见）

```yaml
# 错误（双引号 + 单反斜杠：\s 被吞成 s，正则变成匹配 "Hits+any..."）
prompt: "(?:=>|U-Boot>)\s*$"
```

- **症状**：配置看似正确，但 `serial_enter_uboot` 总是超时失败
- **解决**：改双写（`"\\s*$"`）或改单引号（`'\s*$'`）

### 2. 括号不闭合

```yaml
# 错误（括号不闭合，会导致 new RegExp 抛错）
prompt: "((=>|U-Boot>)"
```

- **症状**：工具返回 `Failed to build U-Boot detector (config error): ...`
- **解决**：检查每个 `(` 是否有对应的 `)`

### 3. 提示符正则没锚 `$` 导致误判

```yaml
# 不推荐（没锚末尾，命令输出中间偶然出现 => 会被误判成功）
prompt: "=>"
```

- **症状**：明明没进入 U-Boot 命令行，工具却报告成功
- **解决**：命令提示符正则**推荐**锚 `$`（如 `"=>\\s*$"`）。内置默认值已正确处理

### 4. 元字符未转义

```yaml
# 错误（想匹配字面 3.14，但 . 是"任意字符"，会匹配 3X14）
prompt: "3.14"
```

- **解决**：匹配字面元字符要加 `\`（如 `"3\\.14"`）

### 5. 误以为配置会替换默认值

```yaml
# 这条配置不会让默认的 => 失效（合并语义）
prompt: "Marvell>>\\s*$"
```

- **症状**：期待"只认 Marvell>>"，实际 `=>` 也算成功
- **解决**：合并是设计行为，见"五、合并语义"。若确需完全替换，目前需自行写联合正则覆盖所有需要的提示符

## 八、 参考

- 配置字段完整说明：`.embedded/configs/devices/board-example.yaml` 的 `serial.uboot` 段
- 项目使用 JavaScript 正则（ECMAScript 规范），完整语法参考：[MDN RegExp](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/RegExp)
- 正则可视化与在线测试：[regex101.com](https://regex101.com/)（选 ECMAScript flavor）

---
*本文档由 markdowncli 技能辅助生成*
