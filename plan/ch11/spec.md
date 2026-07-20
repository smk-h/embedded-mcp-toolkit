# ADB 日志目录设备名错位修复 Spec

## 背景

`embedded-mcp-toolkit` 的设备终端日志按设备名分目录存放（`{SAVE2FILE_PATH}/{deviceName}/{sessionId}_{ts}.log`）。ADB 通道存在日志目录与真实连接设备对不上的问题，典型现象：

- 通过 adb 登录 board-b，日志却被创建到 `board-a/` 子目录下
- 或反过来：连的是其他设备，目录却固定是 `board-b/`

### 根因（已定位）

`adb_shell_open` 在**连接 adb 之前**就确定了 `deviceName`，并把它直接用作日志子目录；而 `shell.open()` 真正连哪台设备由 adb 自动发现决定，两者相互独立。

代码现状（`src/mcp/tools/adb/shell.ts`）：

```ts
const deviceName = args.device ?? resolveDeviceName();  // 连接前静态猜测
banner = await shell.open();                            // 连接，可能连到别的设备
shell.fileLogger.enableFromEnv(sessionId, deviceName);  // 用猜测值建目录
```

- `resolveDeviceName()` 的兜底链：`process.env.DEVICE`（来自 `.mcp.json`，常量如 `board-b`）→ `config.yaml` 的 `default`（`board-a`）→ 硬编码 `board-a`。这是一个进程级常量，不随实际连接设备变化。
- `board-b.yaml` 中 `adb.serialNo: "sn_none"`，意味着 ADB 目标完全交给 `adb devices` 自动发现，与 `deviceName` 没有绑定关系。

只要 AI 调用 `adb_shell_open` 时**没传 `args.device`**，目录名就永远是那个静态值，错位必然发生。

### 连带影响

错误的 `deviceName` 还会被写入会话表（`src/mcp/sessions/session-store.ts` 的 `SessionMeta`）和设备索引（`src/mcp/sessions/registry.ts` 的 `#sessionsByDevice`），导致 `registry.getByDevice("board-b")` 查不到实际连着 board-b 的 adb 会话——同一根因的扩散面。

### 对照：Serial/SSH 为何不出问题

它们的连接目标（host / 串口路径）本身就从静态 `deviceName` 对应的配置里取，"连哪个"和"记到哪个"天然一致。ADB 因为把目标决定权下放给 adb 自动发现，才让两者解耦。

## 目标

- 让 ADB 日志目录名反映**真实连接的设备**，而非连接前的静态猜测
- 同步修复会话表 `deviceName` 字段，让 `registry.getByDevice()` 能正确归位
- 覆盖调试设备无序列号（`????????????`）的边界情况
- 不改变 Serial / SSH / PowerShell 通道的现有行为
- 不改变用户显式传 `args.device` 时的行为（信任调用方）

## 功能需求

### F1：连接成功后用实际 serialNo 决定日志目录名

`adb_shell_open` 的日志启用时机和 `deviceName` 来源调整：

- **时机**：日志启用（文件创建）挪到 `shell.open()` 成功之后，此时实际连接的 serialNo 已可知
- **目录名确定策略**（按优先级降级，命中即止）：

  | 优先级 | 条件 | 目录名 | 说明 |
  |---|---|---|---|
  | 1a | 调用方传 `args.device`，且其值本身能被反查为别名（即调用方误传了 serialNo） | 反查到的别名（如传 `"43b1e5fe7b186666"` → 得到 `board-lubancat`） | 防御 AI 先调 `adb_device_list` 拿 serialNo、再当 device 传入的常见误用 |
  | 1b | 调用方传 `args.device`，且其值无法被反查为别名（是别名或未登记标识） | `args.device` 原值 | 信任调用方，原样使用 |
  | 2a | 未传 `args.device`，真实 serialNo 有效且在 `config.yaml` 中能反查到设备别名 | 反查到的别名（如 `board-lubancat`） | 通过遍历 `devices` 配置，比对 `adb.serialNo` 与真实 serialNo 实现 |
  | 2b | 未传 `args.device`，真实 serialNo 有效但未在 `config.yaml` 中绑定 | 真实 serialNo 字符串本身（如 `43b1e5fe7b186666`） | serialNo 是连接成功后从 adb 实拿，绝对真实 |
  | 3 | 真实 serialNo 无效（`????????????`、空串、`(auto)` 占位） | 固定占位符 `adb-unknown` | 同一块无序列号调试板的多次会话日志聚合在同一目录 |

  **优先级 1a 的设计动机**：实测发现 AI 调用 adb 工具时，会先调 `adb_device_list` 获取在线设备的 serialNo，再把这个 serialNo 作为 `device` 参数传入 `adb_shell_open`。若按"无条件信任 args.device"处理，日志目录会变成 `43b1e5fe7b186666/` 这种 serialNo 串号目录，而非人类可读的 `board-lubancat/`。1a 在保留"信任调用方"主基调的同时，对"调用方误传 serialNo"这一高频场景做防御性纠正。

