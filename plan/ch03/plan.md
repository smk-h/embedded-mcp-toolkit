# 配置文件分文件化 Plan

## 架构概览

本次重构的核心是 `src/shared/config.ts` 的配置加载层。改造后加载层能自动识别两种布局，并把它们归一化为同一份内存结构（`RootConfig`），使上层所有 `getSSHConfig()` / `listDevices()` 等调用方完全无感。

```
                        ┌──────────────────────────────────┐
                        │      loadConfig()  (归一化)        │
                        │   进程级单例 _cached 缓存           │
                        └──────────────┬───────────────────┘
                                       │ 判定布局
                   ┌───────────────────┴────────────────────┐
                   ▼                                        ▼
        【分文件布局】                           【单文件布局】
        扫描 devices/*.yaml                       读取 config.yaml
        合并为 { devices: {...} }                的 devices 段
                   │                                        │
                   └───────────────────┬────────────────────┘
                                       ▼
                        ┌──────────────────────────────────┐
                        │   RootConfig（内存统一结构）        │
                        │   { default, devices: {...} }     │
                        └──────────────────────────────────┘
                                       │
            ┌──────────────┬───────────┼──────────────┬─────────────┐
            ▼              ▼           ▼              ▼             ▼
       listDevices()  resolveDeviceName()  getSSHConfig() ...  getAllConfig()
       （上层调用方完全无感，接口/返回结构不变）
```

改动集中在三处：
1. **`src/shared/config.ts`**：`loadConfig()` 内部增加布局判定与分文件加载逻辑。
2. **`src/cli/commands/init.ts`**：`init` 生成的模板改为分文件布局。
3. **`src/cli/index.ts`**：新增 `split` 命令注册。

## 核心数据结构

### `RootConfig`（保持不变）

```typescript
interface RootConfig {
  default?: string;                      // 默认设备名
  devices?: Record<string, DeviceConfig>; // 设备配置字典，key 为设备名
}
```

加载层归一化的产物。无论来自单文件还是分文件，最终都落到这个结构。`DeviceConfig` 定义不变。

### `LoadedLayout`（新增，内部用）

```typescript
type LoadedLayout = "single" | "split" | "none";
```

- `"single"`：使用旧单文件布局（`devices/` 目录不存在或为空，回退到 `config.yaml` 的 `devices` 段）。
- `"split"`：使用新分文件布局（`devices/` 目录存在且含 `.yaml` 文件）。
- `"none"`：主配置文件本身不存在或解析失败（与现有兜底一致，返回 `{}`）。

此类型仅用于加载层内部判定与日志，不对外暴露。

### 设备文件格式

每个 `devices/<设备名>.yaml` 的根直接是该设备的配置内容，结构与单文件布局中 `devices.<设备名>` 下的内容完全一致：

```yaml
# devices/board-a.yaml
ssh:
  host: "192.168.16.103"
  port: 22
  keyProvider: { ... }
serial:
  port: "COM4"
  baudRate: 115200
adb:
  serialNo: "sn_none"
```

不重复 `devices:` 包裹层，文件名即设备名。

**通道启用/禁用约定（沿用现有判定，非本次新增语义）：**

| 通道 | 禁用取值 | 启用取值 | 判定位置 |
|------|---------|---------|---------|
| SSH | `ssh.host: "none"` | 具体 IP/主机名 | `getSSHConfig` 兜底为 `"none"`；`mcp/tools/ssh/shell.ts` 判定 `host === "none"` 拒绝并提示 `does not support SSH` |
| 串口 | `serial.port: "none"` | 具体 COM/tty 设备路径 | `getSerialConfig` 兜底为 `"none"`；`mcp/tools/serial/shell.ts` 判定 `port === "none"` 拒绝并提示 `does not support serial` |
| ADB | `adb.serialNo: "sn_none"` 或留空 | `sn_<序列号>` | `parseSerialNo` 解析 `sn_none`/空为 undefined，交由 adb 自动发现 |

不需要的通道可直接整段删除，或保留段并把关键字段置 `"none"`/`"sn_none"`。模板文件 `devices/board-example.yaml` 已据此注明。

## 模块设计

### 模块一：`src/shared/config.ts`（配置加载层改造）

**职责：** 读取主配置 + 自动判定布局 + 归一化为 `RootConfig`，提供所有设备配置查询函数。

**改动点：**

1. `loadConfig()` 保持函数签名与缓存语义不变（仍为进程级单例 `_cached`），内部实现改为：
   - 读取主配置文件（`BOARD_CONFIG_PATH` 指向的 `config.yaml`），解析出 `default` 和可能的 `devices` 段。
   - 判定布局：以主配置文件所在目录下的 `devices/` 子目录是否存在且包含 `.yaml` 文件为准。
   - 分文件布局：扫描 `devices/` 目录，逐个读取 `.yaml` 文件，以文件名（去扩展名）为设备名，合并进 `devices` 字典。
   - 单文件布局：沿用主配置文件的 `devices` 段。
   - 解析或读取失败时，沿用现有兜底逻辑（返回 `{}` 并 warn）。

