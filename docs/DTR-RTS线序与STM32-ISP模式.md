<!-- more -->

## 一、 DTR 与 RTS 是什么

### 1. 信号的来历与定义

`DTR` 与 `RTS` 是 RS-232 串口标准中的两根**调制解调器控制线**，诞生于电话线拨号通信时代：

- `DTR`（Data Terminal Ready，数据终端就绪）：终端告知调制解调器"我已上电就绪，可以通信"
- `RTS`（Request To Send，请求发送）：半双工时代终端申请占用信道；全双工时代与 `CTS` 配对成为硬件流控

它们与 `TXD`/`RXD` 的本质区别：`TXD`/`RXD` 承载**数据**，`DTR`/`RTS` 承载**控制**——是两根可由软件随时置高置低的控制引脚，电平变化不携带任何数据语义，但会被对端电路解读。

### 2. 从 RS-232 电平到 USB 转串口芯片

（1）RS-232 时代：负逻辑，+3V～+15V 表示 0（SPACE），-3V～-15V 表示 1（MARK），"有效（asserted）"指该控制信号进入激活状态。

（2）USB 转串口时代：CH340、CP210x、FT232 等芯片把 `DTR`/`RTS` 变成 TTL 电平输出脚，极性因芯片而异（如 CH340 的 `DTR#`/`RTS#` 为低有效输出）。本文统一按**逻辑状态**讨论：`on` = 有效（asserted），`off` = 无效（de-asserted），与 [`test/scripts/serial/mcu_serial_term.mjs`](../test/scripts/serial/mcu_serial_term.mjs) 的 `--dtr/--rts` 参数语义一致。

### 3. 在嵌入式场景中的两类用途

#### 3.1 硬件流控

`RTS`/`CTS` 用于速率匹配：接收方缓冲区将满时拉低 `RTS`，发送方检测到后暂停发送。常见于高波特率链路、蓝牙模块、GPS 模块。绝大多数嵌入式调试串口（本工具包默认 `flow: none`）不使用流控，此时 `RTS` 空闲。

#### 3.2 被电路征用为控制线

现代开发板上没有调制解调器，这两根线被板级电路"征用"为通用控制脚，典型用法：

- STM32 一键下载电路：`DTR`/`RTS` 经三极管门电路控制 MCU 的 `BOOT0` 与 `nRST`（本文主角）
- ESP32/ESP8266 自动下载电路：`DTR`/`RTS` 经三极管控制 `EN` 与 `GPIO0`，esptool 借此自动进下载模式
- Arduino Uno：`DTR` 经 100nF 电容触发 AVR 复位，配合自动烧录

## 二、 打开串口时 DTR/RTS 会发生什么

### 1. 各驱动与工具的默认行为

不同软件打开串口时对 `DTR`/`RTS` 的处理并不一致：

| 软件/驱动 | 打开端口时的行为 | 对一键下载板的影响 |
|---|---|---|
| PuTTY / MobaXterm | 主动断言两线 | 打开即可能触发复位/进 ISP，典型"连上但收不到数据" |
| XCOM 等裸串口工具 | 不主动改变 | 保持电平原样，相对安全 |
| Windows CH340 驱动 | 打开瞬间断言两线 | 实测会让本板静默（被按进复位或误入 ISP） |
| mcu_serial_term `--dtr off --rts off` | 打开后立即显式置 off | 实测唯一稳定通信的组合 |

### 2. 显式控制语义与实测基线

本工具包的诊断脚本支持 `--dtr/--rts {on,off,keep}` 三种取值：`on`/`off` 为打开端口后的最终电平，`keep` 表示不动驱动默认状态（默认值，等价于 PuTTY 类行为）。2026-10-31 在 ATK 战舰 V3 风格板卡（CH340，VID:PID=1A86:7523，COM4）上的实测基线：

- `off/off`：应用正常打印与应答，是唯一可靠的通信线序
- `on/off`：正在运行的应用**不受影响、继续打印**（实测收到 `count = 98` 及命令回显）
- 危险的不是"静态电平组合"，而是**打开/关闭端口的电平跳变沿**（见第四章）

## 三、 STM32 的 ISP 模式

### 1. 三种启动方式与 BOOT 引脚

STM32（以 F103 为例，详见 ST 官方文档 AN2606）在**复位释放沿**采样 `BOOT0`/`BOOT1` 引脚，决定从哪里启动：

