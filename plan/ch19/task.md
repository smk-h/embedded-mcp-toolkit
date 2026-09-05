# 交互式设备配置创建命令（create）Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/commands/create/template.ts` | 模板引擎：读取、段级替换、yaml 校验、无冲突命名、写盘 |
| 新建 | `src/cli/commands/create/prompts.ts` | 交互问答：六段问答、输入解析、就地重提示循环 |
| 新建 | `src/cli/commands/create/index.ts` | 命令入口：`runCreate` 流程编排与摘要输出 |
| 修改 | `src/cli/index.ts` | 注册 `create` 命令，更新头部命令树注释 |

> 编码约束（贯穿所有任务）：新文件 UTF-8 无 BOM、LF；修改 `src/cli/index.ts` 保持原编码不变。开发前先调用 `ts-lang-spec` 技能，文件头注释、JSDoc @brief/@details 风格对齐 `src/cli/commands/split.ts`。

## T1: 模板引擎——类型与模板读取

**文件：** `src/cli/commands/create/template.ts`（新建）
**依赖：** 无
**步骤：**
1. 新建文件，写文件头注释块与模块说明（Description: create 命令模板引擎）。
2. 定义并导出 `FieldReplacement` 接口（`section: "adb" | "ssh" | "serial"`、`field: string`、`value: string`），附字段 JSDoc。
3. 实现并导出 `loadTemplateText(templatePath: string): string`——`readFileSync(templatePath, "utf8")` 读取；文件不存在时向上抛出调用方可捕获的错误（由入口统一转用户提示）。

**验证：** `npm run build` 编译通过（tsc 零错误）。

## T2: 模板引擎——替换与校验

**文件：** `src/cli/commands/create/template.ts`
**依赖：** T1
**步骤：**
1. 实现并导出 `applyFieldReplacements(templateText: string, replacements: FieldReplacement[]): string`：
   - 按 `\n` 拆行，维护「当前顶层段」状态：匹配 `^([A-Za-z][A-Za-z0-9_]*):\s*$` 更新段名。
   - 在目标段内匹配 `^  field:`（恰好 2 空格缩进 + 目标字段名 + `:`），捕获值区与行内注释区；重写为 `  field: <value>` 并原样保留 `#` 起始的注释。
   - 每个替换项统计命中次数；扫描结束后任一项为 0 次则抛错（消息含 section/field）。
2. 实现并导出 `validateYaml(content: string): void`——`js-yaml` 的 `load()` 解析；解析失败或缺 `adb`/`ssh`/`serial` 任一段抛错。

**验证：** 编译通过后，用临时 node 片段对真实模板执行一次替换并断言：
`node -e "import('./out/cli/commands/create/template.js').then(m => { const fs = require('fs'); const t = fs.readFileSync('.embedded/configs/devices/board-example.yaml','utf8'); const out = m.applyFieldReplacements(t, [{section:'serial',field:'port',value:'\"none\"'},{section:'adb',field:'serialNo',value:'\"sn_test\"'}]); m.validateYaml(out); console.log(out.includes('port: \"none\" # 串口设备路径'), out.includes('sn_test')); })"`
期望输出 `true true`（注释保留 + 值已替换），且无异常抛出。

## T3: 模板引擎——命名与写盘

**文件：** `src/cli/commands/create/template.ts`
**依赖：** T1
**步骤：**
1. 实现并导出 `resolveNonConflictingPath(devicesDir: string, baseName: string): string`——依次探测 `<baseName>.yaml`、`<baseName>-2.yaml`、`<baseName>-3.yaml`…，返回首个不存在的绝对路径（`existsSync`）。
2. 实现并导出 `writeDeviceFile(filePath: string, content: string): void`——内容先 `replace(/\r\n/g, "\n")` 归一换行，再 `writeFileSync(filePath, content, "utf8")`。

**验证：** 编译通过后，临时 node 片段调用 `resolveNonConflictingPath(".embedded/configs/devices", "board-example")`，期望返回 `board-example-2.yaml` 路径（该名已被模板占用）。

## T4: 问答——输入解析纯函数

**文件：** `src/cli/commands/create/prompts.ts`（新建）
**依赖：** 无（与 T1-T3 并行）
**步骤：**
1. 新建文件，写文件头注释块（Description: create 命令交互问答与输入解析）。
2. 实现并导出解析纯函数（返回值或错误消息字符串，不直接 IO）：
   - `parsePortBaud(input: string): { port: string; baudRate: number } | string`——按第一个 `@` 分割；端口非空、波特率为正整数；失败返回错误描述。
   - `parseUserPass(input: string): { username: string; password: string } | string`——按第一个 `@` 分割，两段均非空（密码可含 `@`）。
   - `parseIpPort(input: string): { host: string; port: number } | string`——含 `@端口` 时端口为正整数，否则默认 22；IP 非空。
   - `normalizeSn(input: string): string`——已以 `sn_` 开头原样返回，否则 `sn_` + 输入。

**验证：** 编译通过后，临时 node 片段断言典型用例：`COM3@115200` 成功、`COM3` 失败、`root@p@ss` → username `root`/password `p@ss`、`192.168.1.10` → port 22、`sn_abc` → `sn_abc`、`123456` → `sn_123456`。

## T5: 问答——交互循环

