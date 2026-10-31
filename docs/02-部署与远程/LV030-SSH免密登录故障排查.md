## 一、 SSH 免密登录故障排查（双网卡 IP 访问差异）

> **排查日期**：2026-08-04
> **环境**：AI 客户端（Linux）↔ Windows MCP 服务器（双网卡）↔ 嵌入式开发板
> **结论**：根因为 Windows 防火墙网络类别（Profile）差异，已通过新增 All Profiles 入站规则修复。

---

## 二、 现象描述

Windows 主机上有两块网卡，均可 ping 通，但 SSH 免密登录行为不一致：

| 目标 IP | 网卡 | ping | SSH 免密登录（22 端口） |
|---------|------|------|------------------------|
| `192.168.10.102` | Wi-Fi（Intel AX200） | ✅ 通 | ✅ 正常免密登录 |
| `192.168.16.100` | USB 千兆（ASIX） | ✅ 通 | ❌ 连接超时/拒绝 |

登录命令：

```bash
# ✅ 可正常免密登录
ssh -i ~/.ssh/id_mcp_server <win_user>@192.168.10.102

# ❌ 无法登录（卡住或超时）
ssh -i ~/.ssh/id_mcp_server <win_user>@192.168.16.100
```

**关键疑点**：两块网卡都能 ping 通，说明网络层（ICMP）是通的，为何独独 SSH（TCP 22）有差异？

---

## 三、 诊断过程（自下而上分层排查）

### 1. 网络层 — 路由与连通性

在 Linux 端确认到两个 IP 的路由走向和基础连通性：

```bash
# 路由走向不同
ip route get 192.168.10.102
# → 192.168.10.102 via 192.168.164.2 dev ens33 src 192.168.164.128

ip route get 192.168.16.100
# → 192.168.16.100 dev ens37 src 192.168.16.101
```

```bash
# 两个 IP 均 ping 通（ICMP 层无问题）
ping -c 3 192.168.16.100   # 0% 丢包，~0.5ms
ping -c 3 192.168.10.102   # 0% 丢包，~0.5ms
```

**结论**：网络层完全正常，两个 IP 都可达。排除网线/路由/ARP 问题。

### 2. 端口层 — TCP 22 连通性

用 Bash 的 `/dev/tcp` 探测 22 端口：

```bash
# 192.168.10.102 的 22 端口可达
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/192.168.10.102/22' && echo "✅ 可达"

# 192.168.16.100 的 22 端口不可达
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/192.168.16.100/22' && echo "✅ 可达"
# → 超时，❌ 不可达
```

**结论**：ICMP 通但 TCP 22 不通，典型特征是 **Windows 防火墙放行了 ICMP、拦截了 SSH 入站**。问题定位到 Windows 侧。

### 3. 服务层 — sshd 是否监听

在 Windows 上检查 SSH 服务监听情况：

```powershell
netstat -ano | findstr ":22"
```

输出：

```
TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       25244
TCP    [::]:22                [::]:0                 LISTENING       25244
```

**结论**：sshd 监听在 `0.0.0.0:22`，即**所有网卡都在监听**，包括 192.168.16.100。服务层没问题，进一步锁定为**防火墙拦截**。

### 4. 防火墙层 — Profile 与规则（根因所在）

#### 4.1 查看各网卡的网络类别（Profile）

```powershell
Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory
```

输出：

```
Name              InterfaceAlias   NetworkCategory
----              --------------   ---------------
未识别的网络       以太网 2         Public          ← 192.168.16.100（USB 网卡）
15-1-601          WLAN             Public          ← 192.168.10.102（Wi-Fi）
```

#### 4.2 查看现有的 SSH 入站规则

```powershell
Get-NetFirewallRule -DisplayName "*SSH*" | ... | Format-Table DisplayName,Direction,Action,Profile,LocalPort
```

输出：

```
DisplayName                         Direction  Action  Profile   LocalPort
-----------                         ---------  ------  -------   ---------
sshd.exe                            Inbound    Allow   Public    Any
sshd.exe                            Inbound    Allow   Public    Any
OpenSSH SSH Server Preview (sshd)   Inbound    Allow   Private   22
```

#### 4.3 根因分析

虽然两块网卡都是 `Public` Profile，但 **192.168.16.100 所在的 USB 网卡显示为"未识别的网络"**：

- "未识别的网络"在 Windows 防火墙中处理更严格，即便标为 Public，来自不同网段/网卡次的 SSH 入站连接仍被默认规则拦截。
- 而 Wi-Fi 网卡（192.168.10.102）所在网络被正确识别，命中了 `sshd.exe` 的 Public 放行规则。
- ICMP（ping）默认放行，所以两块网卡都能 ping 通；TCP 22 入站被防火墙差异处理，导致 SSH 行为不同。

---

## 四、 解决方案

采用**新增一条 All Profiles 入站放行规则**的方案（方案 A），一劳永逸覆盖所有网络类别。

### 1. 操作命令

在 Windows 上以**管理员权限**运行 PowerShell：

```powershell
New-NetFirewallRule `
  -DisplayName "OpenSSH Server (sshd) Inbound - All Profiles" `
  -Description "Allow inbound SSH (TCP 22) on all network profiles for sshd" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 22 `
  -Profile Any `
  -Program "C:\Program Files\OpenSSH\sshd.exe"
```

### 2. 关键参数说明