| BOOT0 | BOOT1（PB2） | 启动空间 | 含义 |
|---|---|---|---|
| 0 | × | 主 Flash | 正常运行用户应用 |
| 1 | 0 | 系统存储器 | 运行 ST 出厂固化的 ROM 引导程序（即 ISP 模式） |
| 1 | 1 | 内置 SRAM | 调试用途，掉电即失 |

关键点：BOOT 引脚**只在复位释放沿被采样锁存**，之后翻转不影响运行中的芯片。`BOOT0` 平时经板级跳线或下拉电阻保持低。

### 2. System Memory 中的 ROM 引导程序

ISP（In-System Programming，在系统编程）模式的主体是 ST 出厂固化在系统存储器中的 **ROM 引导程序**（System Memory Bootloader），不可擦除。它监听 USART1（PA9/PA10）、USB DFU 等接口，接收协议命令对主 Flash 进行擦写。FlyMcu、STM32CubeProgrammer 串口模式、各板卡"一键下载"功能的本质，都是通过这个引导程序烧写固件——不接调试器也能烧录，这正是它的存在价值。

### 3. USART ISP 协议（AN3155）要点

| 命令 | 字节 | 用途 |
|---|---|---|
| Get / Get Version / Get ID | 0x00 / 0x01 / 0x02 | 查询 bootloader 版本与芯片 PID |
| Go | 0x21 | 跳转到指定地址执行——软件退出 ISP 的正道 |
| Write Memory | 0x31 | 写存储器 |
| Erase / 扩展擦除 | 0x43 / 0x44 | 擦除 Flash |
| Read Memory | 0x11 | 读回数据 |

协议要素：

（1）帧格式：命令帧 = 命令字节 + 按位取反字节（如 Go = `0x21 0xDE`）；数据帧末尾附各字节异或校验。

（2）应答：`0x79` 为 ACK，`0x1F` 为 NACK。

（3）同步：复位后**第一个字节**必须是 `0x7F`，bootloader 据此完成自动波特率测量并回 ACK。

## 四、 为什么不同 DTR/RTS 组合能触发 ISP 模式

### 1. 一键下载电路的信号通路

以 ATK 战舰 V3 类板卡为例（电路描述源自 [`test/scripts/serial/mcu_serial_term.mjs`](../test/scripts/serial/mcu_serial_term.mjs) 头注释），CH340 的两根控制线经三极管门电路译码后驱动 MCU：

```text
CH340.DTR ──┐
            ├─ 三极管门电路(板级相关) ──→ BOOT0 / nRST(低有效)
CH340.RTS ──┘
CH340.TXD ─────────→ PA10(USART1_RX)    数据线, 不受上述控制
CH340.RXD ←──────── PA9 (USART1_TX)
```

两根控制线组成 2 bit 输入，门电路将其译码为"按复位""进 ISP""正常运行"等动作。具体真值表因板而异，必须实测。

### 2. 进入 ISP 的时序条件

由第三章可知，进 ISP 的充要条件只有一句话：**复位释放沿（nRST 上升沿）时刻，BOOT0 采样为高**。两根线凑齐这个条件的方式：

（1）先断言两线：BOOT0=1 且 nRST 被按住，芯片稳定处于复位态；

（2）随后产生释放沿：只要释放瞬间 BOOT0 仍为高，芯片进入 System Memory 启动。

反过来，启动应用要求释放沿时刻 BOOT0=0。

### 3. 本板实测的电路行为拟合

不拆原理图、只靠线序实验，本板（2026-10-31 实测）的电路行为可拟合为：

- `RESET` 按住 ≈ `RTS` 有效 且 `DTR` 无效（`mcu_reset_app.mjs` 正是利用它：`DTR=off + RTS=on` 按住，松开 `RTS` 产生复位沿）
- `BOOT0` 跟随 `DTR` 翻转，且带 RC 滞后——这就是竞态的来源
- 静态组合中 `on/off`（DTR 有效、RTS 无效）对运行中的应用无害（实测 `count = 98` 照常打印）

【**注意**】首轮四组合诊断中三种非 off/off 组合的"静默"含有**窗口错位假象**成分：应用打印周期与 1.5s 监听窗口、冲刷窗口相位错开时会漏采。判断"某组合是否有害"必须用运行中的应用做长窗口（3s 以上）对照实验，不能只信单次短窗口诊断。

### 4. "打开串口"为什么会误触发