**文件：** `src/cli/commands/create/prompts.ts`
**依赖：** T4
**步骤：**
1. 实现并导出 `askDeviceName(devicesDir: string): Promise<string>`——`text()` 提示输入设备名；`isCancel()` 则 `cancel()` 后 `process.exit(0)`；正则 `^[A-Za-z0-9._-]+$` 校验 + `existsSync(join(devicesDir, name + ".yaml"))` 冲突检查；不合法/冲突时 `log.warning` 说明原因后重新提示。
2. 实现并导出 `askSerialConnection(): Promise<SerialConn | null>`——提示 `端口@波特率`；空输入返回 `null`；否则 `parsePortBaud` 循环校验。
3. 实现并导出 `askSshConnection(): Promise<SshConn | null>`——提示 `IP@端口`；空输入返回 `null`；否则 `parseIpPort` 循环校验。
4. 实现并导出 `askCredential(message: string, required: boolean): Promise<Credential | null>`——提示 `用户名@密码`；空输入且 `required=false` 返回 `null`；空输入且 `required=true` 重提示；非空走 `parseUserPass` 循环。
5. 实现并导出 `askAdbSerialNo(): Promise<string>`——提示序列号；空输入返回 `"sn_none"`，非空返回 `normalizeSn(input)`。
6. 文件内部定义 `SerialConn`/`Credential`/`SshConn` 接口并导出（供入口折叠替换项使用）。

**验证：** `npm run build` 编译通过（交互行为在 T7 端到端走查）。

## T6: 命令入口与 `-y` 快速模式

**文件：** `src/cli/commands/create/index.ts`（新建）
**依赖：** T1、T2、T3、T5
**步骤：**
1. 新建文件，写文件头注释块；定义并导出 `CreateOptions`（`yes: boolean`）。
2. 实现并导出 `runCreate(opts: CreateOptions): Promise<void>`：
   - 入口调用 `logCommand("create", opts)`（复用 `cli-helpers.ts`），打印 emoji banner（风格对齐 `split.ts`）。
   - 常量 `TEMPLATE_PATH = ".embedded/configs/devices/board-example.yaml"`、`DEVICES_DIR = ".embedded/configs/devices"`。
   - `try { loadTemplateText(...) } catch` → `log.error` 提示模板不存在并 `return`（F2）。
   - `-y` 分支：`resolveNonConflictingPath(DEVICES_DIR, "board-default")` → 模板原文直接作为内容 → `validateYaml` → `writeDeviceFile` → 摘要（F10）。
   - 交互分支：依序 `askDeviceName` → `askSerialConnection`（启用则 `askCredential(required=false)`）→ `askSshConnection`（启用才 `askCredential(required=true)`）→ `askAdbSerialNo` → 折叠 `FieldReplacement[]`（数字字段值不加引号，字符串加双引号；禁用通道只生成约定字段）→ `applyFieldReplacements` → `validateYaml` → `writeDeviceFile` → 摘要（F3-F9）。
   - 摘要打印：设备名、文件路径、串口/SSH/ADB 各通道启用状态与关键参数。

**验证：** `npm run build` 通过；临时以 `node -e` 直调 `runCreate({yes:true})`，期望无任何提示直接生成 `board-default.yaml`（内容与模板一致）；再调一次生成 `board-default-2.yaml`。验证后删除这两个测试产物。

## T7: 命令注册

**文件：** `src/cli/index.ts`（修改，保持原编码）
**依赖：** T6
**步骤：**
1. 顶部按既有排序习惯补充 `import { runCreate } from "./commands/create/index.js";`。
2. 在 `split` 注册段之后追加 `program.command("create").description(...).option("-y, --yes", ..., false).action(async (opts) => { await runCreate(opts); })`（见 plan.md 模块 D）。
3. 更新文件头部命令层级结构注释，加入 `create` 一行。

**验证：** `npm run build` 通过；`node bin\embedded-mcp-toolkit-cli.js --help` 命令列表出现 `create`。

## T8: 端到端走查与风格自检

**文件：** 无新改动（验证性任务，发现问题回改对应文件）
**依赖：** T7
**步骤：**
1. 交互全流程走查：`node bin\embedded-mcp-toolkit-cli.js create` → 设备名 `e2e-test` → 串口 `COM3@115200` + `root@root` → SSH `192.168.1.10`（不带 @端口）+ `admin@secret` → ADB `123456` → 检查生成文件九个目标字段值与行内注释。
2. 边界走查：串口/SSH 均直接回车 + ADB 回车 → 生成文件 `port: "none"`、`host: "none"`、`serialNo: "sn_none"`，凭据保留模板值；再验证同名设备重输、`COM3` 缺波特率重提、Ctrl+C 中途退出无残留文件。
3. 删除走查产物 `e2e-test*.yaml`、`board-default*.yaml`。
4. 对照 `ts-lang-spec` 与既有命令风格人工核对命名/注释/结构（无 lint 脚本，人工检查）。

**验证：** 走查全部符合 spec 的 AC1-AC11 记录（正式逐条验收在 checklist 阶段执行）。

## 执行顺序

```
T1 ──→ T2 ──→ T3 ──┐
                    ├──→ T6 ──→ T7 ──→ T8
T4 ──→ T5 ──────────┘
```

（T4/T5 与 T1-T3 分属不同文件、无相互依赖，可并行推进；T6 汇合两条线。）
