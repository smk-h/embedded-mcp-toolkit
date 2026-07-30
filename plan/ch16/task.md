# 命令目录化拆分 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/commands/remote-mcp-config/index.ts` | 门面：re-export + 原文件头说明 |
| 新建 | `src/cli/commands/remote-mcp-config/types.ts` | 类型/接口/常量/菜单枚举 |
| 新建 | `src/cli/commands/remote-mcp-config/sftp.ts` | C1 SFTP 文件操作 |
| 新建 | `src/cli/commands/remote-mcp-config/json-mutate.ts` | C2 JSON path 操作纯函数 |
| 新建 | `src/cli/commands/remote-mcp-config/status.ts` | C3 状态判定与 bridge 构造 |
| 新建 | `src/cli/commands/remote-mcp-config/target.ts` | C4前 落点路由 |
| 新建 | `src/cli/commands/remote-mcp-config/operations.ts` | C4后 配置/删除/诊断业务流程 |
| 新建 | `src/cli/commands/remote-mcp-config/run.ts` | C5 主菜单 + 主入口 |
| 新建 | `src/cli/commands/sshd-config/index.ts` | 门面：re-export + 原文件头说明 |
| 新建 | `src/cli/commands/sshd-config/types.ts` | 类型/接口/常量/菜单枚举 |
| 新建 | `src/cli/commands/sshd-config/platform.ts` | 平台与管理员权限 |
| 新建 | `src/cli/commands/sshd-config/exec.ts` | 命令执行封装 |
| 新建 | `src/cli/commands/sshd-config/download.ts` | HTTP 下载 |
| 新建 | `src/cli/commands/sshd-config/sshd-service.ts` | sshd 服务辅助 |
| 新建 | `src/cli/commands/sshd-config/sshd-config-edit.ts` | sshd_config 文本处理 |
| 新建 | `src/cli/commands/sshd-config/steps/install.ts` | doInstallSsh |
| 新建 | `src/cli/commands/sshd-config/steps/generate-key.ts` | doGenerateKey |
| 新建 | `src/cli/commands/sshd-config/steps/config-sshd.ts` | doConfigSshd |
| 新建 | `src/cli/commands/sshd-config/steps/check-status.ts` | doCheckStatus |
| 新建 | `src/cli/commands/sshd-config/steps/uninstall.ts` | doUninstallSsh + 专用工具 |
| 新建 | `src/cli/commands/sshd-config/steps/show-info.ts` | doShowConnectionInfo |
| 新建 | `src/cli/commands/sshd-config/steps/gen-template.ts` | doGenerateTemplate |
| 新建 | `src/cli/commands/sshd-config/steps/one-click.ts` | doOneClickFlow |
| 新建 | `src/cli/commands/sshd-config/run.ts` | 主菜单 + 主入口 |
| 删除 | `src/cli/commands/remote-mcp-config.ts` | 原单文件（内容已拆分） |
| 删除 | `src/cli/commands/sshd-config.ts` | 原单文件（内容已拆分） |

修改：`src/cli/index.ts` — **不修改**（import 路径 `./commands/sshd-config.js`、`./commands/remote-mcp-config.js` 现指向目录的 index.ts，ESM 自动解析，无需改动）

---

## 通用搬迁规则（适用于所有任务）

1. **纯搬运**：函数体、注释（含 `@brief/@details/@param/@returns`）、常量值、类型字段原样复制，不改逻辑、不改命名、不改文案
2. **补 export**：原模块内私有函数搬到子文件后，凡被其它子文件引用的，加 `export` 关键字
3. **import 调整**：
   - 同目录子文件互引用：相对路径 + `.js`（如 `import { sftpReadText } from "./sftp.js"`）
   - 对 shared 引用：补层级。remote 子文件用 `../../shared/xxx.js`；sshd 根级文件用 `../../shared/xxx.js`；sshd/steps 子文件用 `../../../shared/xxx.js`
   - 每个文件只 import 它实际用到的符号，不整包引入
4. **文件头**：门面 index.ts 承载原单文件 `@file @brief` 大段说明；其余子文件顶部写一行 `@file <路径>` + 一句 `@brief` 说明本文件职责
5. **可见性**：门面 index.ts 只 re-export 对外 API（入口函数 + Options 类型）

---

## T1: 搭建 remote-mcp-config 目录骨架与 types.ts

