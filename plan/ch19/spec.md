# 交互式设备配置创建命令（create）Spec

## 背景

工具链的设备配置采用分文件布局：`.embedded/configs/devices/<设备名>.yaml`，文件名即设备名（见模板文件 `board-example.yaml` 头部注释）。当前新建一台设备的唯一方式是手工三步：复制 board-example.yaml → 重命名 → 逐字段编辑。

问题：

- 模板 100+ 行，除 adb/ssh/serial 三个通道的连接字段外，还带 keyProvider、uboot、promptPattern 等必须保留的段，新手不清楚哪些该改、哪些不能动；
- 通道禁用靠约定值（`ssh.host="none"`、`serial.port="none"`、`adb.serialNo="sn_none"`，见模板头部注释），手工填写容易写错，导致通道被误启用或误禁用；
- CLI 已有 init/split/regex-verify/sshd-config 等命令，但「从零创建一台新设备」没有入口。

## 目标

- 新增 `create` 命令：交互式问答采集设备名与三通道（串口/SSH/ADB）连接参数，自动生成一台新设备的 yaml 配置文件。
- 生成的文件与模板同构：保留模板全部教学注释与未涉及的配置段（keyProvider/uboot/promptPattern 等），仅替换问答采集到的目标字段。
- 空输入的落盘值与模板头部注释定义的通道禁用约定完全一致（`none` / `sn_none`）。
- 生成后无需额外手工步骤，即可被 MCP server 既有配置加载机制识别。

## 功能需求

- F1: CLI 注册 `create` 子命令——`node bin\embedded-mcp-toolkit-cli.js create` 直接进入交互流程，无必选参数；支持可选 `-y` 标志（快速模式，见 F10）。
- F2: 命令启动后读取 `.embedded/configs/devices/board-example.yaml` 作为模板文本；模板不存在时报错退出，不生成任何文件。
- F3: 提示输入设备名，生成文件为同目录 `<设备名>.yaml`。仅允许字母、数字、点、下划线、连字符；非法字符就地重新提示；目标文件已存在时提示冲突并要求重新输入，绝不覆盖。
- F4: 串口连接信息一次输入：`端口@波特率`（如 `COM3@115200`）。直接回车 → `serial.port="none"`（`baudRate` 保留模板值）。按第一个 `@` 分割，端口非空、波特率为正整数；缺 `@`、缺段、波特率非数字等不合法输入就地重新提示。
- F5: 串口登录凭据一次输入：`登录用户名@密码`（如 `root@root`）。直接回车 → `loginUsername="none"`、`loginPassword="none"`。按第一个 `@` 分割（密码允许含 `@`）；缺少用户名段或密码段视为不合法，就地重新提示。
- F6: SSH 连接信息一次输入：`IP@端口`（如 `192.168.16.10@22`）；不带 `@端口` 时端口默认 22；直接回车 → `ssh.host="none"`（端口/凭据保留模板值），并跳过 F7 的凭据询问。
- F7: SSH 登录凭据一次输入，仅当 F6 输入了 IP 时提示，且不允许为空（为空或缺段就地重新提示）。格式与分割规则同 F5（`用户名@密码`，密码可含 `@`）。
- F8: 提示输入 ADB 序列号。直接回车 → `adb.serialNo="sn_none"`；输入非空时，原始输入已以 `sn_` 开头则原样落盘，否则自动加前缀落盘为 `sn_<输入>`。
- F9: 以文本替换方式改写模板中的目标字段（`adb.serialNo`；`ssh.host/port/username/password`；`serial.port/baudRate/loginUsername/loginPassword`），其余内容（全部注释、keyProvider、uboot、promptPattern 等设备级段）原样保留；写入 `.embedded/configs/devices/<设备名>.yaml`；完成后打印生成文件路径与各通道配置摘要。
- F10: `-y` 快速模式：`create -y` 完全免交互——不出现任何提示，直接使用固定默认设备名 `board-default`，把模板原文写入 `board-default.yaml`；同名文件已存在时自动递增后缀（`board-default-2.yaml`、`board-default-3.yaml`…），绝不覆盖。所有字段保留模板值，效果等价于「复制模板并重命名」。

## 非功能需求

