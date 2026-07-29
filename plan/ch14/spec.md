# 会话日志路径提供 Spec

## 背景

本工具链在 `serial_open` / `serial_shell_login`（及 ssh/adb 同构入口）成功建立会话后，会调用 `FileLogger.enableFromEnv(sessionId, deviceName)` 在 transport 层持续把接收到的原始字节流写入日志文件（路径形如 `.embedded/log/{deviceName}/{sessionId}_{timestamp}.log`）。这个文件日志机制是捕获设备 reset/启动全过程（U-Boot→内核→rootfs）的唯一可靠手段——尤其对 serial 通道，物理串口在设备重启期间不断线，从上电第一刻起的字符都会被落盘。

但当前实现存在一个信息断点：

- **日志路径不回传给调用方。** `enableFromEnv` 返回 `void`，它内部用局部变量算出 `logPath` 后就丢弃，既不存进 session 元数据，也不放进任何工具返回文本。文件路径只出现在 server 自己的诊断日志 `[file-logger] file logging enabled: <path>` 里。
- **日志文件名含一个 server 端生成、但从不回传的时间戳。** 命名规则为 `{sessionId}_{YYYY-MM-DD_HHMMSS}.log`，其中时间戳由 `fileTimestamp()` 现场生成。
- **sessionId 会被复用。** `portToSession` 按物理端口去重，同一端口第二次 open 会复用既有 sessionId（如 `serial_1`），导致同一设备目录下出现多个 `serial_1_*.log` 文件。

三者叠加的结果是：AI（或任何外部调用方）即使知道"设备是 board-b、会话是 serial_1"，面对该设备目录下的多个 `serial_1_*.log` 文件时，**没有任何可靠依据判断哪个是当前会话的**。它只能靠"按修改时间取最新"这类启发式猜测，而启发式会出错——这正是用户担心的"读错文件"问题。

对"升级固件→重启→确认启动日志"这类需要精确回看启动日志的场景，这个断点直接削弱了文件日志机制的可用性：日志可靠地落盘了，调用方却无法确定性地找到它。

## 目标

- 让会话对应的日志文件路径成为会话元数据的一部分，调用方可随时确定性查询，无需猜测
- 通过现有的 `session_info` 工具统一提供日志路径查询，覆盖 serial/ssh/adb 三通道（字段一致性）
- 不改变现有文件日志的写入行为、命名规则、落盘时机
- 处理"文件日志未启用"（`SAVE2FILE_PATH` 未配置）的边界，明确告知而非给出假路径

## 功能需求

### F1：会话元数据承载日志路径

会话注册表（registry）的会话元数据结构增加一个可选字段，用于记录该会话对应的日志文件路径。该字段的取值规则：

- 当文件日志启用（`SAVE2FILE_PATH` 已配置且非 `none`）时，值为该会话的实际日志文件完整路径（含设备子目录、sessionId、时间戳）
- 当文件日志未启用时，值为空（字段存在但无值）

该字段在会话首次建立日志文件时写入，会话存续期间保持不变（即使后续操作复用该会话，也不重建日志文件，故路径不变）。

### F2：日志路径写入时机与数据来源

日志路径的写入与现有 `enableFromEnv` 的调用时机严格对齐：

- `enableFromEnv` 改为返回它实际创建的日志文件路径（未启用时返回空值）
- 各通道的会话建立入口（serial 的 `serial_open` / `serial_shell_login` 的注册收口，ssh/adb 对应入口）在获得该返回值后，将其写入会话元数据
- 复用已有会话（如 serial 的 `portToSession` 命中）时不重建日志文件，元数据中的日志路径保持首次建立时的值不变

### F3：session_info 工具统一展示

现有的 `session_info` 工具在格式化每条会话元数据时，新增一行展示日志路径：

- 文件日志启用时，显示完整路径（如 `Log: .embedded/log/board-b/serial_1_2026-07-29_185730.log`）
- 文件日志未启用时，显示明确的未启用提示（如 `Log: (file logging disabled)`），让调用方清楚知道该会话无日志文件可查

该展示在 `session_info` 的三种查询模式（按 session_id、按 device、列出全部）下一致生效。

### F4：三通道一致

serial、ssh、adb 三个通道的会话建立入口都执行相同的"enableFromEnv 返回路径 → 写入会话元数据"流程，使 `session_info` 对三通道的日志路径展示行为一致。

## 非功能需求

- N1：兼容性——不改变任何现有工具的返回文本结构（`session_info` 仅新增一行，不改动已有字段）、不改变日志文件命名规则、不改变日志写入时机
- N2：零行为回归——文件日志本身的写入逻辑（`FileLogger.write`、`appendData` 双写）完全不动；本次只动"路径如何被外部知晓"，不动"日志如何被写入"
- N3：未启用场景安全——当 `SAVE2FILE_PATH` 未配置时，不产生不存在的路径，不让调用方拿着假路径去读文件

## 不做的事

- 不新增独立的"查日志路径"专用工具（复用现有 `session_info`，避免工具表膨胀）
- 不实现"读取日志内容"的能力（路径提供后，读文件是调用方的通用文件读取能力，不在本工具链职责内）
- 不改变日志文件命名规则（仍为 `{sessionId}_{timestamp}.log`），不改成"去掉时间戳"等方案
- 不为会话增加日志文件的轮转、清理、大小限制等能力
- 不涉及"实时回传启动日志文本到对话"的主动捕获工具（那是独立的能力，本任务只做路径提供）

## 验收标准

- AC1：serial 通道建立会话（`serial_open` 或 `serial_shell_login`）后，调用 `session_info(session_id)` 返回中包含该会话当前日志文件的完整路径，且路径与磁盘上实际存在的文件一致
- AC2：ssh、adb 通道建立会话后，`session_info` 同样正确返回各自的日志文件路径
- AC3：当 `SAVE2FILE_PATH` 未配置（文件日志关闭）时，`session_info` 返回中日志行显示明确的"未启用"提示，且不出现任何文件路径
- AC4：复用已有会话（同一物理端口第二次建立会话）时，`session_info` 返回的日志路径与首次建立时一致（不重建日志文件、路径不变）
- AC5：serial 通道在设备 reset 重启后，会话的日志路径仍可通过 `session_info` 查到，且该路径文件持续追加启动日志（验证路径提供与日志持续写入解耦，互不影响）
- AC6：现有测试（如 `test_enter_uboot`、`test_exec_timeout_*`）行为不回归