打开端口瞬间，Windows CH340 驱动会断言两线；这个断言动作与随后工具显式置 `off` 的动作之间是两次独立的 USB 控制传输，先后顺序存在竞态：

（1）若 `RTS` 先起、`DTR` 后起：`RTS=on ∧ DTR=off` 的瞬间把复位按住，`DTR` 起来时产生释放沿，此刻 `BOOT0` 尚未落下（RC 滞后）——芯片进入 ISP。

（2）若 `DTR` 先起：无复位脉冲，芯片继续跑应用。

这就是"同一块板有时连上正常、有时一打开就砖"的根源，也是 PuTTY/MobaXterm 打开即静默的原因——它们的断言电平会被保持，恰好把板子按死或推进 ISP。

## 五、 判别与退出 ISP 模式

### 1. 症状特征

满足以下全部条件时，应怀疑芯片处于 ISP 模式：

- 串口能正常打开（CH340 仍被枚举，无占用报错），板子供电正常
- 任意波特率、任意线序下都收不到应用打印（应用心跳消失）
- 芯片对 `0x7F` 探测有 ACK/NACK 反应（见下节）

### 2. 用 0x7F 探测确认

#### 2.1 操作方法

发单个字节 `0x7F`（自动波特率同步字节），观察 1s 内的响应。用诊断脚本最方便（Git Bash 语法）：

```shell
node test/scripts/serial/mcu_serial_term.mjs -p COM4 --dtr off --rts off -s $'\x7f' -w 2 --eol none -H
```

`--eol none` 避免附加换行，`-H` 以十六进制显示响应。

#### 2.2 响应解读与实测陷阱

| 响应 | 解读 |
|---|---|
| `0x79` | ACK：同步成功，芯片处于"同步等待态"（新鲜 ISP） |
| `0x1F` | NACK：bootloader 活着且已过同步（命令等待态），`0x7F` 被当作非法命令拒绝 |
| 无响应 | 不在 ISP（在跑应用 / 被按在复位 / 掉电），或自动波特率被毛刺带偏（本板实测出现过） |

【**注意**】`0x1F` 不代表"不在 ISP"——它恰恰证明 bootloader 活着。本板实测还出现过 `0x7F`/`Get`/`Go` **一律 NACK 或无响应**的深度污染态，最合理解释是打开端口瞬间的线序毛刺把 bootloader 的自动波特率锁偏，之后所有命令字节都被当作垃圾拒绝。此时探测结果不可信，直接走复位时序退出。

### 3. 退出方法与实测结论

| 方法 | 原理 | 本板实测（2026-10-31） |
|---|---|---|
| 软件复位时序 | `DTR=off + RTS=on` 按住复位，再释放 `RTS`，释放沿 BOOT0=0 | **4/4 成功，首选** |
| ISP Go 命令 | AN3155 软件跳转 0x08000000 | 0/4 成功——自动波特率易被毛刺锁偏，`Get`/`Go` 一律 NACK |
| BOOT0 跳线 + RESET 按键 | 物理保证释放沿 BOOT0=0 | 通用可靠，需动手 |
| 断电重启 | 期望冷启动时 BOOT0 为低 | 本板无效（实测重启后仍回 `0x79`）——CH340 掉电后线序偏置不可控 |

#### 3.1 ISP Go 命令

协议完整的软件退出路径：`0x7F` 同步 → Go 命令（`0x21 0xDE`）→ ACK 后发目标地址 `0x08 0x00 0x00 0x00` + 异或校验 `0x08` → ACK 后芯片立即跳转，引导程序退出、应用启动：

```text
0x7F                      -> 0x79  同步成功(自动波特率)
0x21 0xDE                 -> 0x79  Go 命令受理
0x08 0x00 0x00 0x00 0x08  -> 0x79  地址受理, 芯片跳转 0x08000000
```

对应 [`test/scripts/serial/mcu_isp_go.mjs`](../test/scripts/serial/mcu_isp_go.mjs)，内置三种握手顺序轮询重试。对状态干净的板子有效；但本板实测跨端口会话后 bootloader 状态易被污染（见 2.2 的陷阱），**在本板上请以软件复位时序为准**。

#### 3.2 软件复位时序（实测可靠，推荐）

利用"按住复位时把 BOOT0 放低、再释放复位"的时序，芯片以 `BOOT0=0` 从主 Flash 干净启动：

