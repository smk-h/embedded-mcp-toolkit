# 跨机部署下的编译路由指引 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/shared/build-routing.ts` | 编译路由文本模块：两个纯函数（单行 instructions 用 / 多行 hint 用） |
| 修改 | `src/mcp/server.ts` | instructions 数组末尾追加编译路由项 + import |
| 修改 | `src/mcp/tools/basic/host-info.ts` | formatHostEndpoint 两个 remote 分支追加编译路由 + import |
| 修改 | `src/mcp/tools/ssh/build.ts` | handler 顶部场景判定 + 两返回分支拼前缀 + import |
| 修改 | `docs/项目简介.md` | 第四章 §3.2 宿主端点一节，补编译路由已纳入 instructions/host_info（文档同步） |

---

## T1: 新建编译路由文本模块

**文件：** `src/mcp/shared/build-routing.ts`
**依赖：** 无
**步骤：**
1. 写文件头版权注释块，风格对齐 `host-endpoint.ts`（Copyright © sumu. 2022-present... / File name / Author / Date / Version / Description），Description 段说明本模块职责——封装跨机部署（方式二）下编译路由指引文本，供 instructions / host_info / ssh_build 三处引用。
2. 实现 `buildRoutingInstructions(): string`——返回**单行**文本（句间空格，无换行），内容覆盖（按序）：
   - "When you need to build (make / gcc / ./build.sh, etc.), run cmdsift directly in your own Linux shell"
   - 三类示例（一句话内并列）：`cmdsift 'make -j8'`、`cmdsift -C /path/to/src 'make'`、`cmdsift './build.sh'`
   - 全量日志说明：cmdsift writes the full build log to `log/YYYYMMDD_HHMMSS.log` (read it later if needed)
   - 不用 ssh_build 的理由：do NOT use the ssh_build tool — it routes traffic Linux→Windows MCP→Linux and wastes a round trip
3. 实现 `buildRoutingHint(): string`——返回**多行**文本（带换行与缩进，风格对齐 `host-info.ts` 的 Usage 段），内容覆盖（按序）：
   - 标题行：空行 + "Build routing notice:"（或同等措辞）
   - "You are in deployment mode 2 (remote-ssh): the AI client runs on Linux, this MCP server runs on Windows."
   - "Build locally with cmdsift instead of ssh_build — ssh_build routes traffic Linux → Windows MCP → Linux (a wasteful round trip)."
   - cmdsift 用法要点（多行示例）：
     - `  - cmdsift 'make -j8'`
     - `  - cmdsift -C /path/to/src 'make'`
     - `  - cmdsift './build.sh'`
   - "Full build log is saved to log/YYYYMMDD_HHMMSS.log (read it later)."
   - "This ssh_build call still runs, but consider cmdsift for subsequent builds."
4. 两个函数各加 JSDoc（`@brief` / `@details`），说明文本用途与适用载体（单行给 instructions、多行给工具返回）。
5. 模块底部不加 `export default`，仅具名导出两个函数。

**验证：** 文件无语法错误（目检）；两个函数均无入参、返回 string；文本含 `cmdsift`、三类示例命令、`log/YYYYMMDD_HHMMSS.log`、`ssh_build` 关键词。

---

## T2: 改造 server.ts 注入 instructions

**文件：** `src/mcp/server.ts`
**依赖：** T1
**步骤：**
1. 在文件顶部 import 区（`resolveHostEndpoint` import 附近，约 `server.ts:7`）新增：
   ```ts
   import { buildRoutingInstructions } from "./shared/build-routing.js";
   ```
2. 在 `server.ts:35-45` 的 instructions 数组中，**末尾**（`To push to Windows: ...` 那一行之后、`.join(" ")` 之前）追加一项：
   ```ts
   buildRoutingInstructions(),
   ```
3. 注入条件（三元表达式 `hostEndpoint.scenario === "remote-ssh" && hostEndpoint.endpoint`）保持不变；方式一仍为 undefined。

**验证：** `npm run build` 编译通过；本地启动场景 `instructions` 仍为 undefined（条件未变）。

---

## T3: 改造 host_info 工具

**文件：** `src/mcp/tools/basic/host-info.ts`
**依赖：** T1
**步骤：**
1. 在文件顶部 import 区（`resolveHostEndpoint` import 附近，约 `host-info.ts:22`）新增：
   ```ts
   import { buildRoutingHint } from "../../shared/build-routing.js";
   ```
