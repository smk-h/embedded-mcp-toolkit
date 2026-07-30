# 命令目录化拆分 Plan

## 架构概览

把两个超长命令单文件各自拆成一个命令目录，目录内按「类型常量层 → 纯工具层 → 业务层 → 入口层」分层，每层拆为聚焦的小文件。目录根的 `index.ts` 作为对外门面，仅 re-export 入口函数与 Options 类型。对外 API、调用方代码、运行时行为完全不变。

两个命令各自独立拆分，互不依赖。拆分是纯文件搬迁：函数体、注释、常量、类型原样搬运，仅在跨文件互调时补 `export` 关键字、调整 import 的相对层级。

### 分层模型（两个命令通用）

| 层 | 职责 | 依赖方向 |
|----|------|----------|
| types | 类型定义、接口、常量、菜单枚举 | （叶子，无内部依赖） |
| 工具层 | 纯函数/IO 封装（SFTP、JSON path、命令执行、下载、文本编辑、平台检测） | → types |
| 业务层 | 状态判定、落点路由、step 业务流程 | → 工具层 + types |
| 入口层 | 主菜单、banner、命令主入口 | → 业务层 + types |
| index | 门面，re-export 对外 API | → 入口层 |

依赖严格自上而下，**无环**。

---

## 核心数据结构

数据结构全部来自原单文件，原样搬迁，不新增、不改字段。仅列出归属文件，字段定义见源文件。

### remote-mcp-config（→ `types.ts`）

- `RemoteMcpConfigOptions`（export）— 命令选项
- `SERVER_KEY`、`SSH_KEY_PATH`、`MENU_CONFIGURE/CHECK/REMOVE/EXIT` — 常量
- `MenuChoice`、`McpClient`、`ClaudeScope` — 联合类型
- `BridgeServer`、`TargetFile`、`Target` — 接口
- `ServerStatus`、`StatusResult` — 状态类型

### sshd-config（→ `types.ts`）

- `SshdConfigOptions`（export）— 命令选项
- `CommandResult`、`OpenSshInstallInfo`、`OpenSshInstallMethod` — 接口/类型
- `CAPABILITY_SSHD_EXE`、`MSI_SSHD_EXE`、`MENU_*`（9 个）、`MenuChoice` — 常量/类型
- `OPENSSH_CAPABILITY_NAME`、`OPENSSH_MSI_URL`、`SSHD_CONFIG_PATH` — 常量
- `LOCAL_PUBKEY_REL`、`LOCAL_MSI_REL`、`REMOTE_MCP_TEMPLATE_REL` — 路径常量
- `SSHD_EXE_CANDIDATES`、`PUBKEY_LINE_RE` — 候选/正则常量

---

## 模块设计

### 一、remote-mcp-config 命令目录

**目录：** `src/cli/commands/remote-mcp-config/`

#### types.ts
- **职责：** 集中所有类型、接口、常量、菜单枚举（原文件 L40–L134）
- **对外接口：** export 上述全部类型与常量
- **依赖：** 无（仅类型，可被任意层引用）

#### sftp.ts
- **职责：** C1 SFTP 文件操作（原 L136–L299）
- **对外接口：** `openSftpSession`、`closeSftpSession`、`sftpReadText`、`sftpEnsureDir`、`sftpWriteText`、`sftpBackup`
- **依赖：** `ssh2`（`Client`、`SFTPWrapper` 类型）。函数均为自包含，不引用内部其它模块

#### json-mutate.ts
- **职责：** C2 JSON 按 path 操作的纯函数（原 L301–L447）
- **对外接口：** `getAtPath`、`getValueAtPath`、`setServerAtPath`、`removeServerAtPath`、`ensureInArray`、`removeFromArray`
- **依赖：** 无（纯函数，入参为普通对象/数组）

#### status.ts
- **职责：** C3 状态判定与 bridge 构造（原 L449–L631）
- **对外接口：** `buildBridgeServer`、`compareServer`、`readStatus`、`checkExists`
- **依赖：** `types.ts`（`BridgeServer`、`TargetFile`、`StatusResult`、`SERVER_KEY`）、`sftp.ts`（`sftpReadText`）、`json-mutate.ts`（`getAtPath`、`getValueAtPath`）

#### target.ts
- **职责：** C4 前半 落点描述符与落点路由（原 L633–L779）
- **对外接口：** `getRemoteHome`、`joinRemotePath`、`askTarget`
- **依赖：** `types.ts`（`Target`、`McpClient`、`ClaudeScope`、`SERVER_KEY`）、`@clack/prompts`、`../../shared/ssh.js`（`sshExec`）、`ssh2`（`Client`）

