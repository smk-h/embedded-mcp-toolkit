# 我的初步想法

设备终端日志在创建时，目录名有时和实际连接的设备对不上。典型现象：

- 通过 adb 登录 board-b，日志却被创建到 `board-a/` 子目录下
- 或者反过来：连的是其他设备，目录却固定是 `board-b/`

---

## 澄清后的最终方案

经过排查，根因不在"识别不准"，而在**目录名用了连接前的静态猜测值，而非连接后的真实 serialNo（adb 序列号）**。

### 1. 根因：日志目录与真实连接解耦

`adb_shell_open` 的流程（`src/mcp/tools/adb/shell.ts`）：

```ts
const deviceName = args.device ?? resolveDeviceName();  // ① 连接前猜
banner = await shell.open();                            // ② 连接（可能连到别的设备）
shell.fileLogger.enableFromEnv(sessionId, deviceName);  // ③ 用 ① 的猜测建目录
```

- **第①步的 `deviceName`**：AI 传了 `args.device` 就用之；没传则走 `resolveDeviceName()`，返回 `process.env.DEVICE`（来自 `.mcp.json`，常量 `board-b`）或 `config.yaml` 的 `default`，或硬编码兜底 `board-a`。
- **第②步的真实连接**：`board-b.yaml` 中 `adb.serialNo: "sn_none"`，目标设备完全交给 `adb devices` 自动发现，连上哪台算哪台。

两者由**互相独立**的机制决定。只要 AI 没传 `args.device`，目录就永远是那个静态值，和实际连上的板子毫无关系——错位必然发生。

### 2. 两种现象同源

| AI 调用方式 | `deviceName` 取值 | 日志目录 | 对应现象 |
|---|---|---|---|
| 传了 `device="xxx"` | xxx | `xxx/` | 目录正确 |
| 没传 + `process.env.DEVICE=board-b` | board-b | `board-b/` | 「连了别的设备，目录却固定 board-b」 |
| 没传 + env 未设、走 config/default 兜底 | board-a | `board-a/` | 「连了别的设备，目录却是 board-a」 |

→ 不是两个 bug，是**同一个 bug 在"AI 是否传 device"两种取值下的不同表现**。

### 3. 对照：Serial/SSH 为何不会出错

它们的连接目标（host/串口号）本身就从静态 `deviceName` 对应的配置里取，"连哪个"和"记到哪个"天然一致。ADB 因为把目标决定权下放给 adb 自动发现，才让两者解耦。

### 4. 连带影响

错误的 `deviceName` 还会被存入会话表（`session-store.ts`）和设备索引（`registry.ts` 的 `#sessionsByDevice`），导致 `registry.getByDevice("board-b")` 查不到实际连着 board-b 的 adb 会话——同一个根因的扩散面。

---

## 解决方案：连接后用实际 serialNo 反查设备名，三级降级

核心思想：**把日志启用挪到 `shell.open()` 之后，用真实 serialNo 决定目录名**，而不是连接前猜。

> 命名约定：本文档中 `serial`/`serialNo` 指的是 **adb 序列号**（device serial number），与"串口（serial port）"无关。为避免歧义，代码与文档统一用 `serialNo`。

### 目录命名优先级

| 优先级 | 条件 | 目录命名 | 示例 |
|---|---|---|---|
| 1 | AI 显式传 `args.device` | 用 `args.device` | `board-b/` |
| 2a | serialNo 有效 + config 反查命中 | 用反查到的别名 | `board-lubancat/` |
| 2b | serialNo 有效但未在 config 绑定 | 用 serialNo 本身 | `43b1e5fe7b186666/` |
| 3 | serialNo 无效（`????????????` / 空 / `(auto)`）| 固定占位符 | `adb-unknown/` |

### 关于"调试设备无序列号"

部分开发板/工模设备出厂未烧录序列号，`adb devices` 显示 `????????????`。此时：

- **无法反查任何别名**（`????????????` 永远匹配不到 config）
- 多台无序列号设备同时在线时，`#discoverDevice()` 会直接抛错（`Multiple ADB devices found`），根本走不到建日志这一步
- 单台无序列号设备：统一写入固定目录 `adb-unknown/`，同一块调试板的多次会话日志聚合在一处，便于排查

### 修复涉及的改动范围（供 plan/task 参考）

- 新增：`src/shared/config.ts` 增加 `resolveDeviceNameBySerialNo(serialNo)` 反查函数
- 改造：`src/mcp/tools/adb/shell.ts`
  - `enableFromEnv` 调用挪到 `shell.open()` 之后
  - 用真实 serialNo 按三级策略算 `deviceName`
  - 同步更新 `adbStore.create()` 里存的 `deviceName`（顺手修掉 `registry.getByDevice()` 的错位）
- 同步：`src/mcp/tools/adb/exec.ts:201-202` 同模式处理（exec 无持久 shell，但现场 `adb devices` 也能拿到 serialNo）
- 可选：更新 `device` 参数的 schema description，向 AI 说清楚「不传则按实际 serialNo 反查」

---

## 补充：实测发现的 AI 误用场景（初版上线后发现）

初版（仅"信任 args.device"）上线后，实测发现一个新的错位路径：

### 现象

AI 调用 adb 工具时，习惯先调 `adb_device_list` 扫描在线设备，拿到 serialNo（如 `43b1e5fe7b186666`），再把这个 serialNo 作为 `device` 参数传给 `adb_shell_open`。结果日志目录变成了 `.embedded/log/43b1e5fe7b186666/`（串号目录），而非人类可读的 `board-lubancat/`。

### 根因

初版的优先级 1 是「args.device 非空 → 无条件信任调用方」，**隐含假设是"调用方传的都是别名"**。但 AI 的实际行为打破了这个假设——它传的是 serialNo。resolver 在「能反查到别名」的情况下却硬用了 serialNo 作目录名，结果反直觉。

### 修复方向

两层组合：

**① schema description 收紧**（从源头减少误用）
- 把 `device` 参数描述从模糊的 "device identifier" 改成明确的 "Device alias (e.g. board-lubancat)"——**不提 config.yaml**，避免诱导 AI 直接读配置文件（别名查询应走 `device_info_tool` 或工具内部自动处理）
- 显式告诉 AI「不传 device 时程序会自动反查，NO need to call adb_device_list first」，减少 AI 的习惯性预扫描

**② resolver 防御性纠正**（兜底保证结果正确）
- 优先级 1 拆成 1a/1b：
  - **1a**：args.device 本身是 serialNo（能被反查为别名）→ 纠正为别名
  - **1b**：args.device 是别名或未登记标识 → 原样使用（与初版行为一致）
- 1a 的判定：`isValidSerialNo(argDevice) && resolveDeviceNameBySerialNo(argDevice) 命中`
- 别名（如 `board-lubancat`）含字母和连字符，不会被 `isValidSerialNo` 误判为 serialNo，所以 1a 不会误伤正常传别名的场景

### 设计权衡

纯粹的"信任调用方"语义被削弱了——程序现在会主动纠正误传的 serialNo。但权衡之下：
- 收益：高频误用场景（AI 预扫描）结果自动正确，不再产生串号目录
- 代价：如果调用方**故意**想用 serialNo 作目录名（罕见），1a 会覆盖掉这个意图。但这种场景在项目中未出现，且 1b 仍保留了"未登记 serialNo 原样使用"的逃逸路径
