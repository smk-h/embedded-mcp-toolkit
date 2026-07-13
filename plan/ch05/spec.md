# Transport 层抽象重构 Spec

## 背景

`embedded-mcp-toolkit` 当前有四个传输类，分别对应四种连接通道（SSH / Serial / ADB / PowerShell），合计约 1360 行代码。它们的核心方法 `open / write / read / drain / close` 签名几乎完全相同，内部都持有一个 `OutputBuffer` 实例，但相互之间**没有任何继承或接口契约关系**——每个类独立实现了整套缓冲区协作逻辑。

当前 `InteractiveShell` 接口（位于 `loop.ts`）虽声明了 `write/read/close`，但只被 demo 的 `interactiveLoop` 使用，四个传输类未 `implements` 它，且签名不完整（缺 `drain/open`、`write` 缺第三参）。

此外，`FileLogger`（原始数据文件日志）仅在 `SSHShell` / `SerialShell` 上挂载，`AdbShell` / `PowerShellShell` 缺失，属于抽象漏洞。

## 目标

- **零功能回归**：重构后所有现有行为保持不变，包括缓冲区策略、溢出处理、banner 采集时机、连接建立/关闭逻辑。
- **消除重复代码**：把四个类中逐字重复的缓冲区协作、公共方法实现上提到统一的基类，预计减少约 60% 重复逻辑。
- **建立接口契约**：补全 `InteractiveShell` 接口，让四个传输类显式 `implements`，形成编译期约束。
- **统一 FileLogger 能力**：四个类都挂载 FileLogger，ADB/PowerShell 在 `SAVE2FILE_PATH` 配置时也写会话日志文件（这是 ch05 **唯一的行为增量**，受环境变量控制）。
- **为后续章节奠基**：ch06（工具层去重）和 ch08（alerts 持续监听）都依赖本章落地的基类。

## 功能需求

- F1：提供抽象基类，统一持有 `OutputBuffer` 和 `FileLogger`，实现 `open / write / read / drain / close` 的公共逻辑，通过模板方法将连接建立、发送、关闭的差异委托给子类。

- F2：基类对子类提供三个受保护的抽象方法：连接建立（含注册数据监听、返回 banner）、发送原始字节、关闭连接/进程。子类只实现这三个方法，其余全部继承。

- F3：基类实现统一的 banner 采集流程——子类建立连接并注册数据监听后，基类负责开启采集、等待固定时长、读取并返回 banner。

- F4：补全 `InteractiveShell` 接口，纳入 `open / write（含三参）/ read / drain / close`，并迁出 `loop.ts` 到独立位置。四个传输类显式 `implements` 该接口。

- F5：`AdbShell` 和 `PowerShellShell` 挂载 `FileLogger`，其 tools 层在会话建立成功后调用 `enableFromEnv(sessionId)`，与 `SSHShell` / `SerialShell` 行为一致。当且仅当 `SAVE2FILE_PATH` 环境变量配置时写日志文件，否则无副作用。

- F6：`write` 方法对「shell 未打开」的异常处理保持现状（子类在 `rawWrite` 中抛出），基类的 `write` 不额外吞掉或转换该异常，保持工具层现有 catch 行为不变。

## 非功能需求

- N1：**零功能回归（硬约束）**。重构前后，对同一输入，所有现有工具的返回值、日志输出、缓冲区状态必须逐字一致。包括：banner 采集等待时长（SSH/Serial 500ms、ADB/PowerShell 800ms）、缓冲区溢出策略、`close` 的释放顺序、`fileLogger.disable` 时机。

- N2：**唯一允许的行为增量**是 F5——ADB/PowerShell 在 `SAVE2FILE_PATH` 配置时新增写日志文件。该增量受环境变量控制，未配置时行为与现状完全一致。

- N3：不改 `OutputBuffer` 的内部实现（缓冲/溢出/采集策略）。

- N4：不改任何对外方法签名：`open/write/read/drain/close` 的参数与返回类型与现状一致，上层 `tools/*.ts` 调用代码**无需改动**（仅文件路径 import 可能微调）。

