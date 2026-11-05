<!-- more -->

<a id="section_exec_timeout"></a>

`serial_exec` / `ssh_shell_exec` / `adb_shell_exec` 这三个交互式 exec 工具，采用了**提示符检测 + 分类超时**机制。核心思路：**普通命令靠提示符检测自然结束，常驻命令（ping/logcat/top 等永不返回提示符的）才默认套用短超时熔断**。

> 本文说的是工具内部的命令完成判定；MCP 协议层「请求超过 60 秒被客户端判超时」是另一套机制，见 [MCP 工具超时机制](./LV025-工具超时机制.md)。

## 一、 常驻命令识别

命令是否常驻按**首 token**（第一个空白/管道/重定向之前的命令名）判定。内置白名单（`config.yaml` 的 `execTimeout.residentCommands` 可扩展）：

- A 类（首 token 命中即常驻）：`ping`、`ping6`、`logcat`、`top`、`htop`、`watch`、`strace`、`tcpdump`
- B 类（首 token 命中且带 follow 参数才常驻）：`dmesg -w` / `--follow`、`journalctl -f` / `--follow`、`tail -f` / `-F` / `--follow`

不在白名单中的命令按普通命令处理。

## 二、 双超时策略

### 1. 两种超时

| 命令类型 | 默认超时 | 超时动作 | 超时类型 | 语义 |
|----------|---------|---------|---------|------|
| 普通命令（瞬时/长命令） | 5 分钟（兜底） | ❌ **不发 Ctrl+C** | `fallback`（兜底超时） | 异常——提示符未匹配的安全阀，调用方应确认/手动终止 |
| 常驻命令（ping/logcat/top...） | 10 秒（采样） | ✅ **发 Ctrl+C** | `sampling`（采样超时） | 中性——预期采样行为，输出已收集 |

### 2. 机制流程

每条命令进入 exec 后：

（1）**常驻分类**——按白名单判定命令类型，选定超时时长与动作；

（2）**前置冲刷**清空缓冲区残留；

（3）在有效时长内**发送命令并轮询**读取输出；

（4）**结束判定**——检测到 shell 提示符（Android `:/ $` / `:/ #`、Linux `$` / `#` / `>`、U-Boot `=>`，支持 `promptPattern` 覆盖）→ 立即返回 `timeoutKind=none`；超时未检测到 → 按命令类型分支：

- **常驻命令**：发 Ctrl+C 终止（避免 ping/logcat 后台持续运行污染后续会话），返回 `timeoutKind=sampling`，末尾追加 `[采样超时: 已收集 Xms 输出，已发送 Ctrl+C 终止常驻命令]`
- **普通命令**：不发 Ctrl+C（避免误杀可能已完成只是提示符没匹配的命令），返回 `timeoutKind=fallback`，末尾追加 `[兜底超时: 已收集 Xms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`

### 3. `timeoutMs` 的作用范围

`timeoutMs` 参数只覆盖「执行时长」，**不改变超时后的动作**（是否发 Ctrl+C 始终由命令常驻性决定）：

| 调用方式 | 命令类型 | 效果 |
|---------|---------|------|
| 不传 `timeoutMs` | 常驻命令（ping） | 默认 10s 采样超时，发 Ctrl+C |
| 不传 `timeoutMs` | 普通命令（make） | 默认 5min 兜底超时，不发 Ctrl+C |
| `timeoutMs: 30000` | 常驻命令（ping） | 30s 采样超时，发 Ctrl+C（时长覆盖，动作不变） |
| `timeoutMs: 5000` | 普通命令（sleep） | 5s 兜底超时，不发 Ctrl+C（时长覆盖，动作不变） |

## 三、 调用方传参约定

exec 工具要求调用方（AI）**每次调用都预估命令预期耗时并显式传 `timeoutMs`**，仅当用户明确表示不传时才可省略。未传时落到的 300000ms（5 分钟）只是内部兜底安全阀，**不作为建议传值**——当前没有需要等满 5 分钟才有结果的命令，确有超过 ~2 分钟的命令时应显式传更大的值。分级参考（与工具描述一致）：

| 命令类型 | 建议 `timeoutMs` |
|---------|------------------|
| 基础瞬时命令（ls/pwd/echo/cat 小文件/ip addr/uname） | 3000-5000，上限 10000 |
| 大输出命令（cat 大文件、dmesg/journalctl 长输出、日志转储） | 20000-30000 |
| 中等任务（apt install、dd、服务重启） | 30000-120000 |
| reboot/reset/断电重启 | ≤120000 |
| 常驻命令采样（ping/logcat/top） | 10000（到点自动发 Ctrl+C） |

漏传 `timeoutMs` 时，exec 返回文本末尾会追加 `[提示: 本次未传 timeoutMs, ...]` 反向引导调用方下次显式传参；该提示不代表命令失败。

## 四、 全局默认配置

常驻命令识别、采样超时、兜底超时的**全局默认值**写在 `config.yaml` 根层的 `execTimeout` 子段：

```yaml
# .embedded/configs/config.yaml
execTimeout:
  residentCommands:          # 常驻命令扩展名单（与内置白名单并集），留空仅用内置
    - my_log_streamer
  samplingTimeoutMs: 10000   # 常驻命令采样超时（ms），留空默认 10000
  fallbackTimeoutMs: 300000  # 普通命令兜底超时（ms），留空默认 300000（5 分钟）
```

三项均为全局级，所有设备共享。设备级可覆盖，写法与优先级见 [配置指南：全局 execTimeout 配置](../03-使用指南/LV005-配置指南.md#section_exec_config)。

> `[采样超时: ...]` 是**中性采样结果，不是异常**——对 `logcat` 取样、`top` 采样就是预期行为，AI 不应视为命令出错。`[兜底超时: ...]` 则提示调用方注意命令可能仍在运行。

---

*本文档由 markdowncli 技能辅助生成*
