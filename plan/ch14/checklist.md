# 会话日志路径提供 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] `enableFromEnv` 返回值为日志文件路径（启用时）或 undefined（未启用时）（验证：编译通过 + 读返回类型签名）
- [ ] `SessionMeta` 含 `logPath?: string` 字段，`CreateSessionMeta` 同步含该字段（验证：编译通过 + 读接口定义）
- [ ] `ShellSessionStore.peekNextId()` 返回下一个将分配的 sessionId，不副作用计数器/registry（验证：调用后立即 create，二者返回的 sessionId 一致）
- [ ] `create()` 将 `meta.logPath` 透传进 registry 的 meta（验证：create 后 `registry.getBySession(id).logPath` 与传入值一致）
- [ ] `session_info` 的 `formatSessionMeta` 输出新增 `Log:` 行（验证：读 session_info.ts 源码确认新增行）

## 三通道集成

- [ ] serial 通道建立会话后，元数据中的 logPath 为实际日志文件路径（验证：`session_info(serial_session_id)` 返回的 Log 行路径与磁盘文件一致）
- [ ] ssh 通道建立会话后，元数据中的 logPath 为实际日志文件路径（验证：`session_info(ssh_session_id)` 返回的 Log 行路径与磁盘文件一致）
- [ ] adb 通道建立会话后，元数据中的 logPath 为实际日志文件路径（验证：`session_info(adb_session_id)` 返回的 Log 行路径与磁盘文件一致）
- [ ] 调用顺序调整后，不重复创建日志文件（验证：建立一次会话后，该 sessionId 对应目录下只有一个 `.log` 文件）

## 未启用场景

- [ ] `SAVE2FILE_PATH` 未配置时，`enableFromEnv` 返回 undefined，会话元数据 logPath 为空（验证：未配置环境变量建立会话后 `registry.getBySession(id).logPath` 为 undefined）
- [ ] 未启用时 `session_info` 的 Log 行显示 `(file logging disabled)`（验证：未配置环境变量时调用 session_info 观察输出）
- [ ] 未启用时不产生任何文件路径（验证：session_info 输出不含 `.log` 路径字符串）

## 复用与持久性

- [ ] 复用已有会话（同一物理端口第二次建立）时，`session_info` 返回的日志路径与首次一致（验证：两次建立同一串口会话，对比 session_info 输出的 Log 路径相同）
- [ ] peekNextId 保证预览 ID 与最终 create 分配的 ID 完全一致（验证：日志文件名中的 sessionId 与 session_info 返回的 id 前缀一致，如 `serial_1_xxx.log` 对应 `serial_1`）

## 编译与测试

- [ ] `npm run build` 编译无错误
- [ ] `npm run format:check` 通过（或 format:fix 后通过）
- [ ] eslint 无错误（验证：`npm run eslint:fix` 后无报错）
- [ ] 代码符合 ts-lang-spec 规范要求（验证：lint 通过或人工检查命名/注释风格）
- [ ] 文件编码未被破坏：新建文件 UTF-8 无 BOM、LF 换行；修改的已有文件保持原编码不变（验证：编码检测无乱码，git diff 无意外编码变更）

## 端到端场景

- [ ] **场景 1（serial 抓启动日志，核心场景）：** serial_shell_login 建立会话 → session_info 拿到日志路径并记住 → 设备执行 reset/enter_uboot 后等系统起来 → 用文件读取能力打开 session_info 报告的路径 → 内容包含启动日志（如 kernel/U-Boot 特征），证明路径提供与日志持续写入解耦、互不影响
- [ ] **场景 2（多会话不混淆）：** 同一设备建立两次会话（产生两个不同的 sessionId），分别用 session_info 查询，两次返回的日志路径各自指向不同的 `.log` 文件，不串号
- [ ] **场景 3（跨通道查询）：** 同时存在 serial/ssh/adb 各一个会话，无参调用 session_info 列出全部，每个会话的 Log 行均正确显示各自路径
- [ ] **场景 4（未启用一致性）：** 不配 SAVE2FILE_PATH 时，serial/ssh/adb 任意通道建立会话，session_info 均显示 `Log: (file logging disabled)`
