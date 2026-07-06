# src/ 内部分层重组 Tasks

## 文件清单

| 操作 | 原文件 | 目标文件 | 说明 |
|------|--------|----------|------|
| 新建 | `src/index.ts` | `src/cli/index.ts` | 将 CLI 入口逻辑整体迁移 |
| 删除 | `src/index.ts` | — | 原 CLI 入口逻辑迁移后删除 |
| 移动 | `src/infra/config.ts` | `src/shared/config.ts` | 基础设施更名 |
| 移动 | `src/infra/constants.ts` | `src/shared/constants.ts` | 基础设施更名 |
| 移动 | `src/infra/file-logger.ts` | `src/shared/file-logger.ts` | 基础设施更名 |
| 移动 | `src/infra/logger.ts` | `src/shared/logger.ts` | 基础设施更名 |
| 移动 | `src/transport/adb.ts` | `src/transports/adb.ts` | transport 更名 |
| 移动 | `src/transport/loop.ts` | `src/transports/loop.ts` | transport 更名 |
| 移动 | `src/transport/output-buffer.ts` | `src/transports/output-buffer.ts` | transport 更名 |
| 移动 | `src/transport/powershell.ts` | `src/transports/powershell.ts` | transport 更名 |
| 移动 | `src/transport/serial.ts` | `src/transports/serial.ts` | transport 更名 |
| 移动 | `src/transport/ssh.ts` | `src/transports/ssh.ts` | transport 更名 |
| 移动 | `src/transport/psh.ts` | `src/services/psh.ts` | 业务状态机下沉 |
| 移动 | `src/transport/user-login.ts` | `src/services/user-login.ts` | 业务状态机下沉 |
| 移动 | `src/utils/key-provider.ts` | `src/services/key-provider.ts` | 业务服务下沉 |
| 修改 | `package.json` | `package.json` | `main` 字段改为 `out/cli/index.js` |
| 修改 | `bin/embedded-mcp-toolkit-cli.js` | `bin/embedded-mcp-toolkit-cli.js` | 加载路径改为 `out/cli/index.js` |
| 批量修改 | 所有 `src/**/*.ts` | 所有 `src/**/*.ts` | 同步更新相对 import 路径 |

## T1: 准备新目录结构

**文件：** 多个新目录
**依赖：** 无
**步骤：**
1. 在 `src/` 下创建 `cli/`、`services/`、`transports/`、`shared/` 四个目录（`mcp/` 和 `utils/` 已存在）。
2. 确认 `src/cli/commands/` 已存在（当前已有 `init.ts`）。

**验证：** 运行 `ls -la src/`，期望看到 `cli`、`mcp`、`services`、`transports`、`shared`、`utils` 六个顶层目录。

## T2: git mv 移动文件

**文件：** 见「文件清单」中所有“移动”行
**依赖：** T1
**步骤：**
1. 使用 `git mv` 将 `src/infra/*` 移动到 `src/shared/`。
2. 使用 `git mv` 将 `src/transport/{adb,loop,output-buffer,powershell,serial,ssh}.ts` 移动到 `src/transports/`。
3. 使用 `git mv` 将 `src/transport/{psh,user-login}.ts` 移动到 `src/services/`。
4. 使用 `git mv` 将 `src/utils/key-provider.ts` 移动到 `src/services/`。
5. 删除空目录 `src/infra` 和 `src/transport`。

**验证：** 运行 `git status --short`，期望看到大量 `R  src/... -> src/...` 记录，无 `D`/`A` 成对出现。

## T3: 迁移 CLI 入口

**文件：** `src/index.ts` → `src/cli/index.ts`
**依赖：** T2
**步骤：**
1. 使用 `git mv src/index.ts src/cli/index.ts`。
2. 打开 `src/cli/index.ts`，确认其中包含 Commander 命令注册、`startMcpServer` 调用、版本信息函数等 CLI 逻辑。
3. （可选）如果 `src/index.ts` 需要保留为转发文件，则新建 `src/index.ts` 并导出 `startMcpServer`；本计划选择完全删除，不保留转发。

**验证：** 运行 `ls src/cli/index.ts && git status --short | grep index.ts`，期望看到 `R  src/index.ts -> src/cli/index.ts`。

## T4: 更新 package.json 与 bin 入口

**文件：** `package.json`、`bin/embedded-mcp-toolkit-cli.js`
**依赖：** T3
**步骤：**
1. 修改 `package.json` 的 `main` 字段：`"main": "out/cli/index.js"`。
2. 修改 `bin/embedded-mcp-toolkit-cli.js` 中的 `outIndex` 变量，指向 `resolve(rootDir, 'out', 'cli', 'index.js')`。

