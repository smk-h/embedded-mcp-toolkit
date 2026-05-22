## 一、 项目简介

`psh` (Portal Shell，门禁 Shell) 是一个终端门禁安全系统。它作为**守门程序 (gate shell)** 替代系统登录 Shell，在用户提供有效解锁密钥之前，锁定终端并拦截所有非法命令。

**工作流程：** 启动后呈现锁定界面 → 仅允许 `dmesg`、`ps` 诊断命令 → 输入 `debug` 获取挑战码 → 输入正确密钥 → `execvp` 进入真正的 Shell。

**核心思路：** 系统管理者可以将锁定的控制台交由他人操作——对方可以查看日志和进程列表，但必须在获得解锁密钥后才能执行任意命令。

---

## 二、 系统架构与原理

### 1. 架构全景

```
                    ┌─────────────┐
                    │  init (PID1)│  ← systemd / busybox-init / sysvinit
                    │             │
                    │  respawn:   │  ← auto-restart on exit
                    │   -/bin/psh │  ← "-" prefix = login shell
                    └──────┬──────┘
                           │ fork/exec
                    ┌──────▼──────┐
                    │     psh     │
                    │ (gate prog) │
                    └──────┬──────┘
                           │
              ┌────────────┼───────────────┐
              │            │               │
        ┌─────▼──────┐ ┌───▼──────┐ ┌──────▼───────┐
        │MODE_LOCKED │ │ debug    │ │MODE_UNLOCKING│
        │ dmesg/ps   │ │→challenge│ │ enter key    │
        │ others deny│ └──────────┘ └──────┬───────┘
        └────────────┘                     │
                                     key == "123456"?
                                           │ yes
                                   ┌───────▼───────┐
                                   │   /bin/sh     │  ← execvp replaces psh
                                   │ (real shell)  │
                                   └───────────────┘
```

### 2. 进程流转

1. **Init 拉起 psh：** 通过 init 配置（inittab 的 `respawn` 或 systemd 的 `Restart=always`）以 login shell 方式启动 psh，进程退出后 init 自动重启。
2. **锁定模式：** 主循环读取用户输入——白名单命令 (`dmesg` / `ps`) fork 子进程执行后返回；`debug` 生成挑战码并切换到解锁模式；其他输入一律提示不支持。
3. **解锁模式：** 等待密钥输入——空输入取消并回到锁定模式，错误密钥拒绝，正确密钥 (`123456`) 跳出主循环。
4. **Shell 启动：** 通过 `execvp("/bin/sh", ...)` 将 psh 进程完全替换为真正的 Shell。**使用 execvp 而非 fork 子进程的好处**：无额外父进程残留、新 Shell 继承相同 PID 和 TTY、Shell 退出后 init 通过 respawn 自动重新拉起 psh。

### 3. 安全机制

| 机制 | 说明 |
|------|------|
| 白名单命令策略 | 仅 `dmesg` 和 `ps` 为安全的只读诊断命令 |
| 信号拦截 | 忽略 SIGINT / SIGTSTP，防止 Ctrl-C / Ctrl-Z 绕过认证 |
| 挑战码机制 | 每次 `debug` 生成新随机码 `PSH-XXXX-XXXX-XXXX-XXXX` |
| 日志审计 | 记录 START、AUTH_OK、EXIT_FAIL 到 `/var/log/psh.log` |

---

## 三、 使用方法与示例

### 1. 本地编译运行

```bash
make psh                    # 编译
sudo make install           # 安装到 /bin/psh
/bin/psh                    # 直接运行
```

### 2. Docker 测试

```bash
# 在 my-psh/ 目录下执行（context 为当前目录）
docker build --no-cache -t psh-test -f docker/Dockerfile .
# systemd 容器需要 tmpfs 和 read-only 绑定
docker run -it --rm \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
    psh-test
```

Dockerfile 基于 Ubuntu 22.04 + systemd，使用双 Service 架构：

- `psh-bg.service` —— 后台演示程序，每 2 秒打印一次时间戳，展示 psh 锁定期间终端仍可接收系统输出
- `psh.service` —— 门禁 Shell，绑定 `/dev/tty1`，`Restart=always` 等效于 inittab 的 respawn

运行后切换至 `tty1` 即可看到 psh 锁定界面，同时 `bg-demo` 的输出也会穿透显示。

### 3. 交互示例

```
╔════════════════════════════════════════╗
║       Portal Shell v2.0                ║
╠════════════════════════════════════════╣
║  System is LOCKED                      ║
║  - dmesg   View kernel log             ║
║  - ps      Show process list           ║
║  - debug   Get unlock code             ║
╚════════════════════════════════════════╝

locked> ls
[PSH] Command not supported in locked mode.
[PSH] Available commands: dmesg, ps, debug

locked> debug
╔════════════════════════════════════════╗
║  Challenge: PSH-A3F1-7B2E-90C4-D518   ║
║  Fixed Key: 123456                     ║
║  Enter '123456' to unlock shell         ║
╚════════════════════════════════════════╝
Enter key to unlock: 123456
[PSH] Access Granted! Unlocking shell...
$ _
```

【**注意**】Docker 容器使用 systemd 作为 PID1，退出前需先通过 `psh` 解锁进入 Shell，再 `exit` 退出。也可直接 `docker rm -f` 强制删除。

---

## 四、 系统部署指南

psh 依赖 init 系统的 respawn 机制持续拉起。不同 init 系统配置方式不同。

### 1. 前置准备（所有系统通用）

