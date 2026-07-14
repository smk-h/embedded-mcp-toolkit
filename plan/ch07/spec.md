# sshd-config 命令 Spec

## 背景

embedded-mcp-toolkit 的典型使用场景是：MCP 服务运行在 Windows 本地，而 Claude / OpenCode 等 AI 编码工具运行在远端 Linux 编译服务器上。为了让 Linux 服务器能通过 SSH 免密登录 Windows（从而远程驱动本地的 MCP 工具），需要在 Windows 侧安装并配置 OpenSSH Server，并在 Linux 侧生成密钥对、把公钥配置到 Windows。

目前这套"Windows 装 sshd + Linux 生成密钥 + 配置免密登录"的流程需要用户手动查阅微软文档、敲多条 PowerShell/systemctl/ssh-keygen 命令、还容易踩 Windows administrators_authorized_keys 这个坑。希望把整套流程封装成一条命令，交互式引导完成。

## 目标

- 提供一条 `embedded-mcp-toolkit sshd-config` 命令，以交互式菜单引导用户完成"Windows 端 SSH 免密登录环境"的搭建与卸载。
- 把原本散落在多份文档里的手动步骤，收敛为六个可独立执行的功能项：安装 Windows SSH 服务、在 Linux 生成密钥对、配置 Windows sshd、检查配置状态、卸载 Windows SSH 服务、查看本机连接信息。
- 自动处理 Windows OpenSSH 的 administrators_authorized_keys 易踩坑点。
- 自动检测 OpenSSH 的安装方式（MSI / Capability），为卸载和诊断提供准确来源信息。
- Linux 编译服务器连接信息全程交互式输入，不落盘，避免凭据泄露。

## 功能需求

- F1: 管理员权限检查与自动提权
  执行命令后，首先检测当前是否在管理员权限的 PowerShell/终端中运行。非管理员时自动尝试 UAC 提权重启：用 `Start-Process -Verb RunAs` 启动一个新的管理员权限进程（弹 UAC 确认），当前非管理员进程随即退出。若用户在 UAC 弹窗中拒绝（或提权失败），则提示"需要管理员权限"并以非零状态码退出。已具备管理员权限时直接继续。

- F2: 平台校验
  仅在 Windows 上运行；在非 Windows 平台提示"本命令仅支持 Windows"并退出。

- F3: 交互式功能菜单
  权限检查通过后，展示文本菜单，包含以下选项，用户输入序号选择：
  [1] 安装 Windows SSH 服务
  [2] 编译服务器生成密钥对
  [3] 配置 Windows 中 sshd 服务
  [4] 检查 sshd 配置状态（只读诊断）
  [5] 卸载 Windows SSH 服务
  [6] 查看本机连接信息（用户名/IP）
  [0] 退出
  每项执行完毕后暂停，提示"按 Enter 回到菜单，按 q 退出"：按 Enter 清屏并重新显示菜单（避免历史输出堆积）；按 q 退出程序；输入其它字符忽略不响应。选择 [0] 时直接退出，无需暂停。每轮循环开始前清屏，保证菜单始终从干净屏幕开始。

- F4: 安装 Windows SSH 服务（菜单 [1]）
  先检测 Windows 是否已安装 OpenSSH Server；若已安装则提示已存在并返回。若未安装，提示用户选择安装途径（默认 MSI）：
  (a) MSI 安装（默认）：从 GitHub OpenSSH releases 下载 MSI 包后调用 msiexec 静默安装。下载前先检测本地是否已存在该 MSI 安装包（默认路径 .embedded/ssh/ 下），若已存在则跳过下载直接安装。
  (b) 在线安装：调用 Windows Capability（Add-WindowsCapability）安装 OpenSSH.Server。
  安装完成后，确保 sshd 服务已注册（MSI 静默安装有时只释放文件不注册服务，此时用 sshd.exe install 补注册），然后启动 sshd 服务并将其启动类型设为自动。

