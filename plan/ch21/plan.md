# 交互式设备删除命令（dev del）Plan

## 架构概览

在 ch20 确立的 `commands/dev/` 聚合结构下新增 del 子命令。两个组件，每个一句话：

- **删除流程**（`src/cli/commands/dev/del/index.ts`，新增）：扫描候选（剔除模板）→ `autocompleteMultiselect` 过滤多选 → `confirm` 二次确认 → 逐个 `unlink` → 汇总反馈。
- **命令注册**（`src/cli/commands/dev/index.ts`，修改）：`devCommand` 上追加 `del` 注册块。

遵循既有分层：commander 接线只在 `dev/index.ts`，`del/index.ts` 只导出 `runDel` 纯执行函数（不依赖 commander）。

### 需求映射

| spec 需求 | 归属 |
|---|---|
| F1 命令注册 | 模块 B（del 注册块） |
| F2 候选扫描与模板剔除 | 模块 A `scanCandidates()` |
| F3 过滤多选 | 模块 A `autocompleteMultiselect` + `matchName()` |
| F4 二次确认 | 模块 A `confirm` |
| F5 逐个删除与汇总容错 | 模块 A `unlinkSync` 循环 + 成功/失败汇总 |
| N2 路径约束 | 模块 A（路径仅由 `join(DEVICES_DIR, name)` 拼接） |

## 核心数据结构

```ts
/** 删除候选（文件级，不解析内容） */
interface DeviceCandidate {
  name: string; // 设备名（文件名去 .yaml/.yml 扩展名）
  filePath: string; // 绝对路径（join(DEVICES_DIR, <entry>)）
}
```

### 对外接口

```ts
export async function runDel(): Promise<void>; // 模块 A 唯一导出，模块 B 调用
```

## 模块设计

### 模块 A：删除流程 `src/cli/commands/dev/del/index.ts`（新增）

**常量：**

```ts
const DEVICES_DIR = ".embedded/configs/devices"; // 与 create/list 约定一致
const TEMPLATE_DEVICE_NAME = "board-example"; // 用户明确要求禁止删除
```

**内部函数：**

- `scanCandidates(devicesDir: string): DeviceCandidate[]` — `readdirSync` 过滤 `.yaml`/`.yml`；**剔除 `board-example`**（F2，从源头杜绝模板进入候选）；按设备名字典序 `sort()`；不解析文件内容（坏 yaml 也可删）。
- `matchName(search: string, label: string): boolean` — 大小写不敏感子串匹配（autocomplete 的自定义 `filter`，spec F3）。
- `exitOnCancel(): never` — `cancel("已取消")` + `process.exit(0)`，与 create 同款取消约定（N1）。
- `logCommand(cmd, opts)` — 文件内私有，与 create/list 逐字同风格（N5）。

**主流程 `runDel()`：**

1. `logCommand("del", {})` + banner（`🗑️ embedded-mcp-toolkit 设备删除`）。
2. `existsSync(DEVICES_DIR)` 为假 → 提示目录不存在 + 引导 `dev create`，正常 return（F2）。
3. `scanCandidates()` → 空数组（目录不存在设备，或仅剩模板）→ 提示"无可删除的设备配置"并 return（F2/AC4）。
4. `await autocompleteMultiselect<string>({ message, options, filter, maxItems })`：
   - `message`: "选择要删除的设备" + 灰色（ANSI 90，`gray()` 助手）弱化显示的操作提示"（输入关键词过滤，Tab 勾选可多选，回车提交）"；
   - `options`: 候选映射为 `{ value: name, label: name, hint: "<name>.yaml" }`；
   - `filter`: `(search, opt) => matchName(search, String(opt.label ?? opt.value))`；
   - `maxItems: 8`（候选多时限高滚动，F3）。
5. 返回值为 symbol（Ctrl+C）→ `exitOnCancel()`（F5）；空数组（未勾选任何设备直接回车）→ `log.info` 提示后 return，不进入确认（F3）。
6. 回填选中候选为 `targets`（扫描所得真实路径，兼容 `.yml`；防御性检查缺失时 `log.error` 返回）。
7. `await confirm({ message: '确定删除 <N> 台设备：<名清单>？对应文件将被删除且不可恢复', initialValue: false })`（F4，默认 No）。
8. `isCancel` → `exitOnCancel()`；返回 false → `log.info("已取消，未删除任何文件")` + return（F5）。
9. 返回 true → 逐个 `unlinkSync(target.filePath)`：收集成功名清单与失败明细——全部成功 → `log.success("已删除 <N> 台设备: <名清单>")` + 提示 `dev list`；有失败 → `log.success` 成功部分 + 逐项 `log.error` 失败原因；正常 return（F5/AC3）。

**依赖：** `fs`（existsSync/readdirSync/unlinkSync）、`path`（join）、`@clack/prompts`（autocomplete/confirm/log/cancel/isCancel）。