- **serialNo 有效性判定**：非空、非全 `?` 字符、非 `(auto)` 占位符三者同时满足才算有效。其余一律视为无效，走占位符
- **多设备无序列号场景无需处理**：`shell.open()` 内部的 `#discoverDevice()` 在多设备时已直接抛错，根本走不到建日志这一步

### F2：会话表 `deviceName` 同步用真实值

`adbStore.create()` 存入 `SessionMeta` 的 `deviceName` 字段，与 F1 计算出的日志目录名**使用同一个值**，确保：

- 日志目录与 `registry.getByDevice(deviceName)` 查询结果一致
- 同一个 adb 会话不会被错误归位到别的设备索引下

### F3：`adb_exec` 同步修复

`src/mcp/tools/adb/exec.ts` 的 `adbExecHandler` 存在与 `adb_shell_open` 相同的"连接前静态猜测 deviceName"问题。本次同步修复，复用 F1 的三级降级策略：

- 对于"需要先连接设备才能知道 serialNo"的命令（如 `adb shell xxx`），在 adb 实际执行返回后，无法稳定拿到 serialNo 的，至少保证 `deviceName` 来源与 F1 一致（不引入新的不一致）
- `adb_exec` 本身不创建终端会话日志（一次性命令，输出走 MCP 响应），但 `deviceName` 的解析逻辑应与 F1 共用同一个工具函数，避免两处实现分叉

### F4：反查函数作为公共工具

提供设备名反查能力作为公共工具函数，供 `adb_shell_open` 和 `adb_exec` 共用：

- **输入**：真实 serialNo 字符串
- **输出**：匹配到的设备别名；匹配不到返回空（由调用方决定降级策略）
- **匹配规则**：遍历 `config.yaml` 的 `devices`，对每个设备解析其 `adb.serialNo`（去掉 `sn_` 前缀），与输入 serialNo 字面相等即命中
- **多设备绑定同一 serialNo 的边界**：若多个别名绑定到同一 serialNo，返回**配置文件中先定义的那个**（YAML 对象键的插入顺序），并在日志中记录 warning 提示存在重复绑定

### F5：schema description 更新

更新 `adb_shell_open` 和 `adb_exec` 工具的 `device` 参数描述，向 AI 说清楚行为，减少误用：

- **推荐传别名**：明确 `device` 参数期望的是 config.yaml 中定义的设备别名（如 `board-lubancat`），而非 serialNo
- **不传也安全**：明确告诉 AI "不传 device 时程序会自动反查别名，无需先调 `adb_device_list`"，避免 AI 习惯性预扫描
- **误传 serialNo 也能纠正**：若 AI 仍传了 serialNo，程序会自动反查为别名（F1 优先级 1a）

目的：从源头减少"AI 先扫描再传 serialNo"的误用路径，同时通过 1a 兜底保证即使误用结果也正确。

描述措辞要点：用 "Device alias (e.g. board-lubancat)" 而非模糊的 "device identifier"——**不提 config.yaml**，避免诱导 AI 直接读配置文件（别名查询应走 `device_info_tool` 或工具内部自动处理）；显式写明 "there is NO need to call adb_device_list first"。

## 非功能需求

### N1：兼容性