- F5: 编译服务器生成密钥对（菜单 [2]）
  通过交互式输入获取 Linux 编译服务器的连接信息。连接地址支持紧凑格式 `user@host[:port]`（如 `cnb-xxx@cnb.space` 或 `user@1.2.3.4:2222`），一次输入完成；未带端口时默认 22。密码单独交互输入。所有连接信息不落盘。登录成功后，在远端执行命令采集并展示当前登录用户名（whoami）、主机名/IP（hostname）、家目录绝对路径（pwd ~），供用户核对连接目标是否正确。随后检查远端 sshd 是否已启动；未启动时提示用户在远端安装并启动 sshd，给出常见发行版的安装命令，并退出本项。sshd 正常时，以登录用户身份在 Linux 上生成 SSH 密钥对（若已存在则询问是否覆盖），通过 SFTP 把公钥拉取到本地 .embedded/ssh 目录，并记录其路径供 [3] 使用。密钥生成完成后，列出远端 ~/.ssh 目录下的所有文件（ls -la），供用户确认密钥已正确生成。

- F6: 配置 Windows sshd（菜单 [3]）
  将 [2] 拉取到的公钥（若 .embedded/ssh 下不存在则提示先执行 [2]）追加写入当前 Windows 用户的 ~/.ssh/authorized_keys（目录不存在则创建）。检查并修改 C:\ProgramData\ssh\sshd_config：确保开启公钥认证、确保 AuthorizedKeysFile 指向 .ssh/authorized_keys，并禁用 Match Group administrators 分组规则（注释/删除该段及其 AuthorizedKeysFile），使管理员账户也统一读取 ~/.ssh/authorized_keys。修改后重启 sshd 服务使配置生效，并回显最终关键配置项供用户核对。

- F7: 可重入与幂等
  各功能项均可独立重复执行；[1] 已安装则跳过，[2] 密钥已存在则询问，[3] 重复执行不产生重复的 authorized_keys 条目（去重）。[4] 为纯只读诊断，可任意次数执行，不修改任何系统状态。[5] 在未检测到 OpenSSH 安装时提示"无需卸载"并返回，不报错。

- F8: 检查 sshd 配置状态（菜单 [4]，只读诊断）
  纯只读，不修改任何文件或服务。逐项检查并汇总展示当前"Linux→Windows 免密登录"所需的配置是否就绪：
  (a) sshd 服务状态：是否已安装、是否 Running、启动类型（Automatic / Manual / Disabled）。
  (a.2) 安装方式诊断：调用 F10 的安装方式检测，展示当前 OpenSSH 的来源（MSI / Capability / 未知）及判定依据，辅助用户判断卸载时应选哪种方式。
  (b) sshd_config 关键项：PubkeyAuthentication 是否为 yes、AuthorizedKeysFile 是否指向 .ssh/authorized_keys、Match Group administrators 分组规则是否已禁用（与 [3] 的配置目标对应）。
  (c) authorized_keys 状态：当前 Windows 用户的 ~/.ssh/authorized_keys 是否存在、含多少条公钥。
  (d) 本地公钥状态：.embedded/ssh/id_mcp_server.pub（[2] 的产物，[3] 的依赖）是否存在。
  每项标注 ✅ 正常 / ⚠️ 异常，并在末尾给出综合结论（"可尝试免密登录" 或 "存在异常项，请先执行对应 [1]/[2]/[3]"）。

- F9: 卸载 Windows SSH 服务（菜单 [5]）
  卸载前先调用 F10 检测安装方式，按检测结果选择卸载策略，做到"对症卸载"：
  (a) MSI 方式：优先用本地缓存的 MSI 包执行 `msiexec /x` 静默卸载（与 [1] 的安装方式对应）；若本地 MSI 包已不存在，则自动打开"程序和功能"（appwiz.cpl）并提示用户在图形界面中手动找到 OpenSSH 卸载。
  (b) Capability 方式：执行 `Remove-WindowsCapability` 卸载（与在线安装方式对应）。
  (c) 未知来源：无法确定安装途径时，直接打开 appwiz.cpl 让用户手动卸载。
  卸载后清理 sshd 服务残留（MSI / Capability 卸载有时不删除 `sshd` 服务，此时用 `sc.exe delete sshd` 补删）。
  不自动清理 `C:\ProgramData\ssh`（可能含用户自定义的 authorized_keys / sshd_config）与 `C:\Program Files\OpenSSH` 目录，仅在末尾提示用户如需彻底清除可手动删除，避免误删用户数据。
  未检测到 OpenSSH 安装（服务与 exe 均不存在）时直接提示"无需卸载"并返回。

