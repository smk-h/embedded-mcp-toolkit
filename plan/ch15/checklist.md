# 远程 MCP 配置命令 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。与实现解耦——代码重构但行为不变时，checklist 依然适用。

## 实现完整性

- [ ] 新命令 `remote-mcp-config` 已注册且可调用（验证：`node ./bin/embedded-mcp-toolkit-cli.js --help` 输出含 `remote-mcp-config`）
- [ ] 命令启动后出现服务器地址输入框与密码输入框（验证：运行命令，观察到两次交互提示，密码不回显）
- [ ] 主菜单包含四项：配置 / 查看状态 / 删除 / 退出（验证：登录成功后看到四项菜单）
- [ ] 地址解析支持 `user@host`、`user@host:port`，默认端口 22；非法格式给出明确错误（验证：分别输入合法与缺 user/端口越界的地址，观察行为）
- [ ] 三类落点（Claude 全局 / Claude 项目 / ZCode 项目）均可被选中并路由到正确的目标文件（验证：选每种 client+scope/路径，观察后续读取的文件路径提示）

## 集成（共享层重构回归）

- [ ] `shared/ssh.ts` 与 `shared/cli-helpers.ts` 已被 sshd-config 与 remote-mcp-config 共同引用（验证：`grep -rn "shared/ssh\|shared/cli-helpers" src` 两文件均命中 import）
- [ ] sshd-config 命令重构后行为不变（验证：`node ./bin/embedded-mcp-toolkit-cli.js sshd-config` 能正常进入主菜单并执行 [5] 只读诊断项；确认未因 import 迁移而报错或行为异常）
- [ ] sshd-config.ts 中已无被抽出函数的重复定义（验证：`grep -nE "^function (prompt|sshConnect|collectConnectionInfo)" src/cli/commands/sshd-config.ts` 无命中）

## 编译与测试

- [ ] 全项目编译无错误（验证：`npm run build` 或 `npx tsc --noEmit` 退出码 0）
- [ ] 代码符合 plan.md 中声明的 `ts-lang-spec` 要求（验证：`npm run eslint:fix` 无新增报错；人工检查命名/JSDoc `@brief`/分节注释风格与 sshd-config.ts 一致）
- [ ] 格式规范通过（验证：`npm run format:check` 无报错，或 `format:fix` 后无 diff）
- [ ] 文件编码未被破坏：新建文件为 UTF-8 无 BOM / LF；修改的 `sshd-config.ts` 与 `index.ts` 保持原编码不变（验证：用编码检测工具核对，无乱码、无 BOM 新增）

## 端到端场景

> 以下场景需在一台可 SSH 登录的真实 Linux 服务器上执行（符合 AC9"远端无依赖"前提：该服务器仅需可被 SSH 登录，无需预装 node 或本工具包）。

- [ ] **场景 E2E-1（Claude 全局写入）**：登录 → claude → 全局 → 查看状态显示"未配置" → 配置 → 退出后远端 `cat ~/.claude.json` 顶层 `mcpServers` 含 `embedded-board`，且 command=ssh、args=`["-i","~/.ssh/id_mcp_server","<winuser>@<winip>","<batpath>"]`；该文件中其它字段（如 `projects`、`userID`）原样保留（验证：配置前 `cp ~/.claude.json /tmp/before`，配置后 `diff` 仅 `mcpServers.embedded-board` 一处变化）
- [ ] **场景 E2E-2（Claude 项目写入+使能）**：登录 → claude → 项目 → 输入远端项目路径 → 配置 → 远端 `<proj>/.mcp.json` 的 `mcpServers` 含 `embedded-board`（保留其它 server），`<proj>/.claude/settings.local.json` 的 `enabledMcpjsonServers` 含 `embedded-board` 且无重复（验证：两个文件分别 cat 核对；父目录不存在时自动创建）
- [ ] **场景 E2E-3（ZCode 项目写入）**：登录 → zcode → 输入项目路径 → 配置 → `<proj>/.zcode/config.json` 的 `mcp.servers` 含 `embedded-board`，对象含 `type:"stdio"`、`enabled:true`、command/args 正确（验证：cat 文件核对结构合法）
- [ ] **场景 E2E-4（三态状态判定）**：对同一落点构造三种状态后选"查看状态"：①目标文件不存在 → 显示"未配置"；②写入本次桥接定义 → 显示"已配置且一致"；③手动篡改 args 中 IP 为旧值 → 显示"已配置但不一致"（验证：三种状态下查看，输出与预期一致）
- [ ] **场景 E2E-5（删除）**：任一落点配置后再删除 → 目标文件中 `embedded-board` 消失，其它 server 与字段保留；Claude 项目落点的 `enabledMcpjsonServers` 同步移除该项；对已删除的落点再次删除 → 提示"无需删除"而非报错（验证：删除前后 diff 目标文件，仅目标项消失）
- [ ] **场景 E2E-6（备份与回滚）**：任一写/删操作前远端生成 `<file>.bak`（验证：操作后 `ls` 看到 .bak 存在；对已含 .bak 的目标再次操作，.bak 内容不变=首次备份被保留）
- [ ] **场景 E2E-7（密码安全）**：全程观察命令输出无明文密码；登录密码不出现在任何回显/诊断/提示文本中（验证：人工审视全程输出；操作完成后远端与本机均无含密码的日志文件）
- [ ] **场景 E2E-8（错误凭据中止）**：输入错误密码 → 给出明确错误提示（认证失败）并中止，不进入主菜单（验证：故意输错密码，观察未进入菜单）
- [ ] **场景 E2E-9（不破坏原有配置）**：在已含其它 server（如手动加一个 `foo` server）和大量业务字段的真实 `~/.claude.json` 上执行配置 → 操作后除 `embedded-board` 及其使能项外，其它所有字段字节级保留（验证：配置前备份原文件，配置后 `diff` 仅目标项变化）
- [ ] **场景 E2E-10（远端无依赖）**：在一台纯净 Linux（仅保证可 SSH 登录、未装 node）上跑通完整配置流程，所有配置改动通过 SFTP 完成（验证：全程无需在远端装任何包即成功写入配置）
