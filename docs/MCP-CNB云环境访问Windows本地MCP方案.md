<!-- more -->

> 本文讨论 [项目简介](./项目简介.md) 中"用法二：跨机远程"的**公网容器变体**——AI 客户端跑在 CNB（云原生开发环境）容器里，MCP Server 跑在路由器 NAT 后的 Windows 工位机。与 [MCP-公网反向隧道跨机部署方案](./MCP-公网反向隧道跨机部署方案.md)（下称"公网隧道篇"）的区别在于：那篇假设 AI 客户端所在的 Linux 是**一台常规公网服务器**（有公网 IP、可被入站访问、有 root 与内核能力），而 CNB 是**受管容器**，这些前提基本都不成立——唯有一个平台专供的公网 SSH 入口例外（见一、3.4 节）。本文先给出 CNB 容器能力的实测画像，再逐条判定公网隧道篇的两个方案为何不能原样落地，最后给出唯一可行的 Cloudflare Quick Tunnel 路线与落地细节。

## 一、 方案定位与 CNB 环境画像

### 1. 场景：AI 在 CNB 容器，设备在 Windows 工位机

CNB 云原生开发环境把整台开发机做成一个托管容器：拉代码、装依赖、跑编译、开 AI 编程助手都在容器内完成，开箱即用、随开随弃。但嵌入式调试绕不开的那两条通道——**串口（COM 口）与 USB-ADB**——插在物理世界里的 Windows 工位机上，容器够不着。

于是拓扑与公网隧道篇完全同构：MCP Server 必须留在 Windows 握着设备，CNB 容器里的 AI 客户端远程连它。唯一变化的是"远端"的身份：

- 公网隧道篇的远端是**自己租的公网服务器**：能开端口、能改防火墙、能装内核模块、有固定公网 IP；
- 本文的远端是 **CNB 托管容器**：无公网入站、无内核能力、无固定出口、`uid=0` 但能力集被裁剪。

这个身份差异是全文所有结论的根因。

### 2. 与既有两份文档的关系

| 文档 | 远端前提 | 与本文的关系 |
| --- | --- | --- |
| [Linux远程连接Windows MCP配置指南](./Linux远程连接Windows%20MCP配置指南.md) | Linux 与 Windows **同局域网**，Linux 可直达 Windows 的 `winip:22` | 本文是其"两端都在 NAT 后、无法互相直达"时的延伸 |
| [MCP-公网反向隧道跨机部署方案](./MCP-公网反向隧道跨机部署方案.md) | 远端是**常规公网服务器**（可入站、有 root、有内核能力） | 本文判定其方案 A、方案 B 在该前提换成 CNB 后为何失效，并给出替代载体 |

三者的公共内核一致：**AI 客户端与 MCP Server 之间总要走一条 stdio 或 HTTP 通道，MCP 本体的工具、配置、行为完全相同**，差别只在通道怎么搭。

### 3. CNB 容器能力实测

以下数据取自 CNB 云原生开发环境的实测（容器标识 `cnb-p0r-*`，镜像基于 Ubuntu 22.04.5 LTS，宿主内核 `5.4.241-1-tlinux4`）。

#### 3.1 容器身份与权限

有效能力集为 `0x00000000a80c05fb`，解码后为：

```text
cap_chown, cap_dac_override, cap_fowner, cap_fsetid, cap_kill,
cap_setgid, cap_setuid, cap_setpcap, cap_net_bind_service,
cap_sys_chroot, cap_sys_ptrace, cap_mknod, cap_audit_write, cap_setfcap
```

【**关键缺失**】`cap_net_admin`、`cap_net_raw`、`cap_sys_module`、`cap_sys_admin` **四项全无**。

这四项恰好是建虚拟网卡、改路由表、收发原始包、加载内核模块的必要条件。其余权限检查结果：

| 检查项 | 实测结果 |
| --- | --- |
| `/dev/net/tun` | 不存在；`/dev/net` 目录也不存在 |
| `mknod` 建 tun 设备节点 | `Operation not permitted` |
| `/lib/modules` | 不存在 |
| `/proc/modules` | 可读，且 **`tun` 模块已加载**（`tun 61440 4 - Live`） |
| `unshare -n` | `unshare failed: Operation not permitted` |
| `unshare -Urn` | `unshare failed: Operation not permitted` |
| `/sys` 挂载 | `sysfs ro`（只读） |
| `/proc/sys/net/ipv4/ip_forward` | 值为 1，但写入报 `Read-only file system` |

【**注意**】`tun` 用不了的原因**不是内核缺模块**（模块明明是 Live 的），而是**容器内没有 `/dev/net/tun` 设备节点、且无权限创建**。这个区分在排查时有意义：换镜像也救不回来，因为限制在安全上下文而非软件包。

