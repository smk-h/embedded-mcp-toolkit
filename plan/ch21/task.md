# 交互式设备删除命令（dev del）Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/cli/commands/dev/del/index.ts` | 删除流程：候选扫描、过滤选择、二次确认、删除执行 |
| 修改 | `src/cli/commands/dev/index.ts` | `devCommand` 追加 `del` 注册块 |

> 编码约束：新文件 UTF-8 无 BOM、LF；修改 `dev/index.ts` 保持原编码不变。ts-lang-spec 已在本会话加载，风格对齐 `commands/dev/create/index.ts` 与 `commands/dev/list/index.ts`。

## T1: 删除流程——候选扫描与交互删除

**文件：** `src/cli/commands/dev/del/index.ts`（新建，含 `del/` 目录）
**依赖：** 无
**步骤：**
1. 新建文件，写文件头注释块（Description: dev del 命令 —— 交互式删除设备配置文件）。
2. 定义常量 `DEVICES_DIR`、`TEMPLATE_DEVICE_NAME`；定义 `DeviceCandidate` 接口。
3. 实现私有 `scanCandidates(devicesDir: string): DeviceCandidate[]`（过滤 yaml/yml、剔除模板、字典序）与 `matchName(search: string, label: string): boolean`（大小写不敏感子串）。
4. 实现私有 `exitOnCancel(): never` 与 `logCommand(cmd, opts)`（同 create/list 风格）。
5. 实现并导出 `runDel(): Promise<void>`——按 plan 主流程 9 步编排：banner → 目录检查 → 候选扫描（空则提示返回）→ `autocompleteMultiselect`（自定义 filter、`maxItems: 8`、hint 为文件名）→ isCancel 退出 / 空选提示返回 → 回填 targets → `confirm`（默认 false、消息含台数与名清单）→ 拒绝/取消不删除 → 确认后逐个 `unlinkSync` 并汇总（成功台数+名清单、失败逐项 `log.error`）。

**验证：** `npm run build` 通过；`runDel` 导出存在；`matchName`/候选剔除行为在 T3 端到端行为验证（模板不可选中、空选不删除）。

## T2: 命令注册

**文件：** `src/cli/commands/dev/index.ts`（修改，保持原编码）
**依赖：** T1
**步骤：**
1. 顶部补充 `import { runDel } from "./del/index.js";`（置于 `runList` 之后）。
2. `list` 注册块之后追加 `del` 注册块（代码与 JSDoc 见 plan 模块 B，`@example embedded-mcp-toolkit dev del`）。
3. 父命令 JSDoc"已挂载 create/list"更新为"已挂载 create/list/del"；文件头 Description 同步。

**验证：** `npm run build` 通过；`node bin\embedded-mcp-toolkit-cli.js dev --help` 出现 `del` 及描述。

## T3: 端到端走查与风格自检

**文件：** 无新改动（验证性任务，发现问题回改）
**依赖：** T2
**步骤：**
1. 造删除目标：`cp board-virt.yaml del-e2e-1.yaml`、`del-e2e-2.yaml`、`del-e2e-3.yaml`（保证候选 ≥ 3 且不含模板）。
2. 批量删除流（piped 驱动，`\r` 提交 + 行间延时——ch19 已验证 clack 非 TTY 只认回车符）：输入 `e2e` 过滤 → Tab 勾选 3 台（`\t` + `\x1b[B` 移动）→ 回车提交 → confirm 输入 `y` → 3 台全部消失 + "已删除 3 台设备"汇总。
3. 单选删除流：再造 1 台 `del-e2e.yaml`，只勾选它 → 确认 → 仅该台被删（批量交互的单选特例）。
4. 拒绝路径：再造 2 台并勾选，confirm 输入 `n` → 文件全部仍在、提示已取消。
5. 空选路径：不勾选直接回车 → 提示未选择，文件全部保留。
6. 模板保护：过滤 `example` → 列表 "No matches found"（board-example 不在候选）；Ctrl+C 中途退出 → 无删除。
7. 边界：目录只剩模板/目录缺失 → 提示正常退出（`echo $?` 为 0）；删除后 `dev list` 数量随之减少。
8. 风格与编码：对照 create/list 人工核对（文件头/JSDoc/emoji banner/logCommand）；`npx eslint src/cli` 通过；新文件无 BOM、LF，`dev/index.ts` 原编码不变。

**验证：** 走查全部符合 spec AC1-AC6（正式逐条验收在 checklist 阶段执行）。

## 执行顺序

```
T1 ──→ T2 ──→ T3
```
