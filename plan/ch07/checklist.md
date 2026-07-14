# sshd-config 命令 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。与实现解耦：代码重构但行为不变时，checklist 依然适用。

## 实现完整性

- [ ] `sshd-config` 命令已注册并出现在 `embedded-mcp-toolkit --help` 输出中（验证：`node ./bin/embedded-mcp-toolkit-cli.js --help`，能看到 sshd-config 条目）
- [ ] 命令描述为"配置 Windows OpenSSH 免密登录环境（交互式菜单）"或同义文案（验证：`--help` 输出中该条目的 description 字段）
- [ ] 主菜单能展示 [1]/[2]/[3]/[4]/[5]/[6]/[0] 七个选项，文本与 spec F3 一致（验证：管理员窗口运行命令，观察菜单输出，含 [6] 查看本机连接信息）
- [ ] 每轮菜单循环开始时清屏，标题与菜单从干净屏幕顶部开始（验证：执行完一个 step 按 Enter 回菜单后，屏幕无上次 step 的输出残留，菜单位于屏幕顶部）
- [ ] step 执行完毕后提示"按 Enter 回到菜单，按 q 退出"（验证：选任意 [1]-[6] 执行后，观察末尾出现暂停提示）
- [ ] 按 Enter 回到菜单且清屏（验证：在暂停提示处按 Enter，屏幕清空并重新显示菜单）
- [ ] 按 q 退出程序（验证：在暂停提示处输入 q，程序打印"再见"并退出）
- [ ] 暂停时输入其它字符不响应，继续等待（验证：在暂停提示处输入 abc 等，不退出也不回菜单，重新等待输入）
- [ ] 选 [0] 直接退出，不经过暂停提示（验证：主菜单选 0，直接打印"再见"退出，无"按 Enter"提示）
- [ ] [1] 执行后能检测 OpenSSH Server 是否已安装并给出相应提示（验证：已安装环境运行 [1]，提示"已安装"并返回菜单；不重复安装）
- [ ] [1] 未安装时提示选择安装方式，默认 MSI（验证：未安装环境运行 [1]，看到"选择安装方式 [1]MSI(默认) [2]在线安装"，直接回车走 MSI 分支）
- [ ] [1] MSI 分支：本地已存在 `.embedded/ssh/OpenSSH-Win64.msi` 时跳过下载直接安装（验证：放一个 MSI 文件后运行 [1] 选 MSI，看到"已存在 MSI 安装包，跳过下载"）
- [ ] [1] MSI 安装后自动注册 sshd 服务（验证：MSI 安装成功但 sshd 服务未注册时，运行 [1] 看到"注册 sshd 服务 (...sshd.exe install)"，之后 `Get-Service sshd` 能查到服务）
- [ ] [1] 服务已注册时不重复注册（验证：在 sshd 服务已注册的环境运行 [1]，不出现"注册 sshd 服务"步骤）
- [ ] [2] 编译服务器地址支持紧凑格式 `user@host[:port]`（验证：运行 [2]，输入 `cnb-xxx@cnb.space` 或 `root@1.2.3.4:2222`，能正确拆解并连接；不带端口时默认 22）
- [ ] [2] 登录成功后展示当前登录用户名、主机 IP、家目录绝对路径三项信息（验证：运行 [2] 连接成功后，观察输出含"当前用户/主机 IP/家目录"三项）
- [ ] [2] 密钥生成完成后列出远端 ~/.ssh 目录所有文件（验证：运行 [2] 生成密钥后，观察输出含 `ls -la ~/.ssh` 的结果，能看到 id_mcp_server 与 id_mcp_server.pub）
- [ ] [2] 执行后能在本地生成公钥文件，内容为合法 SSH 公钥格式（验证：运行 [2] 后 `cat .embedded/ssh/id_mcp_server.pub`，内容以 `ssh-rsa` 开头）
- [ ] [3] 执行后能读取并写入 authorized_keys，对已存在的公钥去重（验证：连续运行两次 [3]，authorized_keys 中该公钥仅出现一次）
- [ ] [3] 执行后能修改 sshd_config 并回显最终关键配置项（验证：运行 [3] 后观察回显的 PubkeyAuthentication / AuthorizedKeysFile / Match Group 处理结果）
- [ ] [4] 是纯只读诊断，展示 sshd 服务状态（是否安装/Running/启动类型）（验证：运行 [4] 观察 sshd 服务状态输出）
- [ ] [4] 展示 sshd_config 关键项检查结果（PubkeyAuthentication / AuthorizedKeysFile / Match Group administrators，每项 ✅ 或 ⚠️）（验证：运行 [4] 观察三项关键配置的 ✅/⚠️ 标注）
- [ ] [4] 展示 authorized_keys 状态（是否存在、公钥条数）（验证：运行 [4] 观察公钥条数输出）
- [ ] [4] 展示本地公钥 .embedded/ssh/id_mcp_server.pub 是否存在（验证：运行 [4] 观察本地公钥状态）
- [ ] [4] 末尾给出汇总结论（全部正常→"可尝试免密登录"；有异常→列出建议的 [1]/[2]/[3]）（验证：未配置环境运行 [4]，结论列出建议项；已配置环境运行 [4]，结论为"可尝试免密登录"）
- [ ] [4] 不修改任何文件或服务（验证：运行 [4] 前后对比 ~/.ssh/authorized_keys、sshd_config 的修改时间戳无变化；sshd 服务未被重启）
- [ ] [4] 展示安装方式诊断（MSI / Capability / 未知）及判定依据（验证：运行 [4]，在服务状态之后看到"安装方式: ..."一行；MSI 装的机器显示 MSI，Capability 装的显示 Capability）
- [ ] [5] 卸载——MSI 方式安装时执行 msiexec /x 静默卸载（验证：MSI 安装环境运行 [5]，看到"使用 MSI 包卸载"，卸载后 `Get-Service sshd` 查不到服务）
- [ ] [5] 卸载——本地 MSI 包不存在时自动打开 appwiz.cpl 并等待（验证：删除本地 .embedded/ssh/OpenSSH-Win64.msi 后运行 [5]，看到"未找到本地 MSI 包"并弹出"程序和功能"窗口，提示按回车继续）
- [ ] [5] 卸载——Capability 方式安装时执行 Remove-WindowsCapability（验证：Capability 安装环境运行 [5]，看到"通过 Remove-WindowsCapability 卸载"，卸载后服务不存在）
- [ ] [5] 卸载——未检测到安装时提示"无需卸载"并返回（验证：在未安装 OpenSSH 的环境运行 [5]，看到"未检测到 OpenSSH 安装，无需卸载"，不报错）
- [ ] [5] 卸载后清理 sshd 服务残留（验证：MSI/Capability 卸载后若 sshd 服务仍存在，看到"sshd 服务仍存在，正在删除服务"，之后 `Get-Service sshd` 查不到）
- [ ] [5] 卸载后提示用户手动清理配置目录（验证：运行 [5] 末尾看到"C:\ProgramData\ssh 未自动清理"提示，不自动删除该目录）
- [ ] 安装方式检测（detectOpenSshInstallMethod）：MSI 安装 → method=msi（依据服务 ImagePath 指向 Program Files\OpenSSH）（验证：在 MSI 安装环境运行 [4] 或 [5]，检测结果为 MSI）
- [ ] 安装方式检测：Capability 安装 → method=capability（依据服务 ImagePath 指向 System32\OpenSSH）（验证：在 Capability 安装环境运行 [4] 或 [5]，检测结果为 Capability）
- [ ] [6] 展示当前 Windows 用户名（验证：运行 [6]，看到"Windows 用户名: ..."；域账户 DOMAIN\user 时只显示反斜杠后的部分）
- [ ] [6] 展示本机 IPv4 地址（验证：运行 [6]，看到至少一个物理网卡 IP；虚拟网卡 IP 不出现）
- [ ] [6] 过滤虚拟网卡（验证：在装了 Docker/WSL2/Hyper-V 的机器运行 [6]，列表不含这些虚拟网卡的 IP）
- [ ] [6] 拼接可用的 ssh 命令示例（验证：运行 [6]，看到 `ssh -i ~/.ssh/id_mcp_server <user>@<ip>`，用户名/IP/密钥路径正确可直接在 Linux 端执行）
- [ ] [6] 不修改任何文件或服务（验证：运行 [6] 前后对比系统状态无变化；仅用 os 模块读取信息，无 PowerShell/写文件操作）