#### 3.2 网络能力

| 检查项 | 实测结果 |
| --- | --- |
| 网络接口 | 仅 `lo` + `eth0`（无 tun/tap/wg 类接口） |
| 容器 IP / 网关 | `172.17.0.3` / `172.17.0.1`（Docker 私网） |
| 公网入站（容器自身） | 无。出口经 NAT 共享，容器自身无任何可被外部直连的端口 |
| 公网入站（平台专供） | **有**：CNB 为每个开发环境注入一个公网 SSH 入口 `<环境标识>@cnb.space:22`，见 3.4 节 |
| 出口公网 IP | 示例 `159.75.12.57`（腾讯云 IP 池，**每次构建可能变化**） |
| 内网 `192.168.x.x:22` | 全部超时（不可路由） |
| 内网 `172.17.0.1:22` | 超时（连本机网关都不通） |
| 出站 **22** 端口 | **按目标分流**：`gitee.com:22`、**`cnb.space:22`** 通；`github.com:22`、`cnb.cool:22`、`gitlab.com:22`、`1.1.1.1:22` **超时丢包** |
| 出站 **443** 端口 | `github.com`、`cnb.cool`、`cloudflare.com`、`api.trycloudflare.com` **全通** |
| 出站 UDP/QUIC | 通（Quick Tunnel precheck 的 UDP 项 PASS） |
| 其它 | `github.com:2222` 通、`ssh.github.com:443` 握手正常 |

两条最重要的结论：

（1）**容器基本只能出站**；出站 **22 端口按目标白名单放行**（`cnb.space`、`gitee.com` 通，`github.com`、`gitlab.com` 等超时），**443 全通**。这不是配置问题，是平台网络策略。

（2）**容器出口 IP 每次构建都会变**，因此任何"把容器当固定入口"的设计都不成立——**隧道入口必须放在 Windows 侧**。

#### 3.3 预装工具与可用资源

| 工具 | 实测状态 | 说明 |
| --- | --- | --- |
| `ssh` / `ssh-keygen` | 已装（openssh-client `1:8.9p1`） | 无需再 `apt-get install` |
| `cloudflared` | 已装（`2026.9.1`，位于 `/usr/local/bin/`） | 部分环境可能未装，见三、3.1 节的兜底安装 |
| `sshd` | **已由平台常驻拉起**：`sshd -e -p 36000 -o AllowTcpForwarding=yes -o PermitRootLogin=yes -o ListenAddress=0.0.0.0` | 是 `cnb.space` 入口的容器侧落点，见 3.4 节 |
| `node` / `npm` | 已装（v24 / 11.x） | 可跑 `npx supergateway` |
| `apt-get` | 可用，`uid=0` | 可安装用户态软件包 |
| 端口预览 | `https://<前缀>-<端口>.cnb.run/` | **HTTP 专用反向代理**，见二、4 节 |

#### 3.4 CNB 公网 SSH 入口（cnb.space）

CNB 在开发环境拉起时，除端口预览外还会注入**一个公网可达的 SSH 入口**，地址形如 `<环境标识>@cnb.space`。环境标识可从容器内的 `CNB_VSCODE_REMOTE_SSH_SCHEMA` 变量中读到：

```text
vscode://vscode-remote/ssh-remote+cnb-p0r-<...>.<uuid>-<后缀>@cnb.space/workspace/
```

该入口也可以被本地 VS Code 的 Remote-SSH 直接使用，说明它对外是**真实可达**的。实测结论如下：

| 验证项 | 结果 |
| --- | --- |
| DNS | `cnb.space` → **公网 IP**（实测 `43.144.78.71` / `43.144.78.116`） |
| 端口 | 仅 `22` 开放；`443`、`2222` 不可达 |
| 认证方式 | **`none`**：`Authenticated to cnb.space ([43.144.78.71]:22) using "none"`，**不需要密钥或密码** |
| 落点 | 连接被路由回**本环境自己的容器**（`hostname` 返回容器名、`whoami=root`、`pwd=/root`） |
| 命令执行 | 可执行任意命令（`ssh <环境标识>@cnb.space "ls /workspace"` 正常返回） |
| **`-L` 本地转发** | ✅ 可用（实测 `18888` 端口转发后 HTTP 返回 200） |
| **`-R` 远程转发** | ❌ **被拒绝**：`Error: remote port forwarding failed for listen port <端口>`（换端口、仅绑回环均失败） |

容器内对应的服务端是平台拉起的 `sshd`（见 3.3 节，监听 `0.0.0.0:36000`，且命令行显式带了 `-o AllowTcpForwarding=yes`）。也就是说，**`-R` 的拒绝发生在网关层**，而不是容器内 sshd 的配置问题——改容器内配置无法绕过。