**文件：** `src/cli/commands/remote-mcp-config/types.ts`
**依赖：** 无
**步骤：**
1. 创建目录 `src/cli/commands/remote-mcp-config/`
2. 从原 `remote-mcp-config.ts` 搬迁 L40–L134 全部内容：`RemoteMcpConfigOptions`（export）、`SERVER_KEY`、`SSH_KEY_PATH`、`MENU_*`（4 个）、`MenuChoice`、`McpClient`、`ClaudeScope`、`BridgeServer`、`TargetFile`、`Target`、`ServerStatus`、`StatusResult`
3. 所有原本就在原文件中 export 的（`RemoteMcpConfigOptions`）保持 export；原本 module-private 的类型/常量加 `export` 供子文件引用
4. 顶部写 `@file` 文件头

**验证：** 该文件无内部依赖，单独可读；暂不编译（等 T9 统一编译）

---

## T2: sftp.ts

**文件：** `src/cli/commands/remote-mcp-config/sftp.ts`
**依赖：** T1（仅类型，`ssh2` 的 `Client`/`SFTPWrapper` 来自外部包）
**步骤：**
1. 搬迁原 L136–L299：`openSftpSession`、`closeSftpSession`、`sftpReadText`、`sftpEnsureDir`、`sftpWriteText`、`sftpBackup` 六个函数
2. `import { Client, type SFTPWrapper } from "ssh2"`（与原文件一致）
3. 六个函数全部加 `export`
4. 搬迁对应注释

**验证：** 文件内函数自包含，无内部模块依赖

---

## T3: json-mutate.ts

**文件：** `src/cli/commands/remote-mcp-config/json-mutate.ts`
**依赖：** 无
**步骤：**
1. 搬迁原 L301–L447：`getAtPath`、`getValueAtPath`、`setServerAtPath`、`removeServerAtPath`、`ensureInArray`、`removeFromArray` 六个纯函数
2. 六个函数全部加 `export`
3. 搬迁对应注释（含 `getAtPath`/`getValueAtPath` 区别说明）

**验证：** 纯函数，无依赖

---

## T4: status.ts

**文件：** `src/cli/commands/remote-mcp-config/status.ts`
**依赖：** T1（types）、T2（sftp）、T3（json-mutate）
**步骤：**
1. 搬迁原 L449–L631：`buildBridgeServer`、`compareServer`、`readStatus`、`checkExists` 四个函数
2. `import { BridgeServer, TargetFile, StatusResult, SERVER_KEY } from "./types.js"`
3. `import { sftpReadText } from "./sftp.js"`
4. `import { getAtPath, getValueAtPath } from "./json-mutate.js"`
5. `import { type SFTPWrapper } from "ssh2"`（readStatus/checkExists 入参）
6. 四个函数全部加 `export`

**验证：** 依赖 T1/T2/T3，引用符号与搬迁一致

---

## T5: target.ts

**文件：** `src/cli/commands/remote-mcp-config/target.ts`
**依赖：** T1（types）
**步骤：**
1. 搬迁原 L633–L779：`getRemoteHome`、`joinRemotePath`、`askTarget` 三个函数
2. `import { Target, McpClient, ClaudeScope, SERVER_KEY } from "./types.js"`
3. `import { select, isCancel, log, text } from "@clack/prompts"`
4. `import { Client } from "ssh2"`、`import { sshExec } from "../../shared/ssh.js"`
5. 三个函数全部加 `export`

**验证：** 仅依赖 types + 外部包 + shared

---

## T6: operations.ts

**文件：** `src/cli/commands/remote-mcp-config/operations.ts`
**依赖：** T1、T2、T3、T4、T5
**步骤：**
1. 搬迁原 L781–L1143：`resolveLocalEndpoint`、`mutateFile`、`doConfigure`、`doRemove`、`doCheckStatus` 五个函数
2. `import { type TargetFile } from "./types.js"`
3. `import { sftpBackup, sftpReadText, sftpWriteText } from "./sftp.js"`
4. `import { setServerAtPath, getValueAtPath, ensureInArray, removeServerAtPath, removeFromArray } from "./json-mutate.js"`
5. `import { buildBridgeServer, readStatus, checkExists } from "./status.js"`
6. `import { askTarget } from "./target.js"`
7. `import { select, isCancel, log, confirm } from "@clack/prompts"`
8. `import { Client, type SFTPWrapper } from "ssh2"`
9. `import { collectConnectionInfo } from "../../shared/cli-helpers.js"`
10. 五个函数全部加 `export`

