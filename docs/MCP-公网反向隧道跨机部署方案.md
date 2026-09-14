<!-- more -->

> 阅读前提：本文讨论的是 [项目简介](./项目简介.md) 中"用法二：跨机远程"的**公网变体**——AI 客户端跑在公网云服务器、MCP Server 跑在路由器 NAT 后的 Windows 工位机。已有的 [Linux远程连接Windows MCP配置指南](./Linux远程连接Windows%20MCP配置指南.md)（下称"形态二"）覆盖的是服务器可 inbound 直连 Windows 的场景；本文讨论"服务器够不着 Windows"时的两条解法路线：SSH `-R` 双反向隧道（方案 A）与 VPN 组网（方案 B）。

## 一、 背景与方案选型

### 1. 核心矛盾与解法全景

跨机部署的核心矛盾是：物理串口、USB-ADB 这些设备只插在 Windows 上，MCP Server 必须守在设备旁；而 AI 客户端（Claude Code / ZCode / opencode）习惯跑在 Linux 侧。公网云服务器场景下，Win 蜗在家用路由器 NAT 后面，服务器发起的一切 inbound 连接都被丢弃——形态二（stdio 桥接）要求的"服务器主动 `ssh winuser@winip`"整体不可用。

但有一条对**所有方案**都成立的事实：**Win 能主动出站连接云服务器的 22 端口**。出站连接 NAT 天然放行，无需路由器做任何配置。于是所有可行方案共享同一个内核——既然服务器进不来，就**让 Win 主动出站建立一条通路**（或虚拟化一个网络让两边"回到同网段"）。差别只在于通路建起来之后，上面跑什么：