## 集成

- [ ] `runSshdConfig` 被 `src/cli/index.ts` 的 `.action()` 正确调用（验证：运行 `sshd-config` 命令能进入主流程，非"command not found"）
- [ ] SSH 操作基于 ssh2 库在 `sshd-config.ts` 内独立实现，不 import `src/transports/` / `src/services/` / `src/mcp/` 任何模块（验证：`grep -E "from ['\"]\.\.\/(transports|services|mcp)" src/cli/commands/sshd-config.ts` 无输出）
- [ ] sshd-config.ts 仅导出 `runSshdConfig` 及必要类型，内部函数不导出（验证：`grep -E "^export " src/cli/commands/sshd-config.ts` 仅含 `runSshdConfig` 与接口类型）

## 编译与测试

- [ ] `npm run build` 编译通过，无 TypeScript 错误（验证：运行 `npm run build`，exit code 0，无 error 输出）
- [ ] 代码符合 `ts-lang-spec` 规范要求（验证：`npm run format:check` 通过或人工检查命名/注释/风格；Doxygen 注释块与 init.ts/split.ts 一致）
- [ ] lint 检查通过（验证：`npm run eslint:fix` 后无 error）
- [ ] 文件编码未被破坏：`src/cli/commands/sshd-config.ts` 为 UTF-8 无 BOM、LF 换行（验证：用编码检测工具或 `file` 命令核对）；`src/cli/index.ts` 保持原编码与换行符不变（验证：修改前后对比，无编码转换痕迹）