**验证：** 依赖链完整，引用符号齐全

---

## T7: run.ts（remote）

**文件：** `src/cli/commands/remote-mcp-config/run.ts`
**依赖：** T1、T2、T6
**步骤：**
1. 搬迁原 L1145–L1287：`mainMenu`、`printBanner`、`runRemoteMcpConfig`
2. `import { MenuChoice, MENU_CONFIGURE, MENU_CHECK, MENU_REMOVE, MENU_EXIT, type RemoteMcpConfigOptions } from "./types.js"`
3. `import { doConfigure, doRemove, doCheckStatus } from "./operations.js"`
4. `import { openSftpSession, closeSftpSession } from "./sftp.js"`
5. `import { select, isCancel, log, text, password } from "@clack/prompts"`
6. `import { Client, type SFTPWrapper } from "ssh2"`
7. `import { parseServerAddress, sshConnect, sshDisconnect, type LinuxServerInfo } from "../../shared/ssh.js"`
8. `import { clearScreen, pauseForMenu } from "../../shared/cli-helpers.js"`
9. `mainMenu`/`printBanner` 保持本文件内部（不加 export）；`runRemoteMcpConfig` 加 `export`

**验证：** 入口函数导出，依赖齐全

---

## T8: index.ts（remote 门面）

**文件：** `src/cli/commands/remote-mcp-config/index.ts`
**依赖：** T7、T1
**步骤：**
1. 顶部写原单文件 L1–L22 的 `@file @brief` 大段说明（命令背景、对偶关系、三类落点表、SFTP 设计要点）
2. `export { runRemoteMcpConfig } from "./run.js"`
3. `export type { RemoteMcpConfigOptions } from "./types.js"`

**验证：** 门面仅暴露对外 API

---

## T9: 删除原 remote 单文件 + 编译验证

**文件：** 删除 `src/cli/commands/remote-mcp-config.ts`
**依赖：** T1–T8
**步骤：**
1. 确认目录 `remote-mcp-config/` 八个文件齐全
2. 删除原 `src/cli/commands/remote-mcp-config.ts`
3. 运行 `npm run build`

**验证：** `tsc` 编译通过，产出 `out/cli/commands/remote-mcp-config/index.js`；无「找不到模块」「重复标识符」错误

---

## T10: 搭建 sshd-config 目录骨架与 types.ts

**文件：** `src/cli/commands/sshd-config/types.ts`
**依赖：** 无
**步骤：**
1. 创建目录 `src/cli/commands/sshd-config/` 与 `src/cli/commands/sshd-config/steps/`
2. 搬迁原 L63–L168 全部类型/常量：`SshdConfigOptions`（export）、`CommandResult`、`OpenSshInstallInfo`、`OpenSshInstallMethod`、`CAPABILITY_SSHD_EXE`、`MSI_SSHD_EXE`、`MENU_*`（9 个）、`MenuChoice`、`OPENSSH_CAPABILITY_NAME`、`OPENSSH_MSI_URL`、`SSHD_CONFIG_PATH`、`LOCAL_PUBKEY_REL`、`LOCAL_MSI_REL`、`REMOTE_MCP_TEMPLATE_REL`、`SSHD_EXE_CANDIDATES`、`PUBKEY_LINE_RE`
3. 原本 module-private 的全部加 `export`
4. 顶部写 `@file` 文件头

**验证：** 叶子类型文件，无内部依赖

---

## T11: platform.ts

**文件：** `src/cli/commands/sshd-config/platform.ts`
**依赖：** 无
**步骤：**
1. 搬迁原 L170–L255：`isWindows`、`isAdmin`、`relaunchAsAdmin`
2. `import { execFileSync } from "child_process"`
3. 三个函数全部加 `export`

**验证：** 仅依赖外部包

---

## T12: exec.ts

**文件：** `src/cli/commands/sshd-config/exec.ts`
**依赖：** T10（types）
**步骤：**
1. 搬迁原 L257–L345：`execFileAsync`（const）、`execToResult`、`runPowerShell`、`runCmd`
2. `import { execFile } from "child_process"`、`import { promisify } from "util"`
3. `import { type CommandResult } from "./types.js"`
4. `execToResult`、`runPowerShell`、`runCmd` 全部加 `export`；`execFileAsync` 保持本文件内部（不加 export，仅本文件 execToResult 用）