这条入口直接决定了两件事：**为什么 `ssh -R` 隧道方案依然走不通**（见二、3 节），以及**它能为 Cloudflare 方案补上什么**（见五、1 节）。

【**安全提醒**】该入口是 `none` 认证，**环境标识字符串本身就是唯一凭证**。任何拿到该字符串的人都能以 `root` 进入对应的开发环境容器。请勿将其写入公开文档、仓库或可分享的日志，并按平台指引确认是否存在访问来源限制。

## 二、 既有方案在 CNB 下的可行性判定

### 1. 判定总表

| 方案 | 关键前提 | CNB 实测 | 判定 |
| --- | --- | --- | --- |
| 公网隧道篇 **方案 A**：`ssh -R` 双反向隧道 | Windows 能 `ssh user@<远端>:22`，且**远端允许 `-R` 注册端口** | 有公网 SSH 入口 `cnb.space:22`，但该网关**拒绝 `-R` 反向转发**（3.4 节） | **原样不可行**（思想可迁移，见二、3） |
| 公网隧道篇 **方案 B**：WireGuard 组网 | 服务端：公网 UDP 入站 + `tun` + `NET_ADMIN`；客户端：`tun` | 无 `tun` 节点、无 `NET_ADMIN`、无 `SYS_MODULE`、无公网 UDP 入站 | **两端都无落脚点，无变体可救** |
| CNB **端口预览** 暴露 sshd | 平台代理需能透传裸 TCP | 预览为 HTTP 专用：HTTP 服务返回 200，裸 TCP 服务**收不到任何连接** | **不可行** |
| **Cloudflare Quick Tunnel** | 双向均只需出站 443 | 443 全通；Quick Tunnel 建立成功；SSH 端到端到达 Windows sshd 认证阶段 | ✅ **唯一零外援可跑** |

### 2. 方案 B（VPN 组网）：两端都无落脚点

公网隧道篇的方案 B 之所以在其前提下能成立，是因为那台公网服务器**同时具备**四个条件：公网 IP、可放行 UDP 入站、`iptables`/转发权限、加载 `wireguard` 内核模块的能力。CNB 容器四项全无：

（1）**服务端落不下来**：没有 `tun` 设备节点、没有 `NET_ADMIN`，`wg-quick up wg0` 连创建接口这一步都过不去；即便解决接口问题，也没有可被 Windows 直连的公网 UDP 入站端口。

（2）**客户端同样落不下来**：这是容易被忽略的一半。WireGuard 客户端**同样**需要虚拟网卡与 `NET_ADMIN`，不是"客户端要求低就可以装在容器里"。既然容器内根本没有 `tun` 节点，容器连当客户端都不行。

（3）**用户态实现也救不了**：`boringtun`、`wireguard-go` 这类用户态实现绕开了内核模块，但**绕不开 `tun` 设备或 `NET_ADMIN`**——它们最终仍要把包注入网络栈。容器内两者皆无。

（4）**容器出口 IP 会变**：即使前三条解决，Windows 侧也没有一个稳定的服务端地址可配对。

结论：**方案 B 在 CNB 场景下不具备任何改造余地**，只能整体淘汰。

### 3. 方案 A（ssh -R 双反向隧道）：入口有了，但不让注册端口

方案 A 的机制本身没有问题——它把"远端连不到 Windows"这个困境，转化成"Windows 主动出站并把端口反向注册到远端"。它要求远端**同时满足两条**：既能被 Windows 连上，又允许 `-R` 注册端口。

CNB 恰好满足了前半条，卡死在**后半条**：

（1）**前半条：入口确实存在**。3.4 节实测，`cnb.space:22` 是公网可达的 SSH 入口，且为 `none` 认证——Windows 执行 `ssh <环境标识>@cnb.space` 不需要任何密钥或密码，即可进入容器并以 `root` 执行命令。这一点与"容器无公网入站"的直觉相反。

（2）**后半条：`-R` 被网关拒绝**。实测对该入口执行 `ssh -R 17777:127.0.0.1:8081` 返回 `Error: remote port forwarding failed for listen port 17777`；换端口、仅绑回环（不带 `0.0.0.0`）同样失败。而同一入口下 `-L` 本地转发**正常可用**。也就是说，**该网关只放行 exec 与本地转发，禁止远程转发**。

（3）**失败点在网关、不在容器**。容器内那个平台拉起的 `sshd` 命令行里明明带着 `-o AllowTcpForwarding=yes`（3.3 节），所以这不是容器配置问题——调整容器内的 `sshd_config` 绕不过去。

而 `-R` 恰恰是方案 A 的**全部机制**：8000（MCP 通道）与 7000（文件通道）都靠它注册到远端。这条能力被关掉，方案 A 只能整体放弃。

