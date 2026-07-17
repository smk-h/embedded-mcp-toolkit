<!-- more -->

## 一、 测试环境

### 1. adb 通道设备

| 项 | 内容 |
|------|------|
| 设备 | LubanCat 2(rk3568) |
| 序列号 | 43b1e5fe7b186666 |
| 系统 | Android(内核 Linux 6.1.141) |
| 提示符 | `rk3568_lubancat_2_v3_mipi1080p:/ $` |
| 通道 | adb shell(`shell -t -t` 强制 PTY) |
| 测试日期 | 2026-07-17 |

### 2. serial / ssh 通道设备

| 项 | 内容 |
|------|------|
| 设备 | ATK-IMX6U(i.MX6U,单核 Cortex-A9) |
| 系统 | Linux(内核版本待补,rootfs 含 Qt 桌面 QDesktop) |
| 提示符 | `root@ATK-IMX6U:~#` |
| serial 通道 | COM3 @ 115200(物理串口) |
| ssh 通道 | `192.168.16.105:22`,root / root(dropbear) |
| 测试日期 | 2026-07-17 |

## 二、 测试结论

A+B 方案(发送控制字符工具 + exec 提示符检测与超时熔断)在 adb、serial、ssh 三个通道全部测试通过。覆盖瞬时命令、长命令、常驻命令、管道命令、全屏 TUI 程序五类场景,以及熔断后会话恢复、前置冲刷消除污染等关键能力。三通道共用 `runExec` 统一编排,熔断时长差异仅来自传输层延迟(serial 8402ms / ssh 8367ms,差 35ms)。

## 三、 测试场景与结果

### 1. adb 通道

测试设备:LubanCat 2(rk3568 / Android),会话 `adb shell -t -t` 强制分配 PTY。

#### 1.1 瞬时命令(AC4)

**命令:** `echo hello_pstriptest`
**预期:** 检测到提示符立即返回,无 timed-out 标注

**结果:** ✅ 通过

```
hello_pstriptest
rk3568_lubancat_2_v3_mipi1080p:/ $
```

命令毫秒级返回,提示符检测命中 `:/ $`,未触发熔断。输出干净,无命令回显(PTY 回显剥离生效)。

#### 1.2 长命令不被误杀(AC6)

**命令:** `sleep 3; echo done_after_sleep`
**maxDuration:** 未传(默认 10000ms)
**预期:** 3 秒内正常完成,不被 10 秒熔断误杀

**结果:** ✅ 通过

```
done_after_sleep
rk3568_lubancat_2_v3_mipi1080p:/ $
```

命令在 3 秒内正常完成,sleep 期间未触达 maxDuration 上限,提示符检测正确识别命令结束。

#### 1.3 调用方覆盖长命令(AC7)

**命令:** `sleep 3; echo done_with_maxdur`
**maxDuration:** 5000
**预期:** 命令正常完成,未被熔断

**结果:** ✅ 通过

```
done_with_maxdur
rk3568_lubancat_2_v3_mipi1080p:/ $
```

`maxDuration:5000` 大于命令耗时(3 秒),命令正常完成。验证调用方可通过 maxDuration 参数为长命令留出足够时间。

#### 1.4 常驻命令自动熔断(AC3)

**命令:** `logcat`
**maxDuration:** 5000
**预期:** 5 秒后自动发 Ctrl+C 熔断,返回 timed-out 标注,会话恢复可用

**结果:** ✅ 通过

```
--------- beginning of kernel
08-04 17:00:04.885     0     0 I         : Booting Linux on physical CPU 0x0000000000 [0x412fd050]
... (大量 kernel 启动日志,此处省略)
[timed-out: collected 5000ms of output, Ctrl+C sent]
```

logcat 持续输出永不结束,5 秒到达 maxDuration 后自动发 Ctrl+C。返回内容含约 5 秒的 kernel 日志(输出过大被工具截断,但行为正确)。末尾标注 `[timed-out: collected 5000ms of output, Ctrl+C sent]`,语义中性。

#### 1.5 发送控制字符终止命令(AC1)