2. `devices/` 目录路径解析：相对主配置文件（`BOARD_CONFIG_PATH`）所在目录，即 `resolve(dirname(configPath), "devices")`。

3. 新增内部辅助函数（不对外导出）：
   - 判断 `devices/` 目录是否含有效 `.yaml` 文件。
   - 扫描并加载分文件设备配置。
   - 布局判定完成后输出一行日志，标明当前布局（`single` / `split`），便于排查。

4. `listDevices()`、`resolveDeviceName()`、`getSSHConfig()` 等所有对外函数**签名与返回结构不变**，因为它们消费的 `RootConfig` 结构不变。

**对外接口（不变）：**
- `resolveDeviceName(): string`
- `getSSHConfig(name?): SSHShellConfig`
- `getSerialConfig(name?): SerialShellConfig`
- `getAdbConfig(name?): AdbDeviceConfig`
- `getKeyProviderConfig(scope, name?): KeyProviderConfig`
- `getAllConfig(name?): { ... }`
- `listDevices(): string[]`

**依赖：** Node `fs`、`path`、`js-yaml`、`src/shared/logger.ts`。无新增依赖。

### 模块二：`src/cli/commands/init.ts`（init 模板适配）

**职责：** 让 `init` 生成的新项目采用分文件布局。

**改动点：**

1. 模板源新增一个示例设备文件 `devices/board-example.yaml`（与 `config.example.yaml` 同源维护），`init` 时复制到目标 `.embedded/configs/devices/board-example.yaml`。

2. `config.example.yaml` 模板调整：移除其中的 `devices` 段（设备配置已拆分），仅保留 `default: board-example` 和注释说明（指向 `devices/` 目录）。

3. `init` 生成的 `config.yaml`（由 `config.example.yaml` 拷贝而来）相应只含 `default` 字段。

4. `CopyTask` 类型新增 `configYaml` 之外的设备文件拷贝（可直接复用 `file` 类型），或新增一条 `pattern` / 显式 `file` 任务处理 `devices/*.yaml`。

**对外接口（不变）：** `runInit(opts: InitOptions): void`、`runUninstall(opts): Promise<void>`。

**依赖：** Node `fs`、`path`。无新增依赖。

### 模块三：`src/cli/index.ts`（split 命令注册）

**职责：** 注册新的 `split` 命令，调用配置拆分逻辑。

**改动点：**

1. 新增顶层命令 `split`，风格与现有 `init` / `uninstall` 一致（`.command()` + `.option()` + `.action()`），注册位置紧随 `uninstall` 之后。

2. 选项：
   - `-c, --config <path>`：指定源 `config.yaml` 路径，默认 `./.embedded/configs/config.yaml`。
   - `-f, --force`：覆盖已存在的设备文件。

3. `.action()` 内部调用新模块 `runSplit(opts)`（见模块四）。

**对外接口：** 新增 `embedded-mcp-toolkit split` 子命令。

**依赖：** `src/cli/commands/split.ts`（模块四）、`src/shared/config.ts`。

### 模块四：`src/cli/commands/split.ts`（配置拆分实现，新建）

**职责：** 读取旧单文件 `config.yaml` 的 `devices` 段，为每个设备生成独立的 `devices/<设备名>.yaml`。

**对外接口：**
```typescript
export interface SplitOptions {
  config: string;   // 源 config.yaml 路径
  force: boolean;   // 是否覆盖已存在文件
}
export function runSplit(opts: SplitOptions): void;
```

**行为流程：**
1. 读取并解析源 `config.yaml`，取出 `devices` 段。
2. `devices` 段为空或不存在时，报告无可拆分内容并退出。
3. 确保 `devices/` 目录存在（相对源配置文件所在目录）。
4. 遍历 `devices` 的每个键（设备名），将对应配置用 `js-yaml` 的 `dump()` 序列化为 YAML 文本，写入 `devices/<设备名>.yaml`。
5. 覆盖保护：目标文件已存在且未指定 `--force` 时跳过并报告；`--force` 时覆盖。
6. 输出汇总：创建 / 跳过 / 覆盖的文件数量。

**输出风格（优化后）：**
- 纯 CLI 场景统一用 `console.log` 输出，**不调用 `logger`**（避免 `logger.info` 经 stderr 重复打印导致每个设备两行冗余输出）。
- 逐设备状态行只打印**设备名**（如 `✅ 创建: board-a`），不打印冗长绝对路径。
- 头部源配置 / 设备目录等路径信息用辅助函数 `shortPath()` 转为相对工作目录的简短形式，并统一为正斜杠（避免 Windows 下 `./a\b\c` 正反斜杠混杂）。
- 预期输出形如：
  ```
  ✂️  embedded-mcp-toolkit 配置拆分
     源配置: ./.embedded/configs/config.yaml
     设备目录: ./.embedded/configs/devices
     覆盖模式: 跳过已存在

    ✅ 创建: board-a
    ⏭  跳过（已存在）: board-b
    ✅ 创建: board-test

  ✅ 拆分完成：创建 6，覆盖 0，跳过 1
  ```

**依赖：** Node `fs`、`path`、`js-yaml`。

## 模块交互

