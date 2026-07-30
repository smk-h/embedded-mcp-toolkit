# 命令目录化拆分 Spec

## 背景

随着 ch14（`sshd-config`）与 ch15（`remote-mcp-config`）两个对偶命令的实现完成，这两个命令的源文件已经显著膨胀：

- `src/cli/commands/sshd-config.ts`：约 1845 行，含 8 个菜单 step 函数 + 平台/权限、命令执行、HTTP 下载、sshd 服务检测、sshd_config 文本编辑、卸载辅助等多组工具层
- `src/cli/commands/remote-mcp-config.ts`：约 1288 行，含 5 个章节（C1 SFTP 文件操作 / C2 JSON path 操作 / C3 状态判定 / C4 落点路由与业务流程 / C5 主菜单与入口）

两个文件虽然内部都已用 `// ===...` 章节标记做了清晰的分段，但作为单文件仍过长，定位、阅读、改动成本高。命令的其余实现（`init.ts`、`split.ts`、`regex-verify.ts`）规模适中，本期不动。

本章对这两个文件做**纯结构拆分**：各自建一个命令目录，内部按现有章节边界拆为多个聚焦的小文件，目录下一个 `index.ts` 作为对外导出门面。对外 API（`runSshdConfig` / `runRemoteMcpConfig` 及其 Options 类型）签名与行为完全不变，上层 `src/cli/index.ts` 无需改动。

## 目标

- 把两个超长命令文件各自拆成一个命令目录，内部按子领域/按 step 拆分为多个聚焦文件，单文件控制在合理规模
- 每个目录提供一个 `index.ts` 门面，re-export 对外 API，使上层调用方（`src/cli/index.ts`）的 import 路径与用法不变
- 拆分是纯搬运重构：不改业务逻辑、不改命名、不改交互行为、不改对外 API、不改注释语义
- 拆分后编译、类型检查、格式检查全部通过，运行时行为与拆分前完全一致

## 功能需求

### F1：建立 `remote-mcp-config` 命令目录

在 `src/cli/commands/remote-mcp-config/` 下建立命令目录，把原单文件内容按现有 C1–C5 章节边界拆为多个文件。门面 `index.ts` 导出 `runRemoteMcpConfig` 与 `RemoteMcpConfigOptions`，供上层按原路径 `./commands/remote-mcp-config.js` 导入。

### F2：建立 `sshd-config` 命令目录

在 `src/cli/commands/sshd-config/` 下建立命令目录，把原单文件内容按辅助层 + step 边界拆为多个文件，8 个菜单 step 各自独立成文件（收纳于 `steps/` 子目录）。门面 `index.ts` 导出 `runSshdConfig` 与 `SshdConfigOptions`，供上层按原路径 `./commands/sshd-config.js` 导入。

### F3：保持对外 API 与调用方不变

两个命令对外暴露的入口函数签名、Options 类型、命令行为、菜单文案、日志输出、错误提示全部保持原样。上层 `src/cli/index.ts` 的 `.action()` 回调不做改动；import 路径因 NodeNext 约束需从 `./commands/<cmd>.js` 改为 `./commands/<cmd>/index.js`（NodeNext 不支持目录 index 自动解析），这是路径写法的必要修正，不涉及 API、命令名、行为。

### F4：保持原文件头说明

原单文件顶部的 `@file @brief` 大段说明（命令背景、对偶关系、落点表、设计要点）迁移到各自 `index.ts` 顶部，作为命令的整体说明保留；各子文件用简短一行 `@file` 说明本文件职责。

## 非功能需求

### N1：依赖关系无环

拆分后各子文件之间的依赖必须构成合法的有向无环图（types 层 ← 纯工具层 ← 业务层 ← 入口层）。不允许出现循环引用。

### N2：可见性最小化

原模块内私有函数搬到子文件后，为跨文件互调需加 `export`，但这种 export 仅在命令目录内部使用。门面 `index.ts` 只 re-export 对外 API（入口函数 + Options 类型），不把内部辅助函数泄露给命令目录之外。

### N3：ESM 路径合规

项目为 NodeNext ESM，所有相对 import 必须带显式 `.js` 后缀；对 `shared/` 的引用层级多一级（如 `../../shared/ssh.js`）。拆分后必须通过 `tsc` 编译，无路径解析错误。

### N4：编码规范不变

新建文件遵循项目既有约定（UTF-8 无 LF、4 空格缩进、分号、ESM `.js` 后缀、中文 Doxygen 风格注释）；通过 `tsc` 编译与 `prettier --check` 格式检查。

### N5：行为完全等价

拆分前后，两个命令的运行时行为逐字一致——菜单、提示、文件读写、状态判定、备份回滚、错误处理路径全部不变。无任何逻辑修改。

## 不做的事

- 不合并/不抽取两个命令之间的共性（如 SFTP 读写、JSON path 操作、地址解析）到 `shared/`——本期只做单文件→目录的搬运，不引入新的跨命令抽象（避免范围蔓延与潜在行为变更）
- 不调整菜单项、不改文案、不改提示语、不改日志措辞
- 不重构 `init.ts` / `split.ts` / `regex-verify.ts`（规模适中，无拆分必要）
- 不修改 `src/cli/shared/ssh.ts`、`cli-helpers.ts` 的任何内容
- 不新增测试（项目无现成测试体系；以编译 + 格式检查 + 运行时等价作为验证）
- 不改变对外命令名、不改 `package.json` 的 `cmd:*` 脚本

## 验收标准

### AC1：目录与文件就位
- `src/cli/commands/remote-mcp-config/` 目录建立，含 `index.ts` 及按章节拆出的若干子文件；原 `src/cli/commands/remote-mcp-config.ts` 已删除
- `src/cli/commands/sshd-config/` 目录建立，含 `index.ts`、按层拆出的若干辅助文件、`steps/` 子目录（内含 8 个 step 文件）；原 `src/cli/commands/sshd-config.ts` 已删除

### AC2：对外 API 不变
- 门面 `index.ts` 正确 re-export `runSshdConfig` / `SshdConfigOptions` 与 `runRemoteMcpConfig` / `RemoteMcpConfigOptions`
- `src/cli/index.ts` 仅因 NodeNext 约束修正两行 import 路径（`./commands/<cmd>.js` → `./commands/<cmd>/index.js`），无 API/行为变更

### AC3：编译与格式通过
- `npm run build`（`tsc`）编译无错误，产出 `out/cli/commands/<cmd>/index.js` 等产物
- `npm run format:check`（prettier）通过；必要时 `format:fix` 后再次 check 通过

### AC4：行为等价（静态核对）
- 拆分后各函数体、注释、常量、类型定义与原单文件逐项对应，无逻辑改动（人工核对搬迁完整性）

### AC5：依赖无环
- 各子文件依赖关系构成 DAG，无循环引用（依赖方向：types → 工具层 → 业务层 → 入口）