**验证：** CommandResult 从 types 引入，无反向依赖

---

## T13: download.ts

**文件：** `src/cli/commands/sshd-config/download.ts`
**依赖：** 无
**步骤：**
1. 搬迁原 L353–L408：`downloadFile`
2. `import { createWriteStream, unlinkSync } from "fs"`、`import { get as httpsGet } from "https"`
3. `downloadFile` 加 `export`

**验证：** 自包含

---

## T14: sshd-service.ts

**文件：** `src/cli/commands/sshd-config/sshd-service.ts`
**依赖：** T10（types）、T12（exec）
**步骤：**
1. 搬迁原 L410–L600：`isSshdServiceRegistered`、`findSshdExe`、`detectOpenSshInstallMethod`、`ensureSshdService`
2. `import { type OpenSshInstallInfo, CAPABILITY_SSHD_EXE, MSI_SSHD_EXE, SSHD_EXE_CANDIDATES, OPENSSH_CAPABILITY_NAME } from "./types.js"`
3. `import { runPowerShell, runCmd } from "./exec.js"`
4. `import { existsSync } from "fs"`
5. `import { log } from "@clack/prompts"`（detectOpenSshInstallMethod 内 log.message）
6. 四个函数全部加 `export`

**验证：** 依赖 types + exec，符号齐全

---

## T15: sshd-config-edit.ts

**文件：** `src/cli/commands/sshd-config/sshd-config-edit.ts`
**依赖：** 无
**步骤：**
1. 搬迁原 L602–L698：`findActiveConfigLine`、`modifySshdConfig`
2. 无 import（纯字符串处理）
3. 两个函数全部加 `export`

**验证：** 纯函数

---

## T16: steps/install.ts

**文件：** `src/cli/commands/sshd-config/steps/install.ts`
**依赖：** T10、T12、T13、T14
**步骤：**
1. 搬迁原 L770–L896：`doInstallSsh`
2. `import { OPENSSH_CAPABILITY_NAME, OPENSSH_MSI_URL, LOCAL_MSI_REL, MENU_INSTALL_SSH } from "../types.js"`（按实际用到的常量引入，逐一核对）
3. `import { runPowerShell, runCmd } from "../exec.js"`
4. `import { downloadFile } from "../download.js"`
5. `import { isSshdServiceRegistered, ensureSshdService } from "../sshd-service.js"`
6. `import { existsSync, mkdirSync } from "fs"`、`import { resolve, dirname } from "path"`
7. `import { select, isCancel, log } from "@clack/prompts"`
8. `doInstallSsh` 加 `export`

**验证：** 常量符号逐一核对（仅引入函数体实际引用的）

---

## T17: steps/generate-key.ts

**文件：** `src/cli/commands/sshd-config/steps/generate-key.ts`
**依赖：** T10、shared/ssh、shared/cli-helpers
**步骤：**
1. 搬迁原 L910–L1057：`doGenerateKey`
2. `import { LOCAL_PUBKEY_REL } from "../types.js"`
3. `import { Client } from "ssh2"`
4. `import { parseServerAddress, sshConnect, sshExec, sshDownload, sshDisconnect, type LinuxServerInfo } from "../../../shared/ssh.js"`
5. `import { text, password, confirm, isCancel, log } from "@clack/prompts"`
6. `import { existsSync, mkdirSync } from "fs"`、`import { resolve, dirname } from "path"`
7. `doGenerateKey` 加 `export`

**验证：** shared 引用层级 `../../../` 正确

---

## T18: steps/config-sshd.ts

**文件：** `src/cli/commands/sshd-config/steps/config-sshd.ts`
**依赖：** T10、T12、T14、T15
**步骤：**
1. 搬迁原 L1072–L1198：`doConfigSshd`
2. `import { SSHD_CONFIG_PATH, LOCAL_PUBKEY_REL, MENU_GENERATE_KEY, MENU_INSTALL_SSH } from "../types.js"`（按实际引用核对）
3. `import { runPowerShell } from "../exec.js"`
4. `import { isSshdServiceRegistered } from "../sshd-service.js"`
5. `import { findActiveConfigLine, modifySshdConfig } from "../sshd-config-edit.js"`
6. `import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs"`
7. `import { resolve, join } from "path"`、`import { homedir } from "os"`
8. `import { log } from "@clack/prompts"`
9. `doConfigSshd` 加 `export`

