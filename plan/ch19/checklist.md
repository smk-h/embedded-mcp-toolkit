# 交互式设备配置创建命令（create）Checklist

> 每一项通过运行命令或观察行为来验证，聚焦系统行为。对应 spec.md 的 AC1-AC11。

## 实现完整性

- [ ] `create` 子命令已注册且可被调用（验证：`node bin\embedded-mcp-toolkit-cli.js --help` 命令列表出现 `create` 及描述）— AC1
- [ ] `-y` 快速模式零交互直接生成（验证：运行 `create -y`，全程无任何提示，生成 `board-default.yaml`，内容与 `board-example.yaml` 一致；再跑一次生成 `board-default-2.yaml` 且原文件不变）— AC11
- [ ] 模板不存在时报错退出（验证：临时移走 `board-example.yaml` 运行 `create`，打印明确错误、不生成文件；恢复模板）— AC2
- [ ] 设备名合法性校验与冲突保护生效（验证：输入含 `/` 或空格的名称被就地重提；输入 `board-example` 被提示冲突要求重输，原模板文件内容不变）— AC3

## 集成

- [ ] 模板替换保注释：生成文件仅目标字段值变化，全部注释、keyProvider、uboot 段逐字保留（验证：交互生成一份设备文件，与模板 diff 对比仅九个目标字段行有差异；生成的文件可被 js-yaml 解析且含 adb/ssh/serial 段）— AC7
- [ ] 串口字段替换正确（验证：串口输入 `COM3@115200` + `root@root` → `port: "COM3"`、`baudRate: 115200`、`loginUsername: "root"`、`loginPassword: "root"`）— AC4 启用分支
- [ ] SSH 字段替换正确（验证：输入 `192.168.1.10`（不带 @端口）→ `host: "192.168.1.10"`、`port: 22`；凭据 `admin@secret` 必填生效，空输入被重提）— AC5 启用分支
- [ ] ADB 序列号归一正确（验证：输入 `123456` → `serialNo: "sn_123456"`；输入 `sn_abc` → `"sn_abc"` 不重复加前缀；直接回车 → `"sn_none"`）— AC6
- [ ] 通道禁用约定落盘正确（验证：串口/SSH 均直接回车 → `port: "none"`、`host: "none"`，`baudRate`/`ssh.port`/两端凭据保留模板值；串口只输 `COM3` 缺 `@波特率` 被就地重提）— AC4/AC5 禁用分支
- [ ] 完成反馈完整（验证：全流程走完控制台打印生成文件路径与串口/SSH/ADB 各通道配置摘要）— AC8 前半

## 编译与测试

- [ ] `npm run build` 编译零错误（验证：tsc 输出无 error）
- [ ] 既有命令行为不变（验证：`init`/`split`/`regex-verify` 的 `--help` 正常显示，选项与改动前一致）— AC10
- [ ] 代码符合 `ts-lang-spec` 与既有命令风格（验证：人工核对文件头注释、JSDoc @brief/@details、命名与 `split.ts`/`remote-mcp-config` 一致；无 lint 脚本，人工检查）
- [ ] 文件编码合规（验证：新建的三个 ts 文件与生成的设备 yaml 为 UTF-8 无 BOM、LF；`src/cli/index.ts` 编码/换行与修改前一致，无乱码）— AC9/N3

## 端到端场景

- [ ] 场景 1（交互全流程启用全部通道）：`create` → 设备名 `e2e-test` → 串口 `COM3@115200` + `root@root` → SSH `192.168.1.10` + `admin@secret` → ADB `123456` → 生成 `.embedded/configs/devices/e2e-test.yaml`，九个目标字段值正确、摘要正确、MCP 重启后可识别该设备 — AC1/AC3/AC4/AC5/AC6/AC7/AC8
- [ ] 场景 2（快速模式）：`create -y` → 直接生成 `board-default.yaml`，内容与模板逐字节一致（等价复制改名）— AC11
- [ ] 场景 3（全禁用边界）：`create` → 设备名 `e2e-none` → 串口回车 → 串口凭据回车 → SSH 回车 → ADB 回车 → `port: "none"`、`host: "none"`、`serialNo: "sn_none"`，凭据/baudRate/port 保留模板值 — AC4/AC5
- [ ] 场景 4（中断安全）：交互中途 Ctrl+C → 进程优雅退出，devices 目录无新增文件，再次运行正常 — AC8/N1/N4
- [ ] 走查产物清理：验证结束后删除 `e2e-test*.yaml`、`e2e-none*.yaml`、`board-default*.yaml`（验证：`ls .embedded/configs/devices/` 仅剩原有文件）