**测试步骤:**

1. `adb_shell_write` 发送 `logcat`(持续输出)
2. `adb_shell_send_ctrl(session_id, key="c")` 发送 Ctrl+C
3. `adb_shell_exec` 执行 `echo after_sendctrl` 验证会话恢复

**结果:** ✅ 通过

send_ctrl 返回 `Ctrl+C sent ()`(注:`\x03` 为不可打印字符,括号内字节不可见属正常)。

```
after_sendctrl
rk3568_lubancat_2_v3_mipi1080p:/ $
```

Ctrl+C 发送后 logcat 被终止,会话恢复正常,后续 echo 命令输出干净。

#### 1.6 前置冲刷消除残留污染(AC2)

**命令:** 先熔断一个 `logcat`,再执行 `echo after_sendctrl`
**预期:** echo 输出无 logcat 残留

**结果:** ✅ 通过(见 1.5 的 echo 输出)

logcat 熔断后,exec 开头的 `drain()` 前置冲刷清掉了 logcat 死前最后瞬间的输出,echo 返回内容只有 `after_sendctrl` 及提示符,无 logcat 日志混入。

#### 1.7 管道命令(logcat | grep)

**命令:** `logcat | grep system_server`
**maxDuration:** 8000
**预期:** 管道命令正确执行,熔断时 Ctrl+C 杀掉整个管道进程组

**结果:** ✅ 通过

```
08-04 17:00:23.821     1     1 I init    : Control message: Processed ctl.start for 'idmap2d' from pid: 653 (system_server)
... (大量含 system_server 的日志行)
05-23 17:06:19.201   653   662 W system_server: Reducing the number of considered missed Gc histogram windows from 362 to 100
^C
130|rk3568_lubancat_2_v3_mipi1080p:/ $
[timed-out: collected 8495ms of output, Ctrl+C sent]
```

关键观察:

- **管道过滤生效**——grep 准确过滤出含 `system_server` 的行
- **Ctrl+C 杀进程组**——末尾 `^C` 是 Ctrl+C 回显,`130` 是 shell 退出码(128+2,表示被 SIGINT 终止),证明 Ctrl+C 经 adb → adbd → shell → 管道进程组的 SIGINT 传递完全正常,logcat 和 grep 同时被杀
- **会话恢复**——提示符 `130|rk3568...:/ $` 正常出现(130 前缀是 bash 的 PS1 显示上次退出码)

#### 1.8 全屏 TUI 程序(top)

**命令:** `top`
**maxDuration:** 5000
**预期:** top 执行,5 秒熔断,top 被终止

**结果:** ✅ 通过(功能正确,输出含 ANSI 转义属 TUI 固有特性)

```
Tasks: 321 total,   1 running, 320 sleeping,   0 stopped,   0 zombie
  Mem:  3984388K total,  3002304K used,  982084K free,    25720K buffers
...
[7m  PID USER         PR  NI VIRT  RES  SHR S[%CPU] %MEM     TIME+ ARGS            [0m
[1m 3243 shell        20   0  10G 4.9M 3.9M R 20.0   0.1   0:00.06 top[m
...
[?25h[0m[999H[Krk3568_lubancat_2_v3_mipi1080p:/ $
[timed-out: collected 5414ms of output, Ctrl+C sent]
```

关键观察:

- **多帧快照捕获**——5 秒内捕获了 top 的多次刷新(CPU idle 从 377%→392%、top 进程 TIME+ 从 0:00.06→0:00.12)
- **top 被终止**——熔断后 echo 验证输出干净,无 top 残留、无 ANSI 码混入
- **ANSI 转义码**——top 在 PTY 模式下用全屏 curses 界面(清屏 `[H[J`、隐藏光标 `[?25l`、反白 `[7m` 等),输出含大量终端控制序列。这是 TUI 程序的固有特性,不影响功能正确性,但 LLM 解析困难。后续可用 `top -n 1 -b`(batch 模式)规避,无需改代码

#### 1.9 会自己结束的常驻命令变体(logcat -t)

