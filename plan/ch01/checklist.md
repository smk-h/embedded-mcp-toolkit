# src/ 内部分层重组 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 目录结构

- [ ] `src/` 下存在 `cli/`、`mcp/`、`services/`、`transports/`、`shared/`、`utils/` 六个顶层目录（验证：`find src -maxdepth 1 -type d | sort`）。
- [ ] `src/infra/` 已不存在（验证：`ls src/infra` 应提示无此目录）。
- [ ] `src/transport/` 已不存在（验证：`ls src/transport` 应提示无此目录）。
- [ ] `src/services/` 中包含 `psh.ts`、`user-login.ts`、`key-provider.ts`（验证：`ls src/services`）。
- [ ] `src/transports/` 中不包含 `psh.ts`、`user-login.ts`、`key-provider.ts`（验证：`ls src/transports`）。
- [ ] `src/shared/` 中包含 `config.ts`、`constants.ts`、`file-logger.ts`、`logger.ts`（验证：`ls src/shared`）。

## CLI 入口

- [ ] `src/cli/index.ts` 存在且包含 Commander 命令注册逻辑（验证：`grep -n "new Command" src/cli/index.ts`）。
- [ ] `package.json` 的 `main` 字段指向 `out/cli/index.js`（验证：`grep '"main"' package.json`）。
- [ ] `bin/embedded-mcp-toolkit-cli.js` 加载路径为 `out/cli/index.js`（验证：`grep "out.*index.js" bin/embedded-mcp-toolkit-cli.js`）。

## 编译与构建

- [ ] `npm run build` 成功且无 TypeScript 错误（验证：运行命令，观察输出无 `error TS`）。
- [ ] `out/` 下生成 `cli/index.js`、`mcp/server.js`、`shared/*.js`、`transports/*.js`、`services/*.js` 等对应产物（验证：`find out -name "*.js" | sort`）。
- [ ] `npm run format:check` 通过，或至少确认没有因移动文件导致的格式破坏（验证：运行命令，无新增格式错误）。
- [ ] `npm run eslint:fix` 不引入新的 lint 错误（验证：运行命令，无新增 `error`）。

## 行为验证

- [ ] `node ./bin/embedded-mcp-toolkit-cli.js version` 正常输出包名、版本号、依赖列表（验证：运行命令，观察输出并确认退出码为 0）。
- [ ] `node ./bin/embedded-mcp-toolkit-cli.js` 能启动 MCP server 并输出 `MCP server starting...`（验证：运行命令 2 秒后发送 `SIGTERM`，观察启动日志）。
- [ ] MCP server 进程终止时执行会话清理并正常退出（验证：终止时输出 `[mcp] ... cleaning up...` 且退出码为 0）。

## 集成检查

- [ ] `src/mcp/tools/serial/shell.ts` 能正确引用 `src/transports/serial.js`（验证：编译通过且运行 `serial_open` 工具不报错）。
- [ ] `src/mcp/tools/ssh/shell.ts` 能正确引用 `src/transports/ssh.js`（验证：编译通过且运行 `ssh_shell_login` 工具不报错）。
- [ ] `src/transports/serial.ts` 能正确引用 `src/services/psh.js` 和 `src/services/key-provider.js`（验证：编译通过）。
- [ ] `src/transports/ssh.ts` 能正确引用 `src/services/psh.js` 和 `src/services/key-provider.js`（验证：编译通过）。
- [ ] `src/mcp/server.ts` 能正确引用 `src/shared/logger.js`（验证：编译通过且启动日志正常输出）。

## Git 历史

- [ ] 所有被移动文件在 `git status --short` 中显示为 `R`（renamed），无成对 `D`/`A`（验证：运行 `git status --short` 并人工检查）。
- [ ] 至少抽查一个移动后的文件保留历史（验证：`git log --follow --oneline src/services/psh.ts` 能追溯到移动前记录）。

## 端到端场景

### 场景 1：CLI 入口可用

1. 执行 `node ./bin/embedded-mcp-toolkit-cli.js --help`。
2. 期望输出包含 `embedded-mcp-toolkit`、子命令列表（`mcp`、`init`、`config`、`demo` 等）及 `--version` 选项。

### 场景 2：MCP server 启动并响应工具列表

1. 执行 `node ./bin/embedded-mcp-toolkit-cli.js`。
2. 通过标准输入发送 MCP `initialize` 请求（或使用 MCP Inspector）。
3. 期望 server 返回初始化响应，且 `tools/list` 包含 `version_tool`、`device_info_tool`、`serial_open`、`ssh_shell_login` 等工具。

### 场景 3：串口/SSH 工具链未因目录重构断裂

1. 在已有设备配置环境下，调用 `device_info_tool` 获取设备信息。
2. 调用 `ssh_shell_login` 登录默认设备（或 `serial_shell_login`）。
3. 期望登录成功并返回 session_id，证明 `services/` 与 `transports/` 的引用关系正确。

## 非功能需求

- [ ] 未引入新的 `dependencies` 或 `devDependencies`（验证：`git diff package.json` 无新增依赖条目）。
- [ ] 未修改现有工具对外行为（验证：对比重构前后 `version` 输出一致，工具列表一致）。
- [ ] 原有注释未被精简或删除（验证：抽查 `src/transports/serial.ts` 和 `src/services/psh.ts`，注释数量与内容未明显减少）。
