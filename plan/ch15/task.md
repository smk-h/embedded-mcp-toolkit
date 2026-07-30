# 远程 MCP 配置命令 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/shared/ssh.ts` | SSH 传输层：地址解析、连接、exec、上传/下载、断开 + LinuxServerInfo 类型 |
| 新建 | `src/cli/shared/cli-helpers.ts` | 终端交互辅助（prompt/clearScreen/pauseForMenu/askPassword）+ 连接信息采集 + ConnectionInfo/IpEntry 类型 |
| 修改 | `src/cli/commands/sshd-config.ts` | 改用 shared import，删除已抽出的 10 函数 + 3 类型（实现不变，机械替换） |
| 新建 | `src/cli/commands/remote-mcp-config.ts` | 远程 MCP 配置命令主体（本章核心） |
| 修改 | `src/cli/index.ts` | 注册 `remote-mcp-config` 命令 |

---

## T1: 新建 `src/cli/shared/ssh.ts`

**文件：** `src/cli/shared/ssh.ts`
**依赖：** 无
**步骤：**
1. 从 `sshd-config.ts` 迁移以下符号（实现逐字搬移，不改动逻辑）：
   - 类型 `LinuxServerInfo`（原 sshd-config.ts:64）
   - 函数 `parseServerAddress`（原 :397）
   - 函数 `sshConnect`（原 :528）
   - 函数 `sshExec`（原 :551）
   - 函数 `sshDownload`（原 :578）
   - 函数 `sshDisconnect`（原 :598）
2. 新增 `sshUpload(client, localPath, remotePath)`：基于 `sftp.fastPut` 实现，与现有 `sshDownload`（fastGet）对称，返回 `Promise<void>`，错误向上抛
3. 补全 import（`Client`/`ConnectConfig` from ssh2、child_process 相关保持 sshd-config 不变——注意 `sshConnect` 不依赖 child_process，仅依赖 ssh2）
4. 所有函数加 `export`
5. 文件头补 `@file`/`@brief` JSDoc（说明本文件是 SSH 传输层共享模块，供 sshd-config 与 remote-mcp-config 共用）

**验证：** `npx tsc --noEmit` 编译通过（此时 sshd-config.ts 尚未改 import，会因符号缺失报错属预期；本步仅验证 shared/ssh.ts 自身无语法/类型错误，用 `npx tsc --noEmit src/cli/shared/ssh.ts` 或临时注释 sshd-config 引用）

---

## T2: 新建 `src/cli/shared/cli-helpers.ts`

**文件：** `src/cli/shared/cli-helpers.ts`
**依赖：** 无
**步骤：**
1. 从 `sshd-config.ts` 迁移以下符号（实现逐字搬移）：
   - 类型 `IpEntry`（原 :1833）、`ConnectionInfo`（原 :1843）
   - 函数 `collectConnectionInfo`（原 :1855）
   - 函数 `prompt`（原 :263）、`clearScreen`（原 :281）、`pauseForMenu`（原 :295）、`askPassword`（原 :316）
2. 补全 import（readline、os 的 homedir/userInfo/networkInterfaces）
3. 所有函数与类型加 `export`
4. 文件头补 `@file`/`@brief` JSDoc

**验证：** `npx tsc --noEmit` 仅本文件无错误

---

## T3: 重构 `src/cli/commands/sshd-config.ts` 改用 shared

**文件：** `src/cli/commands/sshd-config.ts`
**依赖：** T1, T2
**步骤：**
1. 顶部新增 import：`import { parseServerAddress, sshConnect, sshExec, sshDownload, sshDisconnect, type LinuxServerInfo } from "../shared/ssh.js";` 与 `import { prompt, clearScreen, pauseForMenu, askPassword, collectConnectionInfo, type ConnectionInfo } from "../shared/cli-helpers.js";`（注意项目 ESM 用 `.js` 后缀）
2. 删除已迁出的函数/类型定义本体：`LinuxServerInfo`、`prompt`、`clearScreen`、`pauseForMenu`、`askPassword`、`parseServerAddress`、`sshConnect`、`sshExec`、`sshDownload`、`sshDisconnect`、`IpEntry`、`ConnectionInfo`、`collectConnectionInfo`（共 10 函数 + 3 类型）
3. 清理因迁出而失效的 import（如 ssh2 的 `Client`/`ConnectConfig` 若仅被 sshConnect 用，迁出后 sshd-config 本体仍用 `Client` 做类型注解则保留；readline 若仅 prompt 用则删除）
4. 更新文件头 `@file`/`@brief` 注释，说明 SSH/交互基础设施已迁至 shared
5. 全文确认 `LinuxServerInfo` 等符号的所有引用点（如 sshExec 12 处、sshConnect 3 处）均能通过 import 解析

**验证：** `npx tsc --noEmit` 全项目编译通过；`node ./bin/embedded-mcp-toolkit-cli.js sshd-config` 能进入主菜单（功能回归——本步只做位置迁移，行为必须不变）

