<!-- more -->

## 一、 概述

### 1. 背景

项目通过 MCP 服务器管理嵌入式 Linux 板卡，支持 SSH 、串口和 ADB 三种连接方式。原有架构中，四个连接模块（SSH 、Serial 、ADB 、PowerShell）各自维护独立的会话 Map，存在以下问题：

- **设备名丢失**：SSH / Serial 的 `open` 拿到 `device` 参数后仅用于解析连接配置，设备别名被丢弃
- **无双向查询**：无法按设备名查会话，也无法按 session_id 查所属设备
- **list 工具信息贫乏**：`ssh_shell_list` 仅返回 `ssh_1, ssh_2`，无设备名 / host / port
- **跨类型孤立**：四个独立 Map 互不感知，无统一入口

### 2. 目标

- 支持 `设备名 → 所有会话` 的双向查询
- 支持 `session_id → 设备名 + 连接类型 + 连接详情` 查询
- 增强 list 工具输出，展示设备名和连接信息
- 新增 `session_info` 工具，提供跨类型统一查询入口

## 二、 架构概览

### 1. 组件关系

```text
┌─────────────────────────────────────────────────────────────┐
│                      MCP 工具层                              │
│  ssh_shell_open  serial_open  adb_shell_open  power_shell   │
│       │               │              │             │        │
│       ▼               ▼              ▼             ▼        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SessionRegistry (单例)                  │    │
│  │  #metaBySession     : sessionId → SessionMeta       │    │
│  │  #sessionsByDevice  : deviceName → Set<sessionId>   │    │
│  └─────────────────────────────────────────────────────┘    │
│       ▲               ▲              ▲             ▲        │
│  sessions Map    sessions Map   sessions Map   sessions Map │
│  (SSHShell)     (SerialShell)  (AdbShell)   (PowerShell)    │
└─────────────────────────────────────────────────────────────┘
```

- **Transport 实例**仍由各模块的 `Map<string, Transport>` 独立管理
- **SessionRegistry** 只存储轻量元数据，不持有 Transport 引用，避免循环引用和 GC 问题
- 所有查询均为 O(1)

### 2. SessionRegistry 单例

该单例在 `src/mcp/sessions/registry.ts` 文件中定义，全局唯一。其核心数据结构如下：

```typescript
class SessionRegistry {
  #metaBySession = new Map<string, SessionMeta>();       // sessionId → 元数据
  #sessionsByDevice = new Map<string, Set<string>>();    // deviceName → Set<sessionId>
}
```

## 三、 SessionRegistry 设计

### 1. SessionMeta 接口

该接口在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
interface SessionMeta {
  id: string;            // session_id，如 "ssh_1"、"serial_3"
  type: SessionType;     // 连接类型：ssh | serial | adb | powershell
  deviceName: string;    // 设备别名，如 "board-a"；PowerShell 为 "local"
  connectionInfo: string; // 连接详情，如 "192.168.16.103:22"、"COM3@115200"
  createdAt: string;     // ISO 时间戳
}
```

【**接口字段说明**】

- `id`：由各模块在 open / login 时生成，格式为 `<prefix>_<counter>`，如 `ssh_1`
- `type`：区分连接类型，用于 list 工具按类型过滤
- `deviceName`：从 tool 调用参数或环境变量 `DEVICE` 解析，PowerShell 固定为 `"local"`
- `connectionInfo`：人可读的连接标识，不同类型格式不同（详见下表）
- `createdAt`：ISO 8601 格式的创建时间，用于排序

`connectionInfo` 各类型格式：

| 类型 | 格式示例 |
|------|---------|
| ssh | `192.168.16.103:22` |
| serial | `COM3 @ 115200` |
| adb | `43b1e5fe7b186666` |
| powershell | `E:\project`（工作目录） |

### 2. register()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
register(meta: SessionMeta): void
```

【**函数作用**】将会话元数据写入双向索引，同时记录日志

【**参数含义**】

- `meta`：会话元数据对象

【**返回值**】无

### 3. unregister()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
unregister(sessionId: string): void
```

【**函数作用**】从双向索引中移除指定会话，同时清理空的设备条目

【**参数含义**】

- `sessionId`：要移除的会话 ID

【**返回值**】无

### 4. getBySession()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
getBySession(sessionId: string): SessionMeta | undefined
```

【**函数作用**】根据 session_id 获取会话元数据，O(1) 查询

【**参数含义**】

- `sessionId`：会话 ID

【**返回值**】找到时返回 `SessionMeta`，未找到返回 `undefined`

### 5. getByDevice()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
getByDevice(deviceName: string): SessionMeta[]
```

【**函数作用**】获取指定设备的所有活跃会话，按创建时间降序排列

【**参数含义**】

- `deviceName`：设备别名，如 `"board-a"`

【**返回值**】该设备下的会话元数据数组，无会话时返回空数组

### 6. listByType()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
listByType(type: SessionType): SessionMeta[]
```

【**函数作用**】按连接类型过滤活跃会话，用于各 list 工具

【**参数含义**】

- `type`：连接类型（`"ssh"` / `"serial"` / `"adb"` / `"powershell"`）

【**返回值**】该类型下所有会话元数据数组，按创建时间降序

### 7. listAll()

该函数在 `src/mcp/sessions/registry.ts` 文件中声明：

```typescript
listAll(): SessionMeta[]
```

【**函数作用**】获取全部活跃会话，先按类型分组，同类型内按创建时间降序

【**返回值**】所有活跃会话的元数据数组

## 四、 工具层集成

### 1. 会话注册流程

每个 open / login handler 在调用 `sessions.set()` 之后，调用 `registry.register()` 登记元数据：