- N1: 交互实现复用项目已有的 `@clack/prompts`（text/log/isCancel），与 `remote-mcp-config` 命令的交互风格一致；Ctrl+C/取消（isCancel）时优雅退出，不生成任何文件。
- N2: 模板替换必须精准定位目标字段行（按 YAML 缩进层级匹配 `字段名:` 行），仅替换该行值部分，不改动同行注释与其它任何行；替换完成后必须通过 js-yaml 解析校验，解析失败不落盘。
- N3: 生成文件编码 UTF-8 无 BOM、LF 换行。
- N4: 生成过程具备原子性——全部替换与校验在内存完成后一次性写盘；任一步失败不留半成品文件。
- N5: 代码风格与现有 CLI 命令一致（文件头注释、JSDoc @brief/@details、emoji 控制台输出、logCommand 日志记录）。
- N6: 纯 CLI 侧新增，不改动既有命令、MCP server 与 sdk 核心逻辑。

## 不做的事

- 不修改、不删除 `board-example.yaml` 模板本身。
- 不做设备配置的编辑与删除功能——本期只做创建。
- 不探测串口/SSH/ADB 的真实连通性——只生成配置，不连接、不 ping、不校验设备在线。
- 不做完全免交互的自定义命名——`-y` 模式设备名固定为 `board-default`，不支持通过命令行参数指定设备名或通道参数（如 `create --name xxx --serial COM3@115200`）；自定义设备名请使用交互模式。
- 不支持自定义模板路径——模板固定为 `board-example.yaml`。
- 不问答 promptPattern、uboot、keyProvider 等高级字段——一律保留模板默认值，用户后续可手改。
- 不改动 config.yaml 全局配置与既有设备文件。

## 验收标准

- AC1（对应 F1）: `node bin\embedded-mcp-toolkit-cli.js --help` 的命令列表含 `create` 及其描述；运行 `create` 进入交互问答流程。
- AC2（对应 F2）: 模板文件存在时正常进入问答；将模板临时移走后运行 `create`，报错退出且不生成任何文件。
- AC3（对应 F3）: 输入合法设备名（如 `myboard`）→ 生成 `.embedded/configs/devices/myboard.yaml`；输入已存在设备名 → 提示冲突并要求重新输入，原文件内容不变；输入含 `/`、空格等非法字符 → 就地重新提示。
- AC4（对应 F4/F5）: 串口输入 `COM3@115200` + `root@root` → 生成文件中 `serial.port="COM3"`、`baudRate=115200`、`loginUsername="root"`、`loginPassword="root"`；两行均直接回车 → `port="none"`、`loginUsername="none"`、`loginPassword="none"`、`baudRate` 保留模板值；只输入 `COM3`（缺 `@波特率`）→ 就地重新提示。
- AC5（对应 F6/F7）: SSH 输入 `192.168.1.10@22` → `host="192.168.1.10"`、`port=22`，且凭据行必填生效；输入不带 `@端口` 的 IP → `port` 落盘 22；SSH 直接回车 → `host="none"`、不再询问凭据、`username/password` 保留模板值。
- AC6（对应 F8）: ADB 输入 `123456` → `serialNo="sn_123456"`；输入 `sn_abc` → `serialNo="sn_abc"`（不重复加前缀）；直接回车 → `serialNo="sn_none"`。
- AC7（对应 F9/N2）: 打开生成的 yaml，模板注释、keyProvider、uboot 等段逐字保留，仅目标字段值与模板不同；`js-yaml` 解析通过且结构含 adb/ssh/serial 段。
- AC8（对应 N1/N4）: 问答全流程走完，控制台打印生成文件路径与各通道配置摘要；流程中途 Ctrl+C 退出 → 设备目录不出现新文件。
- AC9（对应 N3）: 生成文件为 UTF-8 无 BOM、LF 换行（编码检测工具核对）。
- AC10（对应 N6）: `npm run build` 通过；既有命令（init/split/regex-verify 等）`--help` 与行为不变。
- AC11（对应 F10）: 运行 `create -y`，全程无任何交互，直接生成 `board-default.yaml`，内容与 `board-example.yaml` 完全一致（等价于复制并重命名）；再次运行 → 生成 `board-default-2.yaml`，原文件不被覆盖。
