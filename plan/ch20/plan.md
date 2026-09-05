# 设备列表命令（dev list）Plan

## 架构概览

在 ch19 建立的 `dev` 父命令下新增 `list` 子命令。两个组件，每个一句话：

- **列表引擎**（`src/cli/commands/dev/list.ts`，新增）：扫描 devices/ 目录 → 逐文件解析 yaml 并按禁用约定判定三通道状态 → 读取 config.yaml 的 `default` 字段 → 对齐表格输出（含模板/默认标注与坏文件告警）。
- **命令注册**（`src/cli/index.ts`，修改）：在 `devCommand` 上挂载 `list` 子命令，更新头部命令树注释。

改造面收敛为一处新增文件 + `src/cli/index.ts` 的一处子命令注册，不触碰 sdk 与 MCP server（满足 N3）。

### 需求映射

| spec 需求 | 归属 |
|---|---|
| F1 命令注册 | 模块 B（`devCommand` 注册段） |
| F2 目录扫描与空目录引导 | 模块 A `scanDevices()` |
| F3 通道状态判定 | 模块 A `isDisabled()` + 状态判定 |
| F4/F5 标注 | 模块 A `resolveDefaultDevice()` / `renderList()` |
| F6 坏文件告警 | 模块 A `scanDevices()`（invalidFiles 收集） |
| F7 输出结构 | 模块 A `renderList()` |
| N1 只读 | 全程只有 `readFileSync`/`readdirSync`，无任何写接口 |

## 核心数据结构

### DeviceRow（单台设备的列表行）

```ts
interface DeviceRow {
  name: string;   // 设备名（文件名去 .yaml/.yml 扩展名）
  serial: string; // SERIAL 列展示文本："端口@波特率"（如 COM3@115200），禁用为 "-"
  ssh: string;    // SSH 列展示文本："用户名@主机"（如 root@10.0.0.2），禁用为 "-"
  adb: string;    // ADB 列展示文本：序列号（如 sn_123456），禁用为 "-"
}
```

### ScanResult（扫描结果）

```ts
interface ScanResult {
  rows: DeviceRow[]; // 按设备名字典序排列
  invalidFiles: { file: string; reason: string }[]; // 解析失败的文件（F6 告警来源）
}
```

### 对外接口

```ts
export function runList(): void; // 模块 A 唯一导出，模块 B 调用
```

## 模块设计

### 模块 A：列表引擎 `src/cli/commands/dev/list.ts`（新增）

**职责：** 扫描、解析、状态判定、标注与表格输出（spec F2-F7）。

**常量：**

```ts
const DEVICES_DIR = ".embedded/configs/devices"; // 与 dev create 的约定一致
const CONFIG_PATH = ".embedded/configs/config.yaml"; // 读取 default 字段
const TEMPLATE_DEVICE_NAME = "board-example";
```

**内部函数：**

- `isDisabled(value: unknown, offValues: string[]): boolean` — 值为 `undefined`/`null`/空串，或 `String(value)` 命中 `offValues` 之一则视为禁用。串口/SSH 传 `["none"]`，ADB 传 `["sn_none"]`；`serial`/`ssh`/`adb` 段整体缺失时对应字段取值即 `undefined`，天然归入禁用（spec F3）。`hasValue(value)` 为其反义便捷封装（`!isDisabled(value, [])`），用于可选的波特率/用户名展示。
- `formatSerial(cfg)` / `formatSsh(cfg)` / `formatAdb(cfg): string` — 按三列展示规则生成单元格文本（spec F3）：
  - 串口：port 禁用 → `-`；否则 `port` +（baudRate 存在时 `@baudRate`）；
  - SSH：host 禁用 → `-`；否则（username 存在时 `username@`）+ `host`；
  - ADB：serialNo 禁用 → `-`；否则原样展示。
- `scanDevices(devicesDir: string): ScanResult` — `readdirSync` 后仅取 `.yaml`/`.yml` 文件；逐个 `js-yaml load()` 解析为 `Record<string, unknown>`，解析失败计入 `invalidFiles` 并跳过（对齐 sdk `loadSplitDevices` 的容错约定）；成功则经 format 系列生成 `DeviceRow`；最终按设备名字典序 `sort()`。
- `resolveDefaultDevice(configPath: string): string | null` — config.yaml 存在且根层 `default` 为非空字符串时返回之，否则返回 `null`（不抛错，spec F5）。
- `displayWidth(text)` / `padEndByWidth(text, width)` — 终端显示宽度计算与右填充：东亚全宽字符（如"模板"）按 2 列计；`String.padEnd` 按字符数填充，含中文的列会视觉错位，故四列均改用宽度感知填充。
- `renderList(result: ScanResult, defaultDevice: string | null): void` — 表格输出：
  - NAME 列内容 = 设备名 + 标注（`board-example` 追加 `(模板)`；与 `defaultDevice` 一致者追加 `(默认)`）；
  - 四列宽度均按 `displayWidth` 自适应（max(表头, 各单元格)），列间 2 空格分隔；
  - 依次输出：banner（`📋 embedded-mcp-toolkit 设备列表` + 设备目录路径）、表头、设备行、空行、`共 N 台设备`、图例行（`- 表示通道禁用/未配置`）、告警行（每个坏文件一条 `⚠️ 跳过无效配置: <file> — <reason>`）。
- `logCommand(cmd: string, opts: object): void` — 文件内私有，与 `create`/`split` 的同名助手逐字同风格（N2）。

**主流程 `runList()`：**

