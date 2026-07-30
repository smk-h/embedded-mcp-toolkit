# 远程 MCP 配置命令 Spec

## 背景

本工具链的 `sshd-config` 命令（ch14 之前实现）打通了"Linux 编译服务器免密登录 Windows"的方向：它在 Linux 端生成 SSH 密钥、配置 Windows 的 sshd 与 authorized_keys，并（菜单 [8]）生成一份 Linux 端的 MCP 配置模板 `.embedded/ssh/mcp-remote-template.json`。这份模板的内容是一个 **SSH 桥接 server 定义**——Linux 上的 claude/zcode 通过 `ssh -i ~/.ssh/id_mcp_server <winuser>@<winip> <remote-start-mcp.bat>` 把命令转发到 Windows，MCP 本体仍跑在 Windows。

但 `sshd-config [8]` 只**生成模板文件**到本机，"把它真正安装到 Linux 端 claude/zcode 的配置里"这一步还得用户手动完成——复制到正确路径、按 JSON 结构嵌进对应字段、处理使能开关。这个过程繁琐且易错（不同 client 的配置落点和 JSON 结构差异很大）。

本章新增一个**对偶方向**的 CLI 命令：从 Windows 本机 SSH/SFTP 登录到远程 Linux 服务器，在 Linux 端交互式地完成 claude/zcode 的 MCP 桥接配置。本质是"Windows 当 SSH 客户端，读写 Linux 上几个 JSON 文件"，Linux 端不需要安装 node、不需要工具包、不需要设备配置——MCP 本体始终由 Windows 的 `remote-start-mcp.bat` 启动。

## 目标

- 提供一个交互式命令，从 Windows 登录远程 Linux，把 SSH 桥接形式的 MCP server 配置写入 Linux 端 claude/zcode 的配置文件
- 覆盖三类落点：Claude 全局（`~/.claude.json`）、Claude 项目（`<proj>/.mcp.json` + `.claude/settings.local.json`）、ZCode 项目（`<proj>/.zcode/config.json`）；ZCode 全局本期不做
- 配置前先读取并展示目标落点的当前状态（已配置/未配置/内容不一致），让用户基于状态决定"配置"还是"删除"，而非盲目覆盖
- 复用 `sshd-config` 已建立的能力：连接信息采集（Windows 用户名/IP）、SSH 桥接 server 对象拼接、`user@host[:port]` 地址解析、密码安全输入、基于 ssh2 的连接/执行
- 保持与 `sshd-config` 一致的交互范式（菜单循环 + clack 组件 + 清屏暂停），用户学一套心智即可

## 功能需求

### F1：交互式收集远程 Linux 连接信息并登录

命令启动后交互式收集远程服务器地址（紧凑格式 `user@host[:port]`）与登录密码（不回显、不落盘）。建立 SSH 连接，连接失败时给出明确原因（认证失败/网络不可达/超时）并中止，不进入后续菜单。连接成功后进入主菜单循环。

### F2：主菜单循环

登录成功后展示主菜单，菜单项包括：配置 MCP、查看远端当前 MCP 配置状态（只读诊断）、删除已配置的 MCP、退出。每项执行完毕后暂停（按 Enter 回菜单、按 q 退出），清屏后重新显示菜单。与 `sshd-config` 的菜单交互范式一致。

### F3：选择客户端类型与配置范围（落点路由）

执行"配置"或"删除"时，先选择客户端类型（claude / zcode）：
- 选 **claude** → 再选择范围（全局 / 项目；项目则输入项目绝对路径）
- 选 **zcode** → 直接输入项目绝对路径（本期 zcode 仅项目级，无全局选项）

据此路由到唯一确定的目标配置文件（见 F4 的落点表）。

### F4：读取并展示目标落点的当前状态

在配置或删除前，先通过 SFTP 读取目标配置文件，判断该 MCP server（固定 key 名 `embedded-board`）的当前状态：
- **未配置**：目标文件不存在，或存在但不含该 server key
- **已配置且一致**：存在该 server key，且其 command/args 与本次将要写入的 SSH 桥接定义一致
- **已配置但不一致**：存在该 server key，但 command/args 与本次定义不符（如 Windows IP 变了、密钥名不同）

