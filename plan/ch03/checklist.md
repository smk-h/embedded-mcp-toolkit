# 配置文件分文件化 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 布局判定与加载

- [ ] **AC1 分文件布局加载**：在 `.embedded/configs/devices/` 下放置 `board-a.yaml`、`board-b.yaml`，运行 `node ./bin/embedded-mcp-toolkit-cli.js config`（指向该配置目录），输出包含这两个设备；运行临时脚本调用 `listDevices()` 返回 `["board-a", "board-b"]`（验证：设备名集合 = 目录下 `.yaml` 文件名去扩展名）。
- [ ] **AC2 单文件布局回退**：移除/重命名 `devices/` 目录后，`listDevices()` 回退为读取单文件 `config.yaml` 的 `devices` 段，返回结果与重构前一致（验证：`node ./bin/embedded-mcp-toolkit-cli.js config -b board-a` 仍能输出该设备配置，日志出现 `Config layout: single`）。
- [ ] **AC3 布局自动判定优先级**：同时存在 `devices/board-a.yaml` 和 `config.yaml`（含 `devices.board-a`）时，以分文件布局为准；但主 `config.yaml` 的 `default` 字段仍生效（验证：修改 `default`，确认 `resolveDeviceName()` 返回该值；日志出现 `Config layout: split`）。
- [ ] 启动日志明确标明当前布局：分文件时输出 `Config layout: split`，单文件时输出 `Config layout: single`（验证：观察启动日志）。

## 配置拆分命令（split）

- [ ] **AC4 拆分完整性**：对含 `devices` 段（board-a / board-b / board-test 等）的旧 `config.yaml` 运行 `node ./bin/embedded-mcp-toolkit-cli.js split`，`devices/` 下为每个设备生成对应 `.yaml`（验证：文件数 = devices 段设备数；抽查 1~2 个设备文件，ssh/serial/adb/keyProvider 字段与原文件一致）。
- [ ] **AC5 覆盖保护**：目标 `devices/board-a.yaml` 已存在时，`split` 默认跳过并打印 `⏭  跳过（已存在）: board-a`；加 `--force` 后覆盖（验证：分两次运行，先默认后 `--force`，观察输出）。
- [ ] `split` 命令在 `devices` 段为空或不存在时，打印「无可拆分设备」并正常退出（验证：对只含 `default` 的 config.yaml 运行）。
- [ ] `split --help` 显示 `-c, --config` 和 `-f, --force` 选项及默认值（验证：运行 `node ./bin/embedded-mcp-toolkit-cli.js split --help`）。
- [ ] **split 输出风格（优化版）**：运行 `split` 时每个设备**只输出一行**状态（如 `✅ 创建: board-a`），**无** `[split] created/overwritten:` 重复日志行（验证：对比输出行数 = 设备数 + 头尾，无 stderr 重复）。
- [ ] **split 路径简短化**：头部源配置 / 设备目录显示为相对工作目录的简短形式（如 `./.embedded/configs/devices`），正斜杠统一，无 Windows 反斜杠混杂（验证：在 Windows 下运行 split，观察头部路径）。

## init 命令适配

- [ ] **AC6 init 生成分文件布局**：在临时空目录运行 `node ./bin/embedded-mcp-toolkit-cli.js init`，生成 `.embedded/configs/config.yaml`（仅含 `default` 字段）和 `.embedded/configs/devices/board-example.yaml`（示例设备文件）（验证：检查两个文件的内容）。
- [ ] init 生成的 `config.example.yaml` 不再含 `devices` 段，仅保留 `default` 和指向 `devices/` 目录的注释说明（验证：查看生成的 `config.example.yaml`）。
- [ ] `--help` 命令树中包含 `split` 命令（验证：`node ./bin/embedded-mcp-toolkit-cli.js --help` 输出含 `split`）。

## uninstall 清理

- [ ] `uninstall` 后 `.embedded/` 整目录被清除，`devices/` 子目录随之移除，无残留（验证：运行 `uninstall --force`，`ls .embedded` 应提示不存在）。