| 参数 | 值 | 作用 |
|------|-----|------|
| `-Direction` | `Inbound` | 入站方向（外部访问本机） |
| `-Action` | `Allow` | 放行 |
| `-Protocol` | `TCP` | SSH 协议 |
| `-LocalPort` | `22` | SSH 标准端口 |
| `-Profile Any` | Any | ⭐ **关键**：Domain / Private / Public 全覆盖 |
| `-Program` | `sshd.exe` 完整路径 | 限定到 SSH 服务程序，缩小暴露面 |

### 3. 安全性说明

- 规则限定到 `C:\Program Files\OpenSSH\sshd.exe` 程序本身，非全程序敞开。
- 仅放行 TCP 22，不影响其他端口。
- 192.168.16.x 是 USB 直连开发板网段，物理上与外网隔离，风险可控。

> **更严格的可选写法**（限定来源网段）：
>
> ```powershell
> New-NetFirewallRule -DisplayName "..." -Direction Inbound -Action Allow `
>   -Protocol TCP -LocalPort 22 -Profile Any `
>   -Program "C:\Program Files\OpenSSH\sshd.exe" `
>   -RemoteAddress 192.168.16.0/24
> ```

---

## 五、 验证结果

### 1. 端口连通性

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/192.168.16.100/22' && echo "✅ 可达"
# → ✅ 可达（修复前为超时）
```

### 2. SSH 免密登录

```bash
ssh -i ~/.ssh/id_mcp_server -o StrictHostKeyChecking=no <win_user>@192.168.16.100 "hostname"
# → sumu

ssh -i ~/.ssh/id_mcp_server -o StrictHostKeyChecking=no <win_user>@192.168.16.100 "whoami"
# → sumu\<win_user>
```

### 3. 验证汇总

| 项目 | 192.168.16.100（USB 网卡） | 192.168.10.102（Wi-Fi） |
|------|---------------------------|------------------------|
| 22 端口 | ✅ 可达（修复前 ❌） | ✅ 可达 |
| SSH 免密登录 | ✅ 成功（修复前 ❌） | ✅ 成功 |
| hostname | `sumu` | `sumu` |
| 登录身份 | `sumu\<win_user>` | `sumu\<win_user>` |

两个 IP 指向同一台 Windows 机器，仅入口网卡不同。

---

## 六、 经验总结

### 1. 排查思路（自下而上分层定位）

```
网络层（ping/路由） → 端口层（TCP 探测） → 服务层（sshd 监听） → 防火墙层（Profile/规则）
    ✅ 都通              ❌ 16.100 不通         ✅ 0.0.0.0:22 监听      ❌ 根因在此
```

**核心方法论**：

1. **能 ping 通但端口不通** → 几乎必然是防火墙问题（服务若没监听，ping 也无意义）。
2. Windows 防火墙按**网卡的网络类别（Profile）** + **规则匹配**双重过滤，"未识别的网络"即使标为 Public，行为也可能与正常 Public 网络不同。
3. sshd 监听 `0.0.0.0:22` 不代表所有网卡都能访问到，**防火墙才是最终闸门**。

### 2. 常用诊断命令速查

| 目的 | Linux 端命令 | Windows 端命令 |
|------|-------------|---------------|
| 测端口连通 | `bash -c 'cat </dev/null >/dev/tcp/IP/22'` | — |
| 查路由 | `ip route get IP` | — |
| 查监听 | — | `netstat -ano \| findstr ":22"` |
| 查网卡 Profile | — | `Get-NetConnectionProfile` |
| 查防火墙规则 | — | `Get-NetFirewallRule -DisplayName "*SSH*"` |
| 新建规则 | — | `New-NetFirewallRule ...` |

### 3. 后续可优化项

- [ ] 将"以太网 2"（USB 网卡）的网络类别改为 Private 或 Domain，使其被正确识别（治本）：

```powershell
Set-NetConnectionProfile -InterfaceAlias "以太网 2" -NetworkCategory Private
```

- [ ] 导出本次新增规则为备份，便于其他机器快速套用：

```powershell
Export-NetFirewallRule -DisplayName "OpenSSH Server (sshd) Inbound - All Profiles" -Path "E:\AI\embedded-mcp-toolkit\docs\sshd-firewall-rule.wfw"
```

---

## 七、 环境拓扑

```
┌──────────────────────────────────────────────────────────────┐
│  Linux（AI 客户端，本机）                                       │
│  ens33: 192.168.164.128    ens37: 192.168.16.101             │
└──────────┬──────────────────────────────┬────────────────────┘
           │ Wi-Fi 网段                    │ USB 直连网段
           │ (via 192.168.164.2)          │
           ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Windows（MCP 服务器，hostname: sumu）                         │
│  Wi-Fi (WLAN):     192.168.10.102   Profile=Public  ✅ 原可用 │
│  USB 千兆 (以太网2): 192.168.16.100  Profile=Public  ❌→✅    │
│  VMware VMnet1:    192.168.68.1                              │
│  VMware VMnet8:    192.168.164.1                             │
└──────────┬───────────────────────────────────────────────────┘
           │ 192.168.16.x 网段
           ▼
┌──────────────────────────────────────────────────────────────┐
│  嵌入式开发板                                                  │
│  board-a:        192.168.16.109                              │
│  board-b:        192.168.16.105                              │
│  board-lubancat: 192.168.16.107                              │
└──────────────────────────────────────────────────────────────┘
```

---
*本文档由 markdowncli 技能辅助生成*