将状态连同目标文件路径一起展示给用户，让用户在"配置/删除"前看清现状。状态读取失败（文件权限、JSON 解析失败）时明确报错，不静默继续。

三处落点的文件与字段：

| 落点 | 文件 | server 定义字段 | 使能字段 |
|---|---|---|---|
| Claude 全局 | Linux `~/.claude.json` | 顶层 `mcpServers["embedded-board"]` | （全局无需使能开关） |
| Claude 项目 | Linux `<proj>/.mcp.json` | `mcpServers["embedded-board"]` | `<proj>/.claude/settings.local.json` 的 `enabledMcpjsonServers` |
| ZCode 项目 | Linux `<proj>/.zcode/config.json` | `mcp.servers["embedded-board"]`（含 `type`/`enabled`） | 同文件内的 `enabled` 字段 |

### F5：配置（写入）操作

用户确认配置后，将 SSH 桥接形式的 server 定义写入目标文件：
- server 的 command 固定为 `ssh`，args 为 `["-i", "~/.ssh/id_mcp_server", "<winuser>@<winip>", "<remote-start-mcp.bat 绝对路径>"]`，其中 winuser/winip 来自本机连接信息采集，bat 路径取当前工作目录下的 `remote-start-mcp.bat`
- 写入前对目标 JSON 文件做备份（写入 `.bak`，已存在则不覆盖，保留首次备份）
- 写入方式为"按结构化字段更新"而非"整文件覆盖"——保留目标文件中已有的其它 server 和其它字段，仅新增/更新 `embedded-board` 这一项
- 对 Claude 项目落点，除写 `.mcp.json` 外，还需把 `embedded-board` 加入 `.claude/settings.local.json` 的 `enabledMcpjsonServers` 数组（去重，已存在不重复加）
- 对 ZCode 项目落点，server 对象多带 `type:"stdio"` 和 `enabled:true`
- 目标文件或其父目录不存在时，先递归创建父目录再写入
- 写入成功后回显写入的文件路径与最终的关键字段供核对

### F6：删除操作

用户确认删除后，从目标文件移除 `embedded-board` 这一项（仅删这一项，保留其它 server 与字段）：
- 对 Claude 项目落点，同时从 `.claude/settings.local.json` 的 `enabledMcpjsonServers` 移除 `embedded-board`（若存在）
- 对 ZCode 项目落点，从 `mcp.servers` 移除该项即可（`enabled` 字段随之消失）
- 删除前同样先备份（`.bak`）
- 目标文件不存在或不含该项时，明确提示"无需删除"而非报错

### F7：只读诊断（查看状态）

独立的只读菜单项，不修改任何文件。遍历三类落点中用户指定的一类（选 client + 范围/路径后），读取并展示该落点的配置状态（复用 F4 的状态判断逻辑），末尾给出汇总结论。多落点时只查用户指定的一类，不主动扫描全部。

### F8：SSH 桥接定义的一致性判定基准

F4/F5 中"已配置且一致"的判定，以 command 是否为 `ssh` 且 args 是否与本次计算出的桥接定义完全匹配为准。不一致时不阻断配置，仅作为状态信息提示用户（例如"检测到旧 IP 的配置，将覆盖更新"）。

## 非功能需求

