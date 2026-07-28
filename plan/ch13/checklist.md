<!-- more -->

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 常驻命令检测器 `classifyResident` 已实现且可被调用（验证：`npx tsc --noEmit` 编译通过；临时调用 `classifyResident("ping x")` 返回 `{kind:"resident"}`）
- [ ] 内置 A 类白名单覆盖 8 个首 token 命令（验证：分别测 ping/ping6/logcat/top/htop/watch/strace/tcpdump 均判为 resident）
- [ ] 内置 B 类参数模式正确区分常驻/瞬时（验证：`tail -f x`→resident，`tail x`→normal；`dmesg -w`→resident，`dmesg`→normal；`journalctl -f`→resident，`journalctl --list-boots`→normal）
- [ ] 首 token 提取遇管道/重定向即止（验证：`echo hi | grep foo`→normal 首token echo；`logcat | tee x`→resident 首token logcat）
- [ ] 用户配置扩展名单生效（验证：`classifyResident("myapp", ["myapp"])`→resident；不传则→normal）
- [ ] `runExec` 正确调用分类并按结果选超时与动作（验证：阅读代码，确认常驻走采样分支发Ctrl+C、普通走兜底分支不发）
- [ ] `ExecResult.timeoutKind` 三态正确产出（验证：正常完成→"none"；常驻超时→"sampling"；普通超时→"fallback"）
- [ ] `getExecTimeoutConfig` 注入函数已实现并 export（验证：`npx tsc --noEmit` 通过；函数可被三 handler 调用）
- [ ] 三通道 handler 均透传 `execTimeoutConfig` 并按 `timeoutKind` 三分支格式化（验证：阅读三处代码，文案字节一致）

## 集成

- [ ] adb/ssh/serial 三个 exec handler 都接入了新的配置读取与 runExec 透传（验证：编译通过 + grep 确认三处均有 `getExecTimeoutConfig` 调用与 `execTimeoutConfig` 透传）
- [ ] 所有新增公开接口至少被一个真实调用方使用（验证：`classifyResident` 被 runExec 调用；`getExecTimeoutConfig` 被三 handler 调用；`ExecTimeoutConfig` 被使用）

## 编译与测试

- [ ] 项目编译无错误（验证：`npx tsc --noEmit` 零错误）
- [ ] 代码符合 ts-lang-spec 要求（验证：`npm run eslint:fix` 后无新告警；人工检查命名/风格/JSDoc 注释块完整）
- [ ] 格式化通过（验证：`npm run format:check` 无差异）
- [ ] 文件编码未被破坏：新建文件 `resident-detector.ts` 为 UTF-8 无 BOM、LF；修改的已有文件保持原编码（验证：编译通过无乱码；人工抽查中文注释正常显示）

## 行为验证（对照 spec AC）

- [ ] AC1 普通短命令正常返回无超时标注（验证：exec `echo hello` → 返回 `hello`，无任何超时标注）
- [ ] AC2 普通长命令不被 10 秒误杀（验证：exec `sleep 15; echo done` 不传 maxDuration → 正常返回 `done`，15s < 5min 兜底）
- [ ] AC3 普通命令兜底超时不发 Ctrl+C（验证：构造提示符不匹配场景 + 临时调小 fallbackTimeoutMs → 触发兜底超时，返回标注含「未发送中断」，日志无 Ctrl+C 记录）
- [ ] AC4 常驻命令短熔断并发 Ctrl+C（验证：exec `ping 127.0.0.1` 不传 maxDuration → 约10秒返回，标注含「采样超时/已发送Ctrl+C」，日志有 Ctrl+C；再 exec `echo ok` 正常返回）
- [ ] AC5 常驻命令采样时长可配置（验证：config.yaml 设 samplingTimeoutMs:5000 → exec ping 约5秒返回）
- [ ] AC6 白名单默认识别（验证：ping/logcat/top/tail -f 按常驻处理；tail(无-f)/dmesg(无-w) 按普通处理）
- [ ] AC7 配置扩展白名单生效（验证：config.yaml 加 `my_streamer` → exec `my_streamer` 按常驻处理）
- [ ] AC8 maxDuration 覆盖时长不改动作（验证：exec ping 传 maxDuration:30000 → 约30秒返回，标注仍为采样超时/已发Ctrl+C）
- [ ] AC9 大兜底超时时长可配置（验证：config.yaml 设 fallbackTimeoutMs:30000 → exec 提示符不匹配的普通命令约30秒触发兜底）
- [ ] AC10 三通道行为一致（验证：adb/ssh/serial 分别验证 AC4 常驻短熔断 + AC2 普通不误杀，行为一致）
- [ ] AC11 关键事件可观测（验证：日志含命令分类结果、超时类型(采样/兜底)、是否发Ctrl+C、是否检测到提示符）
- [ ] AC12 前置冲刷与回显剥离不变（验证：先 exec logcat 触发采样熔断，再 exec `echo clean` → 返回仅 `clean` 无 logcat 残留）

## 端到端场景

- [ ] 场景 1：常驻命令采样闭环。打开 adb 会话 → exec `logcat` → 约10秒自动返回采样日志 + 标注「采样超时/已发Ctrl+C」→ 再 exec `echo recovered` 返回 `recovered`（证明 logcat 已终止、会话未污染）→ 全程无需手动 send_ctrl
- [ ] 场景 2：普通长命令不被误杀。exec 一个真实耗时约 30 秒的命令（如 `sleep 30; echo long-done`）不传 maxDuration → 命令正常完成返回 `long-done`，无任何超时标注（对比改动前会被 10 秒熔断）
- [ ] 场景 3：配置驱动的设备适配。某设备有自定义常驻命令 `my_daemon`，在 config.yaml 的 `residentCommands` 加入 → exec `my_daemon` 按常驻采样处理（短熔断+Ctrl+C）；另一未配置该命令的设备上 exec `my_daemon` 按普通命令处理（兜底超时不发Ctrl+C）
- [ ] 场景 4：三通道一致性回归。对同一台设备分别用 adb/ssh/serial 通道 exec `ping` → 三者均约10秒采样超时 + 发Ctrl+C + 相同标注文案