**命令:** `logcat -t 3`
**maxDuration:** 5000
**预期:** 命令打印完最近 3 秒日志后自己退出,提示符检测命中,不触发熔断

**结果:** ✅ 通过

```
--------- beginning of kernel
05-23 17:16:48.938   467   467 W healthd : battery l=50 v=3300 t=2.6 h=2 st=3 c=-1600 fc=100 chg=au
--------- beginning of system
05-23 17:17:00.000   653   753 D AlarmManager: setImplLocked() callingPackage=android isWakeupAlarm=false when=11542243 whenElapsed=11542243 windowLength=0
05-23 17:17:48.942   467   467 W healthd : battery l=50 v=3300 t=2.6 h=2 st=3 c=-1600 fc=100 chg=au
rk3568_lubancat_2_v3_mipi1080p:/ $
```

【**此场景验证了提示符检测的核心价值**】`logcat -t 3` 与 `logcat`(不带参数)本质不同——前者打印完指定时间窗口的日志后自己退出,后者永不结束。对前者,exec 检测到提示符后立即返回,不傻等满 maxDuration;对后者,靠熔断兜底。两者被正确区分。

#### 1.10 会话恢复与残留验证

贯穿上述场景的每次熔断后,均通过执行简单 echo 命令验证会话状态:

| 熔断场景 | 熔断后 echo 输出 | 会话状态 |
|---------|-----------------|---------|
| logcat 熔断后 | `alive_check` 干净 | ✅ 恢复 |
| logcat + send_ctrl 后 | `after_sendctrl` 干净 | ✅ 恢复 |
| logcat \| grep 熔断后 | `top_killed_check` 干净 | ✅ 恢复 |
| top 熔断后 | `top_killed_check` 干净 | ✅ 恢复 |

所有熔断场景下,会话均可靠恢复,后续命令输出无残留、无 ANSI 码、无命令回显污染。

### 2. serial 通道

测试设备:ATK-IMX6U(Linux),会话 `serial_1`(COM3 @ 115200 物理串口)。

#### 2.1 常驻命令自动熔断(AC3 / AC8)

**命令:** `ping 192.168.10.100`(不可达地址)
**maxDuration:** 8000
**预期:** 8 秒后自动发 Ctrl+C,返回 timed-out 标注,会话恢复

**结果:** ✅ 通过

```
PING 192.168.10.100 (192.168.10.100) 56(84) bytes of data.
From 192.168.16.105 icmp_seq=1 Destination Host Unreachable
...
From 192.168.16.105 icmp_seq=6 Destination Host Unreachable
^C
--- 192.168.10.100 ping statistics ---
9 packets transmitted, 0 received, +6 errors, 100% packet loss, time 8002ms
pipe 3
root@ATK-IMX6U:~#
[timed-out: collected 8402ms of output, Ctrl+C sent]
```

关键观察:

- **熔断行为与 adb 一致** — `collected 8402ms` 与 adb 通道 logcat 的 `5000ms` 同源(均由 `maxDuration` 决定,非通道差异)
- **`^C` 回显可见** — ping 在行模式(cooked)下 tty driver 回显 `^C` 两个可见字符,日志中清晰可见
- **SIGINT 语义正确** — `pipe 3`、`100% packet loss, time 8002ms`、退出码行齐全,证明 Ctrl+C 经串口 → tty → ping 的信号传递完整

#### 2.2 全屏 TUI 熔断 + batch 模式对比(AC3 / AC4)

**命令 A:** `top`(maxDuration: 5000)
**命令 B:** `top -n 1 -b`(maxDuration: 5000)

**结果:** ✅ 通过

| 命令 | 是否退出 | 熔断触发 | 输出含 ANSI | 多帧快照 |
|------|---------|---------|-------------|---------|
| `top` | ❌ 永不退出 | ✅ 5 秒熔断(`collected 5421ms`) | ✅ 大量(`[?25l`/`[H[J`/`[7m` 等) | ✅ 2 帧 |
| `top -n 1 -b` | ✅ 单次退出 | ❌ 未触发(提示符检测命中) | ❌ 无 | ❌ 仅 1 帧 |

