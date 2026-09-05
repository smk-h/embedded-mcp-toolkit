# 设备列表命令（dev list）Checklist

> 每一项通过运行命令或观察行为来验证，聚焦系统行为。对应 spec.md 的 AC1-AC7。

## 实现完整性

- [ ] `list` 子命令已注册且可被调用（验证：`node bin\embedded-mcp-toolkit-cli.js dev --help` 子命令列表出现 `list` 及描述）— AC1
- [ ] 列表输出结构完整（验证：运行 `dev list`，依次输出 banner 与设备目录、NAME/SERIAL/SSH/ADB 表头、按名称字典序排列的设备行、设备总数、`- 表示通道禁用/未配置` 图例；`board-example` 行带 `(模板)` 标注；各列视觉对齐）— AC1/F4/F7
- [ ] 通道参数列与配置内容一致（验证：对真实目录每台设备，SERIAL 列 = `端口@波特率`、SSH 列 = `用户名@主机`、ADB 列 = 序列号，与各自 yaml 实际值逐项比对吻合；禁用通道显示 `-`；`tcp://` 端点原样展示）— AC3
- [ ] 目录缺失/空目录引导正常（验证：`devices/` 临时改名后运行 → 打印目录不存在提示、`echo $?` 为 0；建空目录运行 → 打印无设备提示；恢复原名后列表正常）— AC2
- [ ] 坏文件容错与告警（验证：临时放入内容非法的 `broken.yaml` → 其余设备正常列出且末尾出现该文件告警；删除后告警消失、无残留影响）— AC5
- [ ] 默认设备标注随 config.yaml 联动（验证：`default` 临时改为 `board-virt` → 该行出现 `(默认)`；改回 `board-a`（不在列表）→ 无标注、无报错；恢复原值）— AC4

## 集成

- [ ] `dev` 父命令下子命令互不干扰（验证：`dev create -y` 仍正常生成并自动递增、`dev list` 输出正常；生成的测试产物已清理）
- [ ] 既有命令行为不变（验证：顶层 `--help` 的 `dev` 条目与其它命令均在；`create`/`split`/`regex-verify` 的 `--help` 输出与改动前一致）— AC7

## 编译与测试

- [ ] `npm run build` 编译零错误（验证：tsc 输出无 error）
- [ ] ESLint 检查通过（验证：`npx eslint src/cli` 无告警）
- [ ] 代码符合 `ts-lang-spec` 与既有命令风格（验证：人工核对文件头注释、JSDoc @brief/@details、命名与 `create`/`split` 一致）
- [ ] 文件编码合规（验证：新建 `src/cli/commands/dev/list.ts` 为 UTF-8 无 BOM、LF；`src/cli/index.ts` 编码/换行与修改前一致，无乱码）

## 端到端场景

- [ ] 场景 1（正常列表）：`dev list` → 真实目录的全部设备（含模板）逐行列出，三列参数与配置文件一致、禁用为 `-`，模板/默认标注正确、各列对齐 — AC1/AC3/AC4
- [ ] 场景 2（边界生命周期）：目录改名 → 提示退出 → 恢复 → 放入坏 yaml → 告警 → 删除 → 列表恢复干净 — AC2/AC5
- [ ] 场景 3（只读性）：走查前后对 `devices/` 全部文件与 `config.yaml` 做字节级比对，逐字节不变 — AC6
