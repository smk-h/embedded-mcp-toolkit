# 交互式设备配置创建命令（create）Plan

## 架构概览

在既有 CLI 命令树（`src/cli/index.ts`，Commander）下新增 `create` 子命令，落点为 `src/cli/commands/create/` 独立目录。三个组件，每个一句话：

- **命令入口**（`create/index.ts`，新增）：编排整体流程——模板加载 → `-y` 快速路径或交互问答 → 内存替换与校验 → 一次性写盘 → 摘要输出。
- **交互问答**（`create/prompts.ts`，新增）：基于 `@clack/prompts` 的六段问答（设备名/串口连接/串口凭据/SSH 连接/SSH 凭据/ADB 序列号），封装输入解析与就地重提示循环。
- **模板引擎**（`create/template.ts`，新增）：模板读取、段级定位的行文本替换（保留全部注释）、js-yaml 解析校验、`-y` 模式的无冲突命名、写盘。

改造面收敛为两处新增文件 + `src/cli/index.ts` 的一处命令注册，不触碰 MCP server 与 sdk（满足 N6）。

### 需求映射

| spec 需求 | 归属 |
|---|---|
| F1 命令注册 | 模块 D（`index.ts` 注册段） |
| F2 模板读取 | 模块 C `loadTemplateText()` |
| F3 设备名 | 模块 B `askDeviceName()` |
| F4/F5 串口 | 模块 B `askSerialConnection()` / `askCredential()` |
| F6/F7 SSH | 模块 B `askSshConnection()` / `askCredential()` |
| F8 ADB | 模块 B `askAdbSerialNo()` |
| F9 生成 | 模块 C `applyFieldReplacements()` / `writeDeviceFile()` |
| F10 `-y` 快速模式 | 模块 C `resolveNonConflictingPath()` + 入口分支 |
| N1 交互风格 | 模块 B（clack + isCancel） |
| N2/N4 替换精度与原子性 | 模块 C（替换计数 + 解析校验后统一写盘） |
| N3 编码 | 模块 C `writeDeviceFile()` |

## 核心数据结构

### CreateOptions（命令选项）

```ts
interface CreateOptions {
  yes: boolean; // -y 快速模式：完全免交互，生成 board-default.yaml
}
```

### FieldReplacement（替换目标描述）

模板引擎的最小工作单元，交互结果最终被折叠为此列表：

```ts
interface FieldReplacement {
  section: "adb" | "ssh" | "serial"; // 顶层段名（限定搜索范围，避免跨段误替换）
  field: string;   // 段内 2 空格缩进的字段名，如 "port"、"serialNo"
  value: string;   // 最终 YAML 值文本：字符串带双引号（"none"、"COM3"、"root"），数字不带（22、115200）
}
```

通道未启用时**不生成**该通道凭据类字段的替换项（保留模板原值），只生成禁用约定字段：

| 场景 | 生成的替换项 |
|---|---|
| 串口启用 | `serial.port`、`serial.baudRate`、`serial.loginUsername`、`serial.loginPassword` |
| 串口禁用（直接回车） | 仅 `serial.port: "none"`（baudRate/凭据保留模板值） |
| SSH 启用 | `ssh.host`、`ssh.port`、`ssh.username`、`ssh.password` |
| SSH 禁用（直接回车） | 仅 `ssh.host: "none"`（port/凭据保留模板值） |
| ADB | 恒有 `adb.serialNo`（`sn_none` 或 `sn_<输入>`） |

### 问答结果类型（模块 B 内部）

```ts
interface SerialConn  { port: string; baudRate: number; }        // null 表示未启用
interface Credential  { username: string; password: string; }    // null 表示未启用（仅串口允许）
interface SshConn     { host: string; port: number; }            // null 表示未启用
```

## 模块设计

### 模块 A：命令入口 `create/index.ts`（新增）

**职责：** 流程编排——banner 打印、模板加载、`-y` 分支或交互问答、替换与校验、写盘、摘要输出。
**对外接口：**

```ts
export async function runCreate(opts: CreateOptions): Promise<void>;
```

**交互模式流程（无 `-y`）：**

1. 加载模板文本（F2，失败即报错退出）。
2. `askDeviceName()` 取设备名（F3）。
3. `askSerialConnection()` → 启用则继续 `askCredential()`（允许空）；禁用则跳过凭据问答（F4/F5）。
4. `askSshConnection()` → 启用才继续 `askCredential()`（必填）；禁用跳过（F6/F7）。
5. `askAdbSerialNo()`（F8）。
6. 折叠为 `FieldReplacement[]` → `applyFieldReplacements()` → `validateYaml()` → `writeDeviceFile()`（F9）。
7. 打印摘要：设备名、文件路径、各通道启用状态与关键参数。

