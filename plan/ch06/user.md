# ch06 用户需求：会话存储统一

## 背景现象

ch05 完成后，传输层的四个类已统一继承 `BaseShell`，获得了 `open/write/read/drain/close` 的统一签名。但**工具层**（`src/mcp/tools/`）仍是 ch05 重构前的状态——四个通道的工具文件各自独立维护着一套近乎相同的会话存储设施。

当前四个工具文件的规模与分布：

| 文件                          | 行数             | 特有工具                                       |
| ----------------------------- | ---------------- | ---------------------------------------------- |
| `tools/ssh/shell.ts` + 同目录 | 724 + build/sftp | shell_login、build、sftp_upload、sftp_download |
| `tools/serial/shell.ts`       | 909              | shell_login、enter_uboot                       |
| `tools/adb/shell.ts` + 同目录 | 424 + exec       | device_list、exec（一次性）                    |
| `tools/win/powershell.ts`     | 387              | （无）                                         |
| **合计**                      | **~2444**        |                                                |

四个文件合计约 2444 行。其中各文件都各自维护着一份 `sessions Map + sessionCounter + create/register/unregister/disposeAll`——这部分是**真正稳定、可统一**的重复，是本章的处理对象。

## 痛点

### 1. 会话存储逻辑各自为政

每个文件都有这样一套独立设施：

```ts
const sessions = new Map<string, XxxShell>(); // 四个文件各一个
let sessionCounter = 0; // 模块级全局变量，四个各一个
// + 各自的 create / register / unregister / disposeAll 逻辑
```

问题：

- `sessionCounter` 是**散落的模块级变量**，全局视图不清晰，将来若要支持热重载或测试隔离会冲突。
- 各文件对 `registry`（中心化会话注册表）的调用约定靠人工保持一致，没有统一约束。
- SSH 的 `sessions` 是 `export` 的（跨文件访问需求），其余三个是模块私有，可见性不统一。
- 串口额外维护了 `portToSession`（防止同一 COM 口重复打开），这是通道特有逻辑，但当前与通用存储设施混在同一份样板里。

### 2. ch05 成果在会话存储层未被利用

ch05 让四个传输类统一为 `BaseShell` 子类，但工具层仍以各自的具象类型（`SSHShell` / `SerialShell` / ...）操作 sessions。本可以用一个泛型 `Map<string, BaseShell>` 表达"任意一种 shell"，现在却是四个独立的具象 Map。把会话存储统一成一个泛型类，能直接吃下 ch05 的类型统一红利。

## 关键前提

- 本章**依赖 ch05 已完成**：四个传输类已统一继承 `BaseShell`，具备 `open/write/read/drain/close` 的统一签名。这是泛型会话存储能工作的类型基础。
- **`open` 工具仍由各通道自定义**：四个通道的 open 参数差异大（Serial 有 port/baudRate/dataBits/stopBits/parity、ADB 有设备发现逻辑、SSH/PowerShell 各有配置），由各自文件实现。
- **通道特有工具保留在各自文件**：SSH 的 `shell_login`/`build`/`sftp_*`、Serial 的 `shell_login`/`enter_uboot`、ADB 的 `device_list`/`exec`，承载通道专属业务逻辑，只复用会话存储。
- session ID 的**生成格式保持不变**（`ssh_1` / `serial_3` / `adb_2` / `power_1`），避免破坏现有用户的习惯和已写好的提示词。
- `registry`（`src/mcp/sessions/registry.ts`）的中心化元数据管理**保持不变**，会话存储层只是把对 registry 的调用收敛到一处。

## 选定方向

只提取一层通用设施：**泛型会话存储**。通道文件各自保留 open 和特有工具的 handler 实现，仅把"会话存哪儿、ID 怎么生成、怎么注册到 registry、怎么统一销毁"收敛到一个泛型类。

### 目标结构

```
src/mcp/
├── sessions/
│   ├── registry.ts         # 已有：id → 元数据
│   ├── session-store.ts    # 新增：ShellSessionStore<T extends BaseShell>
│   └── index.ts            # 新增：聚合导出
├── tools/
│   ├── ssh/
│   │   ├── shell.ts        # 改：open + 特有工具（均复用 store）
│   │   └── index.ts        # 改：各工具仍逐条注册，handler 取自本通道文件
│   ├── serial/             # 同上结构，额外保留 portToSession 防重
│   ├── adb/                # 同上结构
│   └── win/                # 同上结构
```

### 会话存储承担的职责

把四个文件里重复的 `sessions Map + sessionCounter + create/register/unregister/disposeAll` 收敛到一个泛型类：

- 以 `session_id` 为键存储 `BaseShell` 子类实例
- 生成 ID（`<prefix>_<自增>`，格式与现状一致）
- 注册/注销到中心化 `registry`
- 提供 `get` / `require`（不存在时返回统一的 not-found 响应）/ `disposeAll`
- Serial 的 `portToSession` 防重作为**通道侧的扩展能力**保留在 serial 目录内（不进基类存储），通过 store 提供的 `get`/`require` 配合本通道自己的查重逻辑实现。

## 范围边界

- **只统一会话存储**：新增 `ShellSessionStore<T extends BaseShell>`，四个通道改为各自持有一个 store 实例。
- **不动传输层**（BaseShell 及四个子类保持 ch05 后的状态）。
- **不改 `tool-registry.ts`**（`mcpDefineTool` / `ToolEntry` 等基础构件保持不变）。
- **各通道的 `index.ts` 仍逐条注册工具**：新增/修改工具仍需在对应通道文件内操作。
- **不改对外工具契约**：工具名、参数 schema、返回结构与现状逐字一致，仅内部实现路径变化。
- **通道特有工具（login/build/sftp/enter_uboot/device_list 等）保留在各自通道文件**，只让它们复用会话存储。
- **`open` 工具仍由各通道自定义**（参数差异太大）。
- **不引入 alerts / 持续监听**（独立章节 ch08）。
- **不改 `src/mcp/server.ts`** 的工具批量注册循环：它仍遍历各通道的 `mcpXxxTools` 数组。
- **不改变 `disposeAll` 对外的导出函数名**（`disposeAllSshSessions` 等），因为 `server.ts` 的 cleanup 钩子按名引用它们。