【**注意**】`-L` 可用但帮不上忙：`-L` 的语义是"**客户端侧**监听、转发到服务端"，而方案 A 需要的是"**服务端侧**监听、转发回 Windows"——方向恰好相反。

【**待确认**】上述 `-R` 拒绝是在容器内向该入口发起时观测到的。若要排除"网关对来自本环境内部的连接限制更严"的可能，可在 Windows 上用同一地址执行一次 `ssh -R` 复核。但从该网关的定位（Remote-SSH 接入）看，禁掉远程转发属于常规加固。

因此方案 A 的修复路径只剩两条：

| 修复路径 | 做法 | 代价 |
| --- | --- | --- |
| 换隧道载体 | 保留"反向隧道 + 复用既有连接"的思想，把载体从 `ssh -R` 换成 Cloudflare（本文第三章） | 依赖 Cloudflare 边缘，域名随重启变化 |
| 加一台跳板 | 另租公网 VPS 跑 sshd，Windows `ssh -R` 到 VPS，CNB 再从 VPS 取 | 多一台机器与一份运维；但此时已回到公网隧道篇原样 |

【**关键认识**】方案 A 的**架构思想**（反向隧道 + 端口级缝合 + supergateway 协议转换）在 CNB 下依然可用，被否定的只是"CNB 充当隧道服务端"这一具体选择——否决理由已从"没有入口"精确到"入口禁止 `-R`"。

### 4. CNB 端口预览：HTTP 专用，无法替代

CNB 为开发环境提供了端口预览：容器内监听某端口后，可通过 `https://<前缀>-<端口>.cnb.run/` 从公网访问。环境变量 `VSCODE_PROXY_URI` 即其地址模板。它的存在容易让人产生"CNB 有公网入站能力"的错觉，实测结论如下：

| 实验 | 结果 |
| --- | --- |
| 容器内起 HTTP 服务（`python3 -m http.server 8080`），访问 `https://<前缀>-8080.cnb.run/` | **HTTP 200**，返回服务内容 ✅ |
| 容器内起裸 TCP 回声服务（监听 8081），访问 `https://<前缀>-8081.cnb.run/` | 返回 **HTTP 500**，且 **TCP 服务端一个连接都没收到** ❌ |

结论：**端口预览是 HTTP 反向代理，不是 TCP 透传**。它只能暴露 HTTP/HTTPS 服务，无法承载 SSH、WireGuard 这类需要裸 TCP/UDP 的协议，因此**不能用来把容器里的 sshd 发布给 Windows**。

【**注意**】这条限制双向成立——端口预览既不能作为 SSH 入口，也不能作为 VPN 入口。公网隧道篇对"业务端口预览不能当 SSH/VPN 入口"的判断在 CNB 下同样成立。CNB 另有一个真正的 SSH 入口 `cnb.space`，但它走独立通道、与端口预览无关（见 3.4 节）。

### 5. 判定结论

把四条判定收敛成一句话：

> **在 CNB 容器里，VPN 这条路彻底没有；反向隧道的思路还在，但中转必须从"CNB 自己的 SSH 入口"换成 Cloudflare 边缘——因为前者禁止 `-R`。**

不引入额外机器（VPS）的前提下，**Cloudflare Quick Tunnel 是唯一可行路径**，理由很简单：它的两端**都只做出站 443 连接**，既不要求任何一方拥有公网入站端口，也不依赖任何一方的端口转发权限——这恰好绕开了 CNB 的全部限制。

## 三、 Cloudflare Quick Tunnel 方案

### 1. 原理：一条双向纯出站的通路

Cloudflare Tunnel 是 Cloudflare 的反向隧穿服务（原名 Argo Tunnel）。它把"服务发布"从"开一个公网入站端口"改为"向 Cloudflare 边缘发起一条长连接"：

```text
[CNB 容器] AI 客户端
     │ ① cloudflared access ssh —— 出站 443/QUIC（拨号到 Cloudflare 边缘）
     ▼
[Cloudflare 边缘]  ── 按隧道名/域名做配对转发 ──
     ▲ ② cloudflared tunnel —— 出站 443/QUIC（同样是拨号）
     │
[Windows 工位机] cloudflared ──► 127.0.0.1:22（Windows sshd）
                                      │
                                      └─► remote-start-mcp.bat ──► node（握着 COM / USB）
```

与公网隧道篇的 `ssh -R` 对比，本质机制完全相同（**被访问方主动出站建立通路**，见该文一、2.4 节），差别只在"通路注册到哪台机器"：`ssh -R` 注册到一台你自己拥有的 sshd，Cloudflare Tunnel 注册到 Cloudflare 边缘。后者不需要你有任何公网 IP。