**验证：** 使用 `grep` 或文本查看确认两处路径均已改为 `cli/index.js`。

## T5: 批量更新 import 路径

**文件：** 所有 `src/**/*.ts`
**依赖：** T2、T3
**步骤：**
1. 将 `../infra/` 批量替换为 `../shared/`（注意层级变化后的相对路径）。
2. 将 `../transport/` 批量替换为 `../transports/`。
3. 将引用 `../utils/key-provider.js` 的路径根据新位置改为 `../services/key-provider.js` 或 `../../services/key-provider.js`。
4. 将 `src/cli/index.ts` 中引用 `../package.json` 的路径保持为 `../package.json`（因为文件从 `src/` 移到 `src/cli/`，相对 package.json 的层级从 `../` 变为 `../../`；需要相应更新为 `../../package.json`）。
5. 将 `src/mcp/server.ts` 中引用 `../infra/logger.js` 改为 `../shared/logger.js`。
6. 将 `src/mcp/tools/*` 中引用 `../../../transport/...` 或 `../../../infra/...` 或 `../../../utils/...` 的路径按新层级更新（多数变为 `../../../transports/...`、`../../../shared/...`、`../../../services/...`）。

**验证：** 运行 `npm run build`，记录所有 TypeScript 编译错误并修复。

## T6: 编译修复

**文件：** 所有编译报错的 `src/**/*.ts`
**依赖：** T5
**步骤：**
1. 运行 `npm run build`。
2. 逐条修复 `Cannot find module` 或 `Cannot find module ... or its corresponding type declarations` 错误。
3. 重复步骤 1-2 直到 `npm run build` 无错误输出。

**验证：** `npm run build` 输出 `tsc` 成功，无 error。

## T7: 验证 CLI version 命令

**文件：** `bin/embedded-mcp-toolkit-cli.js`
**依赖：** T6
**步骤：**
1. 运行 `node ./bin/embedded-mcp-toolkit-cli.js version`。
2. 观察输出是否包含包名、版本号、依赖列表。

**验证：** 命令输出形如 `@smai-kit/embedded-mcp-toolkit: 0.1.3` 及后续依赖信息，无异常退出。

## T8: 验证 MCP server 启动

**文件：** `out/cli/index.js`、`out/mcp/server.js`
**依赖：** T6
**步骤：**
1. 运行 `node ./bin/embedded-mcp-toolkit-cli.js`。
2. 观察控制台是否输出 `MCP server starting... cwd: ...`。
3. 按 `Ctrl+C` 或用 `SIGTERM` 终止进程，观察是否执行清理并正常退出（exit code 0）。

**验证：** 进程启动无报错，终止时输出 `[mcp] SIGINT received, cleaning up...` 并退出。

## T9: 验证目录结构

**文件：** `src/`
**依赖：** T2
**步骤：**
1. 运行 `find src -maxdepth 2 -type d | sort`。
2. 核对是否仅有 `src/cli`、`src/mcp`、`src/services`、`src/transports`、`src/shared`、`src/utils` 六个业务顶层目录。
3. 确认 `src/infra` 和 `src/transport` 已不存在。

**验证：** 输出匹配 plan.md 中「文件组织」重组后的目录树。

## T10: 验证 Git 历史保留

**文件：** 所有被移动的文件
**依赖：** T2
**步骤：**
1. 运行 `git status --short`。
2. 确认所有被移动文件均显示为 `R`（renamed），而非成对的 `D` + `A`。
3. 任选 1-2 个文件运行 `git log --follow --oneline <新路径>`，确认能看到移动前的提交历史。

**验证：** `git status` 无 `D`/`A` 成对记录；`git log --follow` 能追溯到移动前历史。

## 执行顺序

```
T1 → T2 → T3 → T4
              ↓
T5 → T6 → T7 → T8
       ↓
    T9 → T10
```

说明：
- T1 和 T2 完成后，文件已在正确位置。
- T3 和 T4 可并行（互不影响），但建议 T3 在前，因为 T4 依赖 T3 中 `src/cli/index.ts` 的存在。
- T5 必须在 T2/T3 之后，因为路径更新依赖最终文件位置。
- T6 必须在 T5 之后。
- T7/T8 必须在 T6 之后。
- T9/T10 可在 T2 后随时执行，但建议在 T6 之后做最终确认。
