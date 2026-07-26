# 串口 ZMODEM 文件传输 — 超时与串口恢复测试计划

## 一、测试目标

验证 ZMODEM 文件传输在各种超时场景下的 MCP 行为正确性与串口恢复能力：

1. **双正交超时机制**：空闲超时（`idle_timeout`）与总时长超时（`timeout`）是否按设计触发，中止原因语义是否正确
2. **中止后串口恢复**：`abortDeviceSession`（CAN×5+BS×5）能否让设备端 rz/sz 干净退出，`recoverShell` 能否恢复 shell 提示符
3. **会话连续性**：超时中止后同一 session_id 是否仍可执行命令（无需重新 `serial_open`）
4. **异常场景不崩溃**：协议层异常、全局 rejection 不会导致 MCP 进程退出
5. **半写文件清理**：下载超时后半写文件是否被 `unlink` 清理

## 二、测试环境

| 项目 | 说明 |
|------|------|
| 设备 | board-b（COM3 @ 115200） |
| 串口会话 | `serial_1`（通过 `serial_shell_login board-b` 建立） |
| 测试文件 | 预置在设备端和本地各一个 5MB+ 二进制文件 |
| 设备端工具 | `rz` / `sz`（lrzsz 包） |
| 默认超时 | `timeout=300s`，`idle_timeout=15s` |
| 空闲超时下限 | `min=3s`（`IDLE_TIMEOUT_MIN_SEC`） |

### 前置准备

```bash
# 一键登录
serial_shell_login board-b
# → session_id = serial_1

# 设备端准备大文件（5MB 随机数据）
serial_exec serial_1 "dd if=/dev/urandom of=/tmp/testfile.bin bs=1M count=5"
serial_exec serial_1 "md5sum /tmp/testfile.bin"

# 本地准备大文件（5MB 随机数据，在 Git Bash 执行）
#   dd if=/dev/urandom of=test/testfile.bin bs=1M count=5
#   md5sum test/testfile.bin
```

## 三、超时分类与预期行为矩阵

| 编号 | 超时类型 | 触发条件 | `abortReason` | 预期行为 | 串口恢复 |
|------|---------|---------|---------------|---------|---------|
| T-Idle | 空闲超时 | 无数据流动超过 `idle_timeout` 秒 | `"idle"` | 真故障，停止并报错 | CAN×5+BS×5 → recoverShell |
| T-Overall-P | 总时长超时（仍在推进） | `timeout` 到点且距上次进度 < `idle_timeout` 秒 | `"overall-proceeding"` | timeout 设小了，给建议值 | CAN×5+BS×5 → recoverShell |
| T-Overall-S | 总时长超时（已停滞） | `timeout` 到点且距上次进度 >= `idle_timeout` 秒 | `"overall-stalled"` | 兜底，按真故障处理 | CAN×5+BS×5 → recoverShell |
| T-Handshake | 握手超时 | 设备 5 秒内未回 ZRINIT/ZRQINIT | —（抛错） | 返回失败 + 协议层 abort | 协议层未挂旁路，直接 recoverShell |
| T-ZFIN | 关闭握手超时 | `session.close()` 5 秒未完成 | —（`cleanEnded=false`） | `closeSessionWithTimeout` 超时返回 | CAN×5+BS×5 → recoverShell |
| T-AbortExternal | 外部中止 | 用户主动 Ctrl+C / 其他 abort | —（取决于触发时机） | 失败返回 | CAN×5+BS×5 → recoverShell |

### 关键判据对照表

| 信号 | 含义 |
|------|------|
| CAN×5 + BS×5 | **主动中止**（MCP 发送 `abortDeviceSession`） |
| CAN×10 + BS×10 | **设备 lrzsz 超时退出**（等不到对端响应，lrzsz 内部调 `canit` 两次） |
| 距上次进度 < idleTimeoutSec | **传输仍在推进** → `overall-proceeding` |
| 距上次进度 >= idleTimeoutSec | **传输已停滞** → `overall-stalled` |