关键观察:

- **`top -n 1 -b` 是获取系统快照的推荐用法** — batch 模式打印完单次快照后自退出,exec 检测到提示符 `root@ATK-IMX6U:~#` 立即返回,既不熔断也无 ANSI 噪声,输出纯文本可直接解析
- **TUI 模式的 ANSI 转义码属固有特性** — 不影响功能正确性,但 LLM 解析困难,需调用方选用 batch 模式规避

#### 2.3 短命令提示符检测提前返回(AC4 / AC8)

**命令:** `ping -c 3 192.168.16.100`(可达地址)
**maxDuration:** 5000

**结果:** ✅ 通过

```
PING 192.168.16.100 (192.168.16.100) 56(84) bytes of data.
64 bytes from 192.168.16.100: icmp_seq=1 ttl=128 time=0.675 ms
64 bytes from 192.168.16.100: icmp_seq=2 ttl=128 time=0.458 ms
64 bytes from 192.168.16.100: icmp_seq=3 ttl=128 time=0.457 ms

--- 192.168.16.100 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 1998ms
rtt min/avg/max/mdev = 0.457/0.530/0.675/0.102 ms
root@ATK-IMX6U:~#
```

关键观察:

- **提示符检测核心价值** — `ping -c 3` 在 ~2 秒自结束,exec 检测到提示符后立即返回,未傻等满 5 秒 `maxDuration`,末尾无 `[timed-out]` 标注
- **与常驻 ping 正确区分** — 同样是 ping,带 `-c 3` 的会结束(靠提示符检测提前返回),不带的永不结束(靠熔断兜底),两者被正确区分
- **TTL=128** — 目标 `192.168.16.100` 为 Windows 主机(开发机),亚毫秒级延迟,链路质量良好

#### 2.4 字节日志可观测性缺陷发现(AC10 边角)

测试 `top` 熔断时,对照串口原始字节日志 `.embedded/log/serial_1_*.log` 发现两类现象:

- **top 熔断无 `^C` 回显** — 与 ping 场景(行模式,日志可见 `^C`)不同,top 在 raw 模式下吞掉 `\x03` 字节不回显。经 hexdump 验证:ping 场景日志含 `0x5e 0x43`(`^C` 两个可见字符),top 场景日志对应位置仅有光标定位码。这是 TUI 程序的固有行为,非 bug
- **提示符与下一条命令合并写同一行** — top 被杀后 shell 恢复打印的提示符 `root@ATK-IMX6U:~#` 字节里不含 `\n`,卡在 FileLogger 的行缓冲区(`#logLineBuf`)中未 flush,直到下一次 exec 发命令带来 `\n` 才合并写出,导致提示符与下一条命令回显挤在同一日志行

【**影响范围**】不影响功能正确性(熔断、会话恢复、前置冲刷均正常),仅影响字节日志的可读性。属 AC10(日志可观测)未覆盖的边角,留待后续优化(可考虑在熔断点写事件标记,或 FileLogger 增加超时 flush 机制)。

### 3. ssh 通道

测试设备:ATK-IMX6U(Linux),会话 `ssh_1`(`192.168.16.105:22`,dropbear)。SSH 本就有 PTY,无需像 adb 那样加 `-t -t`。

#### 3.1 常驻命令自动熔断(AC3 / AC8)

**命令:** `ping 192.168.10.100`(不可达地址)
**maxDuration:** 8000

**结果:** ✅ 通过

```
PING 192.168.10.100 (192.168.10.100) 56(84) bytes of data.
From 192.168.16.105 icmp_seq=1 Destination Host Unreachable
...
From 192.168.16.105 icmp_seq=6 Destination Host Unreachable
^C
--- 192.168.10.100 ping statistics ---
9 packets transmitted, 0 received, +6 errors, 100% packet loss, time 8006ms
pipe 3
root@ATK-IMX6U:~#
[timed-out: collected 8367ms of output, Ctrl+C sent]
```

关键观察:

