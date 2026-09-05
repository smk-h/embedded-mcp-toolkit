# 交互式设备删除命令（dev del）Checklist

> 每一项通过运行命令或观察行为来验证，聚焦系统行为。对应 spec.md 的 AC1-AC6。

## 实现完整性

- [ ] `del` 子命令已注册且可被调用（验证：`node bin\embedded-mcp-toolkit-cli.js dev --help` 出现 `del` 及描述）— AC1
- [ ] 候选列表正确且模板被剔除（验证：运行 `dev del`，候选含全部设备 yaml 但无 `board-example`；输入 `example` 过滤后列表为空；目录仅剩模板时提示无可删除设备并正常退出，`echo $?` 为 0）— AC1/AC4
- [ ] 关键词过滤与键盘多选生效（验证：输入 `virt` 列表实时缩小至匹配项；清空恢复全量；上下键移动高亮、Tab 勾选/取消勾选、可同时勾选多台、回车提交）— AC2
- [ ] 批量删除与汇总反馈正确（验证：勾选 3 台后 confirm 展示台数与名清单；输入 `y` → 3 台全部消失并打印"已删除 3 台设备"汇总；`dev list` 数量随之减少）— AC3
- [ ] 单选与空选路径正确（验证：仅勾选 1 台 → 确认后仅该台被删；不勾选直接回车 → 提示未选择、文件全部保留）— AC2/AC3
- [ ] 二次确认拒绝生效（验证：勾选多台后输入 `n` → 文件全部仍在、提示已取消）— AC3
- [ ] 中断安全（验证：选择或确认环节 Ctrl+C → 优雅退出，devices 目录无文件被删除）— AC5

## 集成

- [ ] dev 子命令树互不干扰（验证：`dev --help` 同时列出 create/list/del；`dev list` 数量随删除减一；`dev create -y` 仍正常生成并自动递增，测试产物已清理）
- [ ] 既有命令行为不变（验证：顶层 `--help` 正常；`split`/`regex-verify --help` 通过）— AC6

## 编译与测试

- [ ] `npm run build` 编译零错误（验证：tsc 输出无 error）
- [ ] ESLint 检查通过（验证：`npx eslint src/cli` 无告警）
- [ ] 代码符合 `ts-lang-spec` 与既有 dev 子命令风格（验证：人工核对文件头注释、JSDoc @brief/@details、emoji banner、logCommand 与 create/list 一致）
- [ ] 文件编码合规（验证：新建 `del/index.ts` 为 UTF-8 无 BOM、LF；`dev/index.ts` 编码/换行与修改前一致）

## 端到端场景

- [ ] 场景 1（批量删除流）：`dev del` → 输入 `e2e` 过滤 → Tab 勾选 3 台 → 回车提交 → confirm `y` → 3 台 yaml 全部消失、汇总反馈、`dev list` 数量减 3 — AC1/AC2/AC3
- [ ] 场景 2（单选与拒绝）：仅勾选 1 台删除成功；勾选多台后 confirm `n` / 中途 Ctrl+C → 文件全部保留 — AC2/AC3/AC5
- [ ] 场景 3（模板保护）：任何输入都无法选中 `board-example`，候选扫描阶段即被剔除 — AC1
- [ ] 场景 4（边界）：目录缺失/仅剩模板 → 提示正常退出；空选提交 → 不进入确认 — AC4
- [ ] 走查产物清理：验证结束后 devices 目录仅剩原有文件