## 四、测试用例

### TC01：基础功能验证（对照基线）

**目的**：确保传输本身正常，后续超时测试的结果可信。

| 方向 | 步骤 | 预期 |
|------|------|------|
| 上传 | `serial_upload serial_1 local_path=test/testfile.bin` | 成功，返回摘要含 bytes/durationMs/rate |
| 验证 | `serial_exec serial_1 "md5sum /tmp/testfile.bin"` | md5 与本地一致 |
| 下载 | `serial_download serial_1 remote_path=/tmp/testfile.bin local_path=test/downloaded.bin` | 成功，返回摘要 |
| 验证 | 本地 md5sum `downloaded.bin` | 与设备端 md5 一致 |
| 会话 | 传输后 `serial_exec serial_1 "echo ok"` | 返回 `ok`，shell 提示符正常 |

---

### TC02：空闲超时触发——上传无响应（T-Idle / Upload）

**目的**：验证 `idle_timeout` 在设备端停止响应时正确触发，串口恢复。

**触发方式**：传一个不存在的命令让设备不启动 rz。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin recv_cmd="nonexistent_cmd" idle_timeout=5` | 命令写后设备无 ZRINIT 响应 |
| 2 | 等待 ≤ 5 秒 | idle 超时触发 |
| 3 | 观察返回文案 | 含 `No data flow for 5s — likely a link or device failure.` |
| 4 | 检查日志 | `[zmodem] sending CAN×5+BS×5 to abort device-side rz/sz` 出现 |
| 5 | 串口恢复 | `recoverShell` 执行：发回车 → 排空缓冲 |
| 6 | `serial_exec serial_1 "echo alive"` | 返回 `alive`，shell 正常 |
| 7 | 会话可用性 | 可再次 `serial_upload` 正常传输 |

---

### TC03：空闲超时触发——下载无响应（T-Idle / Download）

**目的**：对称验证下载方向的 idle 超时。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_download serial_1 remote_path=/nonexistent/file.bin local_path=test/test_dl.bin idle_timeout=5` | sz 报错或无 ZFILE offer |
| 2 | 等待 ≤ 5 秒 | idle 超时触发 |
| 3 | 检查返回文案 | `No data flow for 5s — likely a link or device failure.` |
| 4 | 检查日志 | `CAN×5+BS×5` 发出 |
| 5 | 检查本地文件 | `test/test_dl.bin` **不存在**（被 catch → `unlink` 清理） |
| 6 | `serial_exec serial_1 "echo alive"` | 返回 `alive` |

---

### TC04：总时长超时——传输仍在推进（T-Overall-P / Upload）

**目的**：验证 `timeout` 到点时传输仍在推进，返回建议值而非静默截断。

**触发方式**：设很小的 `timeout`（如 3s）传一个大文件（5MB），3 秒内传输不可能完成。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin timeout=3 idle_timeout=60` | 开始传输，进度显示字节递增 |
| 2 | 3 秒后 | `timeout` 超时触发 |
| 3 | 检查返回文案 | 含 `Reached overall timeout (3s) while transfer was still progressing` |
| 4 | 文案含实测速率 | 如 `~11.50 KB/s` |
| 5 | 文案含建议值 | `Retry with timeout >= NNNs`（基于实测速率外推 + 30% 余量） |
| 6 | 文案含已传/总大小 | `The file is incomplete (X/Y bytes)` |
| 7 | 检查日志 | `CAN×5+BS×5` 发出 |
| 8 | `serial_exec serial_1 "echo alive"` | 返回 `alive` |

> **关键**：设 `idle_timeout=60` 的目的是防止 idle 先于 overall 触发，确保一定由 `overall-proceeding` 路径处理。

---

### TC05：总时长超时——传输仍在推进（T-Overall-P / Download）

**目的**：对称验证下载方向的 `overall-proceeding`。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_download serial_1 remote_path=/tmp/testfile.bin local_path=test/test_dl.bin timeout=3 idle_timeout=60` | 开始接收数据 |
| 2 | 3 秒后 | `timeout` 超时触发 |
| 3 | 检查返回文案 | `Reached overall timeout (3s) while transfer was still progressing` |
| 4 | 检查本地文件 | `test/test_dl.bin` **不存在**（被 `unlink` 清理） |
| 5 | `serial_exec serial_1 "echo alive"` | 返回 `alive` |