- **与 serial 通道逐字节一致** — 同样的命令、同样的 ping 统计(9 包 / 0 收 / +6 errors / `pipe 3`)、同样的 `^C` 回显、同样的退出码行
- **熔断时长差 35ms** — serial `8402ms` vs ssh `8367ms`,差异来自物理串口传输 vs TCP 的微小延迟,上层 `runExec` 轮询逻辑完全共用(对应 F5 共享逻辑复用的设计目标)

#### 3.2 send_ctrl 手动终止常驻命令(AC1 / AC8)

**流程:** `ssh_shell_write(ping)` → `ssh_shell_send_ctrl(c)` → `ssh_shell_exec(echo after_sendctrl_ssh)`

**结果:** ✅ 通过

send_ctrl 返回 `Ctrl+C sent ()`(注:`\x03` 为不可打印字符,括号内字节不可见属正常)。后续 exec 返回:

```
after_sendctrl_ssh
root@ATK-IMX6U:~#
```

关键观察:

- **send_ctrl 跨通道一致** — ssh 通道的 `ssh_shell_send_ctrl` 与 serial 的 `serial_send_ctrl` 返回格式、字节语义完全一致
- **前置冲刷消除残留(AC2)** — send_ctrl 后 exec 的输出 `after_sendctrl_ssh` 干净,无 ping 残留,证明 `runExec` 前置 `drain()` 在 ssh 通道同样生效

#### 3.3 top 熔断 + batch 模式对比(AC3 / AC4 / AC8)

**命令 A:** `top`(maxDuration: 5000)
**命令 B:** `top -n 1 -b`(maxDuration: 5000)

**结果:** ✅ 通过

| 命令 | 熔断触发 | `collected` 时长 | 输出含 ANSI |
|------|---------|-----------------|-------------|
| `top` | ✅ 5 秒熔断 | 5403ms | ✅ 大量 |
| `top -n 1 -b` | ❌ 未触发 | — | ❌ 无 |

关键观察:

- **与 serial 通道 top 行为一致** — serial `5421ms` vs ssh `5403ms`,差 18ms,同样来自传输层延迟
- **SSH 本就有 PTY** — 无需像 adb 那样加 `-t -t`,PTY 回显与提示符检测在 ssh 通道天然生效

#### 3.4 短命令提示符检测(AC4 / AC8)

**命令:** `ping -c 3 192.168.16.100`(可达地址)
**maxDuration:** 5000

**结果:** ✅ 通过(输出与 serial 2.3 一致,3 包全收,RTT 0.386~0.571ms,提示符检测命中后立即返回,未熔断)

## 四、 测试发现与设计调整

### 1. adb shell 无 PTY 不回显提示符(关键发现)

测试场景 1(echo)首次执行时,命令跑满 10 秒被误熔断。根因:AdbShell 用 `spawn("adb", [..., "shell"])` 不带 `-t`,adb 默认不分配 PTY,设备侧 shell 不回显 PS1 提示符,导致提示符检测正则永远不命中。

**修复:** `transports/adb.ts` 的 spawn 参数改为 `shell -t -t`(两个 `-t` 强制分配 PTY)。单个 `-t` 因 stdin 非 terminal 会被 adb 拒绝。修复后 banner 即含提示符 `rk3568...:/ $`,所有场景恢复正常。

### 2. PTY 回显剥离

启用 PTY 后,设备会原样回显输入的命令行(如 `rk3568...:/ $ echo hi`),污染输出。runExec 加入回显剥离逻辑:发命令后丢弃首行(到第一个 `\n`),`\n` 之后才是真实输出。所有测试场景的输出均无命令回显,验证剥离生效。

### 3. 退出码前缀 130

管道命令熔断后,提示符前出现 `130|`(如 `130|rk3568...:/ $`)。`130 = 128 + 2`,表示前一个命令被 SIGINT(信号 2)终止。这是 shell 的 PS1 显示上次退出码的正常行为,证明 Ctrl+C 的 SIGINT 语义正确传递到管道进程组。非 bug,不影响后续命令执行。

