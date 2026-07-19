# 我的初步想法

在进入 uboot 的命令中，需要检测 uboot 的提示符以保证进入了 uboot，但不同厂商可能定制 uboot，导致提示符不能完全涵盖。

### 方案

方案一：

1. 把 `AUTOBOOT_ANY_KEY_RE` 和 `AUTOBOOT_CTRL_U_RE` 这些提取到一个数组，方便扩展，在 config.yaml 中添加对应配置字段支持用户扩展
2. `UBOOT_PROMPT_RE` 也在 config.yaml 中添加对应配置字段

方案二：

发完控制字符后发送 `printenv` 命令，拿到输出后匹配 `bootcmd`、`bootdelay` 这些环境变量键，这些一定会有的

以上方案足够确定了，优先方案一（匹配按下控制字符后自动出现的提示符），方案二用于兜底。

### 要求

1. 配置文件模板中添加对应字段配置示例
2. 不能改变原有功能
3. 尽可能封装成函数调用，逻辑清晰一点

---

## 澄清后的最终方案

经过讨论，对最初想法做了三处关键修正。

### 1. 方案二原版存在循环论证 → 改为「事后验证」

最初想法是"发 `printenv`，匹配 `bootcmd` / `bootdelay`，这些键一定会有"作为兜底。讨论中发现两个硬伤：

**硬伤一：循环论证。** `printenv` 只有在已经进入命令行后才会按预期工作，但"判断是否进入命令行"恰恰是我们要解决的问题——要求方案二"先确认进入命令行"才能发 `printenv`，等于用答案验证答案。

**硬伤二：判据不成立。**
- "`bootcmd` / `bootdelay` / `baudrate` 必然存在"——经 U-Boot 源码核实不成立，三者受 `CONFIG_USE_BOOTCOMMAND` / `CONFIG_BOOTDELAY` / `CONFIG_BAUDRATE` 控制，可被关闭；bad CRC 场景下退回 default environment，但 default 里有没有这些键仍由 Kconfig 决定。
- "`printenv` 命令依赖 `CONFIG_CMD_PRINTENV` 可能被裁"——经核实此选项不存在，`printenv` 在 `cmd/nvedit.c` 无条件编译，唯一能裁的是关掉整个 `CMDLINE`。这一条原担心不成立。
- silent console 模式（`CONFIG_SILENT_CONSOLE` + `silent=1`）下 `printenv` 输出被 `puts()` 路径压制——但这是整个 `serial_enter_uboot` 工具的前提失败（连 autoboot 提示都看不到），不在本方案责任范围内。

**修正方向：把"事前检测"改成"事后验证"。** 既然方案二本身就要发命令、就要看输出，那就不绕"先确认进入命令行"这个弯——发 `printenv`，**有 uboot 特征键输出就判定成功，没有就快速失败让用户重试**。

但这样会引入新风险：Linux 也有 `printenv` 命令（coreutils），若 autoboot 没停住、设备引导进了 Linux，发 `printenv` 同样有输出，会**反向误判**成"成功进入 uboot"。

所以判据要从"**有没有输出**"收紧为"**有没有 uboot 独有特征**"：

| 判据 | 风险 |
|---|---|
| 有输出 → 成功 | ❌ Linux 的 printenv 也有输出 |
| 输出含 `baudrate=` / `bootdelay=` → 成功 | ✅ uboot 强特征键，Linux 一般没有 |
| 输出含 `Starting kernel` / `Linux version` → 立即失败 | ✅ 加速失败返回 |

### 2. 兜底方案定位：不是"补漏"，是"独立验证层"

调整后两层判据的关系不是"方案一抓不住再让方案二补"，而是：

| 层 | 判据 | 触发时机 | 适用场景 |
|---|---|---|---|
| 主（配置驱动）| 配置的提示符正则命中 | 立即成功 | 提示符正常的板子（大多数）|
| 验证（事后发命令）| `printenv` 输出含 uboot 强特征键 | 主判据未命中时 | 提示符被厂商改写但 CLI 正常 |
| 失败 | 上述都未命中 / 命中 kernel 特征 | 短超时后快速返回 | 让用户重试，避免长时间等待 |

关键体验原则：**不靠"等 N 秒输出稳定"判失败**。成功要快（提示符命中或特征键命中立即返回），失败也要快（短超时 + kernel 特征即判失败），不要让用户干等。

### 3. 配置项支持自然字符串输入

`AUTOBOOT_*_RE` / `UBOOT_PROMPT_RE` 提取到配置后，用户不一定懂正则。约定配置字段写**普通字符串**，程序内部自动转模糊正则：

- 连续空白 → `\s+`（容忍空格数量差异）
- 元字符转义（`. * + ? ( ) [ ] { } ^ $ | \`）
- 大小写不敏感

例：配置写 `"Hit any key to stop autoboot"`，程序内部转为 `/Hit\s+any\s+key\s+to\s+stop\s+autoboot/i`，等价于现有硬编码正则。

对高级用户保留逃生舱：字段值以 `re:` 开头时按原始正则处理（如 `re:^(?:=>|Marvell>>)\s*$`），与普通字符串共存。

### 4. 不被采纳的备选方案（记录否决理由）

- **未知命令错误响应**（发 `zzq...` 匹配 `Unknown command`）：可行但被"事后验证 printenv"取代——后者更直接，且 printenv 输出本身就是更丰富的强证据。
- **行为签名反向证明**（已发中断键 + 无倒计时刷新 + 无 kernel 日志 = 停在交互态）：可行但需要"等 N 秒输出稳定"，与"失败也要快"原则冲突，故不采用。
- **启动 banner 字符串**（`U-Boot x.x`）：在 autoboot 倒计时阶段就打印了，正常引导也会有，无法区分"进入命令行"和"未中断继续引导"，无意义。

### 涉及改动范围（供 plan/task 参考）

- 新增：配置字段（autoboot 提示数组 + uboot 命令提示符），位置在设备文件 `serial` 段下，与 `promptPattern` 平级或独立成 `uboot` 子段
- 新增：`fuzzyPattern()` 工具函数（普通字符串 → 模糊正则，含 `re:` 逃生舱），建议放 `src/mcp/shared/prompt-detector.ts`
- 改造：`src/mcp/tools/serial/shell.ts` 的 `serialEnterUbootHandler`，从硬编码正则改为读配置，新增 printenv 事后验证分支
- 更新：`.embedded/configs/config.example.yaml` 模板，加 uboot 字段配置示例
- 不变：现有 `AUTOBOOT_*_RE` 命中逻辑、中断键发送逻辑、超时返回结构
