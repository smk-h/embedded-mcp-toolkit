# 配置文件分文件化 Tasks

## 文件清单

| 操作 | 原文件 | 目标文件 | 说明 |
|------|--------|----------|------|
| 修改 | `src/shared/config.ts` | `src/shared/config.ts` | `loadConfig()` 增加布局判定与分文件加载 |
| 新建 | — | `src/cli/commands/split.ts` | 配置拆分命令实现 `runSplit`（纯 console.log 输出 + `shortPath` 辅助函数） |
| 修改 | `src/cli/index.ts` | `src/cli/index.ts` | 注册 `split` 命令 |
| 修改 | `src/cli/commands/init.ts` | `src/cli/commands/init.ts` | init 生成分文件布局模板 |
| 修改 | `config.example.yaml` | `config.example.yaml` | 移除 `devices` 段，仅保留 `default` + 注释 |
| 新建 | — | `.embedded/configs/devices/board-example.yaml` | init 示例设备文件（模板源） |
| 修改 | `package.json` | `package.json` | `files` 字段纳入新增的 devices 模板文件 |

## T1: 改造 loadConfig 支持分文件加载

**文件：** `src/shared/config.ts`
**依赖：** 无
**步骤：**
1. 在 `loadConfig()` 函数内，保留现有 `_cached` 缓存判定与「读取主配置文件」逻辑不变。
2. 新增内部辅助函数 `loadSplitDevices(devicesDir: string): Record<string, DeviceConfig> | null`：
   - 用 `existsSync` 判断 `devicesDir` 是否存在；不存在返回 `null`。
   - 用 `readdirSync` 列出目录，过滤出 `.yaml` / `.yml` 文件。
   - 文件列表为空返回 `null`（视为回退单文件布局）。
   - 逐文件 `readFileSync` + `load()` 解析，以文件名（去扩展名）作为设备名 key，组装为 `Record<string, DeviceConfig>`。
   - 单个文件解析失败时 `logger.warn` 并跳过该文件，不中断整体加载。
3. 新增内部辅助函数 `resolveDevicesDir(configPath: string): string`：返回 `resolve(dirname(resolve(configPath)), "devices")`。
4. 在 `loadConfig()` 读取主配置后，调用 `loadSplitDevices`：
   - 返回非 `null`（分文件布局）→ 用其结果覆盖主配置的 `devices` 字段，并 `logger.info` 标明 `Config layout: split`。
   - 返回 `null`（单文件布局）→ 沿用主配置原 `devices` 段，并 `logger.info` 标明 `Config layout: single`。
   - 主配置文件不存在/解析失败的兜底逻辑保持原样（`_cached = {}`）。
5. `RootConfig`、`DeviceConfig` 等类型定义不变。

**验证：** `npm run build` 编译通过；在 `devices/` 放置测试 `.yaml` 后调用 `listDevices()` 返回对应文件名集合（通过临时脚本或 `config` 命令验证）。

## T2: 验证单文件布局回退

**文件：** `src/shared/config.ts`
**依赖：** T1
**步骤：**
1. 确认 `devices/` 目录不存在或为空时，`loadSplitDevices` 返回 `null`。
2. 此时 `loadConfig()` 走单文件布局分支，读取主配置 `devices` 段。
3. 临时移除/重命名 `devices/` 目录，运行 `node ./bin/embedded-mcp-toolkit-cli.js config -b board-a`（指向含 devices 段的旧 config.yaml），确认仍能输出该设备配置。

**验证：** 单文件布局下 `listDevices()` 返回的设备列表与重构前一致；日志出现 `Config layout: single`。

## T3: 新建 split 命令实现

**文件：** `src/cli/commands/split.ts`
**依赖：** 无（独立模块）
**步骤：**
1. 定义导出接口 `SplitOptions`：`{ config: string; force: boolean }`。
2. 定义导出函数 `runSplit(opts: SplitOptions): void`，加 JSDoc（`@brief` / `@param` / `@details`），风格参照 `init.ts` 的 `runInit`。
3. 函数逻辑：
   - 用 `readFileSync` + `load()` 读取源 `config.yaml`，取 `devices` 段；为空则打印「无可拆分设备」并 `return`。
   - 计算 `devices/` 目录路径 = `join(dirname(resolve(opts.config)), "devices")`，用 `ensureDir`（或 `mkdirSync recursive`）创建。
   - 遍历 `devices` 的每个键（设备名），用 `dump(deviceConfig, { ... })` 序列化为 YAML 文本（`dump` 从 `js-yaml` 导入）。
   - 覆盖保护：目标路径已存在且 `!opts.force` → 计入「跳过」并打印 `⏭  跳过（已存在）: <设备名>`；否则写入并计入「创建」或「覆盖」。
   - 汇总输出：创建 / 覆盖 / 跳过的文件数量。