- **N1：密码安全** —— 登录密码仅存在于进程内存，不写入日志、不写入磁盘、不出现在任何回显或诊断输出中。密码输入不回显明文（非 TTY 环境回退为可见输入属已知限制，需在交互时提示）。
- **N2：兼容性——不破坏目标文件原有内容** —— 对目标 JSON 文件（`~/.claude.json`、`.mcp.json`、`settings.local.json`、`.zcode/config.json`）的任何修改，必须是"按字段更新"而非"整文件覆盖"。保留文件中已有的其它 server 定义、其它顶层字段（如 `~/.claude.json` 的 `projects`、`userID` 等大量业务字段必须原样保留）；保留 JSON 的合法结构；仅动 `embedded-board` 这一个 server key 及其对应的使能项。
- **N3：写入前备份** —— 任何对目标文件的写/删操作前，先在同目录生成 `.bak` 备份（`<原文件名>.bak`）。`.bak` 已存在时不覆盖，保留首次备份。备份失败时中止本次操作并报错，不进行后续写入。
- **N4：JSON 序列化风格** —— 写回 JSON 时采用 2 空格缩进、末尾一个换行，与项目现有 `.mcp.json` / `.zcode/config.json` 的风格一致。对原本就格式规范的文件，修改后不应产生无意义的 diff 噪音（如全文件重排）。
- **N5：错误处理——不静默吞错** —— SSH 连接失败、SFTP 读写失败、JSON 解析失败、权限不足等异常，都要给出明确的中文错误提示与原因，不静默继续、不写半成品文件。写操作失败时优先尝试回滚（用 `.bak` 恢复）。
- **N6：平台校验** —— 本命令在 Windows 上发起（SSH 客户端角色），但实际可跨平台运行（ssh2 是纯 JS 实现）。不强制限定为 Windows——只要本机能采集到用户名与可用 IP、能发起 SSH，即可运行。但连接信息采集（用户名/IP）的来源是本机 OS，需对"采集不到可用 IP"给出明确提示并中止。
- **N7：交互范式一致** —— 菜单循环、清屏、暂停返回、clack 组件（select/text/password/confirm）的使用方式与 `sshd-config` 命令保持一致，复用相同的交互心智，降低用户学习成本。
- **N8：不依赖远端预装** —— 不在远端 Linux 执行任何依赖（不要求远端装 node、不要求远端有本工具包、不要求远端有 `.embedded/configs/`）。远端只需能被 SSH 登录、目标配置文件路径可写即可。所有文件操作通过 SFTP 完成，不在远端执行 shell 命令来改配置文件（避免 shell 转义与编码问题）。

## 不做的事

- **不做 ZCode 全局配置** —— 本期 ZCode 仅支持项目级（`<proj>/.zcode/config.json`）。ZCode 全局（`~/.zcode/cli/config.json`）涉及"远端 Linux 是否真的装了 zcode 桌面应用"的不确定性，留待后续按需评估。
- **不在远端 Linux 部署 MCP 运行环境** —— 不在远端安装 node、安装本工具包、同步 `.embedded/configs/` 设备配置。MCP 本体始终由 Windows 的 `remote-start-mcp.bat` 启动，Linux 只配一个 SSH 桥接 server。本章是"配 JSON"，不是"装环境"。
- **不在远端执行 shell 命令改配置** —— 所有对目标配置文件的读写都通过 SFTP 完成（上传/下载整个文件后在本地解析改写）。不通过 `ssh exec "cat > file"` 之类的方式改文件，避免 JSON 引号转义与远端 shell 编码问题。
- **不做 server key 名可配置** —— 写入的 MCP server 固定使用 key 名 `embedded-board`（与现有 `sshd-config [8]` 模板、项目 `.mcp.json` 保持一致）。不提供自定义 server 名的能力。
- **不做批量/多项目配置** —— 一次操作只针对一个落点（一个 client + 一个范围/路径）。不支持"一次给多个项目批量配"、不支持"同时配 claude 和 zcode"。
- **不做配置文件格式校验之外的业务校验** —— 只校验目标文件是否为合法 JSON、是否含期望字段。不校验 claude/zcode 的配置 schema 完整性（如不验证 `enabledMcpjsonServers` 里的 server 名是否都在 `.mcp.json` 中有定义——那是 client 自身的职责）。
- **不做 SSH 密钥/免密登录的配置** —— 本章只负责"配 MCP server 定义"，不负责建立 SSH 信任关系。免密登录环境（密钥生成、authorized_keys）由 `sshd-config` 命令负责，本章假定它已就绪或用户用密码登录。
- **不做配置生效/重启 client** —— 写入配置后不重启 claude/zcode、不触发 client 重新加载。仅在末尾提示用户"需重启对应 client 使配置生效"。
- **不做 Windows 侧的任何修改** —— 本章只在远端 Linux 上读写文件，不修改 Windows 本机的任何配置（Windows 侧的 sshd、authorized_keys、模板文件均不在本章职责内）。
- **不做远端配置文件的清理/重置** —— 删除操作只移除 `embedded-board` 这一项，不提供"清空整个 mcp 配置""恢复到初始状态"等批量清理能力。