- N5：不改四个类的连接建立逻辑——SSH 的 PTY 分配、Serial 的 COM 口打开、ADB/PowerShell 的 spawn 参数等从 `open()` 搬到子类的 `acquire()`，逻辑体不变。

- N6：不引入新依赖，仅使用项目已有的 `OutputBuffer`、`FileLogger`。

- N7：`SSHShell` 现有的 `uploadFile / downloadFile / #ensureSftp` 等 SFTP 能力作为子类特有方法保留，不进入基类。

- N8：demo 函数（`pshDemoSsh / pshDemoSerial / userLoginDemoSerial` 等）保持可用——它们引用的 shell 方法签名不变，仅可能因 `InteractiveShell` 接口位置迁移而调整 import。

## 不做的事

- 不改 `OutputBuffer` 的缓冲/溢出/采集语义（那是后续章节的事）。
- 不改四个传输类的连接建立/关闭的具体实现逻辑（只搬位置，不改内容）。
- 不剥离 demo 函数（`pshDemoSsh` 等留在原文件，归属后续章节）。
- 不引入 alerts / 持续监听（独立章节 ch08）。
- 不重构工具层（`tools/*.ts` 的会话存储、handler 结构属 ch06）。
- 不改 `tool-registry.ts`、`mcpDefineTool`、`server.ts` 注册流程。
- 不改工具名、工具参数 schema、工具返回结构。
- 不给 `OutputBuffer` 加 alerts 扫描、不加 `drainAlerts`。

## 验收标准

- AC1（F1+F2）：抽象基类存在，统一持有 `OutputBuffer` 和 `FileLogger`，实现 `open/write/read/drain/close`；子类只实现连接建立/发送/关闭三个受保护方法。

- AC2（F3）：基类的 banner 采集流程对外行为与现状一致——SSH/Serial open 后等待 500ms、ADB/PowerShell 等待 800ms（验证见 checklist 端到端场景）。

- AC3（F4）：`InteractiveShell` 接口补全为含 `open/write(三参)/read/drain/close`，四个传输类显式 `implements`，编译通过。

- AC4（F5 行为增量）：配置 `SAVE2FILE_PATH` 后，ADB/PowerShell 会话建立时生成 `<sessionId>_<时间戳>.log` 日志文件，内容含 banner 原始数据；未配置时不生成文件。

- AC5（F5 无副作用）：不配置 `SAVE2FILE_PATH` 时，ADB/PowerShell 会话行为与重构前完全一致（不写文件、无报错）。

- AC6（F6 异常保持）：在未打开的 shell 上调用 `write` 仍抛出与现状一致的错误（`"Shell not open. Call open() first."` 等），不被基类吞掉。

- AC7（N1 零回归-SSH）：通过 MCP 工具完整执行 SSH open → write → read → exec → close 流程，输出与重构前逐字一致（对比 `.embedded/log` 下的会话日志）。

- AC8（N1 零回归-Serial）：通过 MCP 工具完整执行 Serial open → write → read → exec → close 流程，输出与重构前逐字一致。

- AC9（N1 零回归-ADB）：通过 MCP 工具完整执行 ADB open → write → read → exec → close 流程，输出与重构前逐字一致。

- AC10（N1 零回归-PowerShell）：通过 MCP 工具完整执行 PowerShell open → write → read → exec → close 流程，输出与重构前逐字一致。

- AC11（N1 零回归-PSH登录）：SSH/Serial 的 `shell_login` 工具（含 PSH 状态机驱动解锁流程）行为与重构前一致。

- AC12（N7 SFTP保留）：SSH 的 `upload` / `download` 工具正常工作，文件传输成功。

- AC13（N8 demo可用）：`embedded-mcp-toolkit demo ssh interact` / `demo serial interact` 命令正常运行，交互终端功能正常。

- AC14（N6 无新依赖）：`git diff package.json` 无新增依赖条目。

- AC15（编译）：`npm run build` 编译通过，无 TypeScript 错误。

- AC16（N4 工具层零改动）：`tools/*.ts` 中对传输类方法的调用代码无需改动（仅 import 路径可能因接口迁移而调整）。