1. `logCommand("list", {})` + banner 打印。
2. `existsSync(DEVICES_DIR)` 为假 → 打印「设备目录不存在，可先运行 dev create 创建」并 return（F2）。
3. `scanDevices()` → rows 为空 → 打印「未发现任何设备 yaml，可先运行 dev create 创建」并 return（F2）。
4. `resolveDefaultDevice()` → `renderList()`（F4/F5/F7）。

**依赖：** `fs`（readdirSync/readFileSync/existsSync）、`path`（join/resolve）、`js-yaml`（load）。

### 模块 B：命令注册 `src/cli/index.ts`（修改）

**改动点：**

1. 顶部按既有排序习惯补充 `import { runList } from "./commands/dev/list.js";`（置于 `runCreate` 之后）。
2. `devCommand` 的 `create` 注册段之后追加：

```ts
devCommand
  .command("list")
  .description("列出 devices/ 下全部设备（含模板）及串口/SSH/ADB 通道状态")
  .action(() => {
    runList();
  });
```

3. `dev` 父命令的 JSDoc 追加 list 一句；文件头部命令树注释在 `create` 行下加入 `│   └── list` 一行。

**依赖：** 模块 A。

## 模块交互

```
用户执行 node bin\embedded-mcp-toolkit-cli.js dev list
    │
    ▼
index.ts（模块 B，devCommand 子命令分发）
    └→ runList（模块 A）
         ├→ existsSync(DEVICES_DIR) ── 无目录：引导提示后返回（F2）
         ├→ scanDevices（A）        ── 扫描/解析/状态判定，坏文件收进 invalidFiles（F2/F3/F6）
         ├→ rows 为空 ──────────────  引导提示后返回（F2）
         ├→ resolveDefaultDevice（A）── 读 config.yaml 的 default，容忍缺失（F5）
         └→ renderList（A）         ── 标注 + 对齐表格 + 总数 + 图例 + 告警（F4/F6/F7）
```

数据流单向：文件系统 → ScanResult → 控制台文本。全程只读（N1）。

## 预期输出样例（实现与验收参照）

```
[list] 命令: embedded-mcp-toolkit list
[list] 参数个数: 2
[list] 解析后参数: {}

📋 embedded-mcp-toolkit 设备列表
   目录: .embedded/configs/devices

  NAME                  SERIAL                       SSH                   ADB
  board-example (模板)  COM3@115200                  root@192.168.16.105   -
  board-virt            tcp://127.0.0.1:4444@115200  root@127.0.0.1        -

  共 2 台设备
  - 表示通道禁用/未配置
```

## 文件组织

```
embedded-mcp-toolkit/
├── bin/
│   └── embedded-mcp-toolkit-cli.js        — 既有入口，不改
├── src/cli/
│   ├── index.ts                           — 修改：devCommand 挂载 list + 更新头部注释
│   └── commands/
│       ├── create/                         — 既有（ch19），保持原位不动
│       └── dev/
│           └── list.ts                    — 新增：模块 A 列表引擎
└── .embedded/configs/
    ├── config.yaml                        — 只读（取 default 字段）
    └── devices/*.yaml                     — 只读（列表数据源）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 文件落点 | `src/cli/commands/dev/list.ts` | 目录与命令树对应，后续 del 等子命令继续进 `dev/`；`create/` 保持 ch19 原位不动，避免无谓迁移（统一迁移留待 dev 子命令增多时） |
| 不复用 sdk `DeviceConfig` 类型 | 手动 `Record<string, unknown>` 窄化 | list 只读 3 个字段；`DeviceConfig` 未从 sdk 导出且结构重，复用会引入跨层耦合 |
| 不复用 sdk `loadSplitDevices` | 自行扫描 | 该函数未导出，且与配置加载日志/缓存语义耦合；list 的容错行为（跳过坏文件）对齐其约定即可 |
| `default` 来源 | 固定读 `.embedded/configs/config.yaml` | 与 spec「不支持自定义路径」及 dev create 的固定路径约定一致；缺失时静默降级（F5） |
| 同步实现 | `runList(): void`，注册不 async | 无交互、无等待 IO，同步最简；与 create 的 async（clack 问答）形成对照 |
| 路径常量 | list 内部自定义，不 import create 的私有常量 | create 的常量是其模块私有实现细节；跨命令 import 造成无谓耦合，两处字符串常量的重复可接受 |
| 状态判定 | 统一 `isDisabled(value, offValues)` 辅助 | 三通道判定逻辑同构（段缺失/空值/约定值 → 禁用），仅约定值不同；单点实现避免三份漂移 |
| 列对齐 | `displayWidth`/`padEndByWidth` 按东亚宽度填充 | `padEnd` 按字符数填充，`(模板)` 等含中文内容按 2 列渲染，直接填充会视觉错位 |

## 编码规范

**编程语言：** TypeScript（ESM，编译至 `out/`，tsc 构建）。

**适用的语言规范技能：** `ts-lang-spec`——开发执行者开始编码前必须调用该技能，严格遵循其中命名、注释（文件头 + JSDoc @brief/@details）、风格要求；与既有命令（create/split）的代码风格保持一致（N2）。

**文件编码规则（ts-lang-spec 另有规定时从其规定，以下为兜底）：**
- **新建文件**：`src/cli/commands/dev/list.ts` 为 UTF-8 无 BOM、LF 换行。
- **修改已有文件**（硬规则，不得覆盖）：`src/cli/index.ts` 保持原编码与换行符不变。