---

### TC06：总时长超时——传输已停滞（T-Overall-S）

**目的**：验证兜底路径 `overall-stalled` 按真故障处理。

**触发方式**：设 `timeout=6`、`idle_timeout=10`（让 timeout 先于 idle 触发），然后在传输中途让设备暂停。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin timeout=6 idle_timeout=10` | 开始传输 |
| 2 | 在设备端暂停 rz：`serial_exec serial_1 "killall -STOP rz"` | rz 进程暂停，数据停止流动 |
| 3 | ~6 秒后 | `timeout` 超时触发（此时 idle 未触发因为 10s 还差 4s） |
| 4 | 检查 `abortReason` | `"overall-stalled"`（兜底路径） |
| 5 | 检查返回文案 | 按真故障处理，文案等同 idle：`No data flow for ...` |
| 6 | `serial_exec serial_1 "killall -CONT rz 2>/dev/null; echo recovered"` | 恢复 rz 进程，返回 `recovered` |
| 7 | `serial_exec serial_1 "echo alive"` | 返回 `alive` |

> **补充说明**：`overall-stalled` 在正常场景中较少出现（通常 idle 会先触发）。它的存在意义是**兜底**——当 `timeout` < `idle_timeout` 且传输停滞时，提供一条不依赖 idle 的中止路径。此处用 `killall -STOP rz` 模拟传输停滞但不阻塞串口通道的极端场景。

---

### TC07：握手超时（T-Handshake）

**目的**：验证设备端 5 秒内未发首帧时，协议层正确超时并返回。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin recv_cmd="sleep 10"` | `sleep 10` 不是 rz，不会回 ZRINIT |
| 2 | 等待 5 秒 | 握手超时，`establishSession` 抛错 |
| 3 | 检查日志 | `[zmodem] handshake timeout: no first frame from device within 5000ms` |
| 4 | 返回错误 | `ZMODEM handshake timeout: no first frame from device within 5000ms` |
| 5 | 此时字节旁路已卸载 | `detach()` 在 `establishSession` 的 catch 中已调用 |
| 6 | `serial_exec serial_1 "echo alive"` | 返回 `alive`（可能混在 sleep 回显中，但不影响 shell 可用性） |

> **注意**：`sleep 10` 执行后 shell 会卡 10 秒才回提示符。`establishSession` 5 秒超时返回后，`recoverShell` 会发回车 + 排空。sleep 回显可能出现在下一次 `serial_exec` 的输出中——这是正常现象，不影响 shell 可用性。

---

### TC08：ZFIN 握手超时——正常路径验证（T-ZFIN）

**目的**：验证成功路径上 `cleanEnded=true`，不发设备 abort。ZFIN 超时异常路径通过代码审查验证。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 正常上传一个文件 | `serial_upload serial_1 local_path=test/testfile.bin` |
| 2 | 正常完成 | 成功，`cleanEnded=true`，不发设备 abort |
| 3 | 检查日志 | 无 `CAN×5+BS×5` 日志（成功路径不发 abort） |
| 4 | `serial_exec serial_1 "echo alive"` | 返回 `alive` |

**ZFIN 超时代码验证**（不依赖真机触发，审查 `closeSessionWithTimeout`）：

```
zmodem-bridge.ts:112-145
  - const timer = setTimeout(() => finish(false), SESSION_END_TIMEOUT_MS)  // 5s 兜底
  - signal.aborted 时立即 finish(false)
  - session.close() reject 时 finish(false)
  - finally 块: if (!cleanEnded) abortDeviceSession(shell)
```

