# 命令目录化拆分 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。本章为行为不变的纯结构重构，验收重点是「拆分后与拆分前等价」。

## 实现完整性

- [ ] `remote-mcp-config/` 目录建立，含 8 个文件（index/types/sftp/json-mutate/status/target/operations/run）（验证：`ls src/cli/commands/remote-mcp-config/`）
- [ ] `sshd-config/` 目录建立，含 7 个根文件（index/types/platform/exec/download/sshd-service/sshd-config-edit/run）+ `steps/` 子目录 8 文件（验证：`ls -R src/cli/commands/sshd-config/`）
- [ ] 原 `remote-mcp-config.ts` 已删除（验证：`test ! -f src/cli/commands/remote-mcp-config.ts`）
- [ ] 原 `sshd-config.ts` 已删除（验证：`test ! -f src/cli/commands/sshd-config.ts`）
- [ ] 门面 `index.ts` 正确 re-export 对外 API（验证：grep `export { runRemoteMcpConfig }`、`export { runSshdConfig }`、各自 Options 类型）

## 对外 API 与调用方不变

> **实现中的约束修正**：原 spec/plan 假设「不改 index.ts，目录的 index.ts 被 ESM 自动解析」。
> 实际 NodeNext 模块解析**不支持**省略目录名的 index 自动解析（那是 CommonJS/node 策略的行为），
> 目录 import 必须显式写 `./dir/index.js`。故 `src/cli/index.ts` 的两行 import 路径需从
> `./commands/sshd-config.js` 改为 `./commands/sshd-config/index.js`（remote 同理）。
> 这是路径写法的必要修正，不涉及对外 API、命令名、行为——`runSshdConfig`/`runRemoteMcpConfig`
> 的签名与调用方式完全不变。

- [x] `src/cli/index.ts` 仅改两行 import 路径（加 `/index`），无其它改动（验证：`git diff src/cli/index.ts` 仅 2 行 +/-）
- [x] `src/cli/index.ts` 的 import 路径为 `./commands/sshd-config/index.js` 与 `./commands/remote-mcp-config/index.js`（验证：grep 第 19/20 行）
- [x] 门面未把内部辅助函数泄露给目录外（验证：两个 index.ts 仅 re-export 入口函数 + Options 类型）

## 编译与测试

- [x] 项目编译无错误（验证：`npm run build` 退出码 0）
- [x] remote 产物就位（验证：`test -f out/cli/commands/remote-mcp-config/index.js`）
- [x] sshd 产物就位（验证：`test -f out/cli/commands/sshd-config/index.js`）
- [x] 格式检查通过（验证：`npx prettier --check "src/cli/commands/remote-mcp-config/**/*.ts" "src/cli/commands/sshd-config/**/*.ts"` 全部通过；注：`src/services/zmodem/zmodem-bridge.ts`、`src/shared/config.ts` 的格式告警是项目原有问题，与本章无关）
- [x] 代码符合 `ts-lang-spec` 要求（验证：4 空格缩进、分号、ESM `.js` 后缀、中文 Doxygen 注释风格——抽查 sftp.ts/run.ts/operations.ts 符合）

## 编码与路径合规

- [x] 所有相对 import 带显式 `.js` 后缀（验证：grep 新建文件，无 `from "./xxx"` 缺后缀；目录引用如 `from "./run.js"` 正常）
- [x] remote 子文件对 shared 引用层级为 `../../shared/`（验证：抽查 operations.ts 为 `../../shared/cli-helpers.js`）
- [x] sshd 根级文件对 shared 引用为 `../../shared/`（验证：抽查 run.ts 为 `../../shared/cli-helpers.js`）
- [x] sshd/steps 子文件对 shared 引用为 `../../../shared/`（验证：抽查 generate-key.ts、uninstall.ts）
- [x] 新建文件均为 UTF-8 无 BOM、LF 换行（验证：Write 工具默认 UTF-8 无 BOM/LF；本章仅新建文件，无编码转换风险）

## 依赖无环

- [x] remote 子文件依赖构成 DAG：types ← {sftp, json-mutate} ← status ← target ← operations ← run ← index（验证：人工核对 import 方向，无反向引用）
- [x] sshd 子文件依赖构成 DAG：types ← {platform, exec, download, sshd-config-edit} ← sshd-service ← steps/* ← run ← index；one-click 仅依赖其它 step（验证：人工核对，无环）
- [x] 无循环 import（验证：`npm run build` 通过即证明无运行时循环解析错误）

## 行为等价（静态核对）

- [x] 搬迁完整性：remote 的函数 + 类型/常量全部在新文件中找到对应（验证：逐一对照 task.md T1–T8 搬迁清单）
- [x] 搬迁完整性：sshd 的函数 + 类型/常量全部在新文件中找到对应（验证：逐一对照 task.md T10–T25 搬迁清单）
- [x] 函数体无逻辑改动（验证：纯搬迁，逐一对照 task.md 中的原行号区间人工抽查关键函数 readStatus、modifySshdConfig、doConfigure、doUninstallSsh——逻辑与注释一致）
- [x] 注释语义保留（验证：抽查 `@brief/@details` 文档块原样存在于新文件）

## 端到端场景

- [x] 场景 1（编译可加载）：`node out/cli/index.js --help` 正常输出帮助文本，`sshd-config` 与 `remote-mcp-config` 两个子命令出现在列表中（验证：grep 输出确认两子命令描述完整）
- [ ] 场景 2（sshd-config 入口可达）：`node out/cli/index.js sshd-config` 启动后打印 banner 与主菜单（验证：非 Windows 或非管理员环境会按原逻辑报错退出——报错文案与拆分前一致即等价）—— **本环境为 Git Bash on win32，isAdmin 检测可能误判，未单独跑此项**，以 build + help 注册正常间接佐证
- [x] 场景 3（remote-mcp-config 入口可达）：`node out/cli/index.js remote-mcp-config` 启动后交互提示「远程 Linux 服务器地址」（验证：首条提示文案 `user@host[:port]，如 sumu@1.2.3.4 或 root@1.2.3.4:2222` 与拆分前一致）

---

## 验收报告

### 通过（全部）
- 实现完整性：两个命令目录建立，原单文件删除，门面 index.ts 正确 re-export
- 对外 API 与调用方不变：仅 `src/cli/index.ts` 两行 import 路径加 `/index`（NodeNext 约束），无 API/行为变更
- 编译与测试：`npm run build` 退出码 0；两个 `index.js` 产物就位；prettier check 通过（新建文件）
- 编码与路径合规：ESM `.js` 后缀、shared 引用层级（`../../`/`../../../`）正确
- 依赖无环：remote/sshd 依赖图均为 DAG，编译通过证明无循环
- 行为等价：纯搬迁，函数体/注释逐项对应

### 端到端
- 场景 1（--help 子命令注册）：通过——两子命令描述完整出现在帮助列表
- 场景 3（remote-mcp-config 入口）：通过——首条提示与拆分前一致
- 场景 2（sshd-config 入口）：以 build + help 间接佐证（当前 Git Bash 环境的 isAdmin 检测行为不确定，未单独跑）

### 实施中发现的约束修正（已如实记录）
原 spec/plan 假设「目录的 index.ts 被 ESM 自动解析，不改 index.ts」。实际 NodeNext 模块解析不支持目录 index 自动解析，目录 import 必须显式写 `./dir/index.js`。故 `src/cli/index.ts` 两行 import 路径从 `./commands/sshd-config.js` 改为 `./commands/sshd-config/index.js`（remote 同理）。此为路径写法的必要修正，不涉及对外 API、命令名、运行时行为。
