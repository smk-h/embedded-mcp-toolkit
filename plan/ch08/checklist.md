<!-- more -->

## 一、 实现完整性

- [ ] PromptDetector 已实现且可被调用(验证:`npx tsc --noEmit` 编译通过;对 `"root@host:~# "` 调 detect 返回 true,对 `"some output"` 返回 false)
- [ ] CONTROL_CHAR_MAP 已实现且映射正确(验证:c→`\x03`、u→`\x15`、d→`\x04`、z→`\x1a`,四项齐全)
- [ ] sendControlChar 已实现且以 `appendLineEnding=false` 发送(验证:读 `src/mcp/shared/send-ctrl.ts` 确认 write 调用第三参为 false;编译通过)
- [ ] runExec 已实现,含前置冲刷、轮询、提示符检测、超时熔断四段逻辑(验证:读 `src/mcp/shared/exec-runner.ts` 确认四段逻辑齐全;编译通过)
- [ ] ExecResult 三态语义实现正确(验证:正常完成返回 `timedOut:false`;超时熔断返回 `timedOut:true` 且 `interrupted:false`)
- [ ] getPromptPattern 已实现(验证:无配置时返回 undefined;config.yaml 配置 promptPattern 后返回对应字符串)
- [ ] 三个 send_ctrl handler 已实现(验证:`adbShellSendCtrlHandler`、`sshShellSendCtrlHandler`、`serialSendCtrlHandler` 均存在且编译通过)

## 二、 集成

- [ ] 三个 `*_shell_exec` handler 已改为调用 runExec(验证:grep 确认 adb/ssh/serial 三个 shell.ts 的 exec handler 内含 `runExec(` 调用)
- [ ] 三个 send_ctrl 工具已注册到各自 index.ts(验证:启动 MCP server `npm start`,工具列表含 `adb_shell_send_ctrl`、`ssh_shell_send_ctrl`、`serial_send_ctrl`)
- [ ] 三个 exec handler 正确构造 PromptDetector 与 sendCtrl 闭包(验证:读三个 shell.ts 确认 handler 内有 `new PromptDetector` 与 `sendCtrl` 闭包定义)
- [ ] exec handler 按 ExecResult 三态正确格式化输出(验证:读三个 shell.ts 确认 `timedOut===true` 分支追加 `[timed-out: collected ${elapsedMs}ms of output, Ctrl+C sent]`)

## 三、 编译与测试

- [ ] 项目编译无错误(验证:`npm run build` 通过)
- [ ] lint 检查无新增错误(验证:`npx eslint -c eslint.config.ts src/mcp/shared src/mcp/tools/adb/shell.ts src/mcp/tools/ssh/shell.ts src/mcp/tools/serial/shell.ts src/shared/config.ts` 无 error)
- [ ] 代码符合 ts-lang-spec 要求(验证:lint 通过或人工检查命名/风格/JSDoc 注释)
- [ ] 文件编码未被破坏(验证:新建的 `mcp/shared/` 三文件为 UTF-8 无 BOM、LF;修改的 config.ts/三个 shell.ts/三个 index.ts 保持原编码与换行符不变,无乱码)

## 四、 端到端场景(adb 通道,真机)

> 以下场景在连接 LubanCat 设备的 adb shell 会话上执行,对应 spec 的 AC1-AC10。

- [x] **AC1** 控制字符工具可发送且语义正确:exec 执行 `logcat` 持续输出,调 `adb_shell_send_ctrl(session_id, key="c")`,logcat 被 SIGINT 终止,会话恢复(再 exec `echo after_sendctrl` 正常返回)— 实测通过
- [ ] AC1 补充 字节验证:读日志确认 send_ctrl 发送的字节恰好为 `\x03`,无附加换行(验证:`grep` 日志中 send_ctrl 相关记录)
- [x] **AC2** 前置冲刷消除残留污染:logcat 熔断后再 exec `echo after_sendctrl`,返回内容只有 `after_sendctrl` 及提示符,无 logcat 残留 — 实测通过
- [x] **AC3** 常驻命令自动熔断:exec 执行 `logcat` 传 `maxDuration:5000`,约 5 秒自动返回大量 kernel 日志并熔断,会话恢复可用 — 实测通过(输出过大被截断,但行为正确)
- [x] **AC4** 瞬时命令提前返回:exec 执行 `echo hello_pstriptest`,检测到提示符立即返回(明显短于 10 秒),无 timed-out 标注 — 实测通过
- [x] **AC5** 提示符检测:默认正则命中 Android 提示符 `rk3568_lubancat_2_v3_mipi1080p:/ $`(即 AC4 通过);配置覆盖场景未单独测(机制已实现)
- [x] **AC6** 长命令不被误杀:exec 执行 `sleep 3; echo done` 不传 maxDuration(默认 10 秒),3 秒内正常完成返回 done,无 timed-out 标注 — 实测通过
- [x] **AC7** 调用方覆盖长命令:exec 执行 `sleep 3; echo done` 传 `maxDuration:5000`,命令正常完成返回 done,未被熔断 — 实测通过
- [ ] AC8 三通道一致:见第五节(ssh/serial 无真机,靠代码同构保证)
- [ ] AC9 向后兼容:现有 write/read/close 工具签名不变(验证:grep 确认三处 shell.ts 的 write/read/close handler 未改签名);exec 旧参数(session_id/command/delay/clear)保留
- [ ] AC10 关键事件可观测:日志中能看到 send_ctrl 发送、熔断触发、前置冲刷三类事件记录
- [x] **adb PTY 生效**:`adb shell -t -t` 强制分配 PTY,banner 含提示符 `rk3568...:/ $`(不加 `-t -t` 时 banner 为空、提示符检测失效)— 实测通过
- [x] **PTY 回显剥离生效**:exec 返回输出无命令回显行(如 `:/ $ echo hi`),首行即为真实输出 — 实测通过

## 五、 三通道一致性(对应 AC8)

- [ ] 工具命名一致:adb/ssh 为 `*_shell_send_ctrl`,serial 为 `serial_send_ctrl`(遵循各自通道既有命名规范)
- [ ] 三个 send_ctrl 工具输入参数一致:`{ session_id, key: "c"|"u"|"d"|"z" }`
- [ ] 三个 exec handler 调用 runExec 的方式一致(验证:对比三处 runExec 调用,参数结构相同,仅 store/logPrefix/deviceName 不同)
- [ ] 三通道熔断行为一致:超时均发 Ctrl+C + 标注 timed-out(验证:读三处 exec handler 的格式化逻辑一致)

---
*本文档由 code-spec 技能辅助生成*