对本项目而言，还有一个额外红利：**CNB 侧通过 `cloudflared access ssh` 建立的是真 SSH 会话**，Windows 的 sshd 真实参与认证与会话——因此 `SSH_CONNECTION` 存在，现有场景判定天然正确（详见第四章）。

### 2. Windows 侧配置

#### 2.1 安装 cloudflared

任选一种：

```powershell
# 方式一：winget（推荐）
winget install --id Cloudflare.cloudflared

# 方式二：scoop
scoop install cloudflared
```

也可以从 GitHub Release 下载 `cloudflared-windows-amd64.exe` 手工放置并加入 `PATH`。

#### 2.2 准备 SSH 服务端

Windows 需要作为 SSH 服务端（隧道末端要有一个 SSH 服务）。用项目自带的 `sshd-config` 命令完成安装与加固：

```powershell
# 在 Windows 的「管理员」终端、项目根目录执行
embedded-mcp-toolkit sshd-config
```

在菜单中依次执行：

- `[2] 安装 Windows SSH 服务`：安装并启动 `sshd`，设为开机自启；
- `[4] 配置 Windows 中 sshd 服务`：写 `authorized_keys`、调整 `sshd_config`（开启 `PubkeyAuthentication`、禁用 `Match Group administrators` 分组规则）；
- `[7] 查看本机连接信息`：确认本机 Windows 登录用户名（下文记作 `<win_user>`）。

【**注意**】菜单 `[3] 编译服务器生成密钥对` 在本拓扑下**用不了**——它要求 Windows 主动 SSH 登录到"编译服务器"去生成密钥，而 CNB 容器没有公网 22 入站，Windows 登不进去。密钥改在 CNB 侧生成，见 2.3 与 3.2 节。

#### 2.3 写入 CNB 侧公钥

先在 CNB 容器内生成密钥对（见 3.2 节），把打印出的**公钥内容**取回 Windows，写入 Windows 项目根目录下的固定路径：

```text
<Windows 项目根>/.embedded/ssh/id_mcp_server.pub
```

这个路径不是随手定的——`sshd-config` 的配置步骤正是从**当前工作目录下的 `.embedded/ssh/id_mcp_server.pub`** 读取公钥内容（路径常量见 [`constants.ts`](../src/cli/commands/sshd-config/constants.ts)，读取见 [`configure-sshd.ts`](../src/cli/commands/sshd-config/steps/configure-sshd.ts)，写入逻辑见 [`authorized-keys.ts`](../src/cli/commands/sshd-config/authorized-keys.ts)），再追加进 `~/.ssh/authorized_keys`（自动去重）。

放好文件后，**再次执行菜单 `[4]`**，即可复用项目既有的免密配置流程，无需手工编辑 `authorized_keys`。若目标是 Windows 管理员账户，公钥应落到 `C:\ProgramData\ssh\administrators_authorized_keys`（菜单 `[4]` 会一并处理分组规则）。

#### 2.4 启动并确认隧道

```powershell
# 把本机 22 端口通过 Quick Tunnel 暴露出去
cloudflared tunnel --url ssh://localhost:22
```

启动后日志会输出连通性预检结果与分配到的随机域名：

```text
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://<随机词>-<随机词>-<随机词>-<随机词>.trycloudflare.com                              |
+--------------------------------------------------------------------------------------------+
INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully         |
INF |  UDP Connectivity  region1.v2.argotunnel.com  PASS    QUIC connection successful        |
INF |  TCP Connectivity  region1.v2.argotunnel.com  PASS    HTTP/2 connection successful      |
INF |  Cloudflare API    api.cloudflare.com:443     PASS    API is reachable                  |
```

【**重要**】Quick Tunnel **重启即换域名**。这是它相对公网隧道篇 `ssh -R` 固定 IP 的主要劣势，应对方式见五、1 节。

如需开机自启，可注册计划任务：

```powershell
Register-ScheduledTask -TaskName "CloudflaredSSH" `
  -Action (New-ScheduledTaskAction -Execute "cloudflared" -Argument "tunnel --url ssh://localhost:22") `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) -RunLevel Highest
```

### 3. CNB 侧配置

#### 3.1 确认依赖

当前环境实测已预装 `openssh-client` 与 `cloudflared`，可直接跳过本节。若目标环境缺失 `cloudflared`：