#### operations.ts
- **职责：** C4 后半 配置/删除/诊断业务流程（原 L781–L1143）
- **对外接口：** `resolveLocalEndpoint`、`mutateFile`、`doConfigure`、`doRemove`、`doCheckStatus`
- **依赖：** `types.ts`、`sftp.ts`（`sftpBackup`、`sftpReadText`、`sftpWriteText`）、`json-mutate.ts`（`setServerAtPath`、`getValueAtPath`、`ensureInArray`、`removeServerAtPath`、`removeFromArray`）、`status.ts`（`buildBridgeServer`、`readStatus`、`checkExists`）、`target.ts`（`askTarget`）、`@clack/prompts`、`../../shared/cli-helpers.js`（`collectConnectionInfo`）、`ssh2`（`Client`、`SFTPWrapper`）

#### run.ts
- **职责：** C5 主菜单、banner、命令主入口（原 L1145–L1287）
- **对外接口：** export `runRemoteMcpConfig`
- **依赖：** `types.ts`（`MenuChoice`、`MENU_*`、`RemoteMcpConfigOptions`）、`operations.ts`（`doConfigure`、`doRemove`、`doCheckStatus`）、`@clack/prompts`、`../../shared/ssh.js`（`parseServerAddress`、`sshConnect`、`sshDisconnect`、`LinuxServerInfo`）、`../../shared/cli-helpers.js`（`clearScreen`、`pauseForMenu`）、`sftp.ts`（`openSftpSession`、`closeSftpSession`）、`ssh2`（`Client`、`SFTPWrapper`）。`mainMenu`、`printBanner` 留在本文件内部

#### index.ts
- **职责：** 门面。承载原单文件顶部的 `@file @brief` 大段说明（命令背景、对偶关系、三类落点表、设计要点）；re-export 对外 API
- **对外接口：** export `runRemoteMcpConfig`（from `./run.js`）、export `RemoteMcpConfigOptions`（from `./types.js`）
- **依赖：** 仅 `./run.js`、`./types.js`

**依赖图（DAG）：**
```
types ←─ sftp
   ↑       ↑
   │       │
json-mutate │
   ↑   ╲   │
   │    ╲  │
   │    status
   │     ↑
target   │
   ↑  ╲  │
   │   ╲ │
operations
   ↑
  run
   ↑
 index
```

---

### 二、sshd-config 命令目录

**目录：** `src/cli/commands/sshd-config/`

#### types.ts
- **职责：** 集中所有类型、接口、常量、菜单枚举（原 L63–L168）
- **对外接口：** export 上述全部类型与常量
- **依赖：** 无

#### platform.ts
- **职责：** 平台与管理员权限（原 L170–L255）
- **对外接口：** `isWindows`、`isAdmin`、`relaunchAsAdmin`
- **依赖：** `child_process`（`execFileSync`）

#### exec.ts
- **职责：** 命令执行封装（原 L257–L345）
- **对外接口：** `execToResult`、`runPowerShell`、`runCmd`、`CommandResult`（类型，供 sshd-service 等引用；从 types.ts 引入或在此导出——见技术决策 D2）
- **依赖：** `child_process`（`execFile`）、`util`（`promisify`）、`types.ts`（`CommandResult`）

#### download.ts
- **职责：** HTTP 下载 MSI 离线安装包（原 L353–L408）
- **对外接口：** `downloadFile`
- **依赖：** `https`、`fs`（`createWriteStream`、`unlinkSync`）

#### sshd-service.ts
- **职责：** sshd 服务辅助（原 L410–L600）
- **对外接口：** `isSshdServiceRegistered`、`findSshdExe`、`detectOpenSshInstallMethod`、`ensureSshdService`
- **依赖：** `types.ts`（`OpenSshInstallInfo`、`CAPABILITY_SSHD_EXE`、`MSI_SSHD_EXE`、`SSHD_EXE_CANDIDATES`、`OPENSSH_CAPABILITY_NAME`）、`exec.ts`（`runPowerShell`、`runCmd`）、`fs`（`existsSync`）

#### sshd-config-edit.ts
- **职责：** sshd_config 文本处理（原 L602–L698）
- **对外接口：** `findActiveConfigLine`、`modifySshdConfig`
- **依赖：** 无（纯字符串处理）

#### steps/ 子目录（8 个 step 文件）

每个 step 文件职责单一：搬迁对应 `doXxx` 函数及其专用小工具。