**验证：** 符号核对齐全

---

## T19: steps/check-status.ts

**文件：** `src/cli/commands/sshd-config/steps/check-status.ts`
**依赖：** T10、T12、T14、T15
**步骤：**
1. 搬迁原 L1214–L1335：`doCheckStatus`
2. `import { SSHD_CONFIG_PATH, LOCAL_PUBKEY_REL, PUBKEY_LINE_RE, MENU_INSTALL_SSH, MENU_CONFIG_SSHD, MENU_GENERATE_KEY } from "../types.js"`（按实际引用核对）
3. `import { runPowerShell } from "../exec.js"`
4. `import { detectOpenSshInstallMethod } from "../sshd-service.js"`
5. `import { findActiveConfigLine } from "../sshd-config-edit.js"`
6. `import { existsSync, readFileSync } from "fs"`
7. `import { resolve, join } from "path"`、`import { homedir } from "os"`
8. `import { log } from "@clack/prompts"`
9. `doCheckStatus` 加 `export`

**验证：** 符号齐全

---

## T20: steps/uninstall.ts

**文件：** `src/cli/commands/sshd-config/steps/uninstall.ts`
**依赖：** T10、T12、T14、shared/cli-helpers
**步骤：**
1. 搬迁原 L1352–L1568：`doUninstallSsh` 及其专用工具 `openAppwizAndAwait`、`removeMcpPubKeyFromAuthorizedKeys`、`restoreSshdConfigFromBackup`
2. `import { LOCAL_PUBKEY_REL, OPENSSH_CAPABILITY_NAME, LOCAL_MSI_REL, SSHD_CONFIG_PATH } from "../types.js"`（按实际引用核对）
3. `import { runPowerShell, runCmd } from "../exec.js"`
4. `import { isSshdServiceRegistered, detectOpenSshInstallMethod } from "../sshd-service.js"`
5. `import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "fs"`
6. `import { resolve, join } from "path"`、`import { homedir } from "os"`
7. `import { log } from "@clack/prompts"`
8. `import { prompt } from "../../../shared/cli-helpers.js"`
9. 三个专用工具保持本文件内部（不加 export，仅 doUninstallSsh 用）；`doUninstallSsh` 加 `export`

**验证：** 专用工具内聚于本文件；shared 层级 `../../../`

---

## T21: steps/show-info.ts

**文件：** `src/cli/commands/sshd-config/steps/show-info.ts`
**依赖：** T10、shared/cli-helpers
**步骤：**
1. 搬迁原 L1585–L1623：`doShowConnectionInfo`
2. `import { MENU_INSTALL_SSH, MENU_GENERATE_KEY, MENU_CONFIG_SSHD } from "../types.js"`（按实际引用核对）
3. `import { collectConnectionInfo } from "../../../shared/cli-helpers.js"`
4. `import { log } from "@clack/prompts"`
5. `doShowConnectionInfo` 加 `export`

**验证：** 符号齐全

---

## T22: steps/gen-template.ts

**文件：** `src/cli/commands/sshd-config/steps/gen-template.ts`
**依赖：** T10、shared/cli-helpers
**步骤：**
1. 搬迁原 L1639–L1724：`doGenerateTemplate`
2. `import { REMOTE_MCP_TEMPLATE_REL, MENU_INSTALL_SSH, MENU_GENERATE_KEY, MENU_CONFIG_SSHD } from "../types.js"`（按实际引用核对）
3. `import { collectConnectionInfo } from "../../../shared/cli-helpers.js"`
4. `import { log, box } from "@clack/prompts"`
5. `import { existsSync, mkdirSync, writeFileSync } from "fs"`
6. `import { resolve, join, dirname } from "path"`
7. `doGenerateTemplate` 加 `export`

**验证：** 符号齐全

---

## T23: steps/one-click.ts

**文件：** `src/cli/commands/sshd-config/steps/one-click.ts`
**依赖：** T16、T17、T18、T22
**步骤：**
1. 搬迁原 L1736–L1758：`doOneClickFlow`
2. `import { doInstallSsh } from "./install.js"`
3. `import { doGenerateKey } from "./generate-key.js"`
4. `import { doConfigSshd } from "./config-sshd.js"`
5. `import { doGenerateTemplate } from "./gen-template.js"`
6. `import { log } from "@clack/prompts"`
7. `doOneClickFlow` 加 `export`

