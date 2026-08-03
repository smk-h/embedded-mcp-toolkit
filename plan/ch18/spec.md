# 跨机部署下的编译路由指引 Spec

## 背景

本工具链支持两种部署形态（见 `docs/项目简介.md` 第四章）：

- **方式一（本地同机）**：AI 客户端在 Windows、MCP Server 在同一台 Windows、编译机是远程的 Linux。AI 经 MCP 的 SSH 通道到编译机跑编译。
- **方式二（跨机远程）**：AI 客户端在 Linux 编译机、MCP Server 经 SSH 桥接留在 Windows（物理串口/USB 插在 Windows）。AI 编辑源码、跑编译这些事 Linux 本机就能干。

编译这件事，工具链里存在**两个同源的分身**：

| 工具 | 跑在哪 | 怎么连编译机 | 适用 |
|------|--------|-------------|------|
| `ssh_build`（MCP 工具） | Windows 上的 MCP Server 进程内 | 经 SSH PTY 会话到远端编译机 | 方式一 |
| `cmdsift`（外部 CLI，`E:\AI\cmdsift`） | Linux 编译机本机 | 直接 `sh -c` 本地执行 | 方式二 |

两者连完成标记（`___MCP_BUILD_DONE___`）、ANSI 剥离、error/warning 分类正则都几乎一样——`cmdsift` 本质就是 `ssh_build` 剥掉 SSH 隧道层、改成本地直执的版本。

**问题在于 AI 分不清该用哪个**：

- `ssh_build` 的工具描述写的是 *"Execute a build command on the **remote** server via SSH"*。方式二下 AI 本机就在编译机，但看到这个描述可能误判"我本机不算 remote 所以不能用"，也可能照调不误——而一旦调用，流量就变成 **AI 在 Linux → MCP 在 Windows → SSH 回 Linux 编译机**，绕了一圈。
- `cmdsift` 作为 Linux 本机二进制，AI **默认根本不知道它的存在**，必须有人明确告知。

当前状态：
- ch17 已建立两条给 AI 的传达通道——`instructions` 字段（MCP 握手时注入）与 `host_info` 工具（AI 主动查询的兜底），目前内容只覆盖 **scp 文件传输**指引，未涉及编译路由。
- ch17 已用 `SSH_CONNECTION` 环境变量精确区分"本地启动"与"远程 SSH 启动"两种场景，判定逻辑成熟可直接复用。

## 目标
- 方式二（远程 SSH 启动）下，让 AI **自动**知道编译应优先用本机 `cmdsift`，而非经 `ssh_build` 让流量 Windows↔Linux 绕一圈。
- 方式一（本地启动）完全不受影响，三处相关行为零改变。
- 装完 MCP 即自动获得此能力——复用 ch17 已建立的两条通道，无需维护额外 md 文件。

## 功能需求
- F1: 复用 ch17 的 `SSH_CONNECTION` 场景判定（远程 SSH 启动 vs 本地启动），不新建判定逻辑。
- F2: 远程 SSH 启动场景下，在 `instructions` 字段（ch17 已注入 scp 指引）末尾追加编译路由指引——说明 AI 已在 Linux 编译机、编译应优先用本机 `cmdsift`（给出示例），并说明 `ssh_build` 在本场景会让流量绕圈故不应使用。
- F3: 远程 SSH 启动且端点解析成功场景下，`host_info` 工具返回文本（ch17 已含 scp 指引）追加同样的编译路由指引。
- F4: 远程 SSH 启动但端点解析失败（`SSH_CONNECTION` 格式异常，`(unavailable)`）场景下，`host_info` 返回文本仍补充编译路由指引——此场景下 scp 端点虽不可用，但编译路由（仅依赖"AI 在 Linux"这一事实）仍有意义。
- F5: `ssh_build` 工具在远程 SSH 启动场景下被调用时实施**软拦截**——在返回结果前缀追加一段提示（建议改用本地 `cmdsift`），但仍照常执行编译：不硬阻断、不改变退出码、不改变分类与返回结构。
- F6: 本地启动场景下，`instructions` 不含编译路由（仍为 undefined）、`host_info` 返回 local 状态无编译路由、`ssh_build` 软拦截不触发——三处零改变。
- F7: 编译路由指引中的 `cmdsift` 用法示例覆盖三种典型场景：直接编译（`make -j8`）、带工作目录（`cmdsift -C <dir> <cmd>`）、build 脚本（`./build.sh`）；并说明全量编译日志落盘位置（`log/YYYYMMDD_HHMMSS.log`），AI 后续可自行读取。

## 非功能需求
- N1: 编译路由文本独立成一个共享模块（纯函数），供 `instructions` / `host_info` / `ssh_build` 三处引用，避免三处文本硬编码导致语义漂移。
- N2: `instructions` 保持单行字符串风格（与 ch17 现有 scp 文本一致，空格拼接）；`host_info` 与 `ssh_build` 提示保持多行文本风格。
- N3: 软拦截只追加提示文本，不改变 `ssh_build` 的命令构造、PTY 回显剥离、轮询检测、ANSI 清洗、分类格式化等既有执行逻辑。
- N4: 方式一（本地启动）的工具注册、工具描述、会话管理、日志输出与改动前逐字一致。
- N5: 不引入对 `cmdsift` 二进制是否存在的运行时探测——编译路由文本只告知 AI 用法，`cmdsift` 是否实际安装由部署方保证。

## 不做的事
- 不动态隐藏/注销 `ssh_build` 工具（保持工具列表稳定；软拦截已足以引导，硬隐藏反而让 AI 失去兜底通路）。
- 不把 `cmdsift` 包装成 MCP 工具（架构不通：方式二下 MCP Server 在 Windows，`cmdsift` 在 Linux，无法把 Linux 的二进制包进 Windows Server）。
- 不维护 Linux 项目根的 `CLAUDE.md` / `AGENTS.md`（用户明确要求一切通过 MCP 自动获取）。
- 不改动 ch17 的 scp 指引文本与 `SSH_CONNECTION` 场景判定逻辑。
- 不探测 `cmdsift` 是否在 PATH、不校验其版本（由部署保证，文本只给用法）。

## 验收标准
- AC1（对应 F1/F6）：本地启动 MCP，`instructions` 为 undefined、`host_info` 返回 local 状态无编译路由、调用 `ssh_build` 不触发软拦截——三处行为与改动前逐字一致。
- AC2（对应 F2）：远程 SSH 启动 MCP，握手 `instructions` 文本含 `cmdsift` 编译路由指引（含 `make -j8` / `-C` / `./build.sh` 三类示例 + 全量日志落盘说明 + 不用 `ssh_build` 的理由）。
- AC3（对应 F3）：远程 SSH 启动且端点解析成功，`host_info` 返回文本在 scp 指引之后含编译路由指引。
- AC4（对应 F4）：远程 SSH 启动但端点不可用（`(unavailable)`），`host_info` 返回文本仍含编译路由指引。
- AC5（对应 F5）：远程 SSH 启动 MCP，调用 `ssh_build`，返回结果开头含软拦截提示，但编译照常执行、退出码正确透传、error/warning 分类结果不受影响。
- AC6（对应 F7）：编译路由指引中的 `cmdsift` 示例命令形态正确、可直接复制执行（命令名 `cmdsift` 假定在 PATH，参数与 ch18 调研的 cmdsift CLI 一致）。
- AC7（对应 N1）：`instructions` / `host_info` / `ssh_build` 三处引用的编译路由文本来自同一共享模块，无重复硬编码。