```bash
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

注意下载地址走 `github.com:443`（已实测畅通），**不要**走 `:22` 的 git 协议（已实测被封）。

#### 3.2 生成密钥

在 CNB 容器内生成项目专用密钥（与 `sshd-config` 的密钥名保持一致，便于复用既有约定）：

```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_mcp_server -N ""
chmod 600 ~/.ssh/id_mcp_server
cat ~/.ssh/id_mcp_server.pub
```

把 `cat` 输出的公钥内容取回 Windows，按 2.3 节写入 `.embedded/ssh/id_mcp_server.pub`。

#### 3.3 建立免密连接

先用密码登录互通一次（首次连接需信任主机密钥），可直接验证隧道是否端到端可达：

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname <随机域名>.trycloudflare.com" \
    -o StrictHostKeyChecking=accept-new \
    <win_user>@<随机域名>.trycloudflare.com
```

【**提示**】`--hostname` 只写**域名**，不要带 `https://` 前缀。若此处弹出 `password:` 提示，说明隧道已通、只是公钥尚未生效——此时填 Windows 的**账户密码**（**不是** PIN。微软账户用户填微软账户密码）。

完成 2.3 节的公钥写入后，即可免密登录验证：

```bash
ssh -i ~/.ssh/id_mcp_server \
    -o ProxyCommand="cloudflared access ssh --hostname <随机域名>.trycloudflare.com" \
    <win_user>@<随机域名>.trycloudflare.com "hostname"
```

【**实测佐证**】隧道连通时，`sshd` 会明确列出支持的认证方式：

```text
<win_user>@<随机域名>.trycloudflare.com: Permission denied (publickey,password,keyboard-interactive).
```

这行输出同时确认了三件事：隧道 TCP 已通到 Windows、Windows sshd 真实在响应、且服务端**没有关闭密码认证**（因此才会出现 `password` 选项）。

### 4. MCP 落点配置

在 CNB 容器的项目根写入 `.mcp.json`，把 MCP Server 定义为一条经隧道启动的 `ssh` 命令：

```json
{
  "mcpServers": {
    "embedded-board": {
      "command": "ssh",
      "args": [
        "-i", "~/.ssh/id_mcp_server",
        "-o", "StrictHostKeyChecking=accept-new",
        "<win_user>@127.0.0.1",
        "C:/Users/<win_user>/<项目根>/remote-start-mcp.bat"
      ]
    }
  }
}
```

要点：

（1）`command` 为 `ssh`、末位参数是 `remote-start-mcp.bat` 的**绝对路径**——这与 [Linux远程连接Windows MCP配置指南](./Linux远程连接Windows%20MCP配置指南.md) 的 stdio 桥接定义完全一致，只是把端点从 `winip` 换成了 `127.0.0.1`。

（2）这里**没有写 `-o ProxyCommand`**，因为该参数由下一章的 `~/.ssh/config` 统一提供（一个域名只维护一处）。若希望配置自包含，也可改成显式写法：

```json
"-o", "ProxyCommand=cloudflared access ssh --hostname <随机域名>.trycloudflare.com"
```

（3）**不需要 supergateway**。公网隧道篇方案 A 引入 supergateway 是因为 `ssh -R` 只能提供"端口"，服务器侧需要一个懂 TCP 的服务；而本文方案提供的是**完整 SSH 会话**，stdio 桥接直接成立。

## 四、 端点解析与场景判定

MCP Server 启动时会依据环境变量判定"本地 / 远程"并决定注入什么指引。这一章说明隧道拓扑下这些判定是否天然正确，以及唯一需要额外处理的地方。

### 1. 场景判定天然正确