**验证：** 依赖同目录 4 个 step，无环

---

## T24: run.ts（sshd）

**文件：** `src/cli/commands/sshd-config/run.ts`
**依赖：** T10、T11、T16–T23
**步骤：**
1. 搬迁原 L700–L753（mainMenu）、L1768–L1772（printBanner）、L1780–L1844（runSshdConfig）
2. `import { MenuChoice, MENU_*, type SshdConfigOptions } from "./types.js"`（引入 switch 用到的全部 MENU_*）
3. `import { isWindows, isAdmin, relaunchAsAdmin } from "./platform.js"`
4. `import { doOneClickFlow } from "./steps/one-click.js"`
5. `import { doInstallSsh } from "./steps/install.js"`
6. `import { doGenerateKey } from "./steps/generate-key.js"`
7. `import { doConfigSshd } from "./steps/config-sshd.js"`
8. `import { doCheckStatus } from "./steps/check-status.js"`
9. `import { doUninstallSsh } from "./steps/uninstall.js"`
10. `import { doShowConnectionInfo } from "./steps/show-info.js"`
11. `import { doGenerateTemplate } from "./steps/gen-template.js"`
12. `import { select, isCancel } from "@clack/prompts"`
13. `import { clearScreen, pauseForMenu } from "../../shared/cli-helpers.js"`
14. `mainMenu`/`printBanner` 保持本文件内部；`runSshdConfig` 加 `export`

**验证：** 8 个 step 全部引入；switch 分支与原一致

---

## T25: index.ts（sshd 门面）

**文件：** `src/cli/commands/sshd-config/index.ts`
**依赖：** T24、T10
**步骤：**
1. 顶部写原单文件 L1–L20 的 `@file @brief` 大段说明（命令背景、菜单功能、SSH 复用说明）
2. `export { runSshdConfig } from "./run.js"`
3. `export type { SshdConfigOptions } from "./types.js"`

**验证：** 门面仅暴露对外 API

---

## T26: 删除原 sshd 单文件 + 编译验证

**文件：** 删除 `src/cli/commands/sshd-config.ts`
**依赖：** T10–T25
**步骤：**
1. 确认目录 `sshd-config/` 文件齐全（index + 7 辅助/steps 文件 + steps/ 8 文件 + run）
2. 删除原 `src/cli/commands/sshd-config.ts`
3. 运行 `npm run build`

**验证：** `tsc` 编译通过，产出 `out/cli/commands/sshd-config/index.js`；无错误

---

## T27: 格式检查与最终验证

**文件：** 全部新建文件
**依赖：** T9、T26
**步骤：**
1. 运行 `npm run format:check`
2. 若有格式问题，运行 `npm run format:fix` 后再次 `format:check`
3. 再次 `npm run build` 确认通过
4. 抽查产物：`out/cli/commands/remote-mcp-config/index.js`、`out/cli/commands/sshd-config/index.js` 存在

**验证：**
- `format:check` 通过
- `build` 通过
- 两个命令目录的 `index.js` 产物存在
- `src/cli/index.ts` 未被修改（git diff 确认）

---

## 执行顺序

```
remote-mcp-config 分支：
T1(types) → T2(sftp) ──┐
          → T3(json) ──┤
                       ├→ T4(status) ─┐
          T5(target) ──┤              ├→ T6(operations) → T7(run) → T8(index)
                       └──────────────┘                                    │
                                                                            ↓
                                                                   T9(删除+编译)

sshd-config 分支（可与 remote 并行，但建议串行避免上下文切换）：
T10(types) → T11(platform) ─┐
          → T12(exec) ───────┼→ T14(sshd-service) ─┐
          → T13(download) ───┤                      │
          → T15(config-edit)─┤                      │
                               │   ┌────────────────┘
                               ↓   ↓
          T16(install) ──────┐      
          T17(generate-key) ─┤      
          T18(config-sshd) ──┼→ T23(one-click) ─┐
          T19(check-status) ─┤                   │
          T20(uninstall) ────┤                   ├→ T24(run) → T25(index)
          T21(show-info) ────┤                   │
          T22(gen-template) ─┘ (T23 依赖)        │
                                                 ↓
                                          T26(删除+编译)
                                                 ↓
                                          T27(格式+最终验证)
```

总执行顺序：T1→T2→T3→T4→T5→T6→T7→T8→T9→T10→...→T25→T26→T27