## 验收标准

- **AC1：交互式登录与菜单** —— 执行命令后，依次出现服务器地址输入框、密码输入框；输入正确凭据后连接成功并进入主菜单（配置/查看/删除/退出）；输入错误凭据时给出明确错误提示并中止，不进入菜单。按 q 可从菜单退出。（验证：在真实 Linux 服务器上跑通登录）
- **AC2：地址解析与端口默认** —— 服务器地址支持 `user@host`、`user@host:port` 两种紧凑格式；不带端口时默认 22；格式非法（缺 user、缺 host、端口非数字或越界）时给出明确错误并要求重输，不进入连接。（验证：分别输入三种合法/非法地址观察行为）
- **AC3：Claude 全局配置写入与回显** —— 登录后选 claude → 全局，先读取并展示 `~/.claude.json` 顶层 `mcpServers` 中 `embedded-board` 的当前状态；确认配置后写入 SSH 桥接定义（command=ssh、args 含 `-i ~/.ssh/id_mcp_server <winuser>@<winip> <bat路径>`），保留该文件中其它所有字段（如 `projects`、`userID`）不变；写入后回显目标文件路径与关键字段。（验证：配置前后 `cat ~/.claude.json`，对比仅 `mcpServers.embedded-board` 变化，其余字段原样）
- **AC4：Claude 项目配置写入与使能** —— 登录后选 claude → 项目 → 输入项目路径，先展示 `<proj>/.mcp.json` 与 `<proj>/.claude/settings.local.json` 的状态；确认配置后，在 `.mcp.json` 的 `mcpServers` 写入 `embedded-board`（保留其它 server），并在 `settings.local.json` 的 `enabledMcpjsonServers` 数组追加 `embedded-board`（去重）；父目录不存在时自动创建。（验证：配置后两个文件均含目标项，且 `enabledMcpjsonServers` 无重复条目）
- **AC5：ZCode 项目配置写入** —— 登录后选 zcode → 输入项目路径，先展示 `<proj>/.zcode/config.json` 状态；确认配置后在 `mcp.servers` 写入 `embedded-board`，对象含 `type:"stdio"`、`command:"ssh"`、args、`enabled:true`，保留其它 server。（验证：配置后文件结构合法，含 type/enabled 字段）
- **AC6：状态判定（三态）准确** —— 针对任一落点，"查看状态"能正确区分三种情况并准确展示：未配置（文件不存在或无该 key）、已配置且一致（command/args 与本次桥接定义匹配）、已配置但不一致（如旧 IP）。其中"不一致"场景通过手动篡改目标文件模拟。（验证：分别构造三种状态后查看，输出与预期一致）
- **AC7：删除操作** —— 针对任一落点，删除后 `embedded-board` 从目标文件消失，而其它 server 与其它字段保留；Claude 项目落点同时从 `enabledMcpjsonServers` 移除该项；目标文件不存在或本就无该项时提示"无需删除"而非报错。（验证：删除前后对比目标文件，仅目标项消失）
- **AC8：备份与回滚** —— 任何写/删操作前生成 `<file>.bak`（已存在不覆盖）；写入失败时用 `.bak` 回滚目标文件，回滚后文件内容等于操作前。（验证：故意触发写入失败场景，如中途断开 SSH，检查 .bak 存在且目标文件未被破坏）
- **AC8b：密码安全** —— 密码全程不回显、不落盘、不出现在任何输出。进程内存中无持久化。（验证：全程观察输出无明文密码；操作完成后检查无日志文件含密码）
- **AC9：远端无依赖** —— 全程不在远端执行 shell 命令安装任何东西；远端无需预装 node 或本工具包；所有配置改动通过 SFTP 完成。（验证：在一台纯净 Linux 上仅保证可 SSH 登录，跑通完整配置流程）
- **AC10：不破坏原有配置** —— 对已含其它 server 或大量业务字段的目标文件（如真实 `~/.claude.json` 含 14 个 projects），配置/删除后除 `embedded-board` 及其使能项外，其它所有字段字节级保留。（验证：配置前备份原文件，操作后 diff，仅目标项变化）