```text
1. 解析 deviceName（args.device ?? env.DEVICE ?? "default"）
2. 将 deviceName 写入 Transport 配置
3. 创建 Transport 实例并 open()
4. 生成 sessionId，存入 sessions Map
5. registry.register({ id, type, deviceName, connectionInfo, createdAt })
```

涉及文件：

- `src/mcp/tools/ssh/shell.ts` — `sshShellOpenHandler` / `sshShellLoginHandler`
- `src/mcp/tools/serial/shell.ts` — `serialOpenHandler` / `serialShellLoginHandler`
- `src/mcp/tools/adb/shell.ts` — `adbShellOpenHandler`
- `src/mcp/tools/win/powershell.ts` — `powerShellOpenHandler`

### 2. 会话注销流程

每个 close handler 和 login 失败路径在关闭连接后调用 `registry.unregister()`。

SSH login handler 有 5 个失败路径需 unregister（LOCKED 无 handler 、解锁失败、UNLOCKING 无 key 、UNLOCKING 解锁失败、ERROR 状态）。

Serial login handler 通过 `cleanupNewSession` 辅助函数统一处理新建会话的清理（关闭连接 + 从 Map 移除 + registry unregister）。

### 3. list 工具增强

各 list 工具由原先遍历本地 `sessions.keys()` 改为调用 `registry.listByType()`，输出格式统一增强：

**`ssh_shell_list` 示例输出**：

```text
Active SSH sessions: 2

  [ssh_1]  board-a  192.168.16.103:22
  [ssh_2]  board-a  192.168.16.103:22
```

**`serial_list` 示例输出**：

```text
Active serial sessions: 1

  [serial_1]  board-b  COM3 @ 115200
```

**`adb_shell_list` 示例输出**：

```text
Active sessions: 1

  [adb_1]
  Device:     board-a
  SerialNo:   43b1e5fe7b186666
```

**`power_shell_list` 示例输出**：

```text
Active PowerShell sessions: 1

  [power_1]  local  E:\project
```

## 五、 新增 MCP 工具

### 1. session_info

该工具在 `src/mcp/tools/basic/session_info.ts` 文件中定义，注册于 `src/mcp/tools/basic/index.ts`。

提供三种查询模式：

| 模式 | 参数 | 示例 |
|------|------|------|
| 按 session 查 | `session_id: "ssh_2"` | 返回该会话的 type 、device 、connectionInfo 、createdAt |
| 按 device 查 | `device: "board-a"` | 返回 board-a 上所有 SSH / Serial / ADB 会话 |
| 全部列出 | 无参数 | 返回当前所有活跃会话，按类型分组 |

**调用示例**：

```json
{ "name": "session_info", "arguments": { "session_id": "ssh_2" } }
```

```json
{ "name": "session_info", "arguments": { "device": "board-a" } }
```

```json
{ "name": "session_info", "arguments": {} }
```

【**示例输出（按 session 查）**】

```text
[ssh_2]
Type:         ssh
Device:       board-a
Connection:   192.168.16.103:22
Created:      2026-06-09T07:45:30.123Z
```

【**示例输出（按 device 查）**】

```text
Sessions for device 'board-a' (3):

  [ssh_1]
  Type:         ssh
  Device:       board-a
  Connection:   192.168.16.103:22
  Created:      2026-06-09T07:45:30.123Z

  [adb_2]
  Type:         adb
  Device:       board-a
  Connection:   43b1e5fe7b186666
  Created:      2026-06-09T07:46:15.456Z

  [serial_3]
  Type:         serial
  Device:       board-a
  Connection:   COM4 @ 115200
  Created:      2026-06-09T07:47:00.789Z
```

### 2. 常用提示词

以下提示词可直接复制到 AI 对话中使用：

【**查看某设备的所有会话**】

```
使用 session_info 工具，传入 device="board-a"，查看该设备当前有哪些活跃会话
```

【**查看某会话的详细信息**】

```
使用 session_info 工具，传入 session_id="ssh_2"，查看该会话的设备名、连接信息和创建时间
```

【**查看全部活跃会话**】

```
使用 session_info 工具，不带参数，列出当前所有活跃会话
```

【**打开新会话前先检查已有连接**】

```
先用 session_info 查看 board-a 是否已有 SSH 会话。如果有则复用已有会话的 session_id，否则再调用 ssh_shell_open
```

【**关闭所有不用的会话**】

```
先用 session_info 列出全部会话，然后逐个调用对应的 close 工具清理不再使用的会话
```

## 六、 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/mcp/sessions/registry.ts` | 新建 | SessionRegistry 单例 + SessionMeta 接口 + 双向索引 |
| `src/mcp/tools/basic/session_info.ts` | 新建 | session_info MCP 工具 |
| `src/mcp/tools/basic/index.ts` | 修改 | 注册 session_info 工具 |
| `src/transport/ssh.ts` | 修改 | SSHShellConfig + deviceName ；SSHShell + 4 个访问器 |
| `src/transport/serial.ts` | 修改 | SerialShellConfig + deviceName ；SerialShell + getDeviceName() |
| `src/mcp/tools/ssh/shell.ts` | 修改 | open / login / close / dispose 集成 registry ；list 增强 |
| `src/mcp/tools/serial/shell.ts` | 修改 | open / login / close / dispose 集成 registry ；list 增强 |
| `src/mcp/tools/adb/shell.ts` | 修改 | open / close / dispose 集成 registry ；list 增强 |
| `src/mcp/tools/win/powershell.ts` | 修改 | open / close / dispose 集成 registry ；list 增强 |

---

*本文档由 markdowncli 技能辅助生成*