| 文件 | 搬迁内容（原行号） | 依赖 |
|------|--------------------|------|
| `steps/install.ts` | `doInstallSsh`（L770–L896） | types、exec、download、sshd-service、`fs`、`path` |
| `steps/generate-key.ts` | `doGenerateKey`（L910–L1057） | types、`@clack/prompts`、`../../shared/ssh.js`、`ssh2`、`fs`、`path` |
| `steps/config-sshd.ts` | `doConfigSshd`（L1072–L1198） | types、sshd-service、sshd-config-edit、exec、`fs`、`os`、`path` |
| `steps/check-status.ts` | `doCheckStatus`（L1214–L1335） | types、exec、sshd-service、sshd-config-edit、`fs`、`os`、`path` |
| `steps/uninstall.ts` | `doUninstallSsh` + 专用工具 `openAppwizAndAwait`、`removeMcpPubKeyFromAuthorizedKeys`、`restoreSshdConfigFromBackup`（L1352–L1568） | types、exec、sshd-service、`fs`、`os`、`path`、`../../shared/cli-helpers.js`（`prompt`） |
| `steps/show-info.ts` | `doShowConnectionInfo`（L1585–L1623） | types、`../../shared/cli-helpers.js`（`collectConnectionInfo`） |
| `steps/gen-template.ts` | `doGenerateTemplate`（L1639–L1724） | types、`../../shared/cli-helpers.js`（`collectConnectionInfo`）、`@clack/prompts`（`box`）、`fs`、`path` |
| `steps/one-click.ts` | `doOneClickFlow`（L1736–L1758） | 同目录其它 7 个 step（install/generate-key/config-sshd/gen-template） |

注：steps 文件对 shared 的引用层级为 `../../../shared/xxx.js`（多两级：steps → sshd-config → commands → cli）。

#### run.ts
- **职责：** 主菜单（原 L700–L753）、banner（L1768–L1772）、命令主入口（L1780–L1844）
- **对外接口：** export `runSshdConfig`
- **依赖：** `types.ts`、`platform.ts`（`isWindows`、`isAdmin`、`relaunchAsAdmin`）、8 个 `steps/*`、`../../shared/cli-helpers.js`（`clearScreen`、`pauseForMenu`）、`@clack/prompts`。`mainMenu`、`printBanner` 留在本文件内部

#### index.ts
- **职责：** 门面。承载原单文件顶部的 `@file @brief` 大段说明（命令背景、菜单功能、SSH 复用说明）；re-export 对外 API
- **对外接口：** export `runSshdConfig`（from `./run.js`）、export `SshdConfigOptions`（from `./types.js`）
- **依赖：** 仅 `./run.js`、`./types.js`

**依赖图（DAG）：**
```
types ←─ platform
   ↑
   ├─ exec ←─ sshd-service
   ├─ download
   ├─ sshd-config-edit
   ↑
steps/install        ─┐
steps/generate-key   ─┤
steps/config-sshd    ─┤── steps/one-click
steps/check-status   ─┤
steps/uninstall      ─┤
steps/show-info      ─┤
steps/gen-template   ─┘
   ↑
  run ── (platform, steps, types)
   ↑
 index
```

---

## 模块交互

调用链与原单文件一致，仅跨文件边界：

### remote-mcp-config
```
cli/index.ts → remote-mcp-config/index.ts → run.ts:runRemoteMcpConfig
  → 登录后开 SFTP 会话（sftp.ts:openSftpSession）
  → 菜单循环（run.ts:mainMenu）
    → 配置: operations.ts:doConfigure
        → resolveLocalEndpoint → target.ts:askTarget
        → status.ts:{buildBridgeServer, readStatus}
        → sftp.ts/json-mutate.ts 经 operations.ts:mutateFile
    → 查看: operations.ts:doCheckStatus（同上状态链）
    → 删除: operations.ts:doRemove → status.ts:checkExists + mutateFile
```

### sshd-config
```
cli/index.ts → sshd-config/index.ts → run.ts:runSshdConfig
  → platform.ts:{isWindows, isAdmin, relaunchAsAdmin}
  → 菜单循环（run.ts:mainMenu）
    → [1] steps/one-click.ts:doOneClickFlow → 调 install/generate-key/config-sshd/gen-template
    → [2] steps/install.ts:doInstallSsh → exec/download/sshd-service
    → [3] steps/generate-key.ts:doGenerateKey → shared/ssh
    → [4] steps/config-sshd.ts:doConfigSshd → sshd-config-edit/exec
    → [5] steps/check-status.ts:doCheckStatus → sshd-service/exec
    → [6] steps/uninstall.ts:doUninstallSsh → exec/sshd-service + 本文件专用工具
    → [7] steps/show-info.ts:doShowConnectionInfo → shared/cli-helpers
    → [8] steps/gen-template.ts:doGenerateTemplate → shared/cli-helpers
```

