本项目交互式 CLI 命令（如 `sshd-config`）的终端输出统一采用 [`@clack/prompts`](https://github.com/bombshell-dev/clack/tree/main/packages/prompts) 的 `log` 对象。本文档约定各方法的选用规则与文本组织方式，供后续命令开发参考。

## 一、 核心原则

按「是否需要独立时间线节点」选方法，而非按「成功 / 失败」的语义选。

clack 的 `log` 方法分为两类：

| 类别 | 方法 | 渲染效果 | 是否新开节点 |
|------|------|----------|------------|
| 节点型 | `log.info` / `log.success` / `log.warn` / `log.error` | 带 `◆` / `✔` / `▲` / `✖` 符号，独占一行 | 是 |
| 追加型 | `log.message` | 纯文本，带 `│` 竖线缩进，归属上方节点 | 否（追加到当前节点） |

每次调用节点型方法，都会新开一个独立的时间线节点，在视觉上与上方阶段并列。因此：

- 需要开新阶段、或让某事件成为独立节点 → 用节点型方法（`info` / `success`）
- 必须归属当前阶段、不能另起节点 → 用追加型方法（`message`）

这是本规范最重要的判断依据。错误地用 `log.error` 输出阶段内部的失败，会让失败信息变成与该阶段并列的独立节点，破坏原本的归属结构。

## 二、 各方法选用规则

### 1. `log.info` — 阶段标题 / 主流程节点（节点型）

用于标记一个主要阶段的开始，给用户「现在进行到哪一大步」的导航。

- 一律是「动词开头的阶段名」，常以省略号 `...` 结尾表示「即将进行」
- 函数入口、每个检测组 / 子任务的开头都用它
- 不用于具体细节

```ts
log.info("开始安装 Windows SSH ...");
log.info("启动 sshd 服务 ...");
log.info("检查 sshd 配置状态（只读诊断）");
log.info("sshd 服务状态");          // 检测组标题
log.info("生成结果");                // 结果展示阶段
```

### 2. `log.message` — 阶段内部细节 / 过程 / 失败（追加型，最常用）

用于阶段内部的具体动作、检测结论、子结果、失败提示。占绝大多数输出。

- 内容前统一加 4 个空格缩进，使明细视觉内嵌于所属阶段
- 子层级（如列表项下的说明）在 4 空格基础上再叠加缩进
- 失败提示也用 `message` 而非 `error`——只要该失败属于当前阶段内部（非整体流程终结事件）
- 多行 JSON / 代码块预览不加缩进（会破坏后续行对齐）

```ts
log.message("    OpenSSH Server 已安装，跳过");
log.message(`    状态: ${status}`);
log.message(`    启动 sshd 失败: ${startResult.stderr || "未知错误"}`);  // 失败也用 message
log.message("    1. 将模板复制到 Linux 项目根目录并重命名为 .mcp.json");
```

### 3. `log.success` — 整体流程最终成功（节点型）

只在整个命令 / 函数最终成功时用，非常克制。一个流程通常只有一处。

- 用于「安装完成」「配置就绪」「模板已生成」这类收尾成果
- 不用于阶段内的子成功（子成功用 `message`）

```ts
log.success("Windows SSH 服务安装完成");
log.success("配置就绪，可尝试从 Linux 免密登录");
log.success(`模板已生成: ${templatePath}`);
```

### 4. `log.warn` / `log.error` — 慎用（节点型）

这两个方法会强制开新节点，只在「失败 / 警告本身就该作为独立事件呈现」时才用。

- `log.error`：仅当失败后直接退出整个流程、且希望失败成为独立收尾节点时用
- `log.warn`：仅当需要用户手动干预、且该干预提示应作为独立节点呈现时用
- 阶段内部的失败 / 兜底提示一律用 `log.message`，避免破坏阶段归属

```ts
// error：在线安装失败后直接 return 退出安装流程，失败升级为独立节点
log.error(`在线安装失败: ${installOnline.stderr || "未知错误"}`);

// warn：需用户手动注册服务，作为独立提醒
log.warn("请手动注册 sshd 服务：<sshd.exe 路径> install");
```

## 三、 典型输出结构

一个完整命令的输出通常呈「阶段标题（info）→ 细节（message）→ 收尾（success）」的层级：

```ts
async function doXxx(): Promise<void> {
  log.info("执行 XXX ...");                    // 入口阶段

  // 子阶段
  log.info("检测状态");
  log.message("    检测到: ...");              // 细节归属「检测状态」
  log.message("    配置项: ...");

  // 失败（阶段内部，用 message 保持归属）
  if (!result.success) {
    log.message(`    执行失败: ${result.stderr}`);
    return;
  }

  log.success("XXX 完成");                     // 整体收尾
}
```

渲染效果（示意）：

```
◆ 执行 XXX ...
◆ 检测状态
│     检测到: ...
│     配置项: ...
✔ XXX 完成
```

## 四、 禁止做法

| 禁止 | 原因 | 应改为 |
|------|------|--------|
| 用 `console.log` / `console.error` 输出 | 绕过 clack，无节点结构、无符号标识 | `log.message` / `log.error` 等 |
| 阶段内部失败用 `log.error` | 失败变成与阶段并列的独立节点，破坏归属 | `log.message` |
| 给 `log.message` 加 `[ok]` / `[warn]` / `[info]` 文本前缀 | clack 节点符号已承担状态标识，重复 | 删掉前缀，只保留值 |
| `log.message` 内容不加缩进 | 明细与阶段标题视觉上无层级区分 | 内容前加 4 空格 |
| 大量使用 `log.success` / `log.warn` | 节点过多，时间线碎片化 | 仅整体收尾用 success，兜底提示用 message |

## 五、 来源与一致性

本规范提炼自 [`src/cli/commands/sshd-config.ts`](../src/cli/commands/sshd-config.ts) 的实际用法（`doInstallSsh` / `doCheckStatus` / `doShowConnectionInfo` / `doGenerateTemplate` 等函数）。新增 CLI 命令时应遵循同一套规则，并在代码评审时对照本规范检查。

- 依赖：`@clack/prompts@^1.7.0`（ESM，项目已配置 `"type": "module"`）
- 导入方式：

```ts
import { log } from "@clack/prompts";
```

---
*本文档由 markdowncli 技能辅助生成*
