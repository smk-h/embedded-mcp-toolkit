# 设备列表命令（dev list）Spec

## 背景

设备配置采用分文件布局：`.embedded/configs/devices/<设备名>.yaml`，文件名即设备名；`board-example.yaml` 是 `dev create` 的固定模板。ch19 已建立 `dev` 父命令（当前仅有 create 子命令）并预留 list/del 扩展点。

当前查看有哪些设备只能 `ls` 该目录，且看不到每台设备启用了哪些通道——通道禁用靠约定值（`serial.port="none"`、`ssh.host="none"`、`adb.serialNo="sn_none"`），需要逐个打开文件比对才能判断。config.yaml 根层的 `default` 字段标识默认设备，列表时可顺带标注。

## 目标

- `dev list` 一条命令列出 devices/ 下全部设备（含模板 board-example），并以状态摘要表展示每台的串口/SSH/ADB 通道启用情况。
- 纯只读命令：不改动任何文件、不连接设备。

## 功能需求

- F1: 注册 `dev list` 子命令（挂在 ch19 的 `dev` 父命令下），无必选参数。
- F2: 扫描 `.embedded/configs/devices/` 下全部 `.yaml`/`.yml` 文件，文件名（去扩展名）作为设备名；目录不存在或无 yaml 文件时打印提示并正常退出（非报错崩溃），提示可先运行 `dev create` 创建设备。
- F3: 每台设备解析 yaml 后按通道禁用约定判定各通道是否启用（串口：`serial.port` 为 `"none"` 或段缺失 → 禁用，`tcp://` 端点形态亦视为启用；SSH：`ssh.host` 为 `"none"` 或段缺失 → 禁用；ADB：`adb.serialNo` 为 `"sn_none"`、空值或段缺失 → 禁用），摘要表直接展示通道连接参数：
  - SERIAL 列：`端口@波特率`（如 `COM3@115200`；`tcp://` 端点原样展示；波特率缺失时仅显示端口）；
  - SSH 列：`用户名@主机`（如 `root@192.168.16.105`；用户名缺失时仅显示主机）；
  - ADB 列：序列号原样展示（如 `sn_123456`）；
  - 禁用的通道一律显示 `-`。
- F4: 模板标注：设备名为 `board-example` 的行追加 `(模板)` 标记。
- F5: 默认设备标注：读取 `.embedded/configs/config.yaml` 根层 `default` 字段，与列表中某设备名一致时该行追加 `(默认)` 标记；config.yaml 不存在、无 `default` 字段或指向的设备不在列表中时不标注、不报错。
- F6: 单个 yaml 解析失败时跳过该文件并在列表末尾打印告警（文件名 + 原因），其余设备正常列出，不中断。
- F7: 输出结构：banner、表头（NAME/SERIAL/SSH/ADB）、设备行（按设备名字典序）、设备总数、图例说明（`- 表示通道禁用/未配置`）；各列宽度按终端显示宽度自适应对齐（东亚全宽字符按 2 列计）。

## 非功能需求

- N1: 只读——不写入、不修改、不删除任何文件。
- N2: 输出风格与既有命令一致（emoji banner、列对齐、中文提示）。
- N3: 纯 CLI 侧新增——复用 ch19 的 `dev` 父命令与既有 js-yaml 依赖，不改动 sdk 核心与 MCP server。
- N4: 新建文件 UTF-8 无 BOM、LF；修改 `src/cli/index.ts` 保持原编码与换行符不变。

## 不做的事

- 不做删除/重命名/编辑等其它设备管理子命令（del 等留待后续章节）。
- 不探测设备真实连通性——不 ping、不连接，仅反映配置文件内容。
- 不做机器可读输出（JSON/CSV），不做过滤、排序等参数。
- 不读取分文件布局之外的设备来源——单文件布局 config.yaml 内嵌 devices 段的设备不在列表范围（既有 split 命令负责迁移到分文件布局）。
- 不支持自定义 devices 目录路径——固定 `.embedded/configs/devices`（与 dev create 的路径约定一致）。

## 验收标准

- AC1（对应 F1/F7）: `dev --help` 的子命令列表出现 `list`；运行 `dev list` 输出 banner、表头、按名称排序的设备行、总数与图例，各列对齐。
- AC2（对应 F2）: 临时移走 devices/ 目录后运行 `dev list`，打印无设备提示并正常退出（退出码 0）；目录恢复后列表正常。
- AC3（对应 F3）: 三列展示的连接参数与配置文件实际值一致（如 `COM3@115200`、`root@192.168.16.105`、`sn_123456`），禁用通道显示 `-`。
- AC4（对应 F4/F5）: `board-example` 行带 `(模板)` 标记；将 config.yaml 的 `default` 改为列表中某设备名时该行带 `(默认)` 标记，恢复原值后标记消失且无报错。
- AC5（对应 F6）: 临时放入一个非法 yaml 文件，其余设备正常显示且末尾出现该文件的告警；移除后告警消失。
- AC6（对应 N1）: 命令运行前后 devices/ 目录与 config.yaml 内容逐字节不变。
- AC7（对应 N3/N4）: `npm run build` 通过；`dev create` 与其它既有命令行为不变。