```js
// 节选自 test/scripts/serial/mcu_reset_app.mjs(本机路径, 已 gitignore)
await set({ dtr: false, rts: true }); // BOOT0 放低, RESET 按住
await sleep(200);                     // 稳定处于复位态
await set({ rts: false });            // 释放 RESET: 释放沿 BOOT0=0, 从 Flash 启动应用
```

该时序不依赖 ISP 协议，不受 bootloader 状态污染影响，实测 4/4 成功，是本板救砖与日常重启的首选。

#### 3.3 物理手段

（1）把 `BOOT0` 跳线接到 0（GND）侧，按板上 RESET 键——释放沿 `BOOT0` 必为低，任何状态下都能回应用。

（2）断电重启：只在"冷启动时 BOOT0 确定为低"的板子上有效。本板实测无效（重启后芯片仍在 ISP，`0x7F` 照回 `0x79`），原因是 CH340 掉电后 `DTR`/`RTS` 的线序偏置不可控，冷启动沿上 `BOOT0` 仍可能为高。

### 4. 实测救援记录

以下为 2026-10-31 完整踩坑与救援时间线，可作复现参考：

| 步骤 | 操作 | 观察 |
|---|---|---|
| 1 | 首次 `--diagnose` 四组合遍历 | 仅 off/off 收到 `flash-app count = 26` |
| 2 | `keep/keep` 打开 3s（模拟 XCOM 默认行为） | 静默 |
| 3 | off/off 发 `wifi info` × 2 | 静默（芯片已被拉进 ISP） |
| 4 | `0x7F` 探测 | 回 `0x79`——确认 ISP 同步等待态 |
| 5 | 用户断电重启 | 四组合仍静默，`0x7F` 仍回 `0x79`——重启未脱离 ISP |
| 6 | ISP Go 命令 | NACK `0x1F`；补测 `Get` 亦 NACK（状态污染） |
| 7 | 软件复位时序（`mcu_reset_app`） | 应用完整启动，842 字节输出，count 从 1 重计 |
| 8 | `wifi info` 双向验证 | 命令回显 + ESP8266 完整 Wi-Fi 状态（SSID/RSSI/IP） |

## 六、 工具家族与本项目关联

### 1. test/scripts/serial 下的 mcu 家族

围绕 DTR/RTS 线序与 ISP 模式的四个脚本（相互在头注释中交叉引用）：

| 脚本 | 用途 | 典型用法 |
|---|---|---|
| [`mcu_serial_term.mjs`](../test/scripts/serial/mcu_serial_term.mjs) | 串口终端 + 四组合线序诊断 + 单发命令 + 0x7F 探测 | `node test/scripts/serial/mcu_serial_term.mjs -p COM4 --diagnose` |
| [`mcu_isp_enter.mjs`](../test/scripts/serial/mcu_isp_enter.mjs) | 主动进 ISP（主备两种时序，逐步探测验证） | `node test/scripts/serial/mcu_isp_enter.mjs COM4` |
| [`mcu_isp_go.mjs`](../test/scripts/serial/mcu_isp_go.mjs) | AN3155 Go 命令跳应用（多轮握手重试） | `node test/scripts/serial/mcu_isp_go.mjs COM4` |
| [`mcu_reset_app.mjs`](../test/scripts/serial/mcu_reset_app.mjs) | DTR/RTS 复位时序起应用（救砖首选，最可靠） | `node test/scripts/serial/mcu_reset_app.mjs COM4` |

推荐工作流：先 `--diagnose` 确定可用线序 → 用该线序通信；一旦静默，先 `0x7F` 探测判态 → 在 ISP 则直接 `mcu_reset_app` 拉回应用。

### 2. 对 MCP 串口工具的启示

带一键下载电路的板卡对本工具包的 `serial_open` 同样构成风险：打开端口时的驱动断言竞态可能让 MCP 串口会话"连上但无输出"，甚至把芯片按进 ISP。可考虑的改进方向：

（1）`serial_open` 增加显式 `dtr`/`rts` 参数，或在打开后立即 `set({ dtr: false, rts: false })`，消除竞态窗口；

（2）串口会话建立后长时间无输出时，在工具返回信息中提示"可尝试 DTR/RTS 线序诊断"（`mcu_serial_term --diagnose`）；

（3）`device_info_tool` 的设备配置中可增加板卡线序标注字段，让一键登录等流程按设备选择安全线序。

---

*本文档由 markdowncli 技能辅助生成*
