# 跨机部署下的编译路由指引 Plan

## 架构概览

本方案在 ch17 已建立的基础设施（`SSH_CONNECTION` 场景判定 + `instructions`/`host_info` 两条 scp 指引通道）之上，叠加**编译路由指引**，并新增 `ssh_build` 软拦截。改动收敛在 MCP Server 的指引注入层与一个工具的返回层，不触碰执行逻辑。

四个组件，每个一句话：

- **编译路由文本模块**（新增）：封装两段指引文本的纯函数，供三处引用，避免硬编码漂移。
- **`instructions` 注入点**（改造 `server.ts`）：在 ch17 的 scp 文本末尾追加编译路由（单行）。
- **`host_info` 工具**（改造 `host-info.ts`）：在两个 remote-ssh 分支末尾追加编译路由（多行）。
- **`ssh_build` 工具**（改造 `build.ts`）：远程 SSH 场景下，在返回结果前缀追加软拦截提示，照常执行。

复用关系：场景判定（`SSH_CONNECTION` → local/remote-ssh + endpoint）完全复用 ch17 的 `resolveHostEndpoint()`，不新建判定逻辑。

### 三层防线如何衔接（满足 F2-F5）

| 防线 | 触发时机 | 位置 | 方式一是否受影响 |
|------|---------|------|:---:|
| ① instructions | 方式二 MCP 握手时注入（F2） | `server.ts` | 否（undefined） |
| ② host_info | AI 主动查询时（F3/F4） | `host-info.ts` | 否（local 分支不动） |
| ③ ssh_build 软拦截 | AI 调用 ssh_build 时（F5） | `build.ts` | 否（local 不触发） |

方式二下：① 引导在前 → 若未采纳，② 兜底 → 若仍调了 ssh_build，③ 追加提示照常编译。任一层生效都能引导 AI 改用 cmdsift。方式一三层全不触发，零改变（满足 F6）。

## 核心数据结构

### HostEndpoint（ch17 既有，仅复用）

来自 `src/mcp/shared/host-endpoint.ts`，本方案不改其结构，只消费两个字段：

| 字段 | 类型 | 用途 |
|------|------|------|
| `scenario` | `"local" \| "remote-ssh"` | 判定三层防线是否触发 |
| `endpoint` | `string \| null` | host_info 展示用（编译路由本身不依赖它） |

### 编译路由文本模块（新增，无数据结构）

该模块只导出**两个纯函数**，无类、无可变状态、无配置。文本为常量，函数无入参。

## 模块设计

### 模块 A：编译路由文本模块（新增）

**职责：** 封装编译路由指引文本，供 `instructions` / `host_info` / `ssh_build` 三处引用（满足 N1）。
**对外接口：**

- `buildRoutingInstructions(): string` —— 给 `instructions` 用的**单行**文本（与 ch17 scp 文本风格一致，无换行，句间空格）。内容覆盖：AI 已在 Linux 编译机 → 编译优先用本机 `cmdsift`（三类示例：`cmdsift 'make -j8'` / `cmdsift -C /path 'make'` / `cmdsift './build.sh'`）→ 全量日志落在 `log/YYYYMMDD_HHMMSS.log`（可后续读取）→ 不要用 `ssh_build`（会让流量 Windows↔Linux 绕圈）。
- `buildRoutingHint(): string` —— 给 `ssh_build` 软拦截用的**多行**提示文本（带换行、缩进，风格对齐 `host_info` 的 Usage 段）。内容覆盖：检测到远程 SSH 启动（方式二）→ 应在 Linux 本机用 cmdsift → 本次 ssh_build 仍会照常执行但流量会绕圈 → cmdsift 用法要点。

两段文本语义同步（都说"方式二下编译优先用 cmdsift"），但措辞与长度针对各自载体定制：单行紧凑给 instructions、多行展开给工具返回。

**依赖：** 无（纯字符串常量，不 import 任何项目模块）。

**文本内容设计原则：**
- `cmdsift` 命令名直接写明（满足 F6/N5：假定在 PATH，部署方保证安装）。
- 示例命令形态与 `cmdsift` 实际 CLI 一致（`cmdsift [选项] <命令>` / `cmdsift [选项] -- <命令> [参数]`），调用方拿原文即可执行。
- 不出现方法名、类型、文件路径等实现细节（这些是 plan/task 层的事，指引文本面向 AI 阅读）。

### 模块 B：`instructions` 注入点（改造 `server.ts`）

**职责：** MCP 握手时把指引注入 `instructions` 字段。
**对外接口：** 无新增，仍由 `server.ts` 顶部 `const instructions = ...` 计算后传入 `McpServer` 构造器。
**依赖：** 新增 `import { buildRoutingInstructions } from "./shared/build-routing.js"`；复用 ch17 的 `resolveHostEndpoint()`。

**改动点：** `server.ts:35-45` 的 instructions 数组末尾追加一项 `buildRoutingInstructions()`。注入条件（`scenario === "remote-ssh" && endpoint`）保持 ch17 原样，方式一仍为 undefined（满足 F2/F6）。

### 模块 C：`host_info` 工具（改造 `host-info.ts`）

**职责：** 兜底查询工具，返回端点 + 指引。
**对外接口：** 无新增，仍为无参 `hostInfoHandler`。
**依赖：** 新增 `import { buildRoutingHint } from "../../shared/build-routing.js"`；复用 ch17 的 `resolveHostEndpoint()`。