### 正常运行时的配置加载链（改造后）

```
MCP server / CLI 工具调用
  └── getSSHConfig(name) 等（src/shared/config.ts）
        └── loadConfig()  ──────────────────────────┐
              │ _cached 命中 → 直接返回              │
              │ _cached 未命中：                     │
              │   1. 读主 config.yaml → {default}     │
              │   2. 判定 devices/ 是否含 .yaml       │
              │      ├─ 是 → 扫描加载（split 布局）   │
              │      └─ 否 → 用 config.yaml 的 devices│
              │   3. 写入 _cached 并返回              │
              └──────────────────────────────────────┘
```

### split 命令的调用链（一次性迁移）

```
embedded-mcp-toolkit split --config config.yaml
  └── src/cli/index.ts  (.action)
        └── runSplit(opts)  (src/cli/commands/split.ts)
              ├── 读 config.yaml，取 devices 段
              ├── 确保 devices/ 存在
              └── 逐设备 → dump → 写 devices/<name>.yaml
```

### init 命令的调用链（适配后）

```
embedded-mcp-toolkit init
  └── runInit(opts)  (src/cli/commands/init.ts)
        ├── 复制 config.example.yaml → config.yaml（仅含 default）
        └── 复制 devices/board-example.yaml → devices/board-example.yaml（示例设备）
```

## 文件组织

### 改动后的关键文件

```
src/
├── cli/
│   ├── index.ts                 # 新增 split 命令注册
│   └── commands/
│       ├── init.ts              # init 模板改为分文件布局
│       └── split.ts             # 【新建】配置拆分命令实现
└── shared/
    └── config.ts                # loadConfig() 增加布局判定与分文件加载

# 模板与配置文件（随 init 分发）
config.example.yaml              # 移除 devices 段，仅保留 default + 注释
.embedded/configs/devices/
└── board-example.yaml           # 【新建】示例设备文件（init 模板源）
```

### 用户侧目录形态（分文件布局）

```
.embedded/configs/
├── config.yaml                  # 仅 default + 全局设置
└── devices/
    ├── board-a.yaml             # 自包含设备配置
    ├── board-b.yaml
    └── ...
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 设备文件根结构 | 文件根直接是设备配置，不重复 `devices:` 包裹层 | 文件名即设备名，内容与单文件布局下 `devices.<name>` 段一致，迁移与阅读最直观。 |
| 布局判定依据 | 以 `devices/` 目录是否存在且含 `.yaml` 为准 | 满足 F4 自动判定；目录为空即自然回退单文件，零额外开关。 |
| 两种布局不混用 | 分文件布局生效时忽略主文件的 `devices` 段 | 避免同一设备出现两份冲突配置，`default` 字段始终从主文件读。 |
| `devices/` 路径基准 | 相对主配置文件所在目录（`dirname(BOARD_CONFIG_PATH)`） | 与现有 `BOARD_CONFIG_PATH` 语义一致，主配置在哪设备目录就在哪的同级。 |
| 不引入默认值继承 | 本次只做分文件化 | 各设备参数本质不同，可继承字段极少（spec 已界定范围）。 |
| 设备文件序列化方式 | 用 `js-yaml` 的 `dump()` 生成 | 项目已依赖 `js-yaml`，无需引入新库；`dump` 保证 YAML 格式正确。 |
| split 命令位置 | 顶层命令，与 init/uninstall 并列 | 同属配置生命周期管理命令，风格统一。 |
| split 输出风格 | 纯 `console.log`，不调 `logger`；逐设备只打印设备名；路径用 `shortPath()` 转简短相对形式 | CLI 面向人读，`logger.info` 会经 stderr 重复打印造成每个设备两行冗余；设备名比绝对路径更易扫读；统一正斜杠避免 Windows 路径混杂。 |
| 缓存语义不变 | 仍为进程级单例 `_cached`，启动加载一次 | 性能基准实测为亚毫秒级增量，整会话复用后可忽略（N1）。 |
| init 默认设备名 | `board-example` | 与 init 模板源设备文件名 `devices/board-example.yaml`、`config.example.yaml` 的 `default` 字段三者保持一致；用户 init 后可立即改名复用。 |

## 编码规范

**编程语言：** TypeScript

**适用的语言规范技能：** `ts-lang-spec`

开发阶段编写代码时，必须遵循 `ts-lang-spec` 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能。

本次改动的额外约定：
- import 路径统一使用相对路径 `./xxx.js` / `../xxx.js`，与现有 `src/` 代码一致。
- 新增的 `runSplit` 等导出函数使用 JSDoc 注释（`@brief` / `@param` / `@details`），风格参照 `src/cli/commands/init.ts` 中的 `runInit`。
- 配置加载层的新增内部函数（布局判定、设备扫描）不导出，仅 `loadConfig` 同文件内调用。
- 配置加载层的日志使用 `logger.info` / `logger.warn`，参照 `config.ts` 现有日志风格。
- split 命令属纯 CLI 场景，统一用 `console.log` 输出，不引入 `logger`（避免 stderr 重复打印）；路径输出经 `shortPath()` 辅助函数转为简短相对形式。