4. **输出风格（优化版）：**
   - 统一用 `console.log` 输出，**不引用 `logger`**（避免 `logger.info` 经 stderr 重复打印造成每个设备两行冗余）。
   - 逐设备状态行只打印**设备名**（如 `✅ 创建: board-a`），不打印绝对路径。
   - 新增辅助函数 `shortPath(absPath: string): string`，用 `path.relative` 转为相对工作目录的简短形式，并将 Windows 反斜杠统一为正斜杠；头部源配置 / 设备目录路径用它输出。
5. import 路径：`js-yaml` 的 `load` 和 `dump`、Node `fs`、`path`（含 `relative`）。

**验证：** `npm run build` 编译通过；准备一个含 `devices` 段的旧 `config.yaml`，运行拆分后 `devices/` 下生成对应文件，内容与原段一致。

## T4: 在 cli/index.ts 注册 split 命令

**文件：** `src/cli/index.ts`
**依赖：** T3
**步骤：**
1. 在文件顶部 import 区新增：`import { runSplit, type SplitOptions } from "./commands/split.js";`（参照第 14 行 `runInit` 的导入风格）。
2. 在 `uninstall` 命令注册块之后，新增 `split` 命令注册块，加与现有命令一致的 JSDoc 头注释：
   ```typescript
   program
     .command("split")
     .description("将单文件 config.yaml 的 devices 段拆分为 devices/*.yaml")
     .option("-c, --config <path>", "源 config.yaml 路径", "./.embedded/configs/config.yaml")
     .option("-f, --force", "覆盖已存在的设备文件", false)
     .action((opts) => {
       runSplit(opts);
     });
   ```
3. 更新文件头部命令树注释（第 20~28 行附近的 ASCII 命令树），把 `split` 加进去。

**验证：** `npm run build` 通过；`node ./bin/embedded-mcp-toolkit-cli.js --help` 输出包含 `split`；`node ./bin/embedded-mcp-toolkit-cli.js split --help` 显示选项。

## T5: 运行 split 迁移现有 config.yaml

**文件：** `.embedded/configs/config.yaml`、`.embedded/configs/devices/*.yaml`
**依赖：** T1、T2、T3、T4
**步骤：**
1. 先备份现有 `.embedded/configs/config.yaml`（如 `cp config.yaml config.yaml.bak`）。
2. 运行 `node ./bin/embedded-mcp-toolkit-cli.js split`（默认指向 `./.embedded/configs/config.yaml`）。
3. 检查 `devices/` 目录生成情况，确认每个设备（board-a / board-b / board-test 等）都有对应 `.yaml` 文件。
4. 抽查 1~2 个设备文件，核对 ssh/serial/adb/keyProvider 字段与原 `config.yaml` 完全一致。
5. 运行 `node ./bin/embedded-mcp-toolkit-cli.js config -b board-a`，确认分文件布局下能正确解析该设备。

**验证：** `devices/` 下文件数 = 原 `config.yaml` 中 `devices` 段设备数；设备配置字段无丢失；`config` 命令输出正确。split 运行时每个设备**只输出一行**（如 `✅ 创建: board-a`），无 `[split] created:` 重复日志；头部路径为简短相对形式（如 `./.embedded/configs/devices`）。

## T6: 适配 init 模板为分文件布局

