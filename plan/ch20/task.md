# 设备列表命令（dev list）Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/commands/dev/list.ts` | 列表引擎：扫描、状态判定、标注、表格输出 |
| 修改 | `src/cli/index.ts` | `devCommand` 挂载 `list` 子命令，更新头部命令树注释 |

> 编码约束（贯穿所有任务）：新文件 UTF-8 无 BOM、LF；修改 `src/cli/index.ts` 保持原编码不变。开发前先调用 `ts-lang-spec` 技能，文件头注释、JSDoc @brief/@details 风格对齐 `src/cli/commands/create/index.ts`。

## T1: 列表引擎——常量、类型、扫描与状态判定

**文件：** `src/cli/commands/dev/list.ts`（新建）
**依赖：** 无
**步骤：**
1. 新建文件（含 `dev/` 目录），写文件头注释块（Description: dev list 命令——设备列表与通道状态摘要）。
2. 定义常量 `DEVICES_DIR`、`CONFIG_PATH`、`TEMPLATE_DEVICE_NAME`（值见 plan 模块 A）。
3. 定义并导出 `DeviceRow`/`ScanResult` 接口（字段见 plan 核心数据结构）。
4. 实现私有 `isDisabled(value: unknown, offValues: string[]): boolean`。
5. 实现私有 `scanDevices(devicesDir: string): ScanResult`——`existsSync` 由调用方先判；`readdirSync` 过滤 `.yaml`/`.yml`；逐文件 `load()` 解析，失败计入 `invalidFiles`（`err instanceof Error ? err.message : String(err)`）并跳过；成功则对 `serial.port`/`ssh.host`/`adb.serialNo` 调 `isDisabled`（前两者 `["none"]`，ADB `["sn_none"]`）取反得启用状态；结果按 `name` 字典序 `sort()`。

**验证：** `npm run build` 通过后，node 片段直调验证：
`node -e "import('./out/cli/commands/dev/list.js').then(m => { /* 调用导出物或临时导出的 scanDevices */ })"` —— 对真实 `.embedded/configs/devices/` 期望返回 2 行且按名称排序、无 invalidFiles；对 `isDisabled(undefined,["none"])`、`isDisabled("tcp://127.0.0.1:4444",["none"])`、`isDisabled("sn_none",["sn_none"])` 期望 `true`、`false`、`true`。

## T2: 列表引擎——标注、输出与主流程

**文件：** `src/cli/commands/dev/list.ts`
**依赖：** T1
**步骤：**
1. 实现私有 `resolveDefaultDevice(configPath: string): string | null`——文件不存在或 `default` 非非空字符串返回 `null`，任何异常吞掉返回 `null`（F5 静默降级）。
2. 实现私有 `renderList(result: ScanResult, defaultDevice: string | null): void`——标注拼接（`(模板)`/`(默认)`）、NAME 列宽自适应（max 行长与表头）、三列固定宽 6 输出 `✓`/`-`、总数行、图例行、invalidFiles 告警行（格式见 plan 预期输出样例）。
3. 实现文件内私有 `logCommand(cmd: string, opts: object): void`（与 `create/index.ts` 同名助手逐字同风格）。
4. 实现并导出 `runList(): void`——按 plan 主流程四步编排（目录缺失/无设备的两种引导提示均打印后正常 return）。

**验证：** `npm run build` 通过后，`node -e "import('./out/cli/commands/dev/list.js').then(m => m.runList())"` 输出与 plan 预期样例结构一致（banner/表头/两台设备/总数/图例，`board-example` 带 `(模板)` 标注）。

## T3: 命令注册

**文件：** `src/cli/index.ts`（修改，保持原编码）
**依赖：** T2
**步骤：**
1. 顶部 `import { runCreate } ...` 之后补充 `import { runList } from "./commands/dev/list.js";`。
2. `devCommand` 的 `create` 注册段之后追加 `list` 子命令注册（代码见 plan 模块 B）。
3. `dev` 父命令 JSDoc 追加 list 说明；头部命令树注释 `create` 行下加入 `│   └── list` 行。

**验证：** `npm run build` 通过；`node bin\embedded-mcp-toolkit-cli.js dev --help` 子命令列表出现 `list`；`node bin\embedded-mcp-toolkit-cli.js dev list` 正常输出列表。

## T4: 端到端走查与风格自检

**文件：** 无新改动（验证性任务，发现问题回改对应文件）
**依赖：** T3
**步骤：**
1. 正常列表：`dev list` 输出表头/排序/总数/图例，`board-example` 带 `(模板)`。
2. 空目录边界：临时把 `devices/` 改名 → 提示目录不存在并正常退出（`echo $?` 为 0）；建空目录 → 提示无设备 yaml；恢复原名。
3. 坏文件：临时放入 `broken.yaml`（内容 `: : :`）→ 其余设备正常列出且末尾出现告警；删除后告警消失。
4. 默认标注：临时把 config.yaml 的 `default` 改为 `board-virt` → 该行出现 `(默认)`；改回 `board-a`（不在列表）→ 无标注无报错；恢复原文件。
5. 只读性核对：走查前后对 `devices/` 与 config.yaml 做内容比对（Node `readFileSync` 字节比较），逐字节不变。
6. 对照 `ts-lang-spec` 与 create/split 风格人工核对命名/注释/结构；`npx eslint src/cli` 通过。

**验证：** 走查全部符合 spec 的 AC1-AC7 记录（正式逐条验收在 checklist 阶段执行）。

## 执行顺序

```
T1 ──→ T2 ──→ T3 ──→ T4
```

（单文件单线依赖，顺序执行。）