- F10: OpenSSH 安装方式检测（内部能力，供 [4] 诊断与 [5] 卸载复用）
  综合三个信号交叉判定 OpenSSH 的安装方式（MSI / Capability / 未知），任一单一信号都不足以准确区分：
  - 信号 A：`Get-WindowsCapability` 的 State。Installed 表示由 Windows 组件安装，但部分 MSI 安装后也可能被 Capability 探测到（因文件落到系统目录），故仅作强提示。
  - 信号 B（最可靠）：sshd 服务的 ImagePath（通过 `Get-CimInstance Win32_Service` 读取）。`C:\Program Files\OpenSSH\sshd.exe` → MSI；`C:\Windows\System32\OpenSSH\sshd.exe` → Capability。服务实际加载的 exe 路径不撒谎。
  - 信号 C：`findSshdExe()` 文件路径探测，作信号 B 不可用（服务未注册）时的兜底。
  判定优先级：信号 B > 信号 A > 信号 C；当信号矛盾或全无时标记为"未知"。

- F11: 查看本机连接信息（菜单 [6]，只读）
  纯只读，不修改任何状态。展示当前 Windows 主机的连接参数，供用户在 Linux 端拼接 ssh 命令时参考：
  (a) 当前 Windows 登录用户名（`os.userInfo().username`）。若为 `DOMAIN\user` 格式则只取反斜杠后的部分。
  (b) 本机所有可用 IPv4 地址（`os.networkInterfaces()`），过滤掉回环地址（127.x）、链路本地地址（169.254）与虚拟网卡（VirtualBox / VMware / Hyper-V / vEthernet / WSL / Docker），避免干扰。多网卡时全部列出，由用户根据网络拓扑自行选择。
  (c) 拼接一条可直接在 Linux 端执行的 ssh 命令示例（含 `-i ~/.ssh/id_mcp_server` 指定专用密钥，使用 [2] 生成的密钥名）。多个 IP 时取首个并提示可换用其它 IP。
  末尾提示用户：需依次执行 [1]→[2]→[3] 后连接才能免密成功。

## 非功能需求

- N1: 复用项目现有依赖与基础设施——命令注册复用 Commander 模式；日志输出风格复用 init/split 的 emoji 前缀约定。SSH 操作**不复用** `src/transports/ssh.ts` 的 `SSHShell`（它绑定 MCP 会话注册、PSH 解锁、会话 id 等业务机制，不适合一次性运维命令），而是直接基于 `ssh2` 库（已是生产依赖）在命令内部重新实现连接、执行命令、SFTP 下载三个最小操作。
- N2: 命令风格与现有 init/split 命令保持一致——独立的 commands/sshd-config.ts 模块，在 src/cli/index.ts 中以顶层内联命令注册。
- N3: 所有外部命令执行（PowerShell、msiexec、systemctl、ssh-keygen）需捕获退出码与输出，失败时给出可读的中文错误提示，不抛未捕获异常导致进程崩溃。
- N4: 敏感信息（Linux 服务器密码）仅存在于进程内存，不写入日志文件、不写入磁盘；交互输入密码时建议关闭回显或提示用户。
- N5: 对系统配置文件（sshd_config）的修改需谨慎——修改前备份原文件（如追加 .bak 后缀），修改失败时能回滚。
- N6: 遵循项目 ts-lang-spec 编码规范；新建文件 UTF-8 无 BOM、LF 换行。

## 不做的事

