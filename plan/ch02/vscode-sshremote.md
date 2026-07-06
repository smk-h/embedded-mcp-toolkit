## 一、 概述

本文基于 VSCode 官方文档 [Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh)、[Remote development over SSH 教程](https://code.visualstudio.com/docs/remote/ssh-tutorial) 与 [VS Code Server 文档](https://vscode.js.cn/docs/remote/vscode-server)，分析 Remote-SSH 这种「无感远程开发」的实现原理，重点拆解编辑与保存两个具体场景下的文件同步机制。

> 背景：`user.md` 中提到，串口/USB 等物理接口无法映射到编译服务器，只能通过 Windows 经 SSH 连接编译服务器，希望用 Claude / opencode 自动调试设备、自动编译和修改代码。本文先分析 VSCode Remote-SSH 这种「无感远程开发」是怎么实现的，为后续方案设计提供参考。

## 二、 总体架构：Client / Server 拆分

VSCode 把自己拆成两半：UI 在本地跑，「大脑」在远程跑，中间用 SSH 隧道传消息。

| 部分 | 运行位置 | 职责 |
|------|----------|------|
| **VS Code Client（本地端）** | 本地电脑 | 窗口、菜单、编辑器渲染、光标、输入处理、TextModel（编辑器缓冲区） |
| **VS Code Server（远程端）** | 远程服务器 | 文件系统访问、任务执行、终端、调试器、**语言服务（补全/诊断）**、扩展宿主（Extension Host） |

```
+---------------------------+      SSH 隧道(加密、多路复用)         +----------------------------+
|  本地 VS Code Client        |<================================>|  远程 VS Code Server        |
|  (UI / 编辑器内核 / 本地扩展) |       结构化 RPC(非文件流)          |  (Server 进程 + ExtHost)    |
+---------------------------+                                    +----------------------------+
        |                                                               |
        | 用户敲键、看渲染                                                 | 直接 fs 操作远程磁盘
        v                                                               v
   [本地显示器]                                                  [远程真实文件 / 进程]
```

关键说明：

- **VS Code Server 独立于远程 OS 上任何已有的 VS Code 安装**——它是由扩展自动部署的独立组件，不会复用远程主机上用户手动装的 VS Code，两者互不干扰。
- 官方原话点明核心机制：扩展直接在远程机器上运行命令和其他扩展，**无需把源代码放到本地机器上**，从而提供「本地质量的开发体验」——完整 IntelliSense、代码导航与调试。
- **大部分扩展（ESLint、TypeScript、Python 等）跑在远程的 Extension Host 里**，而非本地；本地不用装这些工具，远程却能用。

## 三、 远程端：VSCode Server 的部署

### 1. 下载策略

Remote-SSH 连接时扩展会**自动在远程 OS 上安装 VSCode Server**，默认下载策略：

- 先尝试在**远程主机上直接下载**；
- 若远程主机无法访问下载源，则**回退到本地下载后通过 SSH 传到远程**。
- 可由设置 `remote.SSH.localServerDownload` 控制：始终本地下载后传输、或永不本地下载。

安装时本地机器需要到以下地址的**出站 HTTPS（端口 443）**：`update.code.visualstudio.com`、`vscode.download.prss.microsoft.com`。

### 2. 安装位置与启动流程

```
本地 UI                     SSH                    远程主机
  |                          |                          |
  |---- ssh login --------->|                          |
  |                         |---- bash login -------->|
  |<----- banner -----------|                          |
  |                         |                          |
  |-- "VS Code Server 初始化" 通知                      |
  |-- 下载/解压 server 到 ~/.vscode-server/ ----------->| (优先远程拉, 失败则本地推)
  |                         |                          |
  |                         |-- 启动 Server 进程 ----->| (管理连接/文件/终端)
  |                         |-- 启动 Extension Host -->| (跑 "workspace" 类扩展)
  |                         |                          |
  |<--- 建立多路复用长连接 --|                          |
  \--------------- 后续所有交互均走这条通道 -------------/
```

1. 本地 VSCode 通过 SSH 登录远程主机，UI 显示「VS Code Server 正在 SSH 主机上初始化」通知。
2. 在远程 `~/.vscode-server/` 目录下自动下载、解压一份 **vscode-server**（独立的 Node.js 程序，约几十 MB）。
3. 启动两个核心进程：
   - **Server 进程**：管理连接、文件系统、终端；
   - **Extension Host 进程**：运行所有标记为 "workspace" 类型的扩展。
4. 本地 UI 通过 SSH 隧道与远程 Server 建立一条**长连接**，后续所有交互都走这条通道。

第一次连接较慢（需下载 server），之后缓存在远程，秒连。连接成功后状态栏指示器显示远程主机名，集成终端直接落在远程 bash 中，`File > Open Folder` 浏览的是远程文件系统。

## 四、 通信通道：SSH 隧道与消息分层

### 1. 一条隧道，多层消息

两端之间不直接发文件流，而是基于 **SSH 隧道 + 多路复用**传输结构化消息（类似 JSON-RPC / 自定义二进制协议）：

```
+-----------------+        +-----------------+        +-----------------+
|  应用层 RPC #1   |        |  应用层 RPC #2   |        |  应用层 RPC #3   |
|                 |        |                 |        |                 |
|  fs.readFile    |        |  writeFile      |        |  LSP didChange  |
|  terminal PTY   |        |  git status     |        |  file watcher   |
+-----------------+        +-----------------+        +-----------------+
        \                       \                       /
         \                       \                     /
          v                       v                   v
       +---------------------------------------------------+
       |       SSH 连接复用(多 logical channels)            |
       +---------------------------------------------------+
                               |
                               v
                  +---------------------------+
                  |   SSH 加密(TCP/22)         |
                  +---------------------------+
                               |
                               v
                       [ 真实网络链路 ]
```

各种业务对应的消息类型：

- **文件树展开** → UI 发「列目录」请求 → Server `readdir` 返回结果 → UI 渲染
- **打开文件** → UI 发「读文件」请求 → Server 回传字节流 → UI 渲染文本
- **编辑保存** → UI 发「写文件」请求（**整文件内容，非 diff**）→ Server `fs.writeFile` 落盘
- **搜索（Ctrl+Shift+F）** → **整个 ripgrep 在远程跑**，只把匹配结果传回
- **终端** → 通过 PTY 在远程开 shell，I/O 流双向转发
- **代码补全 / 跳转定义** → **Language Server 在远程跑**，只传 LSP 协议消息

【**安全模型**】官方强调：**服务器与 VS Code 客户端之间的所有其他通信，都通过认证的、安全的 SSH 隧道完成**。SSH 既是登录通道，也是后续全部业务消息的加密传输通道，不再另开明文端口。

「无感」的关键：**重活都在远程干，本地只负责显示**，网络上流动的只是小体积的协议消息，而非整个仓库。

### 2. 端口转发机制

当远程应用监听在远程 `localhost`（如 `http://localhost:3000`），本地浏览器无法直接访问，Remote-SSH 提供两种转发方式：

- **临时转发**：命令面板 `Forward a Port`，或 Ports 视图的 `Add Port` 按钮；通知会告知本地访问端口（如远程 3000 → 本地 4123）。
- **永久转发**：写入 SSH 配置 `LocalForward` 指令，每次连接自动生效：

  ```
  Host remote-linux-machine
      User myuser
      HostName remote-linux-machine.mydomain
      LocalForward 127.0.0.1:3000 127.0.0.1:3000
      LocalForward 127.0.0.1:27017 127.0.0.1:27017
  ```

端口转发复用同一条 SSH 连接，无需额外握手。

## 五、 扩展的位置：双位置运行模型

Remote-SSH 采用「双位置运行」模型，扩展按类型自动落到正确位置：

| 运行位置 | 扩展类型 | 说明 |
|----------|----------|------|
| **本地**（UI / Client） | 主题、代码片段等 | 只影响 VS Code UI 的扩展 |
| **远程**（SSH Host） | 大多数扩展 | 确保流畅体验，可从本地机器安装 |

从 Extensions 视图安装扩展时**自动安装到正确位置**，并按类别分组识别：`Local - Installed` 与远程 SSH 主机类别。

可通过 `remote.extensionKind` 强制指定扩展运行位置：

```json
"remote.extensionKind": {
    "ms-azuretools.vscode-containers": [ "ui" ],
    "ms-vscode-remote.remote-ssh-edit": [ "workspace" ]
}
```

- `"ui"`：强制本地运行；
- `"workspace"`：强制远程运行。

`remote.SSH.defaultExtensions` 可指定每次连接自动安装的扩展列表。

## 六、 场景分析：编辑与保存的同步机制

前面几节讲的是「整条链路」是什么，本节聚焦两个最具体的场景：**在编辑器里敲一个字符 `a`**，以及**按下 Ctrl+S 保存**，逐拍拆解文件是怎么「同步」的。

### 1. 一个前提：编辑器内存模型与文件归属

要先厘清 VSCode 里「文件」的两个层次：

| 概念 | 住在哪儿 | 说明 |
|------|----------|------|
| **磁盘文件** | 远程主机真实磁盘 | 唯一的「真实状态」；由 Server 进程通过 Node `fs` API 直接读写 |
| **TextModel（编辑器缓冲区）** | 本地 UI 进程内存 | VSCode 对打开文件的内容镜像，编辑渲染、撤销栈、增量计算都在此进行 |

```
+---------------------------+                              +-----------------------+
|   本地 UI 进程              |       SSH 隧道(按需)         |    远程 Server 进程     |
|  +-----------------------+ |                             |                       |
|  | TextModel (内存镜像)   | <--- readFile (打开时拉) --->  |  fs.readFile <-- 磁盘  |
|  |                       | |                             |                       |
|  |  敲键 / 撤销 / 渲染     | --- writeFile (保存时推) --->  |  fs.writeFile --> 磁盘 |
|  +-----------------------+ |                             |                       |
+---------------------------+                              +---------------------------+
        ^                                                          |
        | 用户看着这个                                               v
        v                                                       [远程真实磁盘]
    [本地显示器]                                                  (唯一真实状态)
```

【**关键点**】在 Remote-SSH 模式下，**TextModel 始终在本地**——这跟本地开发完全一样，VSCode 并没有把编辑器内核搬到远程。远程只负责「按需把磁盘字节送给本地」和「按本地命令把字节写回磁盘」。**编辑动作本身永远先发生在本地内存里，远程磁盘毫不知情。**

这是理解下面两节同步行为的基础：所谓「同步」**并不是「敲一个字符立刻通过网络发一个字符」**，而是「编辑攒在本地，只在特定时机（保存、自动保存）才把整版内容下推一次」。

### 2. 按下字符 `a`：纯本地的一次内存更新

【**同步行为**】**没有任何同步发生**——这一拍完全不碰网络，也不碰远程磁盘。

```
键盘事件 'a'
   |
   v
+-----------------------+
| Monaco / 编辑器内核    |
| 应用到本地 TextModel   |  <- 内存写, ns 级
+-----------------------+
   |
   +---- 乐观重绘当前行             (UI 立即更新, 不等远程)
   +---- 标记 dirty / 状态栏圆点    (本地状态)
   +---- 撤销栈 / 折叠 / 高亮       (本地)
   |
   +---- (防抖、异步) textDocument/didChange
              |
              | range diff(不是整文件)
              v
         [SSH 隧道] --------> 远程 LSP(语义分析)
                                  |
                                  v
                           诊断结果回流 UI(红波浪线等)
```

逐拍拆解：

1. 键盘事件进入本地 UI 进程，交由 Monaco / VSCode 编辑器内核。
2. 编辑器把字符 `a` 应用到本地 **TextModel** 对应行缓冲区，光标右移一格。
3. **乐观渲染**：UI 立刻重绘这一行——不等待任何远程回应。这是 Remote-SSH 编辑延迟极低（即使到几千公里外的服务器）的根本原因：「敲字」是本地操作，往返时延被排除在交互关键路径之外。
4. 文档被标记 dirty（标题栏圆点），状态栏切到「已修改」。
5. 触发编辑事件链，绝大部分**仍然本地**：
   - TextMate 语法高亮在本地重新切词（轻量、走 WebAssembly，不联网）；
   - 增量计算撤销/重做栈（本地）；
   - 折叠区间、缩进辅助等编辑器特性（本地）。
6. 与远程有关的副产物（**异步、不阻塞输入**）：
   - 若开了协同光标（Live Share）或「保存时格式化」等，编辑事件会被转成 RPC 通知发出去——与日常编辑同步无必然联系；
   - Language Server（远程 Extension Host 里的 TypeScript / Python LSP 等）通常以「防抖」方式收到文本变化通知做增量语义分析。`textDocument/didChange` 走的就是同一条 SSH 多路复用通道，但传的是 **range-formatted change（增删字符的 diff）**，而非整文件内容——所以每敲一字并不会整篇回传。

【**结论**】按 `a` 这一下，网络上流动的只是「可能触发的、防抖过的 LSP 增量通知」，远程磁盘上的文件**一个字节都没变**。所有看起来「实时」的反馈，都是本地模型 + 乐观渲染的结果。

### 3. 按下 Ctrl+S：整文件覆盖 + 原子落盘

`Ctrl+S` 是 Remote-SSH 模式下文件真正「同步」到远程的唯一常规路径（auto-save 走同一机制，区别在触发时机）。

#### 3.1 端到端时序图

```
本地 UI                      SSH 隧道               远程 Server             远程磁盘
   |                             |                        |                       |
   | Ctrl+S -> save command      |                        |                       |
   | Serialize TextModel 全文     |                        |                       |
   |                             |                        |                       |
   |-- writeFile(uri, content) ->|-- 多路复用转发 -------->|                       |
   |   (整文件内容, 非增量)       |                        |                       |
   |                             |                        |-- write tmp ---------> |
   |                             |                        |-- fsync -------------->|
   |                             |                        |-- rename(tmp->file) -->| (原子替换)
   |                             |                        |                       |
   |<---- ACK(新 mtime/etag) ----|<-- 多路复用回传 -------|                       |
   |                             |                        |                       |
   | dirty 清除 / 状态栏圆点消失   |                        |                       |
   | 更新本地 etag 基线            |                        |                       |
   |                             |                        |                       |
   |                             |                        |<-- inotify 事件 --------|
   |                             |                        |   (自己写, 抑制 reload) |
   |                             |                        |                       |
   |                             |                        |-- (异步) 触发 LSP 诊断 ->|
   |<--- LSP diagnostics 回流 ---|<-- 多路复用回传 --------|                       |
```

逐拍拆解：

1. `Ctrl+S` 触发 `workbench.action.files.save`，UI 拿到当前 TextModel 的完整内容。
2. UI 通过 **RemoteFileSystemProvider** 发出 `writeFile(uri, content[, options])`——`uri` 形如 `vscode-remote://ssh-remote+<host>/path/to/file`。
3. 该调用被结构化打包，复用同一条 **SSH 多路复用通道**发给 Server（参见[四、 通信通道](#四-通信通道-ssh-隧道与消息分层)）——官方说的「服务器与 VS Code 客户端之间的所有其他通信，通过认证的、安全的 SSH 隧道完成」。
4. Server 进程调用「临时文件 + rename」的原子写策略落盘到远程真实磁盘。
5. 落盘成功后 Server 回 ACK。
6. UI 收到 ACK：清理 dirty、清除圆点；更新本地记录的远程 `mtime`/`etag`，作为后续「外部是否改动过」的判定基线。
7. 写盘触发的远程 **inotify / fsevents** 事件被 Server 端 FileWatcher 捕获——因为是「自己写的」，内部抑制对自身的 reload 通知，避免循环。

#### 3.2 网络层：整文件覆盖写，不做行级增量推送

【**关键认知**】Remote-SSH 的 `Ctrl+S` 在网络层是 **整文件覆盖语义**，不是 diff/patch 增量推送：

- `RemoteFileSystemProvider.writeFile(uri, content, options)` 的接口契约就是「带内容覆盖写」，UI 序列化时把 TextModel 当前完整内容整体下发——无论你只改了一个字符还是改了半篇，网络上流动的字节数都是当前整版文件大小。
- 这跟 Live Share 的协同编辑（基于 OT / CRDT 行级增量）**完全不是一条路径**：Remote-SSH 没有把编辑期间累积的 diff 复用到保存通道里，保存时仍按整版再发一遍。
- 注意区分：LSP 的 `textDocument/didChange` 本身是增量（range diff），但它只喂给 Language Server 做语义分析，**和落盘写入无关**——落盘这一拍并不复用那份增量信息，依然整文件下推一次。

```
编辑期间:                  保存时:
+----------------+        +-----------------------------+
| LSP didChange  |        | writeFile(整文件内容)        |
|  range diff    |        |   -- 整版发 --> 远端覆盖      |
|  -> 远程 LS    |        |                              |
+----------------+        +-----------------------------+
   (语义分析用)                (两条路径, 不复用)
```

#### 3.3 磁盘层：原子 rename，不是直接 truncate 原文件

Server 端落盘不用 `truncate + write`，而是走「临时文件 + rename」的原子写：

```
原文件:  foo.c          <- 不被直接改写
临时文件: foo.c.tmp      <- 整版写入
                       |
   1. write full content to foo.c.tmp
   2. fsync(foo.c.tmp)          // 确保脏页落盘
   3. rename(foo.c.tmp, foo.c)  // 原子替换, POSIX 保证
                                 //   要么看到旧版
                                 //   要么看到新版
                                 //   绝无半截破损
   4. ACK -> UI
```

也就是说，磁盘上的「前一版字节流」与「后一版字节流」之间没有保存增量关系——原文件是被**整体替换**掉的。

#### 3.4 大文件的代价与对策

Remote-SSH 没有针对「超大单文件保存」做专项优化（不像 git packfile 或 rsync 的 rolling checksum 那样做块级增量），所以遇到几十 MB 以上的单文件，`Ctrl+S` 会明显卡在隧道带宽上——单次保存要传整个文件字节数、一次往返。常见规避思路：

- **不在编辑器里手改大单文件**：日志、数据快照、生成物这类不要直接打开编辑；关掉它们的 watcher（`files.watcherExclude`）或不放进 workspace，同时省内存与 IO。
- **改用远程终端的流式工具**：`sed` / `awk` / `head` / `>>` 在 Server 本地操作，不走 UI-Server 内容通道，网络上只回传退出码与少量输出。
- **以 patch 形式更新**：远程 `git diff > p.patch` → 编辑 patch → `git apply`；或 `rsync --only-write-batch` 这类块级增量，把「行级增量」搬到远程做，不让整版文件过隧道。
- **拆分文件**：把超大单文件拆成多个小模块，单次保存只涉及当前窗口里的小文件。
- **慎用 autoSave**：auto-save 触发就是整版下推，大文件 + 频繁 autoSave 会成倍放大带宽负担，大文件场景建议关掉。

### 4. 落盘后的远程事件链：保存之后还会发生什么

保存不是结束，写入真实文件相当于往远程的「事件总线」里投了一颗石子：

```
                  远程真实磁盘(文件被原子替换)
                            |
                            v
                  +-------------------+
                  | inotify / fsevents |  <- FileWatcher
                  +-------------------+
                            |
          +-----------------+-----------------+
          v                 v                 v
    +-----------+      +-----------+      +-----------+
    | LSP       |      | task      |      | Git       |
    | didSave   |      | watcher   |      | status    |
    +-----------+      +-----------+      +-----------+
          |                 |                 |
          v                 v                 v
    诊断/类型检查       build/watch 触发    状态/diff 列表
          |                 |                 |
          +--------+--------+--------+--------+
                   v                 v
              [SSH 隧道回传少量结构化结果]
                   |
                   v
              本地 UI 渲染
```

- 远程跑着的 **Language Server**（TypeScript、ESLint、Python 等）通过 file watcher 或 LSP `didSave` 感知到变化，触发增量诊断、类型检查，把红波浪线、unused 提示等通过 LSP 协议回传 UI。
- 远程任务系统（`task.json` 里的 `build`、`watch`）若配置了文件触发器，会被 file change 事件唤醒。
- 若启用了远程调试器，调试器按需重载或热替换。
- 源代码管理（Git 扩展）在远程跑 `git status`，发现工作区文件变了，把 diff 列表回传 UI 渲染。

【**注意**】所有这些后续动作**都在远程计算**，网络上只传最终需要展示的少量结构化结果（diagnostics、git diff 列表）。这就是「重活在远程干、本地只负责显示」的具体兑现。

### 5. 外部修改怎么办：FileWatcher 的反向通道

如果在 VSCode 之外（别人开了 `vim` 改了同一文件、或 `git pull` 更新了文件）远程磁盘变了，VSCode 怎么知道？

```
[远程磁盘]                       [远程 Server]              [本地 UI]
   |                                 |                          |
   | 外部进程改文件                   |                          |
   v                                 v                          |
inotify IN_MODIFY ----------> FileWatcher 捕获                  |
                                |                               |
                                +-- 发"X 变了" 通知(反向通道) -->|
                                |                               |
                                |                       比对 mtime/etag
                                |                               |
                                |                       弹"已外部修改, 是否 reload"
                                |                       (或按 saveConflictResolution 自动)
                                |<---- reload 请求 ------|
                                |                        |
                                +---- readFile --------->|  重新拉取并覆盖本地 TextModel
```

- Server 端 FileWatcher（基于 inotify/fsevents）捕获事件。
- 通过同一条 SSH 隧道把「文件 X 变了」的轻量通知**反向**发回 UI。
- UI 拿通知后比对 `mtime`/`etag`，若确认外部确实改了，弹「文件已被外部修改，是否重新加载」的提示，或按 `files.saveConflictResolution` 设置自动处理。

这是「反向通道」的典型用法——平时是 UI 拉数据，这次是远程主动推送。复用同一条 SSH 连接，无需额外端口。

### 6. 这一拍设计的好处与权衡

【**好处**】

- **编辑极低延迟**：敲字不联网，乐观渲染，时延与本地几乎无差别。
- **保存一次成本可预测**：写盘动作只在保存时发生，频率与网络往返可控；写盘在远程本地磁盘，没有「客户端-服务器-存储」的额外跳数。
- **不存在「同步冲突」的常态场景**：编辑在本地内存、最终落盘在远程磁盘——是「客户端→服务端」的单向数据流，不像双向同步盘那样需要合并策略。Server 拿到的就是 UI 当前内存里那一版，写下去即可。
- **状态最终一致**：远程磁盘是唯一真实状态，UI 内存镜像只是副本；保存后两边重新对齐 `mtime`/`etag` 基线，后续无论谁改都能感知。

【**权衡**】

- **未保存内容不持久**：网络断开或远程进程崩溃时，本地 dirty 的修改不保证留存——这是 Remote-SSH「内存编辑 + 远程落盘」模型的本征限制，不像 SSHFS / rsync 那样每改一处立即写盘。
- **大文件保存有往返瓶颈**：保存传输的是文件当前整版内容，单次保存大文件会占满隧道带宽；日常代码文件远小于此。
- **多客户端并发编辑无锁**：官方明确 VS Code Server 实例仅供单用户；但若用户自己另开 `vim` 改同一文件，靠 FileWatcher 的冲突提示兜底——无集中式锁。

一句话总结：**把「编辑」与「落盘」的耦合度降到最低——编辑在本地内存（毫秒级响应、零联网），落盘时一次性走 SSH 隧道在远程真实磁盘上原子写，再由远程的 FileWatcher / LSP 回流反馈**。这正是「无感」两个字的工程内里。

## 七、 性能特征：为什么体验接近本地

- **延迟低**：编辑时输入在本地内存处理、乐观渲染，不进网络；保存时一次完整往返，且写盘在远程本地完成。
- **带宽省**：搜索/编译/索引都在远程，不用把 GB 级代码拉到本地。
- **状态一致**：文件读写直接命中远程真实磁盘，不存在「同步冲突」。
- **SSH 复用**：多个通道（文件、终端、调试端口转发）复用同一条 SSH 连接，避免反复握手。
- **安全**：全部业务通信走认证后的 SSH 隧道，不暴露额外明文端口。

## 八、 与其他远程编辑方案对比

### 1. 总览

```
 方案 A: SSHFS / NFS          方案 B: Remote-SSH           方案 C: rsync 双向同步
 (网络挂载盘)                  (计算搬到数据旁)              (本地副本 + 手动同步)

本地 UI --FUSE rw--> 网络盘     本地 UI --RPC 消息--> Remote   本地 UI --操作本地副本--> 本地盘
   ^                              ^                                |
   |                              |                                | (手动 rsync)
   +-- 每次读写都走网络 ---        +---- 重活在远端 ----              v
                                                                远程盘 <-- rsync --

【极慢, 搜索/构建痛苦】          【体验接近本地】               【副本 + 同步冲突】
```

### 2. 详细对比

`sshfs` / NFS 挂载远程目录到本地再编辑的方式，每次读写都要走网络 FUSE 调用，搜索/构建极其痛苦。Remote-SSH 思路相反——**把计算搬到数据旁边**，UI 留在本地，所以才会「无感」。

| 方面 | SSHFS / NFS | Remote-SSH | rsync 双向 |
|------|-------------|-----------|-----------|
| 编辑延迟 | 每字符走网络 | 本地内存，零联网 | 本地内存 |
| 搜索/构建 | 痛苦（大量网络 IO） | 远程本地完成 | 无（需手动） |
| 同步冲突 | 无 | 无（单向数据流） | 有 |
| 离线编辑 | 否 | 否（dirty 仅本地内存） | 是 |
| 文件单一真实状态 | 远程 | 远程 | 两份，需合并 |

## 九、 平台与先决条件

### 1. 本地端要求

本地需安装**与 OpenSSH 兼容的 SSH 客户端**。**不支持 PuTTY**。

### 2. 远程主机支持的平台

| 架构 | 支持的操作系统 |
|------|----------------|
| x86_64 | Debian 8+、Ubuntu 16.04+、CentOS/RHEL 7+ |
| ARMv7l（AArch32） | Raspberry Pi OS Stretch/9+（32-bit） |
| ARMv8l（AArch64） | Ubuntu 18.04+（64-bit） |
| x86_64 | Windows 10/Server 2016/2019（1803+）官方 OpenSSH Server |
| - | macOS 10.14+（Mojave）SSH 主机 |

### 3. 硬件要求

- **最低**：1 GB RAM
- **推荐**：至少 2 GB RAM 和 2 核 CPU

### 4. Linux 先决条件

- 必须有 `Bash (/bin/bash)`、`tar`、`curl` 或 `wget`
- **内核** >= 3.10
- **glibc** >= 2.17
- **libstdc++** >= 3.4.18
- **仅支持 glibc 基础的发行版**（不支持 Alpine Linux 等非 glibc 发行版）

## 十、 已知限制

- **不支持 PuTTY**（Windows 上需用 OpenSSH 兼容客户端）
- **不支持 Alpine Linux** 及非 glibc 基础的 Linux SSH 主机
- **密码不保存**，官方推荐使用密钥认证（基于密钥认证可避免扩展多次提示凭据）
- **本地代理设置不会重用**到远程主机
- ARMv7l / ARMv8l 上某些扩展可能因包含 x86 原生代码而无法工作

## 十一、 对本项目（ch02）的启示

一句话总结 VSCode 的做法：**把「无 UI 内核」塞进远程服务器，本地只留一个壳，两者通过 SSH 隧道用轻量协议交换消息。**

对应到 `user.md` 的场景（Windows 经 SSH 控制编译服务器，同时要操作本地物理设备）：

- 编译/文件编辑这类「纯远程」操作，可以复用 Remote-SSH 的分层思路：SSH 通道 + 文件操作 RPC + 远程进程管理。
- 但串口/USB 这类「只能本地访问」的设备，无法直接放进远程 Server；需要设计一条**反向通道**或**本地代理**，让远程的 AI / 构建流程能间接驱动本地设备。
- 端口转发的「反向」用法可作参考：Remote-SSH 的 `LocalForward` 是把远程端口拉到本地，本项目反过来需要把本地设备能力「暴露」给远程，思路对称。
- 因此本项目不能照搬 Remote-SSH 的「全部在远程」模型，而要解决**跨边界设备访问**问题——这正是 ch02 待设计的重点。

若要实现一个简化版，骨架是：SSH 通道 + 文件操作 RPC + 远程进程管理 + 本地 UI / Agent 适配层 + 设备访问桥接。

## 十二、 参考资料

- [Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh) —— VSCode 官方 Remote-SSH 文档
- [Remote development over SSH（教程）](https://code.visualstudio.com/docs/remote/ssh-tutorial) —— VSCode 官方连接与部署教程
- [Visual Studio Code Server](https://vscode.js.cn/docs/remote/vscode-server) —— VSCode Server 官方文档
- [microsoft/vscode-remote-release](https://github.com/microsoft/vscode-remote-release) —— VSCode Remote Development 扩展仓库

---
*本文档由 markdowncli 技能辅助生成*