---

## 文件组织

```
src/cli/commands/
├── remote-mcp-config/
│   ├── index.ts          门面：re-export + 原文件头说明
│   ├── types.ts          类型/接口/常量/菜单枚举
│   ├── sftp.ts           C1 SFTP 文件操作
│   ├── json-mutate.ts    C2 JSON path 操作纯函数
│   ├── status.ts         C3 状态判定与 bridge 构造
│   ├── target.ts         C4前 落点路由
│   ├── operations.ts     C4后 配置/删除/诊断业务流程
│   └── run.ts            C5 主菜单 + 主入口
├── sshd-config/
│   ├── index.ts          门面：re-export + 原文件头说明
│   ├── types.ts          类型/接口/常量/菜单枚举
│   ├── platform.ts       平台与管理员权限
│   ├── exec.ts           命令执行封装
│   ├── download.ts       HTTP 下载
│   ├── sshd-service.ts   sshd 服务辅助
│   ├── sshd-config-edit.ts  sshd_config 文本处理
│   ├── steps/
│   │   ├── install.ts        doInstallSsh
│   │   ├── generate-key.ts   doGenerateKey
│   │   ├── config-sshd.ts    doConfigSshd
│   │   ├── check-status.ts   doCheckStatus
│   │   ├── uninstall.ts      doUninstallSsh + 专用工具
│   │   ├── show-info.ts      doShowConnectionInfo
│   │   ├── gen-template.ts   doGenerateTemplate
│   │   └── one-click.ts      doOneClickFlow
│   └── run.ts            主菜单 + 主入口
├── init.ts               （不动）
├── split.ts              （不动）
└── regex-verify.ts       （不动）

（删除原单文件：remote-mcp-config.ts、sshd-config.ts）
```

---

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| D1 拆分粒度 | 按层 + 每 step 一文件（最细粒度） | 已与用户确认。贴合文件内已有章节边界，单文件最短最清晰，便于后续单独维护某个 step |
| D2 `CommandResult` 类型归属 | 放 `types.ts`，exec.ts 从 types 引入 | CommandResult 是跨模块共享的数据契约（exec 产出、sshd-service/steps 消费），属类型层而非 exec 私有；放 types 避免上层反向依赖 exec |
| D3 uninstall 专用工具归属 | 与 `doUninstallSsh` 同放 `steps/uninstall.ts` | `openAppwizAndAwait`/`removeMcpPubKeyFromAuthorizedKeys`/`restoreSshdConfigFromBackup` 仅供卸载使用，与该 step 强内聚，保持 step 自包含，不污染辅助层 |
| D4 共性是否抽 shared | 不抽（spec 明确不做） | 本期只做单文件→目录搬运，避免范围蔓延与潜在行为变更；SFTP/JSON path 等共性留待后续章节评估 |
| D5 门面 index 是否 re-export 内部辅助 | 不 re-export | 最小暴露面；门面只暴露对外 API，内部辅助通过子文件相对路径在目录内互调 |
| D6 ESM import 后缀 | 全部带显式 `.js`；目录引用写 `./dir/index.js` | NodeNext 要求；**注意 NodeNext 不支持目录 index 自动解析**（那是 CommonJS/node 策略行为），目录 import 必须显式写 `./dir/index.js`。故 `src/cli/index.ts` 两行 import 从 `./commands/<cmd>.js` 改为 `./commands/<cmd>/index.js` |
| D7 文件头说明迁移 | 原单文件 `@file @brief` 大段说明移到各自 `index.ts` 顶部 | 文件级总说明属于命令整体，门面是最合适的承载点；子文件用一行 `@file` 简述职责 |

---

## 编码规范

**编程语言：** TypeScript（NodeNext ESM）

**适用的语言规范技能：** `ts-lang-spec`

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行、4 空格缩进、语句末分号（与现有命令文件一致）
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本章仅新建文件 + 删除原单文件，不修改既有文件，故无编码转换风险
- **ESM 路径**：所有相对 import 带显式 `.js` 后缀；对 shared 引用按层级补足（remote 子文件 `../../shared/`，sshd 根文件 `../../shared/`，sshd/steps 子文件 `../../../shared/`）

开发阶段编写代码时，必须遵循 `ts-lang-spec` 中定义的编码风格、命名约定、注释规范（中文 Doxygen `@brief/@details/@param/@returns` 风格，与现有命令文件保持一致）。开发执行者应在开始编码前自动调用 `ts-lang-spec` 技能，并严格遵守上述文件编码规则。