---

## T4: 实现 SFTP 文件操作（remote-mcp-config C1）

**文件：** `src/cli/commands/remote-mcp-config.ts`（新建文件，先写此部分）
**依赖：** T1
**步骤：**
1. 创建文件，补 `@file`/`@brief` 头注释（说明本章命令职责）
2. 实现 `sftpReadText(client, remotePath): Promise<{exists:boolean; content?:string}>`：先 stat 探测文件是否存在（不存在返回 `{exists:false}`，不报错）；存在则读取全文（优先 `sftp.readFile`，不可用则 `fastGet` 到 tmp 文件后 readFileSync，注意清理 tmp）
3. 实现 `sftpEnsureDir(client, dirPath): Promise<void>`：逐级 stat + mkdir（SFTP mkdir 不递归）
4. 实现 `sftpWriteText(client, remotePath, content): Promise<void>`：先 `sftpEnsureDir(dirname)`，再写入（优先 `sftp.writeFile`，不可用则本地 tmp 文件 + `fastPut`）
5. 实现 `sftpBackup(client, remotePath): Promise<boolean>`：stat 探测原文件存在则读→写到 `.bak`（`.bak` 已存在跳过，返回 true=产生新备份；原文件不存在返回 false）

**验证：** `npx tsc --noEmit` 本文件编译通过（sftpReadText 等函数暂时未被调用，但签名须正确）

---

## T5: 实现 JSON path 操作纯函数（remote-mcp-config C2）

**文件：** `src/cli/commands/remote-mcp-config.ts`（追加）
**依赖：** 无（纯函数，不依赖 T4）
**步骤：**
1. 实现 `getAtPath(obj, path): Record<string,unknown> | null`：沿 path 逐层取键，任一层缺失返回 null
2. 实现 `setServerAtPath(obj, path, key, server)`：取/建 path 指向的容器对象，设置 `container[key]=server`（保留同容器其它 key）
3. 实现 `removeServerAtPath(obj, path, key): boolean`：path 存在且含 key 则 delete，返回是否实际删除
4. 实现 `ensureInArray(arr, value): boolean`：arr 中不含 value 则 push，返回是否新增
5. 实现 `removeFromArray(arr, value): boolean`：移除 value，返回是否移除

**验证：** 临时在文件底部加自测（构造样例 JSON 调用各函数并 console.log 结果，确认 get/set/remove/ensure 行为正确），验证后删除自测代码；或直接 `npx tsc --noEmit` 确认类型正确

---

## T6: 实现状态判定与 bridge 构造（remote-mcp-config C3）

**文件：** `src/cli/commands/remote-mcp-config.ts`（追加）
**依赖：** T2（collectConnectionInfo）、T5（getAtPath）
**步骤：**
1. 定义 `BridgeServer`/`ServerStatus`/`StatusResult` 类型与 `TargetFile`/`Target` 描述符类型、`McpClient`/`ClaudeScope`/菜单常量（`MENU_*`）
2. 实现 `buildBridgeServer(withTypeEnabled, sshUser, primaryIp, batPath): BridgeServer`：返回 `{command:"ssh", args:["-i","~/.ssh/id_mcp_server",`${sshUser}@${primaryIp}`,batPath], ...(withTypeEnabled?{type:"stdio",enabled:true}:{})}`
3. 实现 `compareServer(existing, bridge): "consistent"|"inconsistent"`：比较 `existing.command===bridge.command` 且 `JSON.stringify(existing.args)===JSON.stringify(bridge.args)`（仅比 command+args，F8）
4. 实现 `readStatus(client, file, bridge): Promise<StatusResult>`：`sftpReadText` → 不存在/无 serverPath → `absent`；存在则 parse → getAtPath → 无 key → `absent`；有 key → `compareServer` → `consistent`/`inconsistent`；parse 失败 → `error`（detail 含原因）

**验证：** `npx tsc --noEmit` 通过；手工核对 compareServer 对三种样例（一致/args 不同/无 command）的输出

---

## T7: 实现落点描述符与 askTarget（remote-mcp-config C4 前半）

**文件：** `src/cli/commands/remote-mcp-config.ts`（追加）
**依赖：** T6
**步骤：**
1. 实现远端 `~` 展开辅助：通过 `sshExec(client, "echo $HOME")` 取远端家目录，拼绝对路径
2. 实现 `askTarget(client): Promise<Target | null>`（F3 落点路由）：
   - `select`(client: claude/zcode)
   - claude → `select`(scope: 全局/项目)；项目 → `text`(项目绝对路径)
   - zcode → `text`(项目绝对路径)
   - 按选择组装 `Target`：
     - Claude 全局 → 1 个 file：`{remotePath: <HOME>/.claude.json, serverPath:["mcpServers"], withTypeEnabled:false}`
     - Claude 项目 → 2 个 file：`.mcp.json`（serverPath:["mcpServers"]）+ `.claude/settings.local.json`（enableArrayPath:["enabledMcpjsonServers"], enableValue:"embedded-board"）
     - ZCode 项目 → 1 个 file：`.zcode/config.json`（serverPath:["mcp","servers"], withTypeEnabled:true）
   - 拼接项目路径与相对子路径（`.mcp.json`/`.claude/settings.local.json`/`.zcode/config.json`）为远端绝对路径
   - clack 取消时返回 null