**`-y` 模式流程（F10）：** 加载模板 → `resolveNonConflictingPath(devicesDir, "board-default")` 取无冲突路径 → 模板原文直接作为文件内容（不做任何替换，但仍过 `validateYaml()`）→ 写盘 → 摘要。全程零提示。

**依赖：** 模块 B、模块 C；`@clack/prompts` 的 `log`/`cancel`；`cli-helpers.ts` 的 `logCommand`。

### 模块 B：交互问答 `create/prompts.ts`（新增）

**职责：** 六段问答 + 输入解析 + 不合法就地重提示循环（spec F3-F8、N1）。
**对外接口：**

```ts
export async function askDeviceName(devicesDir: string): Promise<string>;
export async function askSerialConnection(): Promise<SerialConn | null>;
export async function askSshConnection(): Promise<SshConn | null>;
export async function askCredential(message: string, required: boolean): Promise<Credential | null>;
export async function askAdbSerialNo(): Promise<string>;
```

**解析规则（纯函数，供问答循环调用）：**

- `parsePortBaud(input)`：按**第一个** `@` 分割；端口非空、波特率为正整数；任一不满足返回错误描述（驱动就地重提示）。直接回车由调用方先判定（返回 `null` 表示未启用）。
- `parseUserPass(input)`：按**第一个** `@` 分割；用户名段与密码段均非空（密码允许含 `@`）。
- `parseIpPort(input)`：含 `@端口` 时端口为正整数，否则默认 22；IP 非空。
- `normalizeSn(input)`：输入以 `sn_` 开头原样返回，否则返回 `sn_<输入>`。

**重提示循环模式：** 每段问答为 `while` 循环——`text()` 取输入 → `isCancel()` 则 `cancel()` 优雅退出（N1）→ 解析/校验不通过用 `log.warning` 打印原因后重新 `text()`。`required=true`（SSH 凭据）时空输入也重提示；`required=false`（串口凭据）时空输入返回 `null`。

**依赖：** `@clack/prompts`（`text`/`log`/`isCancel`/`cancel`）；`existsSync`（设备名冲突检查）。

### 模块 C：模板引擎 `create/template.ts`（新增）

**职责：** 模板读取、段级行替换、解析校验、无冲突命名、写盘（F2/F9/F10、N2/N3/N4）。
**对外接口：**

```ts
export function loadTemplateText(templatePath: string): string;
export function applyFieldReplacements(templateText: string, replacements: FieldReplacement[]): string;
export function validateYaml(content: string): void;
export function resolveNonConflictingPath(devicesDir: string, baseName: string): string;
export function writeDeviceFile(filePath: string, content: string): void;
```

**替换引擎（N2 核心）：** 逐行扫描的状态机——

1. 遇 `^<section>:\s*$`（0 缩进）更新当前段；遇其它 0 缩进的 `xxx:` 行则离开目标段。
2. 在目标段内，匹配 `^(  <field>:)( *)([^#]*?)(#.*)?$`（恰好 2 空格缩进，注释前为值区）：重写为 `  <field>: <newValue>` 并原样保留 `#` 起始的行内注释。以 `#` 开头的整行注释天然不命中锚点正则。
3. 每个替换项执行后计数；扫描结束后任一替换项计数为 0 → 抛错（目标字段在模板中不存在，防御模板结构漂移），不产出内容。

**validateYaml：** `js-yaml load()` 解析失败抛错；解析成功但缺 `adb`/`ssh`/`serial` 任一段亦抛错（N2）。

**resolveNonConflictingPath：** `<devicesDir>/<baseName>.yaml` 存在则尝试 `<baseName>-2.yaml`、`<baseName>-3.yaml`…直至首个不存在的路径（F10）。

**writeDeviceFile：** 内容统一 `replace(/\r\n/g, "\n")` 后以 `utf8` 写入（N3：无 BOM、LF）；`-y` 模式内容即模板原文，同样归一换行。

**依赖：** `fs`（readFileSync/writeFileSync/existsSync）、`js-yaml`（`load`）。

### 模块 D：命令注册 `src/cli/index.ts`（改造）

**职责：** 在命令树注册 `create`。
**改动点：** 仿照 `split` 的注册模式追加：

```ts
program
  .command("create")
  .description("交互式创建新设备配置文件（基于 board-example.yaml 模板）")
  .option("-y, --yes", "快速模式：免交互直接生成 board-default.yaml（同名自动递增后缀）", false)
  .action(async (opts) => {
    await runCreate(opts);
  });
```