```bash
# 安装编译工具和依赖
sudo apt-get install -y gcc make procps
# procps 提供 ps 命令（psh 白名单命令之一）
# dmesg 由 util-linux 提供，为基础包无需显式安装

# 编译安装
make psh
sudo cp psh /bin/psh && sudo chmod 0755 /bin/psh

# 创建日志文件
sudo touch /var/log/psh.log && sudo chmod 0666 /var/log/psh.log
```

### 2. BusyBox init —— 嵌入式系统（OpenWrt / Alpine 等）

BusyBox init 原生支持 `/etc/inittab`，配置仅需一行。如需后台演示程序，创建 wrapper 脚本后指向它：

```bash
# 编译安装
make install

# 使用 wrapper 同时启动 bg-demo 和 psh
printf '#!/bin/sh\n/usr/local/bin/bg-demo &\nexec /bin/psh\n' \
    | sudo tee /usr/local/bin/psh-startup > /dev/null
sudo chmod 0755 /usr/local/bin/psh-startup

echo "::respawn:-/usr/local/bin/psh-startup" | sudo tee -a /etc/inittab
sudo reboot
```

不需后台程序时，直接指向 psh 即可：`echo "::respawn:-/bin/psh" >> /etc/inittab`。

### 3. systemd —— 现代桌面/服务器系统（Ubuntu / Debian 12+）

项目中提供了现成的 service 模板文件和自动化部署脚本：

```bash
# 编译 + 安装 + 启用服务（一键完成）
sudo ./docker/setup-systemd.sh

# 仅安装不编译
sudo ./docker/setup-systemd.sh install

# 卸载
sudo ./docker/setup-systemd.sh remove
```

脚本自动完成以下步骤：

1. `make all` 编译 psh 和 bg-demo
2. 安装二进制到 `/bin/psh` 和 `/usr/local/bin/bg-demo`
3. 将 `docker/psh.service`、`docker/psh-bg.service` 复制到 `/etc/systemd/system/`
4. 创建审计日志 `/var/log/psh.log`
5. `systemctl enable --now` 启动两个服务

如需手动配置，参考 `docker/` 目录下的 `psh.service` 和 `psh-bg.service` 模板文件。关键参数说明：`Restart=always` 等效于 inittab 的 respawn，`StandardInput=tty` **必须设置**，否则 psh 的 `isatty()` 检查会失败。

调试时可通过 `journalctl -u psh.service -f` 查看日志。

### 4. sysvinit —— 传统 Debian 系统（可选）

```bash
sudo apt-get purge -y systemd systemd-sysv
sudo apt-get install -y sysvinit-core sysvinit-utils
echo "::respawn:-/bin/psh" | sudo tee -a /etc/inittab
sudo reboot
```

【**警告**】替换 systemd 可能导致依赖它的服务异常，仅建议在隔离环境中使用。

### 5. 方案对比

| 方案 | 配置文件 | 配置行数 | TTY 绑定 | 适用场景 |
|------|----------|----------|----------|----------|
| BusyBox init | `/etc/inittab` | 1 行 | 自动 | 嵌入式设备首选 |
| systemd | `psh.service` 文件 | ~15 行 | 需显式指定 | 服务器/桌面首选 |
| sysvinit | `/etc/inittab` | 1 行 | 自动 | 旧版系统兼容 |

### 6. 排查清单

按顺序检查：

1. `file /bin/psh` —— 确认二进制可执行
2. `which dmesg ps` —— 白名单命令必须存在
3. `cat /etc/inittab | grep psh` 或 `systemctl status psh.service` —— 确认 init 配置
4. `test -t 0 && echo ok` —— psh 必须在真实 TTY 中运行
5. `cat /var/log/psh.log` 或 `journalctl -u psh.service` —— 查看错误日志
6. `systemctl status psh-bg.service` —— 确认后台程序运行状态

---

## 五、 核心函数说明

### 1. run_portal_shell()

该函数在 `psh.c` 文件中声明：

```c
static void run_portal_shell(void);
```

【**函数作用**】

实现 psh 的双模式状态机主循环：`MODE_LOCKED` 下拦截非法命令并处理白名单指令；`MODE_UNLOCKING` 下接收并验证解锁密钥。

【**参数含义**】

无参数。

【**返回值**】

无返回值。通过全局变量 `authenticated` 传递认证结果给调用方。

### 2. launch_shell()

该函数在 `psh.c` 文件中声明：

```c
static void launch_shell(void);
```

【**函数作用**】

调用 `execvp()` 将 psh 进程完全替换为系统默认 Shell（优先 `$SHELL`，回退 `/bin/sh`），同时设置 `PSH_AUTH=1` 环境变量标识已认证状态。

【**参数含义**】

无参数。

【**返回值**】

正常不返回（进程已替换）。若 `execvp` 失败则打印错误并以退出码 1 终止。

### 3. verify_key()

该函数在 `psh.c` 文件中声明：

```c
static int verify_key(const char *user_key);
```

【**函数作用**】

采用固定密钥比对，检查用户输入是否为 `"123456"`。调用前必须已生成 challenge。

【**参数含义**】

- `user_key`：用户输入的密钥字符串

【**返回值**】

返回 1 表示验证通过，返回 0 表示失败。

### 4. generate_challenge()

该函数在 `psh.c` 文件中声明：

```c
static void generate_challenge(char *output, size_t len);
```

【**函数作用**】

基于纳秒级时间戳和进程 ID 生成随机种子，输出格式为 `PSH-XXXX-XXXX-XXXX-XXXX` 的十六进制挑战码。

【**参数含义**】

- `output`：输出缓冲区指针
- `len`：缓冲区大小

【**返回值**】

无返回值。结果写入缓冲区并设置全局标志 `challenge_generated = 1`。

---
*本文档由 markdowncli 技能辅助生成*
