# src/ 内部分层重组 Spec

## 背景

`embedded-mcp-toolkit` 是一个基于 MCP 协议的嵌入式板卡远程管理服务器，源码集中在 `src/` 目录下。当前 `src/` 内部分为 `cli/`、`infra/`、`mcp/`、`transport/`、`utils/` 几个顶层目录，但随着功能扩展，以下问题逐渐显现：

- `transport/` 目录职责混杂：既包含 SSH、Serial、ADB 等真正的连接实现，也包含 PSH 解锁状态机、用户登录状态机、交互式终端循环等偏业务/协议的代码。
- `infra/` 命名偏技术黑话，新成员难以一眼判断里面放的是配置、日志还是通用基础设施。
- `src/index.ts` 同时承担 CLI 命令路由和 MCP 服务器启动入口，随着命令增多会越来越臃肿。
- `utils/` 中混入 `key-provider.ts` 这类与业务强相关的模块，与纯工具函数并列不够清晰。

因此需要对 `src/` 内部进行一次分层重组，让目录结构本身成为文档，降低后续维护成本。

## 目标

- 让每个 `src/` 子目录的职责单一、命名自解释。
- 将“连接实现”与“业务协议/状态机”分离。
- 将 CLI 入口从顶层 `index.ts` 下沉到独立的 `cli/` 模块。
- 保持现有 MCP tools 按领域（adb/basic/serial/ssh/win）分组的好习惯。
- 本次重构只移动/重命名文件，不修改工具对外行为。

## 功能需求

- F1: 提供清晰的 `src/` 顶层分层：`cli/`（命令行）、`mcp/`（MCP 协议与 tools）、`services/`（业务服务与状态机）、`transports/`（连接实现）、`shared/`（通用基础设施）、`utils/`（纯工具函数）。
- F2: `cli/` 目录独立承载所有命令行相关逻辑，包括顶层命令注册、`init` 命令、演示命令等。
- F3: `transports/` 目录只保留与“建立并维护连接/会话”直接相关的实现，如 SSH Shell、Serial Shell、ADB Shell、本地 PowerShell、输出缓冲区等。
- F4: `services/` 目录承载业务层协议与状态机，包括 PSH 解锁状态机、串口用户登录状态机、KeyProvider 密钥管理等。
- F5: `shared/` 目录承载跨模块的通用基础设施，包括配置加载、日志、常量等。
- F6: 所有文件移动后，原引用路径必须同步更新，项目仍能正常编译与启动。
- F7: 保持现有 MCP tools 的分组方式与对外工具名称不变，确保外部调用方（Claude Code / OpenCode）无需修改配置。

## 非功能需求

- N1: 本次改动为纯结构重构，不引入新依赖，不修改现有工具行为。
- N2: 代码风格、注释密度、命名习惯与 surrounding code 保持一致。
- N3: 重构后 `npm run build` 与 `npm start` 仍能正常工作。
- N4: 所有移动后的文件保留其原始 Git 历史（通过 `git mv` 实现）。
- N5: 目录命名使用小写+连字符风格，与现有 `src/` 目录保持一致。

## 不做的事

- 不改动根目录下 `.claude/`、`.cnb/`、`.embedded/`、`.opencode/`、`.vscode/` 等 AI/IDE/CI 配置的位置。
- 不改动 `client/`、`test/`、`docs/`、`scripts/`、`bin/` 等根目录模块（这些属于另一轮重构范围）。
- 不拆分 `mcp/tools/*/*/shell.ts` 等大型文件（仅移动目录，内部逻辑保持原样）。
- 不引入单元测试框架或新增自动化测试用例。
- 不修改 `out/` 的生成逻辑或 `.gitignore` 策略。

## 验收标准

- AC1: `src/` 下出现 `cli/`、`mcp/`、`services/`、`transports/`、`shared/`、`utils/` 六个顶层目录，且每个目录的职责与 spec 中定义一致。
- AC2: 原 `src/index.ts` 中的 CLI 命令注册逻辑迁移到 `src/cli/index.ts`，原文件不再承担 CLI 入口职责或仅做转发。
- AC3: `npm run build` 编译通过，无 TypeScript 错误。
- AC4: `node ./bin/embedded-mcp-toolkit-cli.js version` 能正常输出版本信息。
- AC5: MCP server 能正常启动（`node ./bin/embedded-mcp-toolkit-cli.js` 不报错退出）。
- AC6: 通过 `git status` 检查，所有被移动的文件均显示为 `renamed`（即保留 Git 历史）。