同时更新文件头部的命令层级结构注释（加入 `create` 一行）。

**依赖：** 模块 A。

## 模块交互

```
用户执行 node bin\embedded-mcp-toolkit-cli.js create [-y]
    │
    ▼
index.ts（模块 D，Commander 解析 -y）
    └→ runCreate（模块 A）
         ├→ loadTemplateText（模块 C）          ── 失败：报错退出（F2）
         ├→ [无 -y] askDeviceName（模块 B）      ── 设备名 + 冲突检查（F3）
         ├→ [无 -y] askSerialConnection（B）     ── COM@baud 或回车禁用（F4）
         │            └─启用→ askCredential(required=false)（B）── user@passwd 或回车 none（F5）
         ├→ [无 -y] askSshConnection（B）        ── ip@port 或回车禁用（F6）
         │            └─启用→ askCredential(required=true)（B） ── user@passwd 必填（F7）
         ├→ [无 -y] askAdbSerialNo（B）          ── sn_ 归一（F8）
         ├→ 折叠 FieldReplacement[]（A）
         ├→ applyFieldReplacements（C）          ── 段级行替换保注释（N2）
         ├─ [-y] resolveNonConflictingPath（C）  ── board-default(-N).yaml（F10）
         ├→ validateYaml（C）                    ── 解析 + 段完整性（N2）
         └→ writeDeviceFile（C）→ 摘要输出（A）  ── 原子写盘（N3/N4）
```

数据流单向：问答结果 → `FieldReplacement[]` → 替换后文本 → 磁盘文件。任一环节失败即中断，不落盘（N4）。

## 文件组织

```
embedded-mcp-toolkit/
├── bin/
│   └── embedded-mcp-toolkit-cli.js        — 既有入口，不改
├── src/cli/
│   ├── index.ts                           — 修改：注册 create 命令 + 更新头部注释
│   └── commands/
│       └── create/                        — 新增目录
│           ├── index.ts                   — 模块 A：runCreate 流程编排
│           ├── prompts.ts                 — 模块 B：问答 + 解析 + 重提示循环
│           └── template.ts                — 模块 C：模板引擎（读取/替换/校验/写盘）
└── .embedded/configs/devices/
    └── board-example.yaml                 — 既有模板，只读不改
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 模板改写方式 | 段级状态机文本替换（模块 C） | 必须保留模板注释与 keyProvider/uboot 等段（F9/N2）；js-yaml `dump` 会丢弃全部注释，已否决 |
| 段定位策略 | 顶层段名 + 恰好 2 空格缩进字段锚点 | `port` 字段在 ssh 与 serial 两段同名，必须按段限定；2 空格锚点天然避开 4 空格的 uboot 子段与 `#` 注释行 |
| 交互库 | `@clack/prompts` | 项目已有依赖，`remote-mcp-config` 已有成熟用法（N1），不引新依赖 |
| 行内注释保留 | 正则捕获注释区、重写值区 | 模板每行字段后带说明注释，整体替换值+注释会丢教学信息 |
| 替换完备性校验 | 每个替换项计数，0 次命中即抛错 | 防模板结构漂移导致静默漏替换；配合 `validateYaml` 双保险（N2/N4） |
| `-y` 同名冲突 | 后缀递增 `-2/-3…` | 延续 F3「绝不覆盖」原则，同时保持免交互不失败 |
| `@` 分割规则 | 首个 `@` | 密码允许含 `@`；端口/波特率不含 `@`，无歧义 |
| 模板路径 | 固定 `<cwd>/.embedded/configs/devices/board-example.yaml` | spec 明确不做自定义模板路径；与工具链从项目根启动的既有约定一致 |
| 数字字段落盘 | `ssh.port`/`serial.baudRate` 不带引号，其余带双引号 | 与模板既有写法一致（`port: 22` vs `host: "none"`），保证生成文件风格同构 |

## 编码规范

**编程语言：** TypeScript（ESM，编译至 `out/`，esbuild 构建）。

**适用的语言规范技能：** `ts-lang-spec`——开发执行者开始编码前必须调用该技能，严格遵循其中命名、注释（文件头 + JSDoc @brief/@details）、风格要求；与既有命令（split/remote-mcp-config）的代码风格保持一致（N5）。

**文件编码规则（ts-lang-spec 另有规定时从其规定，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行（模块 A/B/C 三个新文件均适用）。
- **修改已有文件**（硬规则，不得覆盖）：`src/cli/index.ts` 为 UTF-8，保持原编码与换行符不变。
- **生成的设备 yaml**：由 `writeDeviceFile` 统一保证 UTF-8 无 BOM、LF（N3）。