- **Serial / SSH / PowerShell 通道行为不变**：本次改动只涉及 `src/mcp/tools/adb/` 下两个 handler 和一个公共工具函数，不改动其他通道的 `enableFromEnv` 调用方式
- **用户显式传 `args.device`（别名）时行为不变**：若传的是 config 中已定义的别名（如 `board-lubancat`），直接用作目录名，与改动前一致
- **用户显式传 `args.device`（serialNo）时行为有调整**：若传的是 serialNo（如 `"43b1e5fe7b186666"`）且能在 config 中反查到别名，目录名用反查到的别名（F1 优先级 1a）。这是对"AI 误传 serialNo"场景的防御性纠正，与改动前"无条件原样使用"不同，但结果是更正确的别名目录
- **`config.yaml` 中已绑定 serialNo 的设备行为不变**：如 `board-lubancat.yaml` 中 `serialNo: sn_43b1e5fe7b186666`，改动前 `resolveDeviceName()` 凑巧返回 `board-lubancat` 时目录正确，改动后通过反查也能得到同样的 `board-lubancat`，结果一致
- **`SAVE2FILE_PATH` 未设置或为 `none` 时不创建目录**：保留 `file-logger.ts` 现有的降级逻辑，本次改动不影响
- **会话表结构不变**：`SessionMeta` 字段定义不动，仅修正存入的 `deviceName` 值

### N2：可观测性

- 目录名确定过程保留 INFO 级日志，至少覆盖：真实 serialNo、反查结果（命中别名 / 未命中走 serialNo / serialNo 无效走占位符）、最终选定的 deviceName、与 `args.device` 是否一致
- 反查函数遇到多设备绑定同一 serialNo 时，记录 WARNING 级日志

### N3：健壮性

- 反查函数对配置读取异常（config.yaml 加载失败）不崩溃，降级返回空，由调用方继续走降级链
- serialNo 有效性判定覆盖常见无效形态：空串、全 `?` 字符串、`(auto)` 占位符、纯空白

## 不做的事

- **不修改 `resolveDeviceName()` 本身**：该函数被 Serial/SSH/PowerShell 多处使用，行为改动影响面大；本次只在 ADB 侧绕过它
- **不修改 `shell.open()` / `#discoverDevice()` 的自动发现逻辑**：多设备抛错、零设备抛错的行为保持现状
- **不持久化"真实 serialNo ↔ deviceName"映射**：每次连接实时反查，避免缓存一致性问题
- **不处理网络 adb（`IP:port` 形态的 serialNo）的特殊目录命名**：网络 adb 的 serialNo（如 `192.168.1.100:5555`）会走 F1 的 2b 分支直接用作目录名，目录名中含 `:` 在 Windows 下非法——这是已知边界，本次不引入额外处理（调用方应通过 `args.device` 显式指定，或后续单独开题）
- **不给 Serial/SSH 通道加同样的"连接后反查"改造**：它们的 deviceName 与连接目标天然绑定，不存在此问题
- **不修改 `file-logger.ts` 的 `enableFromEnv` 接口**：该函数接受 `deviceName` 参数的现状保持，调用方负责传正确的值
- **不引入配置项控制目录命名策略**：三级降级是硬编码逻辑，不暴露 yaml/env 开关

## 验收标准

### AC1：`args.device` 显式传入时目录正确且行为不变

调用 `adb_shell_open` 时传入 `device="board-b"`，日志目录为 `board-b/`，与改动前行为一致（信任调用方）。

验证：在 `process.env.DEVICE` 设为 `board-a` 的环境下，调用 `adb_shell_open({device: "board-b"})`，观察日志文件路径前缀为 `.embedded/log/board-b/`。

### AC2：未传 `args.device` + serialNo 在 config 中有绑定 → 目录用反查别名

设备 `board-lubancat` 在 config 中绑定 `serialNo: sn_43b1e5fe7b186666`，实际连接的设备 serialNo 也是 `43b1e5fe7b186666`。不传 `args.device` 调用 `adb_shell_open`，日志目录为 `board-lubancat/`，**不再**是 `process.env.DEVICE` 或 `config.yaml default` 的值。

验证：在 `process.env.DEVICE=board-b` 环境下，实际连接 serialNo 为 `43b1e5fe7b186666` 的设备，不传 `device` 调用 `adb_shell_open`，观察日志路径为 `.embedded/log/board-lubancat/`。

### AC3：未传 `args.device` + serialNo 有效但 config 未绑定 → 目录用 serialNo 本身

实际连接的设备 serialNo 为 `abcdef123456`（config 中无任何设备绑定此 serialNo）。不传 `args.device` 调用 `adb_shell_open`，日志目录为 `abcdef123456/`。

验证：在 config 中临时移除某 serialNo 的绑定（或用未登记的设备），不传 `device` 调用 `adb_shell_open`，观察日志路径为 `.embedded/log/{真实serialNo}/`。

### AC4：调试设备无序列号 → 目录用固定占位符