[`host-endpoint.ts`](../src/sdk/host/host-endpoint.ts#L135-L150) 的逻辑是二值的：`SSH_CONNECTION` 存在且非 `(unset)` → `remote-ssh`，否则 → `local`。

隧道拓扑下，`remote-start-mcp.bat` 是被 **Windows 的 sshd** 拉起的，而 `SSH_CONNECTION` 由 sshd 注入到会话环境——所以它**必然存在**，判定结果为 `remote-ssh`。这与公网隧道篇方案 A 的处境截然不同：

| 拓扑 | 谁拉起 MCP 进程 | `SSH_CONNECTION` | 场景判定 |
| --- | --- | --- | --- |
| 本地同机（用法一） | 本机 Host | 无 | `local` ✅ |
| 同局域网跨机（用法二） | Windows sshd（经 ssh） | 有 | `remote-ssh` ✅ |
| 公网隧道篇方案 A（supergateway） | Windows 本地 supergateway | **无** | `local` ❌ 误判 |
| **本文（Cloudflare + ProxyCommand）** | **Windows sshd（经 ssh）** | **有** | `remote-ssh` ✅ |

因此公网隧道篇第四章为方案 A 设计的 `remote-tunnel` 场景改造（涉及 [`host-endpoint.ts`](../src/sdk/host/host-endpoint.ts)、[`host-info.ts`](../src/sdk/tools/basic/host-info.ts)、[`server.ts`](../src/mcp/server.ts)、[`pshell-policy.ts`](../src/mcp/pshell-policy.ts) 四处）**在本方案下整个不需要做**。配套行为也全部天然正确：

- `instructions` 正常注入 scp 引导；
- `host_info` 返回 `remote-ssh started` 而非 `local started`；
- `power_shell_*` 正常注册（AI 在云端，这是它唯一的 Windows 执行通道）；
- `ssh_build` 不注册（AI 就在云端编译机上，注册反而诱导绕行）。

### 2. 端点会被解析成 127.0.0.1

场景判定对了，但**端点内容会有一个需要处理的地方**。

[`host-endpoint.ts`](../src/sdk/host/host-endpoint.ts#L82-L94) 解析 `SSH_CONNECTION`（格式为 `<client-ip> <client-port> <server-ip> <server-port>`）时，取的是**第 3 字段 `server-ip`**（即 sshd 实际监听并被连入的本地地址）作为宿主 IP。

在隧道拓扑下，连接到 Windows sshd 的那一跳是 **Windows 本机的 cloudflared 从 `127.0.0.1:22` 发起的**，因此 `server-ip` 就是 `127.0.0.1`，解析结果是：

```text
Endpoint:   <win_user>@127.0.0.1
```

问题在于：AI 拿到指引后若直接执行骨架里的 `scp <file> <win_user>@127.0.0.1:<路径>`，**这会连到 CNB 容器自己的 127.0.0.1**，而不是 Windows——隧道不会被用上，命令会失败（或更糟：连到容器内某个恰好在 22 端口上的东西）。

【**注意**】这不是判定错误，而是"端点语义变了"：本文拓扑下 `127.0.0.1` 指"**由 `~/.ssh/config` 里 ProxyCommand 接管的那个回环地址**"，而不是"本机某进程"。这一点需要在配置层说死，见下一节。

### 3. ssh config 兜底

最省事的处理方式不是改代码，而是**让 `127.0.0.1` 这个地址自动带上隧道**——在 CNB 容器的 `~/.ssh/config` 里加一段：

```text
Host 127.0.0.1
  ProxyCommand cloudflared access ssh --hostname <随机域名>.trycloudflare.com
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
```

加上之后：

- AI 照常执行指引里的 `scp ... <win_user>@127.0.0.1:...`，`ssh`/`scp` 会读取本段配置，通过 `cloudflared` 把连接送入隧道，**指令零改动、行为正确**；
- 三、4 节的 `.mcp.json` 也只需写 `127.0.0.1`，不必重复声明 `ProxyCommand`；
- 随机域名**只出现在这一个文件里**，域名变化时改一处即可。

【**权衡**】`Host 127.0.0.1` 会接管容器内所有指向回环的 SSH 连接。CNB 开发容器里一般没有别的 SSH 用途，可以接受；若确有其它回环 SSH 需求，可改用显式的 `-o ProxyCommand` 写法（三、4 节），代价是域名要在多个地方维护。

### 4. 与 remote-tunnel 改造的关系

把第四章结论与公网隧道篇第四章对照，可以看出两条路线在"成本花在哪"上的差异：

| 维度 | 公网隧道篇方案 A（supergateway） | 本文方案（Cloudflare + ProxyCommand） |
| --- | --- | --- |
| 协议转换 | 需要 supergateway 把 stdio 包成 HTTP | **不需要**，stdio 桥接直接成立 |
| `SSH_CONNECTION` | 不存在，场景误判为 `local` | 天然存在，判定正确 |
| 代码改造 | 需新增 `remote-tunnel` 场景（四处改动） | **零代码改动** |
| 端点语义 | 需新增 `scpPort` 字段承载 `-P 7000` | 沿用 `remote-ssh`，端点 `@127.0.0.1` |
| 额外配置 | 部署时须记住并同步 `-R` 的服务器侧端口号 | `~/.ssh/config` 一段，域名一处维护 |
| 文件通道 | 需第二条 `-R`（7000）承载 scp | **同一 SSH 会话即可 scp** |
| 通道数量 | 两条 `-R` + 一套保活逻辑 | 一条隧道 |

一句话：**本文方案把成本从"改代码 + 记端口"换成了"依赖 Cloudflare 边缘 + 域名会漂移"**。

## 五、 运维与避坑

### 1. 域名漂移

Quick Tunnel 每次重启换域名，而 CNB 侧的 `~/.ssh/config` 里写着域名——这是本方案最需要管理的耦合点。三种应对：

（1）**Named Tunnel（推荐长期使用）**：需要一个自己拥有、并把 NS 托管到 Cloudflare 的域名，随后 `cloudflared tunnel create` 建命名隧道、`route dns` 绑定固定域名。域名稳定，`~/.ssh/config` 写一次不用改。

（2）**借 `cnb.space` 自动同步（本环境可用）**：3.4 节实测的 `cnb.space` 入口，正好补上了"Windows → 容器"这个方向——Windows 可以从隧道日志里提取当前域名，再经该入口直接改写容器内的 `~/.ssh/config`，全程无需人工介入：

```powershell
# Windows 侧：取隧道最新域名，经 cnb.space 写进容器内的 ssh config
$domain = (Select-String -Path cloudflared.log -Pattern '([\w-]+\.trycloudflare\.com)' |
           Select-Object -Last 1).Matches[0].Groups[1].Value

ssh <环境标识>@cnb.space "sed -i 's|--hostname .*|--hostname $domain|' ~/.ssh/config"
```

注意这里**只把它当作配置同步的手段，不用它承载 MCP 数据通道**——该入口禁止 `-R`，扛不起端口级缝合（见二、3 节）。

（3）**接受手工更换**：临时调试用，每次重启后改一次 config 即可。

### 2. 保活与重连

隧道是一条长期存活的长连接，断线需要自动恢复：

- **Windows 侧**：用计划任务拉起 `cloudflared`，并让其崩溃后自动重启（`RestartCount` 策略）；cloudflared 自身对边缘断线有内建重连。
- **CNB 侧**：无需常驻进程——`cloudflared access ssh` 是**按需拉起的子进程**（由 `ProxyCommand` 每次连接时启动），随会话结束而退出。代价是每次工具调用首次握手略慢。
- **会话状态**：MCP Server 是常驻单例，隧道短暂重连不影响已建立的会话状态；但 Windows 侧 MCP 进程重启会丢掉全部 serial/ssh 会话状态。

### 3. 安全边界

（1）**Quick Tunnel 会把隧道的 URL 暴露到公网**。由于暴露的是 `ssh://localhost:22`，任何拿到该域名的人都可尝试连接——因此**必须关闭密码认证、只留公钥**（`sshd-config` 菜单 `[4]` 已开启 `PubkeyAuthentication`，但默认可保留密码方式，建议另行在 `sshd_config` 中设置 `PasswordAuthentication no`）。

（2）**优先让 sshd 只监听回环**：`cloudflared` 从本机 `127.0.0.1:22` 连入即可，无需把 Windows sshd 监听在 `0.0.0.0`，这样局域网内也不额外扩大暴露面。

（3）**私钥不入仓库**：`~/.ssh/id_mcp_server` 只存在于 CNB 容器运行时；CNB 容器随开随弃，重建后需重新生成密钥并更新 Windows 侧公钥（见三、3.2 节）。

（4）**本 MCP 暴露了 `power_shell_exec` 这类等同远程 shell 的工具**，访问面等于"持有 Windows SSH 凭证的人"，凭证本身要管好。

（5）**勿用 22 端口做隧道入口**：本方案全程走 443/QUIC，正好绕开 CNB 出站 22 被封的问题。若自行改造，务必保持入出口在 443。

### 4. 常见问题

（1）**`cloudflared access ssh` 报连接失败？**

先确认域名正确（**不带 `https://`**、不含尾部斜杠），再看 Windows 侧 cloudflared 进程是否还在运行。用 `curl -o /dev/null -w "%{http_code}" https://<域名>` 探测：返回 `502` 说明隧道在、末端服务未响应；返回 `1033` / `530` 一类错误说明隧道本身已断。

（2）**登录时一直提示 `password:`，公钥不生效？**

检查公钥是否写到了正确位置：普通用户在 `C:\Users\<用户>\.ssh\authorized_keys`，**管理员账户在 `C:\ProgramData\ssh\administrators_authorized_keys`**。`sshd-config` 菜单 `[5]` 可只读诊断这两处状态。

（3）**误填 PIN 导致认证失败？**

Windows 的 PIN、指纹、Windows Hello 是**本地解锁机制**，不能用于 SSH 认证。认证走的是账户密码本身（微软账户用户填微软账户密码，不是邮箱验证码）。

（4）**AI 执行 scp 时报"连接被拒绝"或传到本机了？**

说明 `~/.ssh/config` 的 `Host 127.0.0.1` 兜底段没生效，或域名已过期。先手工验证：

```bash
ssh -i ~/.ssh/id_mcp_server -o ProxyCommand="cloudflared access ssh --hostname <域名>" <win_user>@127.0.0.1 hostname
```

（5）**容器重建后一切失效？**

CNB 容器是临时环境，重建后：出口 IP 变化、容器内 `~/.ssh/id_mcp_server` 与 `~/.ssh/config` 丢失。需要重新执行三、3 节的密钥生成与 config 写入，并把新公钥同步到 Windows。若 Windows 侧把公钥与隧道做成了开机常驻，则 Windows 端无需改动。


---
*本文档由 markdowncli 技能辅助生成*