### 模块 B：命令注册 `src/cli/commands/dev/index.ts`（修改）

**改动点：**

1. 顶部补充 `import { runDel } from "./del/index.js";`（置于 `runList` 之后）。
2. `list` 注册块之后追加：

```ts
devCommand
  .command("del")
  .description("交互式删除设备配置文件（关键词过滤 + 上下键选择 + 删除确认）")
  .action(async () => {
    await runDel();
  });
```

3. del 注册块带同款 JSDoc（职责说明 + `@par 子命令类型` + `@example embedded-mcp-toolkit dev del`）；父命令 JSDoc 的"已挂载 create/list"更新为"已挂载 create/list/del"。

**依赖：** 模块 A。

## 模块交互

```
用户执行 node bin\embedded-mcp-toolkit-cli.js dev del
    │
    ▼
dev/index.ts（模块 B，devCommand 子命令分发）
    └→ runDel（模块 A，async）
         ├→ existsSync(DEVICES_DIR) ── 无目录：引导提示后返回（F2）
         ├→ scanCandidates（A）      ── 剔除模板 + 字典序（F2）
         ├→ 空候选 ─────────────────  提示无可删除设备后返回（AC4）
         ├→ autocompleteMultiselect（clack）── 过滤 + Tab 勾选可多选 + 回车（F3）
         │      ├─ Ctrl+C → exitOnCancel（F5）
         │      └─ 空选提交 → 提示后返回，不进确认（F3）
         ├→ 回填 targets（扫描所得真实路径，兼容 .yml）
         ├→ confirm（clack）         ── N 台名清单 + 默认 No（F4）
         │      ├─ Ctrl+C / No → 不删除，提示已取消（F5）
         │      └─ Yes ↓
         └→ 逐个 unlinkSync（A）     ── 成功汇总 + 失败逐项 log.error（F5）
```

数据流单向：文件系统 → 候选列表 → 用户勾选 → 批量单文件删除。全程不解析 yaml 内容。

## 文件组织

```
embedded-mcp-toolkit/
├── src/cli/
│   ├── index.ts                    — 不改（registerDevCommand 一行接入已就位）
│   └── commands/dev/
│       ├── index.ts                — 修改：追加 del 注册块
│       ├── create/                 — 既有，不动
│       ├── list/                   — 既有，不动
│       └── del/
│           └── index.ts            — 新增：模块 A 交互删除流程
└── .embedded/configs/devices/*.yaml — 数据源（删除对象）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 交互原语 | `@clack/prompts` 的 `autocompleteMultiselect` + `confirm` | 项目已有依赖 v1.7.0 原生支持"输入过滤 + 上下键 + Tab 多选勾选"与确认，零新增依赖（N1）；单选即多选的特例，一套交互同时覆盖 |
| 勾选键 | Tab（clack 库约定，实现期实测确认） | autocompleteMultiselect 的 select 键为 Tab，空格会输入到搜索框；首次 e2e 发现后修正 |
| 空选语义 | `required` 保持默认 false，空选提交视为取消 | 误触回车不产生任何破坏，也不强行要求必选（F3） |
| 模板保护 | 扫描阶段剔除 `board-example`，不进候选 | 用户明确禁止删除模板；源头剔除比"选中后再拦"更早、更彻底（F2） |
| 过滤规则 | 自定义 filter：大小写不敏感子串匹配设备名 | 设备名惯用小写+连字符，子串匹配最直觉；显式自定义避免依赖库默认行为 |
| 确认默认值 | `initialValue: false` | 不可恢复操作，回车直落应为"不删"（保守默认，F4） |
| 候选不解析 yaml | 文件级操作 | 删除不需要内容；坏 yaml 也应可删，且避免为删文件引入解析失败分支 |
| 路径来源 | 仅 `join(DEVICES_DIR, 扫描所得文件名)` | 不接受用户输入路径，杜绝越出设备目录的误删（N2） |
| 取消约定 | `exitOnCancel()` = cancel + `process.exit(0)` | 与 create 命令的 isCancel 处理逐字同风格（N1/N5） |
| 删除反馈 | 成功后提示 `dev list` 复查 | 形成创建/查看/删除的操作闭环 |

## 编码规范

**编程语言：** TypeScript（ESM，编译至 `out/`，tsc 构建）。

**适用的语言规范技能：** `ts-lang-spec`——开发执行者开始编码前必须调用该技能（本会话已加载），严格遵循其中命名、注释（文件头 + JSDoc @brief/@details）、风格要求；与既有 dev 子命令（create/list）的代码风格保持一致（N5）。

**文件编码规则（ts-lang-spec 另有规定时从其规定，以下为兜底）：**
- **新建文件**：`src/cli/commands/dev/del/index.ts` 为 UTF-8 无 BOM、LF 换行。
- **修改已有文件**（硬规则，不得覆盖）：`src/cli/commands/dev/index.ts` 保持原编码与换行符不变。