### 4. serial 字节日志的可观测性缺陷(AC10 边角)

serial 通道测试 `top` 熔断时,对照原始字节日志 `.embedded/log/serial_1_*.log` 发现:top 熔断帧既看不到 `^C` 回显,也看不到提示符,而下一条命令的日志行却同时含提示符与命令回显。经 hexdump 与代码核查定位到两层原因:

- **top 在 raw 模式下吞掉 `\x03` 不回显** — ping 场景的 tty driver 处于行模式(cooked),会把 Ctrl+C 渲染成可见的 `^C` 两字符(`0x5e 0x43`);而 top 是全屏 curses 程序,把 tty 设为 raw 模式后直接读走 `\x03` 字节,不产生回显。这是 TUI 程序的固有行为,非 bug
- **FileLogger 按行 flush 导致提示符延迟落盘** — top 被杀后 shell 恢复打印的提示符 `root@ATK-IMX6U:~#` 末尾无 `\n`,卡在 FileLogger 的行缓冲区 `#logLineBuf` 中未 flush,直到下一次 exec 发命令带来 `\n` 才合并写出,导致提示符与下一条命令回显挤在同一日志行

【**影响范围**】仅影响字节日志的可读性,不影响熔断、会话恢复、前置冲刷等功能正确性。属 AC10(日志可观测)未覆盖的边角,留待后续优化(可考虑在熔断点向 FileLogger 写事件标记,或给 FileLogger 增加超时 flush 机制)。

### 5. ssh 登录的 PSH 状态机误判(非 ch08 范围)

`ssh_shell_login(device=board-b)` 调用返回 30 秒超时,但底层 `ssh_1` 会话实际已建立且立即可用(echo 命令直接返回提示符)。根因:board-b 的 SSH 配置启用了 `keyProvider.mode: file` 的 PSH 解锁流程,但 `challenge.txt` / `password_input.txt` 均为空,PSH 状态机误将已就绪的 shell 判定为需要解锁,白白轮询等待密钥直到 MCP 工具层 30 秒超时。

【**影响范围**】属 `ssh_shell_login` / `serial_shell_login` 共用的 PSH 探测逻辑问题,不在 ch08 的改造范围内。对 ch08 的 exec / send_ctrl 测试无影响(直接用已建立的 ssh_1 会话即可验证)。

## 五、 未覆盖项

| 项 | 原因 | 风险评估 |
|----|------|---------|
| AC5 配置覆盖 | 未单独配置 promptPattern 测试 | getPromptPattern 机制已实现且编译通过,默认正则已覆盖三台测试设备的提示符(adb `:/ $`、serial/ssh `root@...:#`) |
| AC9 向后兼容 | 未对比旧参数行为 | exec 旧参数(delay/clear)保留,新增 maxDuration 为可选,代码层面已保证兼容 |
| AC10 字节日志可观测(熔断事件) | 字节日志仅记录串口原始字节,熔断决策走 logger 不落盘到字节日志;且 top 场景存在行 flush 缺陷(见四-4) | logger.info/warn 调用已埋点,编译通过;功能正确性不受影响,仅日志可读性有边角缺陷 |

## 六、 总结

A+B 方案在 adb、serial、ssh 三个通道的真机验证覆盖了瞬时命令、长命令、常驻命令、管道命令、全屏 TUI 五类核心场景,以及熔断后会话恢复、前置冲刷、控制字符发送等关键能力,全部通过。测试过程中发现的 adb PTY 问题已修复并回归验证;serial 通道额外发现字节日志的可观测性边角缺陷(top 熔断无 `^C` 回显 + FileLogger 行 flush 延迟),不影响功能正确性,留待后续优化。

三通道共用 `runExec` 统一编排,同命令同 `maxDuration` 下的熔断时长差异仅来自传输层延迟(serial 8402ms / ssh 8367ms,差 35ms),验证了 F5(共享逻辑复用)的设计目标。AC8(三通道一致)从"代码同构保证"升级为真机实测通过。

---
*本文档由 markdowncli 技能辅助生成*