**验证：** `npx tsc --noEmit` 通过

---

## T8: 实现配置/删除/诊断 + 菜单 + 主入口（remote-mcp-config C4 后半 + C5）

**文件：** `src/cli/commands/remote-mcp-config.ts`（追加）
**依赖：** T4, T5, T6, T7
**步骤：**
1. 实现 `mainMenu(): Promise<MenuChoice|null>`（F2）：clack select 四项（配置/查看/删除/退出），Ctrl+C 返回 null
2. 实现 `doConfigure(client)`（F5）：
   - `askTarget` → `buildBridgeServer`（用 `collectConnectionInfo` 取 sshUser/primaryIp，batPath=cwd/remote-start-mcp.bat 转正斜杠；无可用 IP 则中止并提示，N6）
   - 对每个 TargetFile `readStatus` → 展示状态（F4）
   - `confirm` 确认配置
   - 对每个 file：`sftpBackup` → `sftpReadText`（不存在则当作 `{}`）→ JSON.parse → `setServerAtPath` +（若 enableArrayPath）`ensureInArray` → `JSON.stringify(json,null,2)+"\n"`（N4）→ `sftpWriteText`；写失败用 .bak 回滚（N3/N5）
   - 回显写入的文件路径与 command/args
   - 末尾提示"需重启对应 client 使配置生效"
3. 实现 `doRemove(client)`（F6）：同 doConfigure 结构，但 `removeServerAtPath` + `removeFromArray`；文件不存在/无该项 → 提示"无需删除"
4. 实现 `doCheckStatus(client)`（F7）：`askTarget` → 对每个 file `readStatus` 展示 → 汇总结论；纯只读不改文件
5. 实现 `printBanner()`
6. 实现 `runRemoteMcpConfig(opts)`（F1+F2 主入口）：
   - `text`(地址) → `parseServerAddress`（非法重输）→ `askPassword`
   - `sshConnect`（失败报错中止，不进菜单，F1）
   - 菜单循环：`clearScreen`+`printBanner`+`mainMenu`→switch(configure/check/remove/exit)→`pauseForMenu`
   - finally `sshDisconnect`
   - `void opts`
   - **不做**管理员检查（N6）

**验证：** `npx tsc --noEmit` 通过；`node ./bin/embedded-mcp-toolkit-cli.js remote-mcp-config` 能启动并出现地址输入框

---

## T9: 注册新命令到 `src/cli/index.ts`

**文件：** `src/cli/index.ts`
**依赖：** T8
**步骤：**
1. 顶部 import：`import { runRemoteMcpConfig } from "./commands/remote-mcp-config.js";`
2. 在 sshd-config 命令注册块之后，新增 commander 注册（参照 sshd-config 写法，含 `@brief`/`@par`/`@example` JSDoc）：
   ```typescript
   program
     .command("remote-mcp-config")
     .description("登录远程 Linux 配置 claude/zcode 的 MCP 桥接（交互式菜单）")
     .action(() => { runRemoteMcpConfig({}); });
   ```
3. 更新文件头命令层级结构注释，补充 `remote-mcp-config` 一行

**验证：** `npx tsc --noEmit` 全项目通过；`node ./bin/embedded-mcp-toolkit-cli.js --help` 输出含 `remote-mcp-config`

---

## 执行顺序

```
T1 (shared/ssh.ts) ─────┐
T2 (shared/cli-helpers)─┤
                        ├─→ T3 (重构 sshd-config) ──┐
                        │                           │
T5 (JSON path 纯函数)───┼──→ T6 (状态判定/bridge) ──┼──→ T8 (业务/菜单/入口) ──→ T9 (注册)
                        │         ↑                  │
T4 (SFTP 操作)──────────┘         T2(collectConn)    │
                                                      │
                          T7 (落点/askTarget)─────────┘
                               (依赖 T6)
```

- T1/T2/T5 可并行起步（均无依赖）
- T3 依赖 T1+T2，是回归验证关卡（sshd-config 行为不变）
- T4/T7 各依赖 T1/T6，互不阻塞
- T8 是集大成，依赖 T4–T7
- T9 收尾

> 集成验证（全部完成后）：针对真实 Linux 服务器跑通 plan.md 全部 F 需求与 checklist.md 验收项；此阶段在 task.md 之外，归 checklist.md 验收。