**改动点：** `formatHostEndpoint()`（`host-info.ts:50-82`）的两个 remote-ssh 分支：
- endpoint 成功分支（`:70-81`）：在 scp Usage 末行后追加编译路由多行段。
- `(unavailable)` 分支（`:61-67`）：新增编译路由 Usage 段（此场景 scp 端点不可用，但编译路由仍给）。
- `local` 分支不动（满足 F3/F4/F6）。

> 设计说明：`host_info` 的多行分支用 `buildRoutingHint()`（而非 `buildRoutingInstructions()`），保持与既有 Usage 段的多行风格一致。

### 模块 D：`ssh_build` 工具（改造 `build.ts`）

**职责：** 编译执行工具；远程 SSH 场景下软拦截。
**对外接口：** 无新增，仍为 `sshBuildHandler`。
**依赖：** 新增 `import { resolveHostEndpoint } from "../../shared/host-endpoint.js"`；新增 `import { buildRoutingHint } from "../../shared/build-routing.js"`。

**改动点（满足 F5/N3）：**
1. handler 顶部（参数默认值之后、查找会话之前）加一次场景判定：
   ```ts
   const routingHint = resolveHostEndpoint().scenario === "remote-ssh"
     ? buildRoutingHint() + "\n\n"
     : "";
   ```
2. 两个返回分支（分类模式 `:457`、非分类模式 `:462`）的 `text(...)` 内容前缀拼上 `routingHint`。
3. 既有执行逻辑（命令构造、PTY 回显剥离、轮询、ANSI 清洗、分类格式化、退出码透传）一字不动。

> 软拦截设计原则：提示在前、执行在后，**提示不影响编译结果**——即便 AI 没采纳提示，也能拿到完整的 error/warning 分类。本地启动 `routingHint === ""`，前缀为空字符串，返回内容与改动前逐字一致（满足 F6/N4）。

## 模块交互

```
MCP 握手时
  server.ts
    └─ resolveHostEndpoint() ──[remote-ssh]──→ buildRoutingInstructions() → 拼进 instructions

AI 主动查询时
  host_info (host-info.ts)
    └─ resolveHostEndpoint() ──[remote-ssh]──→ buildRoutingHint() → 拼进返回文本
                          └──[local]──→ 原样返回（不动）

AI 调用 ssh_build 时
  ssh_build (build.ts)
    ├─ resolveHostEndpoint() ──[remote-ssh]──→ buildRoutingHint() → 作为返回前缀（软拦截）
    │                   └──[local]──→ routingHint=""（无前缀，逐字一致）
    └─ 既有编译执行逻辑（不动）→ 分类结果 → 拼前缀 → 返回
```

三处共享同一文本模块（N1），场景判定共享同一函数（F1），无循环依赖。

## 文件组织

```
src/mcp/
├── shared/
│   ├── host-endpoint.ts      — ch17 既有，仅被 build.ts 新增一处引用（不改其代码）
│   └── build-routing.ts      — 【新增】编译路由文本模块（两个纯函数）
├── server.ts                  — 【改造】instructions 数组末尾追加一项 + import
└── tools/
    ├── basic/host-info.ts     — 【改造】两个 remote 分支追加 + import
    └── ssh/build.ts           — 【改造】handler 顶部场景判定 + 两返回分支拼前缀 + import
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 文本模块化（N1） | 新增 `build-routing.ts`，导出两个纯函数 | 三处引用同一份文本，避免硬编码漂移；纯函数无状态、可被多处安全调用 |
| 软拦截位置 | handler 返回值前缀（运行时），而非工具 description（静态） | description 是静态的、方式一也会看到，会让方式一 AI 困惑；前缀方式只在方式二实际触发时生效，精准不打扰（N4） |
| 软拦截策略 | 追加提示 + 照常执行（不硬阻断） | cmdsift 万一缺失时 AI 仍有 ssh_build 兜底通路；硬阻断会让 AI 无路可走 |
| unavailable 分支是否补编译路由（F4） | 补 | 编译路由只依赖"AI 在 Linux"事实，不依赖 endpoint；此场景 scp 虽不可用但编译路由仍有价值 |
| instructions 单行 vs 多行 | 单行（沿用 ch17 风格） | ch17 的 scp 文本已是单行拼接，保持一致（N2） |
| `cmdsift` 是否运行时探测（N5） | 不探测 | 探测增加复杂度且文本与探测脱节；部署方保证安装，文本只给用法 |
| 是否动态隐藏 ssh_build | 不隐藏（"不做的事"） | 软拦截已足够引导；隐藏破坏工具列表稳定性且失去兜底通路 |

## 编码规范

**编程语言：** TypeScript（ESM，Node.js 运行时）

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（ts-lang-spec 优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。本方案涉及的 `server.ts` / `host-info.ts` / `build.ts` 均为既有文件，写回时须保持各自原编码（含 BOM 与否、换行符）不变，绝不转换。

开发阶段编写代码时，必须遵循 ts-lang-spec 中定义的编码风格、命名约定、注释规范（含 JSDoc `@brief`/`@details` 风格——本方案新增模块的文件头注释块与函数 JSDoc 应与 `host-endpoint.ts` / `host-info.ts` 现有风格一致）。