确认三点：
1. 超时兜底：5 秒后 `finish(false)` → `cleanEnded=false` → 发设备 abort
2. abort 感知：`signal.aborted` 立即返回 → 不干等 5 秒
3. reject 感知：`session.close()` 抛错 → `finish(false)`

---

### TC09：下载侧 abort 信号不假成功（AC5 强化）

**目的**：验证下载超时时 `aborted` 标志防止进入成功返回路径（已修复 Bug 回归测试）。

**背景**：修复前，`onAbort` 直接 `resolveEnd()` 会让 `await sessionEnd` 拿到 `undefined` 后进入"成功"返回路径，带着部分字节报 `Download succeeded`。修复后置 `aborted=true` 标志，`await sessionEnd` 后检查并抛错走 catch。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_download serial_1 remote_path=/tmp/testfile.bin local_path=test/test_dl.bin timeout=3` | 下载中途超时 |
| 2 | 检查返回 | `success: false`（不是 `success: true`） |
| 3 | 检查本地残缺文件 | `test/test_dl.bin` 不存在（被 `unlink` 清理） |
| 4 | 检查日志 | abortDeviceSession + CAN×5+BS×5 发出 |

---

### TC10：上传侧 `raceAbort` 防止悬挂（AC5 强化）

**目的**：验证 `raceAbort` 在 `send_offer` / `transfer.end` 悬挂时主动 reject，防止超时后永久卡死。

**背景**：`zmodem.js` 在 `session.abort()` 后，`send_offer` / `transfer.end` 的 Promise 可能既不 resolve 也不 reject，导致上传超时彻底失效。`raceAbort` 在 `AbortSignal` 触发时主动 reject。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin timeout=2` | 上传 2 秒后超时 |
| 2 | 检查返回 | 在 ≤ 5 秒内返回（未被悬挂卡死） |
| 3 | 检查返回 | `success: false` |
| 4 | 时序验证 | 返回时间 ≈ timeout(2s) + 协议层处理时间 + recoverShell，不应 > 10 秒 |

---

### TC11：`cleanEnded` 门控验证（关键设计回归）

**目的**：确认 `cleanEnded=true` 时跳过 `abortDeviceSession`，避免成功路径上发 CAN 序列破坏终端（已修复 Bug #8 回归测试）。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 代码审查 `zmodemSend` finally | `if (!cleanEnded) await abortDeviceSession(shell)` |
| 2 | 代码审查 `closeSessionWithTimeout` | 仅在 `session.close().then(() => finish(true))` 时 `cleanEnded=true` |
| 3 | 代码审查 `zmodemReceive` finally | `if (!cleanEnded) await abortDeviceSession(shell)` |
| 4 | 代码审查 session_end 事件 | `cleanEnded = true; resolveEnd()` |
| 5 | 真机：`serial_upload` 成功 | 日志无 `CAN×5+BS×5` |
| 6 | 真机：`serial_download` 成功 | 日志无 `CAN×5+BS×5` |
| 7 | 真机：成功传输后 shell 提示符正常 | 无乱码、无重复打印、命令可执行 |

---

### TC12：连续多次传输——旁路挂载卸载反复性

**目的**：验证字节旁路的挂载/卸载可反复进行，无状态残留。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 连续 3 次 `serial_upload` 不同文件 | 每次均成功，md5 一致 |
| 2 | 连续 3 次 `serial_download` 不同文件 | 每次均成功，md5 一致 |
| 3 | 交替 upload/download | 各 2 次，全部成功 |
| 4 | 每次传输后 | `serial_exec serial_1 "echo ok"` 正常返回 |
| 5 | 审查日志 | 每次建立会话后 `attachRawReceiver` 挂载，finally 中 `detach()` 卸载 |

---

### TC13：超时与恢复压力测试

