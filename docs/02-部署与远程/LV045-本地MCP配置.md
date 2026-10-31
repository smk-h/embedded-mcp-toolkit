<!-- more -->

## 一、 功能定位

`local-mcp-config` 命令解决的问题是：**在本机（Windows）其它项目目录里，让 AI 客户端（Claude Code / ZCode / opencode / DSH / CodeBuddy）直接使用 embedded-mcp-toolkit 的 MCP 服务**。

本工具包的 MCP 服务依赖三样东西才能正确启动：启动入口（`bin/embedded-mcp-toolkit-cli.js`）、工作目录（必须锚定在工具包项目根，`.embedded/configs` 等相对路径才有意义）、一组环境变量（`DEVICE` / `BOARD_CONFIG_PATH` / `LOG_DIR` 等）。其它项目目录天然不满足后两项，`local-mcp-config` 用一个" bat 桥"把这三样全部打包：

```text
目标项目的 .mcp.json ──→ cmd /c <remote-start-mcp.bat 绝对路径>
                              │ cd /d <工具包项目根>   ← cwd 锚定
                              │ set DEVICE=... 等五个变量 ← env 全量
                              ▼
                        node bin\embedded-mcp-toolkit-cli.js
```

`remote-start-mcp.bat` 是 **env 的单一事实来源**：生成的客户端配置不含 env 块，改设备或日志路径只需改 bat 一处。

## 二、 使用流程

### 1. 前置条件

（1）工具包项目已运行过 `init`（生成 `remote-start-mcp.bat` 与 `.embedded/configs/`）；

（2）按需编辑 bat 内的 `DEVICE`（该 bat 服务所有接入的本地项目）。

### 2. 命令与交互

```shell
embedded-mcp-toolkit local-mcp-config
# 源码仓库内: npm run cmd:local-mcp-config
```

启动后自动探测 bat 绝对路径（包根 / exe 目录 / 当前目录三候选，多个命中时选择，未命中可手输），随后：

（1）输入目标项目目录（绝对路径，须已存在）；

（2）选择客户端类型（Claude Code / ZCode / opencode / DSH / CodeBuddy）与配置范围（全局 / 项目）；

（3）逐落点展示当前状态（未配置 / 已配置且一致 / 不一致 / 解析失败）；

（4）确认后写入，单落点失败不影响其余；支持"查看（只读）"与"删除"。

### 3. 八类落点

与 `remote-mcp-config` 共用同一张落点数据表（`src/cli/commands/remote-mcp-config/targets.ts` 的 `CLIENTS`），路径与容器结构两端一致，server 形态统一为 `cmd /c <bat>`：

| 落点 | 文件 | server 形态 |
|---|---|---|
| Claude 全局 | `~/.claude.json` | `{command, args}` |
| Claude 项目 | `{proj}/.mcp.json` + `.claude/settings.local.json` | server + 使能数组 |
| CodeBuddy 全局 | `~/.codebuddy/mcp.json` | + `type: "stdio"` |
| CodeBuddy 项目 | `{proj}/.mcp.json`（与 Claude 项目共用） | `{command, args}` |
| ZCode 项目 | `{proj}/.zcode/config.json` | + `type` / `enabled` |
| DSH 项目 | `{proj}/.dsh/dshmm/mcp.json` | + `type` / `cwd` |
| opencode 全局/项目 | `~/.config/opencode/opencode.json` / `{proj}/.opencode/opencode.json` | `command: ["cmd","/c",bat]` 数组形态 |

写入安全：原文件先备份为 `.bak`（保留首次备份），写失败自动回滚；同容器的其它 server 原样保留。

## 三、 与其它部署形态的关系

| 形态 | 命令 | 适用场景 |
|---|---|---|
| 本地 bat 桥（本文） | `local-mcp-config` | AI 客户端与工具包同在本机 Windows 的其它项目 |
| 远程 SSH 桥 | `remote-mcp-config` | AI 客户端在远程 Linux，SSH 回本机（bat 同一个） |
| CNB 云容器 | `cnb` | AI 客户端在 CNB 受管容器，经 Cloudflare 隧道回本机 |

三形态最终都汇聚到同一个 `remote-start-mcp.bat` / 同一个 MCP 进程，会话与日志统一收口在工具包项目内。

## 四、 注意事项

（1）本命令仅适用于 Windows 本机（`cmd /c` 转发），远程场景请用 `remote-mcp-config`。

（2）写入配置后需**重启对应客户端**才生效。

（3）`DEVICE` 等环境变量由 bat 持有，全局生效于所有接入的本地项目；需要按项目区分设备时，可在项目内改用 env 内联的 `.mcp.json`（参见 `init` 生成的模板）。

（4）CodeBuddy 全局落点固定写**不带点**的 `~/.codebuddy/mcp.json`（IDE 与 CLI 双宿主唯一同时生效的路径）。

---

*本文档由 markdowncli 技能辅助生成*