**文件：** `config.example.yaml`、`.embedded/configs/devices/board-example.yaml`、`src/cli/commands/init.ts`
**依赖：** T1
**步骤：**
1. 编辑 `config.example.yaml`：移除其中的 `devices` 段，仅保留 `default: board-example` 和注释（注释说明设备配置位于同级 `devices/` 目录，每个 `.yaml` 文件一台设备）。
2. 新建 `.embedded/configs/devices/board-example.yaml`：内容为示例设备的完整自包含配置（ssh/serial/adb/keyProvider），作为 init 分发的示例模板源。在 `keyProvider` 字段处用注释标明 `challengeFilePath` / `keyFilePath` 是「相对运行 MCP server 时的 cwd」的路径，而非相对设备文件。
3. 编辑 `src/cli/commands/init.ts` 的「配置文件」任务组（约第 335~355 行）：
   - 保持复制 `config.example.yaml` 的任务不变（它现在只含 `default`）。
   - 新增一个 `file` 类型任务：`src: ".embedded/configs/devices/board-example.yaml"` → `dest: ".embedded/configs/devices/board-example.yaml"`。
   - `configYaml` 任务（生成 `config.yaml`）保持不变，仍从 `config.example.yaml` 拷贝。
4. 更新 init 收尾的文件清单输出（约第 429 行），在 `.embedded/configs/` 之外补充提示 `devices/` 示例文件。

**验证：** `npm run build` 通过；在临时空目录运行 `init`，确认生成 `config.yaml`（仅 `default`）和 `devices/board-example.yaml`。

## T7: 更新 uninstall 清理范围

**文件：** `src/cli/commands/init.ts`
**依赖：** T6
**步骤：**
1. 检查 `runUninstall` 的清理路径：当前 `cleanupPaths` 含 `.embedded`（整目录删除），已能覆盖 `devices/` 子目录。
2. 若 `.embedded` 整目录删除逻辑保持不变，则无需改动；仅需在 uninstall 的「即将删除」提示中确认 `.embedded/` 描述仍准确（已包含 devices）。
3. 若发现清理粒度需细化，则补充 `devices` 相关路径，但优先保持整目录删除的简单策略。

**验证：** 运行 `uninstall` 后 `.embedded/` 整目录被清除，`devices/` 随之移除，无残留。

## T8: 编译与构建验证

**文件：** 全项目
**依赖：** T1、T3、T4、T6
**步骤：**
1. 运行 `npm run build`，确认无 TypeScript 编译错误。
2. 运行 `npm run format:check`，确认无格式问题（必要时 `npm run format:fix`）。
3. 运行 `npm run eslint:fix`，确认无新增 lint 错误。

**验证：** 三项检查全部通过，无 `error` 输出。

## T9: 行为一致性验证

**文件：** 全项目
**依赖：** T1、T5
**步骤：**
1. 单文件布局下，运行 `config -b board-a`，记录输出 JSON。
2. 分文件布局下（split 后），运行 `config -b board-a`，记录输出 JSON。
3. 对比两次输出，确认 SSH / Serial / ADB / KeyProvider 字段完全一致。
4. 设置 `DEVICE=board-b` 后运行 `config`（不指定 -b），确认 `resolveDeviceName()` 返回 `board-b`。

**验证：** 两种布局下同一设备的 `getAllConfig` 输出一致；`DEVICE` 环境变量在两种布局下均生效。

## T10: package.json files 字段核查

**文件：** `package.json`
**依赖：** T6
**步骤：**
1. 检查 `package.json` 的 `files` 字段，确认新增的 `.embedded/configs/devices/board-example.yaml` 模板源会被 npm pack 纳入。
2. 若 `files` 字段以目录通配（如 `.embedded/configs/*`）覆盖，确认无需改动；否则显式追加 devices 路径。
3. 运行 `npm run pack:dry-run`，确认打包清单含 `devices/board-example.yaml`。

**验证：** `npm pack --dry-run` 输出包含新增的 devices 模板文件。

## 执行顺序

```
T1 → T2 ──┐
          ├─→ T5（迁移）→ T9（一致性）
T3 → T4 ──┘
T6 → T7 → T10
     ↓
T8（编译/格式/lint 总检，依赖 T1 T3 T4 T6）
```

说明：
- T1（加载层）和 T3（split 实现）相互独立，可并行。
- T2 依赖 T1，验证回退分支。
- T4 依赖 T3，注册命令。
- T5 依赖 T1~T4 全部就绪，执行真实迁移。
- T6（init 模板）依赖 T1 的加载逻辑，确保新布局可被识别。
- T7 依赖 T6，核查清理范围。
- T8 是总编译检查，依赖所有代码改动任务。
- T9 行为一致性依赖 T5 完成迁移。
- T10 依赖 T6 的新增模板文件。