**目的**：验证连续多次超时中止后串口不退化。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 连续 5 次 `serial_upload timeout=2` 上传 5MB 文件 | 每次都在 2~5 秒内返回失败 |
| 2 | 检查每次返回 | `success: false`，文案含超时原因 |
| 3 | 每两次之间 `serial_exec serial_1 "echo round-N"` | 每次正常返回 `round-N` |
| 4 | 第 5 次超时后，正常上传一个文件 | 成功，md5 一致 |
| 5 | 审查 MCP 进程 | 全程无崩溃、无 `unhandledRejection` 警告 |

---

### TC14：快速连续 idle 超时（最小 idle_timeout）

**目的**：验证极端小值 `idle_timeout=3`（下限）的行为。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin recv_cmd="nonexistent" idle_timeout=1` | `idle_timeout` 被提升到下限 3s |
| 2 | 等待 3 秒 | idle 超时触发 |
| 3 | 检查返回文案 | `No data flow for 3s`（显示的是实际生效值 3s，不是传入的 1s） |
| 4 | 串口恢复 | recoverShell 正常执行 |
| 5 | `serial_exec serial_1 "echo ok"` | 返回 `ok` |

---

### TC15：全局异常兜底验证

**目的**：确认 `unhandledRejection` / `uncaughtException` 处理器能防止 MCP 进程崩溃。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 代码审查 `server.ts` | `process.on("unhandledRejection", ...)` 和 `process.on("uncaughtException", ...)` 已注册 |
| 2 | 代码审查 `establishSession` 字节旁路 | `try { session.consume(...) } catch { /* session 已 abort，忽略 */ }` |
| 3 | 真机：上传中途触发 abort | MCP 进程不崩溃，传输返回失败 |

---

### TC16：`drainPort` 对中止序列送达的影响（Windows 专项）

**目的**：验证 `abortDeviceSession` 中 `drainPort()` 的必要性。

**背景**：Windows 串口驱动实测，如果不 `drainPort()`，CAN×5+BS×5 可能滞留 OS 发送缓冲，设备端收不到而卡死。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 代码审查 `abortDeviceSession` | `shell.rawWrite(ZMODEM_ABORT_SEQUENCE)` 后调 `shell.drainPort()` |
| 2 | 代码审查 `drainPort` | 调 `this.#serialPort.drain(callback)` |
| 3 | 真机：超时场景 | 中止序列总能送达，rz/sz 退出 |

---

### TC17：下载失败 cleanup 验证

**目的**：确认半写文件在多种失败场景下均被清理。

| 场景 | 触发方式 | 预期 |
|------|---------|------|
| 握手超时 | `send_cmd="sleep 10"` | 本地无残留文件 |
| idle 超时 | `idle_timeout=5` + 设备不响应 | 本地无残留文件 |
| overall 超时 | `timeout=3` | 本地无残留文件 |
| 协议错误 | 在传输中途拔串口线 | 本地无残留文件（或残余在 catch 的 unlink 中被清理） |

---

### TC18：`suggestTimeoutSec` 建议值合理性验证

**目的**：确认 `overall-proceeding` 场景下给出的建议值合理。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | `serial_upload serial_1 local_path=test/testfile.bin timeout=5 idle_timeout=60` | 5 秒超时触发 |
| 2 | 记录返回文案中的建议值 | 如 `Retry with timeout >= 900s` |
| 3 | 手动验算 | 验证公式正确性 |

验证公式（代码 `suggestTimeoutSec`，`transfer.ts:201-214`）：

```typescript
const ratePerMs = bytes / durationMs;
const fullMs = (totalSize / ratePerMs) * 1.3;  // 留 30% 余量
return Math.max(Math.ceil(fullMs / 1000), 1);
```

---

## 五、串口恢复观察清单

每次超时测试后，按以下清单检查串口状态：

