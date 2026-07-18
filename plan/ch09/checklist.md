# 日志文件命名与目录结构优化 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。与 spec.md 的 AC1–AC9 一一对应，并补充集成、编译、端到端检查。

## 实现完整性

- [ ] **AC1 命令日志文件名格式正确**（对应 F1、F3）：启用日志启动 MCP server（`LOG_SAVE=1`），在 `LOG_DIR` 根目录下查看新生成的命令日志文件名，形如 `2026-07-18_135400.log`（日期用 `-` 分隔、时分秒紧凑无分隔符）。（验证：列出 `.embedded/log/` 根目录文件，核对文件名正则 `^\d{4}-\d{2}-\d{2}_\d{6}\.log$`）
- [ ] **AC2 终端原始日志落盘到设备子目录**（对应 F2）：打开任意通道（adb / serial / ssh / powershell）的 shell 会话，查看新生成的终端原始日志文件路径为 `<LOG_DIR>/<deviceName>/`，文件名形如 `serial_1_2026-07-18_135301.log`；`deviceName` 与 `resolveDeviceName()` 返回值一致（如 `board-lubancat`）。（验证：列出 `.embedded/log/<deviceName>/` 目录，核对路径段与配置默认设备名一致；文件名正则 `^\w+_\d+_\d{4}-\d{2}-\d{2}_\d{6}\.log$`）
- [ ] **AC3 设备子目录自动创建**（对应 F2）：删除目标设备子目录后，首次写终端原始日志不应报错，目录被自动重建；连续打开多个会话，所有日志复用同一子目录。（验证：删 `.embedded/log/board-lubancat/` → 开 serial 会话 → 目录自动出现且含日志；再开 ssh 会话 → 同目录新增第二个文件）
- [ ] **AC4 文件名时间戳统一**（对应 F3）：对比同一次运行产生的命令日志与终端原始日志文件名，两者时间戳部分格式一致，均为 `YYYY-MM-DD_HHMMSS`。（验证：肉眼/脚本对比两类文件名的时间戳段，模式相同）
- [ ] **AC5 日志文件内部格式不变**（对应 F1、F3）：打开新生成的命令日志文件，首行头部仍为 `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log YYYY.MM.DD HH:mm:ss =~=~=~=~=~=~=~=~=~=~=~=`，每行前缀仍为 `[YYYY-MM-DD HH:mm:ss]`；终端原始日志每行前缀仍为 `[YYYY-MM-DD HH:mm:ss]`。（验证：读取文件首行和任意正文行，核对前缀格式未变）
- [ ] **AC6 文件名字典序等于时间序**（对应 N2）：在同一目录下连续产生 3 份以上日志文件（如反复 open/close 同一通道会话），用 `ls` 默认排序（字典序）和按修改时间排序对比，结果一致。（验证：`ls -1 <dir>` 与 `ls -1t <dir>` 输出顺序相同）
- [ ] **AC7 历史日志不受影响**（对应 N1）：改动后启动服务，`.embedded/log/` 下已有的旧格式文件（如 `2026-07-18_13-54-00.log`、`serial_1_2026-07-18_13-53-01.log`）文件名和位置保持不变。（验证：改动前后分别 `ls` 根目录，旧文件名/路径完全一致）
- [ ] **AC8 环境变量语义不变**（对应 N1）：设 `LOG_SAVE=0` 启动，命令日志不产生新文件；设 `SAVE2FILE_PATH=none` 启动，终端原始日志不产生新文件。（验证：分别在两种环境下运行后，核对无新日志文件生成）
- [ ] **AC9 降级行为**（对应 N4）：构造 `deviceName` 为空串/undefined 的场景（如临时改一处调用点不传 deviceName），日志应降级写入 `<log_dir>/` 根目录，且主流程不中断；命令日志中应有一条 `[file-logger] file logging enabled: <根目录路径>` 记录。（验证：人为省略 deviceName 调用 → 文件落在根目录 → 会话仍可正常 open/exec/close）

## 集成

- [ ] **所有 `enableFromEnv` 调用点均透传 deviceName**：`grep -rn "enableFromEnv" src/` 输出的 7 个调用点全部含第二个参数（adb 1 处、serial 3 处、ssh 2 处、powershell 1 处为 `"local"`）。（验证：grep 输出逐条核对，无遗漏调用点）
- [ ] **PowerShell 落入 local 子目录**：打开 powershell 会话，终端原始日志落在 `<log_dir>/local/` 下，与远程设备目录隔离。（验证：开 powershell 会话后查看 `local/` 目录存在且含日志文件）
- [ ] **reopen / login 场景一致**：对 serial / ssh 触发 reopen（如断线重连）和 serial 的 login 场景，新会话日志仍正确落入对应设备子目录，文件名 sessionId 正确（serial reopen 用 `newId`）。（验证：触发 reopen 后，新 sessionId 对应的日志出现在同一设备子目录）

## 编译与测试

- [ ] **项目编译无错误**：`npx tsc --noEmit` 退出码 0，无类型错误。（验证：命令执行后无任何 error/warning 输出）
- [ ] **构建产物正常**：`npm run build`（或项目既定构建命令）成功，`out/` 产物更新。（验证：构建命令退出码 0）
- [ ] **lint 检查通过（如有配置）**：执行项目既定 lint 命令，无新增告警。（验证：lint 命令无新增 error/warning；若项目无 lint 配置则跳过本项）
- [ ] **代码符合 `ts-lang-spec` 规范**：命名、注释（JSDoc 格式与既有风格一致）、缩进、ESM import 路径（`.js` 后缀）均符合 plan.md 声明的语言规范。（验证：人工抽查 `timestamp.ts`、`file-logger.ts` 两处主改动，与既有代码风格一致）
- [ ] **文件编码未被破坏**：本次修改的 6 个源文件保持原编码（UTF-8 无 BOM、LF 换行）写回，无乱码、无 BOM 新增。（验证：用编码检测工具或 `file <path>` 核对，与改动前编码一致）

## 端到端场景

- [ ] **场景 1：多设备混合运行**（主路径）：配置两个不同设备（如 `board-lubancat` 和 `board-a`），分别启动服务并打开 serial 会话 → 各自日志分别落在 `.embedded/log/board-lubancat/` 和 `.embedded/log/board-a/` 下，互不混淆；命令日志在根目录。预期：两设备目录独立存在，各含各自的 `serial_*.log`，根目录有当次命令日志。
- [ ] **场景 2：本地终端隔离**：打开 powershell 会话 → 日志落在 `.embedded/log/local/`，不与任何远程设备目录混淆。预期：`local/` 目录独立存在，远程设备目录中不出现 powershell 日志。
- [ ] **场景 3：同设备多会话聚合**：对同一设备 `board-lubancat` 连续打开 serial_1、ssh_2 两个会话 → 两份终端原始日志均落在 `.embedded/log/board-lubancat/`，sessionId 分别为 `serial_1`、`ssh_2`。预期：同一设备子目录下出现两份不同 sessionId 前缀的日志文件。
- [ ] **场景 4：边界——日志功能关闭**：设 `SAVE2FILE_PATH=none` 启动并打开会话 → 不产生终端原始日志文件，不报错；命令日志不受影响（受 `LOG_SAVE` 独立控制）。预期：会话正常 open/exec/close，无新终端日志文件生成。