- 不实现从 Windows 主动把公钥"推送"到 Linux（方向是 Linux→Windows 免密，公钥在 Linux 生成、拉回 Windows 配置；不需要 Windows→Linux 免密）。
- 不管理 Linux 侧的 sshd_config（Linux sshd 的安装/启动只在 [2] 做"是否运行"检测与提示，不自动修改 Linux 的 sshd_config）。
- 不支持非 Windows 宿主（macOS/Linux 上的 sshd 配置不在范围内）。
- 不集成进 MCP 工具集（sshd-config 是一次性运维命令，不作为 MCP tool 暴露给 AI）。
- 不做 Windows 防火墙规则的细粒度管理（依赖 OpenSSH 安装时自带的防火墙规则；若 22 端口被阻塞仅提示，不自动改防火墙策略）。
- 不处理域账户/AD 的特殊认证场景（仅面向本地账户的公钥认证）。
- 不引入新的第三方依赖（用现有 ssh2 + Node 内置 child_process/fs/readline/net）。

## 验收标准

- AC1: 在非管理员 PowerShell 中执行 `embedded-mcp-toolkit sshd-config`，命令自动弹出 UAC 提权确认窗口；用户确认后以管理员权限重新启动（新窗口进入菜单）；用户拒绝时提示"需要管理员权限"并以非零状态码退出。
- AC2: 在非 Windows 平台执行该命令，提示"本命令仅支持 Windows"并退出。
- AC3: 在管理员 PowerShell 中执行该命令，能展示含 [1][2][3][4][5][6][0] 七个选项的菜单，输入序号后能进入对应功能；执行完单项后能回到主菜单；输入 0 退出。
- AC4: 菜单 [1]：对未安装 OpenSSH Server 的 Windows，执行后 `Get-Service sshd` 能看到 sshd 服务存在且状态为 Running，启动类型为 Automatic；对已安装的环境，执行后提示"已安装"并返回菜单，不重复安装。
- AC5: 菜单 [2]：交互输入正确的 Linux 服务器信息后，能在 .embedded/ssh 目录下生成公钥文件 id_mcp_server.pub，且文件内容为合法的 SSH 公钥格式（以 ssh-rsa/ssh-ed25519 等开头）。Linux sshd 未运行时，提示安装命令并退出本项。
- AC6: 菜单 [3]：执行后当前 Windows 用户的 ~/.ssh/authorized_keys 中包含 [2] 生成的公钥；重复执行 [3] 不会产生重复条目。
- AC7: 菜单 [3]：执行后 C:\ProgramData\ssh\sshd_config 中 Match Group administrators 段被注释/删除，PubkeyAuthentication 为 yes，AuthorizedKeysFile 指向 .ssh/authorized_keys；sshd_config 修改前有 .bak 备份。
- AC8: 全流程：按 [1]→[2]→[3] 顺序执行后，从 Linux 服务器执行 `ssh <windows用户>@<windows IP>` 能免密登录到 Windows PowerShell，无需输入密码。
- AC9: Linux 服务器连接密码不出现在任何日志文件或磁盘文件中。
- AC10: `npm run build` 编译通过，无 TypeScript 错误；新命令在 `embedded-mcp-toolkit --help` 中可见。
- AC11: 菜单 [5] 卸载——MSI 方式安装时，执行后调用 `msiexec /x` 静默卸载；卸载后 `Get-Service sshd` 查不到服务（含 sc.exe delete 补删残留）。本地 MSI 包不存在时，自动打开 appwiz.cpl 并提示用户手动卸载，等待用户按回车继续。
- AC12: 菜单 [5] 卸载——Capability 方式安装时，执行 `Remove-WindowsCapability` 卸载；卸载后 sshd 服务不再存在。
- AC13: 菜单 [5] 卸载——未检测到 OpenSSH 安装时，提示"无需卸载"并返回菜单，不报错、不修改系统状态。
- AC14: 安装方式检测（F10）：MSI 安装的环境检测结果为 MSI（依据服务 ImagePath 指向 Program Files\OpenSSH）；Capability 安装的环境检测结果为 Capability（依据服务 ImagePath 指向 System32\OpenSSH）。
- AC15: 菜单 [4] 检查状态时输出当前安装方式（MSI / Capability / 未知）及判定依据。
- AC16: 菜单 [6] 查看本机连接信息——输出当前 Windows 用户名与至少一个 IPv4 地址（有物理网卡连接时）；输出的 ssh 命令示例中的用户名、IP、密钥路径正确可直接在 Linux 端执行；虚拟网卡 IP 不出现在列表中。