实际连接的设备 serialNo 为 `????????????`（硬件无序列号）。不传 `args.device` 调用 `adb_shell_open`，日志目录为 `adb-unknown/`。

验证：用 serialNo 显示为 `????????????` 的调试板，不传 `device` 调用 `adb_shell_open`，观察日志路径为 `.embedded/log/adb-unknown/`。

### AC5：会话表 `deviceName` 与日志目录一致

无论走哪一级降级，`adbStore.create()` 存入 `SessionMeta` 的 `deviceName` 字段值，与日志目录名**完全相同**。`registry.getByDevice(deviceName)` 能查到该会话。

验证：调用 `adb_shell_open` 后，调用 `adb_session_list`（或等价查询接口），观察返回的 `deviceName` 字段与磁盘上的日志目录名一致；调用 `registry.getByDevice(<真实deviceName>)` 能命中该会话。

### AC6：`adb_exec` 同步修复

调用 `adb_exec` 不传 `device`，其内部 `deviceName` 解析与 `adb_shell_open` 走同一套三级降级逻辑（共用工具函数），日志中记录的 `device=` 字段反映真实连接而非静态猜测。

验证：对比 `adb_exec` 和 `adb_shell_open` 在同一设备、同样不传 `device` 时的日志输出，`device=` 字段值一致；查看代码确认两者调用同一公共函数。

### AC7：Serial/SSH 通道行为不变

改动前后，对 Serial/SSH 通道调用相应工具，日志目录行为完全一致（仍用 `args.device ?? process.env.DEVICE ?? "default"`）。

验证：对照 `src/mcp/tools/serial/shell.ts` 和 `src/mcp/tools/ssh/shell.ts` 的 git diff，确认本次改动未触及这两处；运行 Serial/SSH 工具观察日志目录与改动前一致。

### AC8：反查函数的多设备重复绑定 warning

config 中两个设备别名绑定到同一个 serialNo（如 `board-x` 和 `board-y` 都写 `serialNo: sn_43b1e5fe7b186666`），反查时返回先定义的别名，并在日志中记录 WARNING 提示存在重复绑定。

验证：构造上述 config，调用 `adb_shell_open`（实际连接 serialNo 为 `43b1e5fe7b186666`），观察日志中出现 WARNING 级别的重复绑定提示，且目录名用的是先定义的别名。

### AC9：serialNo 有效性判定覆盖所有边界

反查函数（或其调用方）对以下 serialNo 输入正确归类为"无效"，走占位符分支：空串、`????????????`、`(auto)`、纯空白字符串。

验证：单测覆盖上述 4 种输入，断言走 `adb-unknown` 分支；对有效 serialNo（如 `43b1e5fe7b186666`、`emulator-5554`、`192.168.1.100:5555`）断言不走占位符。

### AC10：schema description 更新

`adb_shell_open` 和 `adb_exec` 工具的 `device` 参数描述中，出现明确的行为说明：
- 推荐传**别名**（如 `board-lubancat`），措辞含 "Device alias"——**不提 config.yaml**，避免诱导 AI 直接读配置文件
- 不传 device 时程序会自动反查别名，措辞显式说明 "NO need to call adb_device_list first"
- 误传 serialNo 也会被反查为别名

验证：阅读 `src/mcp/tools/adb/shell.ts` 和 `exec.ts` 中 `device` 参数的 description 字段，确认含上述三点。

### AC11：args.device 误传 serialNo 时自动反查为别名

调用方误把 serialNo 当作 `args.device` 传入（典型场景：AI 先调 `adb_device_list` 拿到 serialNo，再当 device 传入），程序应将其反查为别名用作目录名，而非原样使用 serialNo。

验证：
- `resolveAdbDeviceName("43b1e5fe7b186666", "43b1e5fe7b186666", "board-b")` → 返回 `"board-lubancat"`（反查命中）
- `resolveAdbDeviceName("43b1e5fe7b186666", "(auto)", "board-b")` → 返回 `"board-lubancat"`（argDevice 能反查即可，与 realSerialNo 无关）
- `resolveAdbDeviceName("deadbeef", "deadbeef", "board-b")` → 返回 `"deadbeef"`（argDevice 是未登记的 serialNo，反查不到，原样使用）
- `resolveAdbDeviceName("board-lubancat", "43b1e5fe7b186666", "board-b")` → 返回 `"board-lubancat"`（argDevice 是别名，原样使用）