## 行为一致性

- [ ] **AC7 设备配置一致**：对同一台 `board-a`，单文件布局与分文件布局下 `getAllConfig("board-a")` 输出的 SSH / Serial / ADB / KeyProvider JSON 完全一致（验证：两种布局各运行一次 `config -b board-a`，diff 输出）。
- [ ] **AC8 DEVICE 环境变量**：设置 `DEVICE=board-b` 后，两种布局下 `resolveDeviceName()` 均返回 `"board-b"`（验证：`DEVICE=board-b node ./bin/embedded-mcp-toolkit-cli.js config`，输出 `Device: board-b`）。
- [ ] `BOARD_CONFIG_PATH` 环境变量仍能指定主配置路径，且 `devices/` 目录相对该路径所在目录解析（验证：设置 `BOARD_CONFIG_PATH` 指向自定义位置，在同级放 `devices/`，确认加载正确）。

## 编译与测试

- [ ] `npm run build` 成功且无 TypeScript 错误（验证：运行命令，观察无 `error TS`）。
- [ ] `out/` 下生成 `shared/config.js`、`cli/commands/split.js` 等对应产物（验证：`find out -name "*.js" | grep -E "config|split"`）。
- [ ] `npm run format:check` 通过（验证：运行命令，无格式错误）。
- [ ] `npm run eslint:fix` 无新增 lint 错误（验证：运行命令，无 `error`）。

## 打包与依赖

- [ ] **AC10 无新增依赖**：`git diff package.json` 的 `dependencies` / `devDependencies` 无新增条目（验证：查看 diff）。
- [ ] `npm run pack:dry-run` 打包清单包含新增的 `devices/board-example.yaml` 模板文件，且不含真实设备配置（验证：查看 dry-run 输出）。

## 端到端场景

### 场景 1：新用户从 init 到使用

1. 在临时空目录运行 `embedded-mcp-toolkit init`。
2. 期望生成 `config.yaml`（含 `default: board-example`）和 `devices/board-example.yaml`。
3. 编辑 `devices/board-example.yaml` 填入真实设备信息，运行 `embedded-mcp-toolkit config -b board-example`。
4. 期望正确输出该设备的 SSH / Serial 配置，证明分文件布局从 init 到加载全链路打通。

### 场景 2：老用户迁移

1. 准备一个旧的单文件 `config.yaml`（含多个设备的 `devices` 段）。
2. 运行 `embedded-mcp-toolkit split`。
3. 期望 `devices/` 下生成所有设备的独立文件，原 `config.yaml` 不被破坏。
4. 再次运行 `embedded-mcp-toolkit config -b <某设备>`，期望加载层自动识别分文件布局并正确解析。

### 场景 3：MCP server 在分文件布局下启动

1. 在已拆分为 `devices/*.yaml` 的配置环境下，启动 MCP server（`node ./bin/embedded-mcp-toolkit-cli.js`）。
2. 期望启动日志输出 `Config layout: split` 和 `Config loaded: <path>`。
3. 通过 MCP Inspector 调用 `device_info_tool` 或 `ssh_shell_login`，期望能正确解析当前 `DEVICE` 指向的设备配置，无配置加载报错。

## 非功能需求

- [ ] **AC9 加载性能**：MCP server 从分文件布局启动时，启动日志正常输出，无性能告警；单次加载保持在毫秒级（验证：观察启动耗时，对比单文件布局无明显退化）。
- [ ] 代码风格符合 `ts-lang-spec`：import 带 `.js` 后缀、JSDoc 注释（`@brief` / `@param`）、命名约定（验证：lint 通过 + 人工抽查 `split.ts` 和 `config.ts` 新增代码）。
- [ ] 配置加载层新增的内部函数（`loadSplitDevices` / `resolveDevicesDir`）不对外导出（验证：`grep "export" src/shared/config.ts` 不含这两个函数名）。
