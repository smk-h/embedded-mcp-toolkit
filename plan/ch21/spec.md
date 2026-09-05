# 交互式设备删除命令（dev del）Spec

## 背景

ch20 已建立 `dev` 命令树（create/list 两个子命令，接线聚合于 `commands/dev/index.ts`）。设备配置的删除目前只能手工删文件，且无任何防误删保护。本期新增 `dev del`：列出候选设备 → 关键词过滤 + 上下键选择 → 确认后删除。

用户明确要求：**模板文件（board-example）禁止删除**。

## 目标

- `dev del` 一条命令完成设备配置的安全删除：实时过滤、键盘选择、二次确认三重防误删。
- 零新增依赖——复用项目已有 `@clack/prompts@1.7.0` 的 `autocomplete` 与 `confirm` 原语。

## 功能需求

- F1: 注册 `dev del` 子命令（挂 `devCommand`），无必选参数。
- F2: 扫描 `.embedded/configs/devices/` 下全部 `.yaml`/`.yml` 文件作为候选（文件名去扩展名为设备名，字典序）；**模板 `board-example` 在候选扫描阶段直接剔除**，不出现在列表中、无法被选中删除；目录不存在或剔除模板后无候选时打印提示并正常退出（退出码 0）。
- F3: 交互选择使用 autocompleteMultiselect 风格——输入框实时过滤（大小写不敏感的子串匹配设备名，自定义 filter）+ 上下键在过滤结果中移动 + Tab 键勾选/取消勾选（**支持单选与多选批量删除**；空格键输入到搜索框）+ 回车提交；无输入时列出全部候选；候选较多时限高显示（maxItems）；无匹配时列表为空；空选提交视为取消删除（不进入确认）。
- F4: 勾选后二次确认——confirm 展示已勾选设备数量与设备名清单，默认值为 No（保守）；仅当用户显式确认 Yes 才执行删除。
- F5: 确认后逐个删除目标 yaml 文件并汇总反馈（成功台数与设备名清单；失败时逐项打印原因）；用户在 confirm 拒绝或任一环节 Ctrl+C（isCancel）→ 不删除任何文件，优雅退出；删除执行失败（文件已被外部删除/被占用/权限不足）不影响其余目标，打印错误并正常退出，不崩溃。

## 非功能需求

- N1: 交互实现复用 `@clack/prompts`（autocomplete/confirm/log/cancel + isCancel），与 create 命令交互风格一致（含取消时 `process.exit(0)` 约定）。
- N2: 删除目标只能由程序内部拼接——固定 `.embedded/configs/devices/` 目录 + 扫描所得文件名，不接受用户输入的任意路径（防误删）；仅限 `.yaml`/`.yml` 扩展名。
- N3: 纯 CLI 侧新增——`commands/dev/del/` 新目录 + `commands/dev/index.ts` 追加注册块，不改动 sdk 与 MCP server，不影响 create/list 行为。
- N4: 新建文件 UTF-8 无 BOM、LF；修改 `commands/dev/index.ts` 保持原编码与换行符不变。
- N5: 风格对齐既有命令（文件头注释、JSDoc @brief/@details、emoji banner、文件内私有 logCommand）。

## 不做的事

- 不做回收站/备份/撤销——删除不可恢复，安全性靠候选剔除 + 二次确认保障。
- 不解析 yaml 内容——按文件名做文件级操作，坏 yaml 同样可删（且无需解析即可删）。
- 不支持命令行参数静默删除（如 `dev del board-x -y`）——本期必须走交互确认。
- 不改动 dev list / dev create 的行为，不改模板文件本身。

## 验收标准

- AC1（对应 F1/F2）: `dev --help` 出现 `del`；运行 `dev del` 进入交互，候选列表含全部设备但**不含 board-example**；输入 `example` 也匹配不到模板。
- AC2（对应 F3）: 输入关键词（如 `virt`）列表实时缩小为匹配项；清空关键词恢复全量；上下键移动高亮，Tab 勾选/取消勾选（可勾选多台），回车提交；空选提交直接结束且不删除。
- AC3（对应 F4/F5）: 勾选 N 台设备后 confirm 展示设备数量与名清单；拒绝（默认）→ 文件全部仍在；确认 → N 台全部删除，打印成功台数与设备名清单。
- AC4（对应 F2）: 设备目录只剩模板时运行 `dev del`，打印无候选提示并正常退出。
- AC5（对应 F5）: 交互中途 Ctrl+C → 进程优雅退出，devices 目录无任何文件被删除。
- AC6（对应 N2/N3）: `npm run build`、ESLint 通过；`dev list`、`dev create -y` 行为不变。