2. 改 `formatHostEndpoint()` 的 **endpoint 成功分支**（`host-info.ts:70-81`）：在现有 scp Usage 末行（`Do NOT use power_shell_* tools for cross-machine transfers ...`）之后，追加一个空字符串元素（视觉空行）+ `buildRoutingHint()` 的展开。具体写法：在数组中追加 `""` 与 `...buildRoutingHint().split("\n")`（或直接将多行字符串作为一个元素，依赖 `\n` 渲染）。保持与现有 Usage 段的多行对齐风格。
3. 改 `(unavailable)` 分支（`host-info.ts:61-67`）：在现有三行（Host/Endpoint/Source）之后追加空行 + `buildRoutingHint()` 内容（此场景 scp 端点不可用，但编译路由仍给）。
4. `local` 分支（`host-info.ts:52-58`）不动。

**验证：** `npm run build` 编译通过；本地启动 host_info 返回内容与改动前一致（local 分支未动）。

---

## T4: 改造 ssh_build 软拦截

**文件：** `src/mcp/tools/ssh/build.ts`
**依赖：** T1
**步骤：**
1. 在文件顶部 import 区新增两行（约 `build.ts:14` 附近）：
   ```ts
   import { resolveHostEndpoint } from "../../shared/host-endpoint.js";
   import { buildRoutingHint } from "../../shared/build-routing.js";
   ```
2. 在 `sshBuildHandler` 内，参数默认值之后、`logger.info(...)` 之前（约 `build.ts:324` 之后），新增场景判定：
   ```ts
   // 软拦截：远程 SSH 启动（方式二）下，编译本应由 AI 在 Linux 本机用 cmdsift 完成。
   // 若 AI 仍调用了 ssh_build，在返回结果前缀追加提示，但照常执行（不硬阻断）。
   const routingHint =
     resolveHostEndpoint().scenario === "remote-ssh"
       ? buildRoutingHint() + "\n\n"
       : "";
   ```
3. 改分类模式返回分支（`build.ts:457-459`）：`text(prefix + formatted)` → `text(routingHint + prefix + formatted)`。
4. 改非分类模式返回分支（`build.ts:462-468`）：`text(\`${header}\n\n...\`)` → 在模板字符串最前拼 `routingHint`。
5. 既有执行逻辑（步骤 1-6 的命令构造、回显剥离、轮询、ANSI 清洗、分类）一字不动。

**验证：** `npm run build` 编译通过；本地启动（scenario === "local"）调用 ssh_build，`routingHint === ""`，返回内容与改动前逐字一致（空字符串前缀无影响）。

---

## T5: 编译验证

**文件：** 无（运行验证）
**依赖：** T1-T4
**步骤：**
1. 运行 `npm run build`。
2. 确认 TypeScript 编译无错误、无类型告警。
3. 若有 lint 配置则运行 lint（按项目实际命令）。

**验证：** `npm run build` 退出码 0，无报错输出。

---

## T6: 文档同步

**文件：** `docs/项目简介.md`
**依赖：** T1-T4（实现定稿后）
**步骤：**
1. 定位第四章 §3.2「跨机带来的新需求：宿主端点」（约 `项目简介.md:472` 起）。
2. 在该节描述 instructions / host_info 传达内容的段落，补一句：除 scp 文件传输指引外，方式二下 instructions / host_info 还会传达**编译路由指引**——建议 AI 用本机 cmdsift 编译、勿用 ssh_build 绕圈；ssh_build 在方式二被调用时会追加软拦截提示但仍照常执行。
3. 保持文档现有 markdown 风格与措辞密度。

**验证：** 文档段落通顺，无遗留 TODO；编译路由指引与代码实现一致。

---

## 执行顺序

```
T1（新模块） → T2（server.ts） ─┐
             → T3（host-info.ts）┼→ T5（编译验证）→ T6（文档同步）
             → T4（build.ts） ──┘
```

T1 是其余改造的前置依赖（提供文本函数）。T2/T3/T4 互不依赖、可并行（但建议顺序执行以便逐步验证）。T5 在全部代码改动后统一编译。T6 最后做文档同步。