| 方案族 | 代表 | 通路形态 | 本质 |
| --- | --- | --- | --- |
| 反向隧道族 | `ssh -R`（[二、](#二-方案-assh--r-双反向隧道)方案 A）、frp、ngrok | 服务器侧暴露转发端口 | 端口级缝合，两个既有服务被"接线" |
| VPN / 覆盖网络族 | WireGuard 自建（[三、](#三-方案-bvpn-组网)方案 B）、Tailscale、ZeroTier | 虚拟网卡 + 虚拟网段 | **网络级缝合，直接恢复"同网段"前提** |
| NAT 打洞族 | STUN/P2P（内嵌于 Tailscale） | 尽力 P2P 直连 | 尝试绕过 NAT，失败回落中继 |
| 端口映射族 | 路由器转发 + DDNS | 真实 inbound | 被 CGNAT 大概率堵死（见 [4.2 节](#2-端口映射把入站规则静态写死的两条现实障碍)） |

两条主推路线的一句话定位：

- **方案 A（SSH `-R` 双反向隧道）**：零新增组件——只用手头就有的 ssh 和 npx（supergateway 经 npx 拉取），今天就能通；代价是要做一次 `remote-tunnel` 场景改造（见 [四、](#四-方案-a-的配套改造remote-tunnel-场景)；

- **方案 B（VPN 组网）**：装一次客户端，**人为恢复"同网段"前提**——形态二原样可用、项目代码零改动、`SSH_CONNECTION` 场景判定天然正确；代价是引入一个常驻网络组件。

### 2. 为什么公网服务器连不上路由器下的 Win

"服务器够不着 Win"是全部讨论的起点，这个"够不着"值得拆到底——它不是"被禁止"，而是"无处翻译、无人接账"。

#### 2.1 核心机制：NAT 是一张"出站连接的记账表"

家用路由器做的是 NAPT（网络地址端口转换），它维持一张**有状态的会话表**，每一行长这样：

```
内网主机:内网端口        ⇄        路由器公网端口        ⇄        对端(公网IP:端口)
192.168.1.100:54321   ⇄   公网IP:40001   ⇄   服务器IP:22
```

关键在于**记账方向**：这行记录是 Win 主动发起出站连接时才被创建的。要理解"发起连接"在 TCP 里的具体形态，先补一个基础概念——SYN 包。

SYN 是 TCP 建立连接时发出的第一个握手包的名字（"Synchronize（同步）"的缩写）。TCP 是面向连接的协议，任何一次数据传输前都要先"握手"确认双方都在：

```
TCP 三次握手：

  客户端                          服务器
     │                              │
     │ ── ① SYN ──────────────►    │   "我想连你，我的初始序列号是 x"
     │                              │
     │ ◄── ② SYN+ACK ─────────    │   "收到，我也准备好了，我的序列号是 y"
     │                              │
     │ ── ③ ACK ──────────────►    │   "好，正式开始传数据"
     │                              │
     ═══════ 连接建立，开始传数据 ═══════
```

SYN 包本身**不携带任何业务数据**，只带一个初始序列号作为"我想开始传数据"的信号（序列号是 TCP 给每个字节的编号，接收方靠它把乱序到达的包排回正确顺序）；服务器回 SYN+ACK，客户端再回 ACK（确认收到），三次握手完成，之后才是真正的 ssh / scp / HTTP 数据。**SYN 因此成为新连接的"出生证明"**——它标志着一条新连接的发起，而 NAT 和防火墙对包的处置，恰恰是按"这是不是一条新连接的第一个包"来分流的。两种方向的命运完全不同：

（1）**出站（Win → 服务器）**：Win 的 SYN 包经过路由器，路由器查表无记录 → 新建一行，把源地址改写成自己的公网 IP + 一个临时端口，转发出去。之后服务器回包到达时，路由器按表把这行记录"逆向翻译"回内网主机。一切正常，因为翻译依据是 Win 自己先登记的。

（2）**入站（服务器 → Win）**：服务器的 SYN 到达路由器的公网 IP:22。路由器查表——没有任何一行记录对应这个端口和方向，它面对一个**无法回答的问题**："内网里有好几台设备（手机、电视、Win……），这个包该翻译给谁？"答案不存在，于是**丢弃**。连接在握手第一步就死了，根本轮不到传任何 SSH 数据。

两种方向的命运用一张图对比：

```
出站（Win 主动连服务器）：查表无记录 → 新建一行记账 → 之后正常翻译

  Win(192.168.1.100)              路由器 NAT 会话表                    云服务器
  ─────────────────        ──────────────────────────        ─────────────
       │                        │                                │
  ssh 发起 SYN ────►  查表：无此行                              │
                        新建：公网IP:40001 ⇄ 192.168.1.100:54321 ⇄ 服务器:22
                        改写源地址，转发 ────────────────────►  收到
                        ◄──────── 按表行"逆向翻译"回内网 ◄────  回包
       │
   连接建立 ✅ 此后所有流量都按这行记账双向翻译

入站（服务器主动连 Win）：查表无对应行 → 无据可翻 → 丢弃

  云服务器                        路由器 NAT 会话表                    内网设备
  ─────────────                ──────────────────────────        ─────────────
       │                        │                                │
  SYN → 公网IP:22 ───►  查表：哪一行对应"从外网主动进来的 22"？      │
                        没有这一行。内网有手机/电视/Win 多台设备，
                        这个包该翻译给谁？——答案不存在，丢弃 ✗       ✗ 谁也收不到
```

这就是本质：**NAT 表里只有"出站时登记过的翻译规则"，入站包没有登记依据就无据可翻**。服务器的 SSH 连接请求不是被"拦截"的，是路由器**根本不知道这笔账该记给谁**——它只能做"翻译器"，而入站方向缺少可供翻译的上下文。用 SYN 的视角再总结一遍：**NAT 挡的不是"SSH"也不是"数据"，而是陌生的新入站 SYN；反向隧道与 VPN 的全部流量都长在一条"SYN 已被放行并记账"的既有连接里，所以永远不会撞上这道闸**。

#### 2.2 端口映射：把入站规则静态写死的两条现实障碍

端口映射（虚拟服务器/端口转发）就是在 NAT 表里**手工预置**一行永久记录："公网 IP:22 → 192.168.1.100:22"。如果这条路通，服务器确实可以直连。但两个现实让它大概率走不通：

（1）**家宽普遍没有公网 IPv4**。路由器 WAN 口拿到的往往是 `100.64.0.0/10`（运营商级 NAT，CGNAT）或 `10.x` 开头的**运营商内网地址**——路由器上面还摞着运营商的又一层 NAT。映射的"公网 IP"其实是运营商 NAT 的内网地址，从互联网根本路由不到。自查方法：路由器管理页看 WAN 口 IP，与"本机 IP 查询"网站对比，两者不一致即为 CGNAT，端口映射直接作废。

（2）**动态 IP**。即便是真公网 IPv4（家宽常常要打电话找运营商申请），也基本是动态分配——DDNS 可以缓解，但又多一个要维护的组件。

#### 2.3 防火墙：翻译之后的第二道闸

即使解决了 NAT 翻译问题，路由器 WAN 侧防火墙与 Windows 主机防火墙的默认策略仍是**丢弃一切未经放行的入站连接**。要逐层开洞：路由器入站规则 → Windows 防火墙放行 22，而每开一个洞都是永久暴露在公网扫描器面前的面。

#### 2.4 "Win 主动出站"路线为什么天然绕开这些阻碍

把方案 A 与方案 B 的机制放回这个框架里，逻辑就闭环了：

| 阻碍 | 出站路线为什么不受影响 |
| --- | --- |
| NAT 无入站映射依据 | 不需要——Win 主动出站连接服务器时，路由器照常建立翻译记录；后续所有流量（包括服务器塞回来的隧道 / VPN 数据）都**复用这一行已存在的记账**，方向上仍是这条连接内的双向传输 |
| 无公网 IPv4 / CGNAT | 无所谓——Win 只要出站可达即可；NAT 摞多少层，出站连接都逐层被正常翻译 |
| 防火墙拦入站 | 无所谓——不存在指向 Win 的新入站连接；Win 侧最后一跳是本机回环（连自己），Windows 防火墙不拦 loopback |
| 动态 IP | 无所谓——Win 每次重连都主动找到服务器，服务器不需要知道 Win 的地址 |

一句话总结：**云服务器连不上路由器下的 Win，不是因为"被禁止"，而是因为"无处翻译、无人接账"——NAT 只为 Win 主动发起的出站连接记账，服务器的入站请求查无此项，只能丢弃；而两条解法路线的共同巧思，就是把需求设计成"只花 Win 已经记好的那笔账"**。

### 3. 方案 A 与方案 B 的选型对比

| 维度 | 方案 A：ssh -R 双隧道 | 方案 B：自建 WireGuard |
| --- | --- | --- |
| 新增组件 | 零（ssh 系统自带，supergateway 经 npx 拉取） | WireGuard 双端 |
| 协议转换 | 需要 supergateway | **不需要**——形态二 stdio 桥接原样成立 |
| 代码改动 | 需 `remote-tunnel` 场景改造（[四、](#四-方案-a-的配套改造remote-tunnel-场景)） | **零改动**——`SSH_CONNECTION` 天然存在，`remote-ssh` 判定天然正确 |
| 文件传输 | 第二条 `-R` + `scp -P 7000` | scp 直连虚拟 IP，无需额外端口 |
| 依赖第三方 | 无 | 无（自建） |
| 国内连通性 | TCP 22，稳定 | UDP 51820，一般稳定 |
| 保活/重连 | 手工循环脚本 | 内置 keepalive |
| 适合场景 | 今天就要通、不想装任何东西 | 长期使用、可以装一次客户端 |

一句话选型：**追求零新增组件、立刻可用 → 方案 A；追求长期稳定、可以装个客户端 → 方案 B**。两条路线其实是投入位置不同的同一笔账——方案 A 把成本花在"隧道之上的适配"（协议转换 + 场景改造），方案 B 把成本花在"一次性组网"，换来整个跨机改造都不用做。

另有两个变体在此一并交代：**frp** 是方案 A 的工业化替代（架构完全同构，自带断线重连、token 认证、dashboard，若打算上常驻运维服务可选）；**Tailscale/ZeroTier** 是方案 B 的零配置变体（基于 WireGuard + 自动打洞，但国内环境下控制面在国外、公共 DERP 中继在境外，打洞不稳时时延高——若用需自建 DERP 或 headscale，那又回到了自建的复杂度，往往不如直接自建 WireGuard 干净）。

## 二、 方案 A：SSH -R 双反向隧道

### 1. 反向转发（ssh -R）的工作原理

`ssh -R <服务器端口>:<Win侧目标地址>:<目标端口> user@服务器` 是挂在这条 Win 主动发起的 SSH 连接上的转发指令，分两个阶段工作：

**注册阶段**：SSH 连接建立后，服务器端 sshd 在**服务器本机**监听 `<服务器端口>`（默认绑回环 127.0.0.1）。此时还没有任何业务数据流动，只是端口登记完成——从服务器的视角，本机多了一个"看似本地"的服务。

**使用阶段**：服务器上任何进程连这个端口，sshd 不在本地处理，而是把这条新连接封装成 SSH 连接协议（RFC 4254）的一个逻辑通道，塞进 Win 建好的那条 SSH 连接里传回；Win 侧的 ssh 客户端收到后，在 Win 本机向 `<Win侧目标地址>:<目标端口>` 发起一条新的 TCP 连接。此后双向字节流沿"服务器进程 ↔ 服务器回环端口 ↔ 既有 SSH 连接中的通道 ↔ Win 回环连接 ↔ Win 目标服务"转发。

```
使用阶段的流量路径（以 -R 7000:127.0.0.1:22 为例）：

服务器进程 ──连──> 127.0.0.1:7000（服务器 sshd 监听）
                        │ 封装为新通道
                        ▼
          ══ Win 主动建立的 SSH 连接（复用，非新连接）══
                        │ 通道数据到达 Win
                        ▼
Win ssh 客户端 ──在本机回环发起──> 127.0.0.1:22（Win sshd）
```

这条机制里有四个关键事实，它们共同决定了方案为什么成立：

（1）**监听在服务器、服务在 Win**：端口暴露在"能被访问的一侧"（服务器），实际服务挂在"够不着的一侧"（Win），中间由隧道缝合——这正是"访问方进不去、被访问方出得来"这类非对称网络的标准解法。

（2）**既有连接复用，无新开 inbound**：每条经隧道的客户端连接只是既有 SSH 连接里的一个新逻辑通道（通道多路复用），不会产生任何从服务器指向 Win 的新 TCP 连接。NAT 挡的是新 inbound 连接的建立，挡不住一条已建立连接内部复用的通道数据。

（3）**隧道的最后一跳由 Win 侧发起**：连接 Win 本地服务的那一跳，是 Win 上的 ssh 客户端在**本机回环**上发起的，等于 Win 连自己，Windows 防火墙不拦 loopback，与 NAT 毫无关系。

（4）**转发的是"连接"而不是"一个端口的数据"**：每个服务器侧的新连接都对应一条独立的通道 + 一条独立的 Win 回环连接，因此多个 scp 会话、多个 HTTP 客户端可以并发使用同一个转发端口，互不干扰。

### 2. 通道一（8000）：解决"MCP 调用够不着 Win"的问题

#### 2.1 要解决的问题：三层障碍

服务器上的 AI 客户端要调用 Win 上的 MCP 工具，中间隔着三层障碍，缺一不可解：

（1）**网络层——够不着**：服务器发起的 inbound 到不了 NAT 后的 Win。形态二的 stdio 桥接（客户端 spawn `ssh win ...`）依赖服务器能发起这条 SSH，整体不可用。

（2）**方向层——方向反了**：连接只能由 Win 发起（出站），而 Win 发起的连接在服务器侧只能表现为"一个监听端口"，不能表现为"一条可被客户端 spawn 的命令"。stdio 桥接要求的是后者。

（3）**协议层——管道挂不到端口上**：MCP 本体是 stdio transport——stdin/stdout 管道语义，要求父进程以子进程方式拉起它并对管道读写。管道语义无法直接挂到 TCP 端口上，即使有一条能通到 Win 的 TCP 通道，端口后面也必须先有一个"懂 TCP 的服务"。

#### 2.2 方案：supergateway 协议转换 + -R 8000 缝合

```bat
npx -y supergateway --stdio "cmd.exe /d /c remote-start-mcp.bat" --port 8000 --outputTransport streamableHttp --cors

ssh -N -R 8000:127.0.0.1:8000 user@云服务器IP
```

supergateway 在 Win 本地把 stdio MCP 包装成 HTTP 服务（监听 Win 回环 :8000），`-R 8000` 把服务器回环 8000 与它缝合。三点说明：

- `--stdio` 写 `remote-start-mcp.bat` 而非裸 `node`，因为 bat 负责锚定项目根目录并注入 `DEVICE`、`BOARD_CONFIG_PATH`、`LOG_SAVE` 等 5 个环境变量，保证经隧道拉起的进程与本地 Claude 启动时环境一致；

- `--outputTransport streamableHttp` 时端点为 `/mcp`（默认 `sse` 时端点为 `/sse`），Streamable HTTP 与新版客户端兼容性更好；

- supergateway spawn 子进程会继承 env，因此改造后注入的场景变量（见[四、](#四-方案-a-的配套改造remote-tunnel-场景)）在 bat 或 npx 外层 `set` 均可生效。

服务器端 MCP 客户端配置（以 Claude Code 为例）：

```json
{
  "mcpServers": {
    "embedded-board": {
      "type": "http",
      "url": "http://127.0.0.1:8000/mcp"
    }
  }
}
```

#### 2.3 为什么这样就能解决

把三层障碍逐一对照回去：

（1）**网络层被通道复用化解**：AI 发 POST 到服务器回环 8000，流量沿 Win 建好的连接回流（[1. 节](#1-反向转发ssh--r的工作原理)的关键事实 2、3），NAT 全程无感——障碍消失的机制不是"穿透了 NAT"，而是"绕开了需要新 inbound 的路径"；

（2）**方向层被端口化化解**：Win 发起的连接在服务器侧表现为端口，方案不再对抗这个事实，而是顺着它设计——服务器侧的 AI 客户端本来就能充当 HTTP 客户端，访问"本机端口"对它零门槛；

（3）**协议层被 supergateway 化解**：HTTP 的请求-响应模型与 MCP 的 JSON-RPC 请求-响应模型一一对应，supergateway 在中间做双向翻译（HTTP 请求 → 写子进程 stdin，子进程 stdout → HTTP 响应）。stdio 的管道语义被完整保留在 Win 本地这一小段，跨机的长距离走的是 HTTP。

完整时序：AI 发 `POST /mcp` → 服务器回环 8000 → 隧道通道 → Win supergateway → stdio 写给 MCP 子进程 → 响应原路返回。**所有工具的物理 I/O 都发生在 Win 进程本地**：`serial_open` 打开的是 Win 的 COM 口，`adb` 连的是插在 Win 上的板子，隧道只搬运 JSON-RPC 报文，不搬运设备操作本身——这就是"远程访问物理串口"成立的根本原因。

```
一次工具调用的完整路径（以 serial_open 为例）：

  [云服务器] AI 客户端
      │ ① JSON-RPC 报文封装成 HTTP：POST http://127.0.0.1:8000/mcp
      ▼
  [云服务器] 回环 :8000（sshd 监听）
      │ ② 封装为 SSH 逻辑通道，沿 Win 建好的连接传输
      ▼
  [Win] supergateway :8000
      │ ③ 协议翻译：HTTP 请求 → 写子进程 stdin
      ▼
  [Win] MCP 子进程（stdio transport）
      │ ④ 工具执行：serial_open("COM3") —— 打开的是 Win 的物理串口
      ▼
  [Win] COM 口 / USB-ADB 设备
      └── 响应按 ④→③→②→① 原路返回：报文过了隧道，设备操作始终没离开 Win
```

#### 2.4 这条通道的边界：只搬报文，搬不了文件

8000 通道搬运的**只有 JSON-RPC 报文**。MCP 的文件类工具（`serial_upload` / `ssh_sftp_upload`）语义是"`local_path` 是 **Win 本地路径**，从这个路径读文件"——它们读的是 Win 的磁盘。AI 在服务器编译出固件后，文件在服务器磁盘上，Win 上根本没有这个文件：报文通道无论多通畅，都改变不了"工具要读的那个文件不在工具所在机器上"这个事实。把文件弄到 Win，需要第二条通道。

```
编译完成后的文件缺口与两条通道的分工：

  [云服务器] ~/build/driver.ko            ← 编译产物在这里
      │
      │  ✗ 8000 通道只搬 JSON-RPC 报文，搬不了文件本体
      │    serial_upload 的 local_path 指的是 Win 路径——Win 磁盘上没有这个文件
      ▼
  [Win] 磁盘（没有 driver.ko）── serial_upload 从这里读 → 读不到 ✗
      │
      └── 必须先经 7000 通道把文件推过来（见 3.）

完整流水线（三条环节各司其职）：

  编译(服务器磁盘)
      ──scp -P 7000──►  .embedded/tmp/(Win 磁盘)
      ──serial_upload──►  设备串口(ZMODEM)
```

### 3. 通道二（7000）：解决"文件到不了 Win"的问题

#### 3.1 要解决的问题

让服务器磁盘上的文件能够到 Win 磁盘（推），或反向取回（拉）。约束有两条：

（1）服务器到 Win 没有任何 inbound 可用，不能指望"服务器直接 scp 到 Win"；

（2）不应为传文件发明新协议、写新代码——项目已有的 `serial_upload` 等工具链不需要任何改动。

#### 3.2 方案：把 Win 自己的 sshd 反代到服务器

```bat
ssh -N -R 7000:127.0.0.1:22 user@云服务器IP
```

Win 上启用 OpenSSH Server 后，这条转发把服务器回环 7000 缝到 Win 自己的 sshd（22）上。服务器侧的日常使用：

```bash
# 服务器 → Win 推（编译产物，为烧录做准备）
scp -P 7000 -i ~/.ssh/id_mcp_server ~/build/driver.ko winuser@127.0.0.1:"E:/.../.embedded/tmp/"

# Win → 服务器拉（日志、从设备下载的文件）
scp -P 7000 -i ~/.ssh/id_mcp_server winuser@127.0.0.1:"E:/.../.embedded/log/mcp.log" ~/
```

两条 `-R` 挂在同一条 Win 出站连接上（完整命令见 [5. 节](#5-拓扑总览与启动命令)），一套连接、一套保活逻辑。

```
服务器推送固件到 Win 的完整路径（scp -P 7000 ... .embedded/tmp/）：

  [云服务器] scp 客户端
      │ ① 目标端点写成 127.0.0.1 -P 7000（自己本机的隧道端口）
      ▼
  [云服务器] 回环 :7000（sshd 监听）
      │ ② 封装为 SSH 逻辑通道，沿 Win 建好的连接传输
      ▼
  [Win] sshd :22
      │ ③ 对 Win 的 sshd 来说，这就是一条再普通不过的本机 SSH 会话
      │    ——认证、加密、SFTP 全部由标准栈完成，零新代码
      ▼
  [Win] 磁盘 E:/.../.embedded/tmp/driver.ko
      └── ✅ 文件落到了 serial_upload 够得着的地方，烧录环节可以继续
```

#### 3.3 为什么这样就能解决：三层复用

（1）**传输协议复用**：scp 走的本来就是 SSH 协议，而这条隧道的末端恰好是 Win 的 sshd——服务器发起的 scp 会话经隧道回流后，对 Win sshd 来说就是一条再普通不过的本机 SSH 会话，认证、加密、SFTP 文件传输语义全部由标准栈完成。**方案不为文件搬运写一行新代码、不改任何 MCP 工具**，只是把"服务器上的 scp 客户端"和"Win 上的 sshd"这两个既有组件用隧道接到了一起。

（2）**客户端复用**：服务器上本来就有 ssh/scp 客户端，AI 的使用习惯几乎不变——只需要把目标端点写成 `127.0.0.1`、端口写成 `-P 7000`，其余照旧。

（3）**凭据复用**：免密体系沿用形态二的 `id_mcp_server` 公私钥对——服务器持私钥 `~/.ssh/id_mcp_server`，Win 的 `authorized_keys` 持对应公钥，认证发生在 Win sshd 侧，与形态二完全同构。注意它与隧道本身的认证（Win 登录服务器那把钥匙）是**两把、两个方向**，不要混淆。

#### 3.4 为什么"服务器主动传输"与"Win 发起连接"不矛盾

这里是最容易绕晕的一点，要把两个概念分开：

（1）**主动权是时序概念**：服务器进程随时可以往自己回环的 7000 发起连接、执行 scp，不需要 Win 配合、不需要通知 Win——想传就传；

（2）**连接方向是物理概念**：这些流量全部塞在 Win 早已建好的那条出站 SSH 连接里回流，全程没有服务器发起的 inbound。

NAT 挡的是后者（物理方向），挡不住前者（时序主动权）。所以"服务器主动向 Win 推文件"在这个方案里的准确表述是：**服务器主动向自己本机的一个端口写数据，隧道代劳剩下的路**。

### 4. 为什么必须这样做：备选方案排除

| 备选 | 不可行 / 不优选的原因 |
| --- | --- |
| 服务器直连 Win 的 22 | inbound 被 NAT 掐断——这是整个问题的起点 |
| 服务器也发起一条"反向隧道" | 方向不成立：反向转发只能由**被访问方**发起（它必须能出站到访问方）。Win 是被访问方，所以隧道永远由 Win 发起；服务器作为访问方发起的任何隧道都到不了 NAT 后的 Win |
| 路由器端口映射 / 家宽公网 IP | 需要改路由器配置，且家宽通常没有公网 IPv4，不满足"零路由器配置"的前提 |
| VPN / Tailscale 组网 | 技术上完全可行，且各有明确优势——正因如此独立成[三、](#三-方案-bvpn-组网)与[一、3 节](#3-方案-a-与方案-b的选型对比)对比讨论，不在方案 A 内部排除 |
| Win 上开两条独立连接分别跑两个 `-R` | 可行但没必要：两条连接两套保活/重连逻辑，没有任何收益；只有当两个服务想独立断连/重启时才值得拆开 |
| **一条连接 + 双 `-R`（方案 A）** | ✅ 一条 Win 出站连接缝合两个需求，开销最小，保活/重连逻辑只有一套 |

### 5. 拓扑总览与启动命令

```
Win 工位机（NAT 后）                          公网云服务器
──────────────────────                      ─────────────────────
supergateway :8000 ──┐
                     │
sshd :22 ────────────┤   Win 主动发起的一条 SSH 连接
                     │   （-N -R 双反向转发挂在这条连接上）
                     ▼
             服务器侧监听端口
               ├─ 127.0.0.1:8000 → 回流 Win 的 8000（MCP HTTP 调用）
               └─ 127.0.0.1:7000 → 回流 Win 的 22（scp 文件传输）

AI 客户端（跑在服务器本机）
  ├─ MCP 调用：POST http://127.0.0.1:8000/mcp
  └─ 文件传输：scp -P 7000 winuser@127.0.0.1:...
```

Win 侧完整隧道命令：

```bat
ssh -N -R 8000:127.0.0.1:8000 -R 7000:127.0.0.1:22 ^
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ^
    -o ExitOnForwardFailure=yes user@云服务器IP
```

### 6. 与形态二的行为差异

| 维度 | 形态二（stdio 桥接） | 方案 A（HTTP + 反向隧道） |
| --- | --- | --- |
| 连接方向 | 服务器 → Win（inbound） | Win → 服务器（出站 + `-R` 回流） |
| 协议层 | stdio 经 SSH 直接延长，零转换 | stdio → HTTP（supergateway）→ TCP 隧道 |
| MCP 进程生命周期 | 连接即启动、断开即退出 | supergateway 常驻拉起，MCP 为常驻单例 |
| 会话状态 | 每次 SSH 断开会话全丢 | 会话跨工具调用天然保持；但 supergateway 重启全丢 |
| 场景判定 | `SSH_CONNECTION` 存在，`remote-ssh` 正确 | `SSH_CONNECTION` 不存在，误判 local（见[四、](#四-方案-a-的配套改造remote-tunnel-场景)） |
| 时延 | 局域网 RTT | 每次工具调用多一个公网 RTT，交互式工具需留余量 |
| 前提条件 | 服务器可达 Win:22 | Win 可出站到服务器:22 + Win 启用 OpenSSH Server |

## 三、 方案 B：VPN 组网

### 1. 核心思想：人为恢复"同网段"前提

方案 A 是在"服务器够不着 Win"这个现实上做端口级缝合，方案 B 则换个思路——**用一张虚拟网卡把两头直接缝合到一个网段里**，让[一、1 节](#1-核心矛盾与解法全景)选型表里"同网段"的前提被人为恢复，从而形态二的所有既有机制原样成立。

```
VPN 建立后：形态二的全部前提原样成立

  云服务器 ════ Win 出站建立的 VPN 通道（如 WireGuard UDP 51820）════ Win
      │
      │  虚拟网卡：服务器 10.0.0.1  ←→  Win 10.0.0.2
      │  （虚拟 IP 的流量全部走在这条 Win 出站建立的通道里）
      ▼
  服务器可 inbound 直连 Win 的虚拟 IP：
      ssh winuser@10.0.0.2 remote-start-mcp.bat
      └── 与局域网直连完全同构 → 形态二原样可用
```

注意这**不需要穿透路由器 NAT**：VPN 通道本身是 Win 出站建好的（同[一、2.4 节](#24-win-主动出站路线为什么天然绕开这些阻碍)的记账原理），虚拟 IP 的流量全部走在这条通道里，对 NAT 而言只是既有出站连接里的续传数据。

### 2. 与方案 A 最本质的架构差异

方案 A 的隧道是**端口级**缝合——服务器侧只能看到端口，所以必须协议转换（supergateway）、必须记转发端口号（`-P 7000`）、必须做场景改造（`remote-tunnel`）。方案 B 的 VPN 是**网络级**缝合——Win 在服务器眼里就是一台虚拟 IP 可达的普通主机，于是连锁的收益清单：

（1）**不需要 supergateway**——形态二的 stdio 桥接直接成立，AI 客户端配置里 `command` 写 `ssh`、目标写虚拟 IP 即可，零协议转换；

（2）**不需要双 `-R`**——文件传输直接 `scp winuser@10.0.0.2`，不需要 7000 端口、不需要记端口号；

（3）**不需要任何代码改动**——这是最值钱的一条。VPN 下 Win 的 sshd 真实参与会话，`SSH_CONNECTION` 存在 → 现有 `remote-ssh` 场景判定**天然正确**：`host_info` 返回真实端点（`winuser@10.0.0.2`）、instructions 注入、`power_shell` 注册、`ssh_build` 不注册，全部行为零修改。[四、](#四-方案-a-的配套改造remote-tunnel-场景)的 `remote-tunnel` 改造整个不需要做；

（4）**项目现成工具链直接复用**——`sshd-config` + `remote-mcp-config` 生成的配置里把 `winip` 换成 VPN 虚拟 IP（10.0.0.2）即可。

### 3. 实现路线

#### 3.1 自建 WireGuard（推荐首选）

云服务器有公网 IP，跑 WireGuard 服务端，安全组放行一个 UDP 端口（如 51820）；Win 装客户端、配置密钥对、`PersistentKeepalive=25` 保活。要点：

- 全程自持——不依赖任何第三方服务、不需要域名、加密强度现代；

- Win 侧 `PersistentKeepalive=25` 每 25 秒发一个保活包，作用有两个：让 NAT 记账行不过期，同时让服务器随时都能反向发起连接（VPN 下服务器可以主动连 Win 的虚拟 IP——这正是"恢复同网段"的意义）；

- 代价是要手工管密钥和虚拟 IP 分配——对单服务器 + 单 Win 的场景，这就是一次性配 10 分钟的事。

#### 3.2 Tailscale / ZeroTier（零配置覆盖网）

基于 WireGuard，自动做 NAT 打洞，打不通自动回落中继（DERP）。优点是安装即用、双端零配置、免费档够用；缺点是国内环境面临两个现实问题——**控制面在国外**（登录/密钥协商可能不稳），**公共 DERP 中继在境外**（回落中继时延高）。解法是在自己云服务器上自建 DERP 或 headscale 控制面，但那又回到了自建的复杂度——所以国内环境下往往不如直接自建 WireGuard 干净。适合：已有海外网络环境、或不想碰任何配置的场景。

### 4. 方案 B 的部署步骤

（1）云服务器安装 WireGuard（`apt install wireguard` 或对应包管理器），生成服务端密钥对，配置 `wg0` 接口（地址如 `10.0.0.1/24`，监听 UDP 51820），安全组放行该端口。

（2）Win 安装 WireGuard 客户端，生成客户端密钥对，配置 `Peer` 指向服务器公网 IP:51820，`AllowedIPs = 10.0.0.0/24`，`PersistentKeepalive = 25`。

（3）服务器上 `ping 10.0.0.2` 验证通道连通。

（4）Win 启用 OpenSSH Server（同方案 A 的[五、1 节](#1-前置条件)），服务器免密配置（同形态二的 `sshd-config` 流程，端点写 `winuser@10.0.0.2`）。

（5）服务器端写 MCP 客户端配置——与形态二完全相同的 stdio 桥接配置，仅 `winip` 换成 `10.0.0.2`；或直接用 `remote-mcp-config` 命令写入后手工改 IP。

（6）端到端验收：让 AI 调 `host_info`（应返回 `remote-ssh started` + `winuser@10.0.0.2`）、`scp` 推固件（无需 `-P`）、`serial_upload` 烧录。

### 5. 方案 B 的运维与边界

（1）**保活**：`PersistentKeepalive=25` 内置，无需循环脚本——这是对方案 A 手工保活的最大改善；UDP 对断线重连天然宽容，WireGuard 自动恢复。

（2）**安全边界**：VPN 接口本身有密钥认证；Win 的 sshd 只在虚拟网卡上对服务器可达，物理网卡零暴露面。比方案 A 多的一层保障是**按密钥分网**——没有服务器签发的密钥对，连虚拟网段都进不来。

（3）**时延预算**：与方案 A 同级（公网 RTT），UDP 头部开销略小于 SSH over TCP，高丢包链路上 UDP 重传也更友好。

（4）**边界**：UDP 51820 在个别受限网络可能被 QoS 限速或封锁（相对 TCP 22 更少见但有），此时退回方案 A 的 TCP 隧道更稳。

## 四、 方案 A 的配套改造：remote-tunnel 场景

> 本章是方案 A 的专属成本——方案 B（VPN）下 `SSH_CONNECTION` 天然存在，无需任何改造，本章可整体跳过。

### 1. 误判面：SSH_CONNECTION 二值判定的影响

现有场景判定在 [`src/sdk/host/host-endpoint.ts`](../src/sdk/host/host-endpoint.ts#L129-L169)：存在 `SSH_CONNECTION`（由 sshd 注入）→ `remote-ssh`，否则 → `local`。supergateway 是在 Win 本地 spawn MCP 的，`SSH_CONNECTION` 必然不存在 → 误判为 `local`。连锁反应波及四件事，不只是 `host_info`：

| 依赖场景判定的行为 | 代码位置 | local 误判的后果 | 隧道拓扑下应有的行为 |
| --- | --- | --- | --- |
| `instructions` 注入 | [`src/mcp/server.ts`](../src/mcp/server.ts#L71-L84) | `undefined`，AI 拿不到任何 scp 引导 | 应注入，且 scp 要带 `-P 7000` |
| `host_info` 返回 | [`src/sdk/tools/basic/host-info.ts`](../src/sdk/tools/basic/host-info.ts#L85-L132) | "local started"，误导 AI 以为无需跨机传输 | 应返回隧道端点与 `-P 7000` 引导 |
| `power_shell_*` 注册 | [`src/mcp/pshell-policy.ts`](../src/mcp/pshell-policy.ts#L42) | **不注册** | **应注册**——AI 在云端，这是它唯一的 Windows 执行通道 |
| `ssh_build` 注册 | [`src/mcp/pshell-policy.ts`](../src/mcp/pshell-policy.ts#L66) | **注册** | **不应注册**——AI 就在云端编译机上，注册了反而诱导绕行 |

注意后两行：两个工具注册策略在误判下**恰好都反了**。这是本改造最实质的理由——不区分的话 AI 既没有 Windows shell 通道，又被塞了一个不该用的编译绕行工具。

### 2. 新场景 remote-tunnel 与环境变量注入

改造面临两个硬约束：

（1）`SSH_CONNECTION` 是 sshd 注入的，supergateway 本地拉起永远拿不到，无法复用现有探测。

（2）**"服务器侧反代端口 7000"这个数字只存在于 Win 的 `ssh -R` 命令行里**，是部署者的知识，MCP 进程无从发现。

因此唯一可行的路径是**在拉起 MCP 时用环境变量显式告知**，让端点解析长出第三个场景：

- 新场景：`HostScenario` 增加 `"remote-tunnel"`，与 `"local"` / `"remote-ssh"` 三态并存；

- 注入变量：`EMBEDDED_TUNNEL_SSH_PORT`（本方案取 7000），Win 侧启动脚本中 `set EMBEDDED_TUNNEL_SSH_PORT=7000` 后再拉起 supergateway；

- 端点语义：`remote-tunnel` 场景下 `endpoint = <winuser>@127.0.0.1`，并携带 `scpPort` 字段（取自上述环境变量）；

- 优先级：`SSH_CONNECTION` 存在时优先按 `remote-ssh` 处理（真实 sshd 会话更权威）；两者同时设置时打日志告警；

- 部署耦合：`EMBEDDED_TUNNEL_SSH_PORT` 的值必须与 `ssh -R` 第二个转发的服务器侧端口一致，文档与配置模板中需显式强调。

启动侧建议仿照 `remote-start-mcp.bat` 生成一个 `remote-start-tunnel.bat` 包装：锚定 cwd、set 场景变量、再拉起 supergateway，避免每次手工敲两条命令。

改造后的三场景判定与配套行为汇总成一张决策图：

```
场景判定与注册策略（改造后）：

            进程启动时读环境变量
                    │
    ┌───────────────┼─────────────────────┐
    ▼               ▼                     ▼
 SSH_CONNECTION   两者都没有           EMBEDDED_TUNNEL_SSH_PORT
 存在（sshd 注入）  （本地启动）          存在（supergateway 拉起）
    │               │                     │
    ▼               ▼                     ▼
 remote-ssh        local                remote-tunnel
 （形态二/方案B） （客户端与 MCP 同机）  （方案 A 隧道拓扑）
    │               │                     │
    ├─ 端点 winuser@winip    ├─ 不注入端点         ├─ 端点 winuser@127.0.0.1 + scpPort
    ├─ scp 骨架不带 -P       ├─ 不注册 power_shell  ├─ scp 骨架带 -P 7000
    ├─ 注册 power_shell      └─ 注册 ssh_build     ├─ 注册 power_shell
    └─ 不注册 ssh_build        （客户端自带 shell） └─ 不注册 ssh_build
```

### 3. 改动点清单

| 文件 | 改动内容 |
| --- | --- |
| [`src/sdk/host/host-endpoint.ts`](../src/sdk/host/host-endpoint.ts) | `HostScenario` 与内联类型增加 `"remote-tunnel"`；检测 `EMBEDDED_TUNNEL_SSH_PORT`；`HostEndpoint` 增加 `scpPort` 字段；新来源 `source: "tunnel-env"`；`SSH_CONNECTION` 优先级与告警 |
| [`src/sdk/tools/basic/host-info.ts`](../src/sdk/tools/basic/host-info.ts) | `formatHostEndpoint()` 新增 tunnel 分支：`Host: remote-tunnel started`、scp 骨架带 `-P ${scpPort}` |
| [`src/mcp/server.ts`](../src/mcp/server.ts#L71-L84) | `instructions` 构造新增 tunnel 分支，scp 骨架带 `-P 7000`，`.embedded/tmp` 落点指引保持不变 |
| [`src/mcp/pshell-policy.ts`](../src/mcp/pshell-policy.ts) | `shouldRegisterPshellTools` 默认分支由 `scenario === "remote-ssh"` 放宽为 `scenario !== "local"`；`ssh_build` 的默认逻辑（`return scenario === "local"`）天然兼容三态，无需改动，仅需更新内联的 `HostScenario` 类型与注释 |

### 4. 指引文本的视角修正

`127.0.0.1` 在形态二里指"Win 自己"，在隧道拓扑里指"**AI 客户端所在云服务器上的隧道端口**"——两个语义不能靠 AI 自己悟。ch17 迭代二已经踩过一次"AI 把 MCP 宿主当成自己"的坑（误用 `power_shell` 跑方向反了的 scp），隧道拓扑是同类问题的变体，指引文本必须把视角说死：

```text
Host:       remote-tunnel started
Endpoint:   winuser@127.0.0.1 (scp port 7000)
Source:     tunnel-env

Usage: You (the AI client) are running on the cloud server; this MCP server
runs on a Windows host behind NAT, reachable ONLY through the reverse tunnel
on YOUR OWN machine. 127.0.0.1:7000 is a tunnel port on the machine YOU are
running on — traffic flows back through the SSH tunnel to the Windows host.
Always pass the passwordless key -i ~/.ssh/id_mcp_server:
  - Server <- Windows (pull):  scp -P 7000 -i ~/.ssh/id_mcp_server winuser@127.0.0.1:"E:/path" ~/local/
  - Server -> Windows (push):  scp -P 7000 -i ~/.ssh/id_mcp_server ~/local/file winuser@127.0.0.1:"E:/.../.embedded/tmp/"
```

密钥链可整体复用形态二的 `id_mcp_server` 免密体系；`sshd-config` 命令的两步动作（Win 出站登录 Linux 生成密钥、把公钥写进 Win 本机 `authorized_keys`）在隧道拓扑下依然走得通，仅客户端连接端点从 `winip:22` 变为 `127.0.0.1:7000`。

## 五、 部署与运维（方案 A）

> 方案 B 的部署步骤见[三、4 节](#4-方案-b-部署步骤)；本章为方案 A 的部署细节。

### 1. 前置条件

（1）Win 启用 OpenSSH Server：`Get-WindowsCapability -Online -Name OpenSSH.Server*` 安装并启动 `sshd` 服务（7000 通道的认证端点）。

（2）免密配置：服务器生成密钥对，公钥写入 Win 的 `C:\Users\<winuser>\.ssh\authorized_keys`；隧道自身的认证（Win 登录服务器）单独一把钥匙。

（3）Win 可出站访问云服务器的 22 端口（公网服务器默认满足）。

（4）Win 项目根目录已执行 `init`，存在 `remote-start-mcp.bat` 与 `.embedded/` 数据目录。

### 2. 部署步骤

（1）Win 上启动 supergateway（若已实施[四、](#四-方案-a-的配套改造remote-tunnel-场景)改造，用 `remote-start-tunnel.bat`；未实施则手工 `set` 环境变量后启动）。

（2）Win 上建立双反向隧道（`ssh -N -R 8000:... -R 7000:... user@云服务器IP`），确认无 "port forwarding failure" 报错。

（3）服务器上验证通道连通：`curl -X POST http://127.0.0.1:8000/mcp` 有响应；`ssh -p 7000 winuser@127.0.0.1` 能免密登录 Win。

（4）服务器端写 MCP 客户端配置（`type: "http"` + `url: http://127.0.0.1:8000/mcp`），重启客户端后在工具列表中确认 `embedded-board` 出现。

（5）端到端验收：让 AI 依次调 `host_info`（确认 tunnel 场景与引导）、`scp -P 7000` 推一个文件到 `.embedded/tmp/`、再调 `serial_upload` 烧录该文件。

### 3. 隧道保活与重连

这条 Win 出站连接是全链路的单点，公网 + NAT 断线是常态，而 Windows 没有 autossh：

- 客户端侧 keepalive：`-o ServerAliveInterval=30 -o ServerAliveCountMax=3`，90 秒无响应即判定死链；

- 失败即退：`-o ExitOnForwardFailure=yes`，转发没建成功就直接退出而不是挂着一条空连接；

- 自动重连：写一个循环 `.bat` 或注册计划任务，检测到 ssh 进程退出即重新拉起（可加退避间隔）；

- 端口残留：重连时若报 7000/8000 端口占用，是服务器侧旧 sshd 会话未释放，等待几秒重试即可；

- supergateway 与隧道是两个独立进程：隧道重连不影响已建立的 MCP 会话，但 supergateway 重启会丢掉全部 serial/ssh 会话状态。

### 4. 安全边界

（1）两个 `-R` 都绑在服务器回环上，能碰 8000/7000 的只有服务器本机进程，不扩大公网暴露面；除非客户端跑在服务器的容器/其他机器里，否则不要开 `GatewayPorts`。

（2）本 MCP 暴露了 `power_shell_exec` 这类等同远程 shell 的工具，隧道两端点都收缩到"持有服务器账号的人"这个访问面内，服务器账号本身要管好。

（3）`-N` 禁止远端命令执行，隧道连接只承担端口转发职责。

### 5. 时延预算

每次工具调用多一个公网 RTT（几十 ms 级）：`serial_exec` / `serial_enter_uboot` 这类带 `timeoutMs` 的交互式调用要把网络往返算进余量，适当上调超时参数；长会话（`serial_open` 后的持续 read）与流式传输（ZMODEM）不受单次调用 RTT 影响。

---
*本文档由 markdowncli 技能辅助生成*