## 权限与平台校验

- [ ] 非管理员 PowerShell 中运行 `sshd-config`，自动弹出 UAC 提权确认窗口（验证：普通窗口运行，观察是否弹出 UAC 窗口）
- [ ] UAC 提权：用户点击"是"后，新管理员窗口启动并进入菜单（验证：UAC 点是后，新窗口出现菜单；旧窗口退出）
- [ ] UAC 拒绝：用户点击"否"后，原窗口提示"需要管理员权限"并以非零状态码退出，不进入菜单（验证：UAC 点否后，原窗口显示提示文本与退出码 1）
- [ ] 非 Windows 平台运行 `sshd-config`，提示"本命令仅支持 Windows"并退出（验证：在 Linux/macOS 上 `node ./bin/embedded-mcp-toolkit-cli.js sshd-config`，观察提示）
- [ ] 管理员 Windows 中运行 `sshd-config`，通过两项校验进入菜单（验证：管理员窗口运行，能看到菜单而非退出）

## 安全性

- [ ] Linux 编译服务器密码不出现在任何日志文件中（验证：完成一次 [2] 后 `grep -rn <密码值> .embedded/log/` 无匹配；进程退出后内存释放）
- [ ] Linux 服务器连接信息（host/port/user/password）不落盘（验证：完成 [2] 后检查 `.embedded/` 下无包含密码的配置文件）
- [ ] `askPassword` 输入时不在终端回显明文（验证：运行 [2] 输入密码时，终端不显示密码字符或仅显示占位符）
- [ ] sshd_config 修改前生成 `.bak` 备份（验证：运行 [3] 后 `C:\ProgramData\ssh\sshd_config.bak` 存在；重复运行 [3] 不覆盖已有 .bak）

## 幂等性

- [ ] [1] 在已安装 OpenSSH Server 的环境重复执行，提示"已安装"不重复安装（验证：已安装环境连续运行两次 [1]，第二次提示已安装）
- [ ] [2] 在密钥已存在的 Linux 上执行，询问是否覆盖；选 N 则保留原密钥（验证：运行 [2] 观察询问提示，选 N 后 `.embedded/ssh/id_mcp_server.pub` 内容不变）
- [ ] [3] 连续执行不产生重复的 authorized_keys 条目（验证：运行两次 [3]，`sort ~/.ssh/authorized_keys | uniq -d` 无重复行）
- [ ] [5] 在未检测到 OpenSSH 安装的环境重复执行，提示"无需卸载"不报错（验证：连续运行两次 [5]，第二次提示无需卸载并返回菜单）

## 端到端场景

- [ ] **场景 1（全流程免密登录）**：管理员 PowerShell 中按 [1]→[2]→[3] 顺序执行后，从 Linux 编译服务器执行 `ssh <windows用户>@<windows IP>` 能免密登录到 Windows PowerShell，无需输入密码（验证：Linux 端执行 ssh 命令，直接进入 Windows shell 提示符，无 password 提示）
- [ ] **场景 2（sshd 未运行）**：[2] 中连接的 Linux 服务器 sshd 未启动时，提示安装命令（apt/dnf）并退出本项，回到主菜单（验证：停掉 Linux sshd 后运行 [2]，观察提示文本与是否回到菜单）
- [ ] **场景 3（公钥不存在）**：未执行 [2] 直接运行 [3]，提示"未找到公钥，请先执行 [2]"并回到菜单（验证：删除 `.embedded/ssh/id_mcp_server.pub` 后运行 [3]，观察提示）
- [ ] **场景 4（sshd_config 回滚）**：[3] 中 Restart-Service 失败时，从 .bak 回滚 sshd_config 并提示（验证：模拟重启失败，观察 sshd_config 是否恢复原样）
- [ ] **场景 5（单项重跑）**：单独运行 [3]（不跑 [1][2]），在公钥已存在且 sshd 已装的环境能独立完成配置（验证：仅运行 [3]，确认 authorized_keys 写入、sshd_config 修改、sshd 重启均正常）
- [ ] **场景 6（MSI 卸载）**：MSI 安装的 OpenSSH，运行 [5] 后 `Get-Service sshd` 查不到服务，sshd.exe 不再存在（验证：[1] 安装后运行 [5]，卸载成功后 Get-Service 与 findSshdExe 均为空）
- [ ] **场景 7（安装循环）**：[1] 安装 → [5] 卸载 → [1] 再安装，能正常完成（验证：三步顺序执行，最终 sshd 服务 Running 且 StartupType=Automatic）