| 检查项 | 通过标准 | 检查方式 |
|--------|---------|---------|
| shell 提示符 | 可见 `root@ATK-IMX6U:~#` 或等价提示符 | `serial_read serial_1` |
| 命令可执行 | `echo alive` 返回 `alive` | `serial_exec serial_1 "echo alive"` |
| 无乱码回显 | read 输出不含异常二进制字节（不含连续 `\x18`、`\x08` 等） | 观察 `serial_exec` 输出 |
| 无重复打印 | rz/sz 残留回显已被排空，不干扰下一次命令输出 | 观察输出首行不是残余协议字节 |
| 字节旁路已卸载 | 再次传输时 `#rawReceiver` 为 null | 代码审查 + 再次传输成功间接证明 |
| 会话 ID 不变 | 同一 `session_id` 可用 | 全程使用 `serial_1` |

## 六、异常处理观察清单

| 检查项 | 通过标准 |
|--------|---------|
| MCP 进程存活 | 测试全程 MCP 进程不退出、不崩溃 |
| 无 `unhandledRejection` 日志 | 日志中不出现 `unhandledRejection swallowed` |
| 无 `uncaughtException` 日志 | 日志中不出现 `uncaughtException swallowed` |
| timer 无泄漏 | 超时 `clearTimeout` 在 finally 中被调用（代码审查确认） |
| detach 必被调用 | `detach()` 在 finally 中被调用（代码审查确认） |

## 七、执行顺序与依赖

```
TC01（基础功能基线）
  │
  ├── TC02（Idle / 上传）
  ├── TC03（Idle / 下载）
  ├── TC04（Overall-P / 上传）
  ├── TC05（Overall-P / 下载）
  ├── TC07（握手超时）
  │
  ├── TC06（Overall-S / 兜底）       ← 需要 killall -STOP rz，独立执行
  │
  ├── TC08（ZFIN / 成功路径验证）    ← 正常上传即可验证
  ├── TC09（下载 abort 不假成功）
  ├── TC10（上传 raceAbort 不卡死）
  ├── TC11（cleanEnded 门控）
  │
  ├── TC12（连续多次传输）
  ├── TC13（压力测试：连续超时）
  ├── TC14（最小 idle_timeout）
  │
  ├── TC15（全局兜底，代码审查）
  ├── TC16（drainPort，代码审查）
  ├── TC17（半写文件清理）
  ├── TC18（建议值合理性验证）
  │
  └── 恢复检查清单（每 TC 后执行）
```

**建议执行顺序**：
1. 先跑 `TC01` 确认基线正常
2. 按顺序跑 `TC02 → TC05` + `TC07`（核心超时场景）
3. `TC06` 在合适时机单独跑（需要 `killall -STOP rz`）
4. `TC08 → TC11` 验证关键设计
5. `TC12 → TC14` 强化 / 压力测试
6. `TC15 → TC18` 代码审查维度的验证

## 八、常见问题与排查

| 现象 | 可能原因 | 排查方向 |
|------|---------|---------|
| 超时后 shell 无响应 | `abortDeviceSession` 的 CAN 序列未送达（缺 `drainPort`） | 检查日志是否有 `CAN×5+BS×5`；确认 `drainPort` 被调用 |
| 成功传输后 shell 卡死 | `cleanEnded` 误判，成功路径上发了 abort | 排查 `cleanEnded` 置位逻辑；检查日志是否有非预期的 `CAN×5+BS×5` |
| 上传超时不返回（永久卡死） | `raceAbort` 未覆盖到的悬挂 Promise | 检查 `send_offer` / `transfer.end` 是否被 `raceAbort` 包裹 |
| 下载超时返回 `success: true` | `aborted` 标志缺失，`resolveEnd` 误入成功路径 | 检查 `onAbort` 是否置 `aborted=true`；回归 TC09 |
| 连续超时后串口越来越慢 | `recoverShell` 排空不彻底，残留字节累积 | 增加 `SHELL_RECOVER_MAX_DRAINS` 或 `SHELL_RECOVER_DRAIN_MS` |
| 设备端发 `CAN×10` | 设备 lrzsz 超时退出（等不到对端响应） | 检查 ZFIN 握手是否完成；检查 `cleanEnded` |
| 日志出现 `already_aborted` | `session.consume` 在 abort 后继续收到字节 | 静默忽略即可（已在 catch 中处理） |
