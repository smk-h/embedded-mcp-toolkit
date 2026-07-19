# serial_enter_uboot 配置化与提示符鲁棒性 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。对应 spec.md 的 AC1-AC13。
>
> **修订说明**（2026-07-19）：
> 1. 原方案曾引入 fuzzyPattern/parsePatternString 做自动正则转换，已取消。改为配置值直接写
>    JavaScript 正则源码字符串，由 `new RegExp(source, flags)` 构造。本文档已据此重写 AC4/AC5，并新增 AC11（文档）。
> 2. 三字段从"替换默认值"改为"**合并默认值**"（autoboot/verifyEnvKeys 用 concat/union，
>    prompt 用联合正则）。AC2/AC3/AC6 已更新为合并语义验证。
> 3. 合并时加**去重**（字面相等判断），避免用户抄默认值产生冗余条目或嵌套正则。新增 AC12。
> 4. 新增 `regex-verify` CLI 命令 + `UbootDetector.getDebugState()` 调试接口，让用户不连真机
>    就能验证配置、查看合并后的实际正则。新增 AC13、第六节"CLI 命令验证"。

## 一、 实现完整性

- [ ] `UbootYaml` 类型已定义并导出（验证：读 `src/shared/config.ts` 确认 `export interface UbootYaml` 存在，含 `autobootPrompts?` / `prompt?` / `verifyEnvKeys?` 三个可选字段）
- [ ] `getUbootConfig` 已实现（验证：读 `src/shared/config.ts` 确认函数存在；无配置时返回 `{}`）
- [ ] `UbootDefaults` 常量值与原硬编码等价（验证：读 `src/mcp/shared/prompt-detector.ts`，确认 `autobootPrompts` 是 `"Hit\\s+Ctrl\\+u..."` / `"Hit\\s+any\\s+key..."`、`prompt` 是 `"(?:=>|U-Boot>)\\s*$"`、`kernelBootPattern` 含 `Starting\\s+kernel|Linux\\s+version`）— 对应 AC1
- [ ] 三字段合并语义已实现（验证：读 `UbootDetector` 构造函数，确认 `autobootPrompts` 用 concat（默认在前）、`verifyEnvKeys` 用 union 去重、`prompt` 用联合正则——存在 `mergePromptPattern` 或等价的剥离尾部 `\s*$` 后 `(?:A|B)` 合并的逻辑）— 对应 spec F4
- [ ] 合并去重已实现（验证：读 `UbootDetector` 构造函数，确认 `autobootPrompts` 经过 `dedupPreserveOrder` 字面去重；`verifyEnvKeys` 用 Set 去重；`prompt` 用户值与默认值字面相等时跳过联合直接用默认）— 对应 AC12
- [ ] `dedupPreserveOrder` 辅助函数已实现（验证：`rg "dedupPreserveOrder" src/mcp/shared/prompt-detector.ts` 命中；用 Set 去重保持首次出现顺序）
- [ ] `getDebugState()` 公共方法已实现（验证：读 `UbootDetector` 类，确认方法返回 `{ autobootPatterns, prompt, kernelBoot, verifyKeys, verifyTimeoutMs }` 字符串快照；不暴露 RegExp 实例）— 对应 spec F8
- [ ] `UbootDetector` 类已实现，构造时直接 `new RegExp(source, flags)`（验证：读 `src/mcp/shared/prompt-detector.ts` 确认构造函数内用 `new RegExp`；autoboot/kernelBoot 带 `"i"` flags，prompt 无 flags）— 对应 AC4
- [ ] **不存在** `parsePatternString` / `fuzzyPattern` 函数（验证：`rg "parsePatternString|fuzzyPattern" src/` 无命中；确认自动转换逻辑已彻底移除）
- [ ] 四个 match 方法语义正确（验证：见第四节离线脚本）
- [ ] `serialEnterUbootHandler` 已改造为串联 `UbootDetector`（验证：读 `src/mcp/tools/serial/shell.ts` 确认 handler 内有 `new UbootDetector(getUbootConfig(...))` 调用；原硬编码 `AUTOBOOT_*_RE` / `UBOOT_PROMPT_RE` 已移除）
- [ ] 配置构造错误已捕获并返回明确信息（验证：读 handler 确认 `try { new UbootDetector(...) } catch` 分支返回 `Failed to build U-Boot detector (config error): ...`）— 对应 AC9、N4
- [ ] `regex-verify` CLI 命令已注册（验证：`node ./bin/embedded-mcp-toolkit-cli.js regex-verify --help` 显示用法；`rg "regex-verify" src/cli/index.ts` 命中注册段）— 对应 spec F7、AC13
- [ ] `runRegexVerify` 函数已实现（验证：读 `src/cli/commands/regex-verify.ts`，确认加载 yaml → 构造 UbootDetector → 跑样本矩阵 → 汇总退出的主流程；错误处理含"找不到设备列可用设备"、"正则非法显示具体错误"）

## 二、 集成

- [ ] `serialEnterUbootHandler` 通过 `shell.getDeviceName()` 拿设备名并调 `getUbootConfig`（验证：读 handler 确认调用链）
- [ ] 检测流程按 spec F3 三层编排：autoboot → 主层提示符 → 验证层 printenv → 失败返回（验证：读 handler 主循环，确认四个阶段分支齐全）
- [ ] `matchKernelBoot` 在主层和验证层都被检查（验证：读 handler 确认两处都有 `detector.matchKernelBoot` 调用）
- [ ] `printenv` 只发一次（验证：读 handler 确认有 `verifyStarted` 标志位控制）
- [ ] 失败返回文本含重试提示（验证：读 handler 失败分支确认文本含 `Retry recommended`）— 对应 AC7
- [ ] 成功返回文本标注命中方式（验证：读 handler 成功分支确认区分 `via prompt` 与 `via verify`）
- [ ] 总超时兜底分支保留（验证：读 handler 确认 `while (Date.now() < deadline)` 循环外的超时返回仍存在）
- [ ] `PromptDetector` 类未被改动（验证：`git diff src/mcp/shared/prompt-detector.ts` 确认 `PromptDetector` 类体无修改，仅文件末尾追加 `UbootDetector` + 常量）— 对应 N1
- [ ] 三个 `*_shell_exec` handler 未受影响（验证：`git diff` 确认 `adb/ssh/serial` 三个 shell.ts 的 exec handler 无改动）— 对应 N1

## 三、 编译与测试

- [ ] 项目编译无错误（验证：`npm run clean && npm run build` 通过）
- [ ] prettier 风格一致（验证：`npm run format:check` 通过）
- [ ] eslint 无新增告警（验证：`npm run eslint:fix` 后 `npx eslint -c eslint.config.ts src/shared/config.ts src/mcp/shared/prompt-detector.ts src/mcp/tools/serial/shell.ts` 无 error）
- [ ] 代码符合 ts-lang-spec 要求（验证：lint 通过或人工检查命名/风格/JSDoc；新增类与函数均有 `@brief` JSDoc）
- [ ] 文件编码未被破坏（验证：新建的 `docs/regex-guide.md`、`test/scripts/uboot-detector-test.mjs` 为 UTF-8 无 BOM、LF；修改的 `config.ts` / `prompt-detector.ts` / `shell.ts` / 两个 yaml 保持原编码与换行符不变）

## 四、 离线脚本验证（对应 AC1/AC2/AC3/AC4/AC6/AC9 的可离线部分）

> 运行 `node test/scripts/uboot-detector-test.mjs`，期望输出 `All uboot-detector tests passed.`

- [ ] **AC1 默认兼容**：`new UbootDetector()` 默认 prompt 匹配 `=>` 和 `U-Boot>` 结尾、不匹配中间出现的 `=>`；autoboot 识别 `Hit any key` 返回 `"\n"`、`Hit Ctrl+u` 返回 `"\x15"`
- [ ] **AC4 正则直接生效**：默认 autoboot 正则容忍多空格（`Hit  any   key to stop autoboot` 仍命中），证明 `\s+` 直接生效；构造 `new RegExp("3\\.14")` 匹配字面 `3.14` 不匹配 `3X14`，构造 `new RegExp("3.14")` 匹配 `3X14`（元字符未转义时）
- [ ] **AC9 配置错误**：`new UbootDetector({ prompt: "((invalid" })` 抛错；`new UbootDetector({ autobootPrompts: [] })` 走默认值不报错
- [ ] **AC2 autoboot 合并**：`new UbootDetector({ autobootPrompts: ["Press\\s+SPACE\\s+to\\s+abort"] })` 能识别自定义提示并返回 `"\n"`，**同时仍识别默认的** `Hit any key to stop autoboot`（合并非替换）
- [ ] **AC3 prompt 合并**：`new UbootDetector({ prompt: "Marvell>>\\s*$" })` 能识别 `Marvell>>` 末尾，**同时仍识别默认的** `=>` 和 `U-Boot>` 末尾（合并非替换）
- [ ] **AC6 verifyEnvKeys 合并**：`new UbootDetector({ verifyEnvKeys: ["mykey"] })` 能匹配 `mykey=`，**同时仍匹配默认的** `baudrate=` 和 `bootdelay=`（合并非替换）；去重生效（用户配 `["baudrate"]` 不重复）
- [ ] **AC12 合并去重**：用户配置与默认值字面相等时不产生冗余——`new UbootDetector({ autobootPrompts: ["Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot"] })`（与默认第一条相同）的 `getDebugState().autobootPatterns.length` 应为 2（默认 2 条 + 用户 1 条重复 → 去重后 2 条）；`new UbootDetector({ prompt: "(?:=>|U-Boot>)\\s*$" })`（与默认相同）的 `getDebugState().prompt.source` 不应含嵌套的 `(?:(?:...)|(?:...)))`

## 五、 YAML 反斜杠双写验证（对应 AC5）

- [ ] **AC5 双引号字符串**：yaml 中写 `prompt: "(?:=>|U-Boot>)\\s*$"`，加载到内存的字符串是 `(?:=>|U-Boot>)\s*$`（验证：`node -e "import('js-yaml').then(m => { const doc = m.load(require('fs').readFileSync('.embedded/configs/devices/board-example.yaml','utf8')); console.log(JSON.stringify(doc.serial.uboot.prompt)); })"` 输出含 `\s*$` 而非 `\\s*$`）
- [ ] docs/regex-guide.md 有专门章节说明双引号需双写反斜杠、单引号不需（验证：读文档确认章节存在）

## 六、 regex-verify CLI 命令验证（对应 AC13）

> 不依赖真机，开发完成后立即验证。

- [ ] **基本用法**：`node ./bin/embedded-mcp-toolkit-cli.js regex-verify board-example` 跑 15 条标准样本，全部 ✅，退出码 0
- [ ] **未配置 uboot 的设备**：`regex-verify <未配置 uboot 的设备>` 显示「未配置 uboot 子段，将完全使用内置默认值」并跑通 15 条样本（合并语义的关键不变量）
- [ ] **-v 详细模式**：`regex-verify board-example -v` 显示「合并默认值后实际生效」的完整正则状态——含 autoboot 各条 source/flags/中断键、prompt source/flags、kernelBoot、verifyKeys、verifyTimeoutMs（验证 `getDebugState()` 输出）
- [ ] **-s 自定义样本**：`regex-verify board-example -s "Marvell>>" -s "Starting kernel..."` 在标准样本后追加用户样本段，正确识别（Marvell>> 为 none、Starting kernel 为 kernel）
- [ ] **错误设备名**：`regex-verify board-xxx` 报错并列出可用设备名，退出码 1
- [ ] **无效正则配置**：构造一个 prompt 为 `((invalid` 的临时设备文件，`regex-verify` 报错显示 `Unterminated group`，退出码 1
- [ ] **去重视觉验证**：`regex-verify board-example -v` 的 autoboot 正则段无重复条目；prompt 正则无嵌套 `(?:(?:...)|(?:...))` 冗余（用户配置与默认相同时）
- [ ] **合并视觉验证**：构造一个含自定义提示的设备（如 `autobootPrompts: ["Press\\s+SPACE..."]`），`-v` 输出含默认 + 用户两类条目（合并非替换）

## 七、 端到端场景（真机，对应 AC1/AC7/AC8 + 时序行为）

> 以下场景在连接真实板子（提示符为 `=>` 的 IMX6ULL 或类似）的串口会话上执行。

- [ ] **AC1 默认值兼容**：设备配置不写 `uboot` 子段，运行 `serial_enter_uboot`，行为与改动前一致——同样的中断键、同样的成功返回文本格式（含 `via prompt`）、能正常进入 uboot 命令行
- [ ] **AC7 失败快速返回**：构造无法中断 autoboot 的场景，观察失败返回时间 ≤5 秒且文本含 `Retry recommended`
- [ ] **AC8 kernel 启动即判失败**：让设备越过 uboot 进入 kernel 启动，观察输出含 `Starting kernel` 或 `Linux version` 时立即失败返回
- [ ] **主层命中路径**：配置默认 prompt，板子提示符就是 `=>`，进入后快速成功返回（应在主层窗口内，不触发 printenv）
- [ ] **验证层命中路径**：配置 `prompt` 为不匹配的值模拟厂商定制，主层不命中 → 触发 printenv → 验证层命中 `baudrate=` → 成功返回（文本含 `via verify`）
- [ ] **配置覆盖实机**：在板子提示符被厂商改为非 `=>` 的情况下，配置 `prompt` 为实际提示符正则，`serial_enter_uboot` 能正确识别并进入

## 八、 配置模板与文档（对应 AC10、AC11）

- [ ] **AC10 模板更新**：`.embedded/configs/config.example.yaml` 的 serial 段下出现 `uboot` 子段示例（验证：读模板确认含三字段，字段值是正则源码字符串，注释说明反斜杠双写）
- [ ] 分文件示例同步：`.embedded/configs/devices/board-example.yaml` 同步含 `uboot` 子段（含常见厂商提示符注释、多板子联合正则示例）
- [ ] 模板可被正常加载（验证：`DEVICE=board-example node -e "import('./out/shared/config.js').then(m => console.log(m.getUbootConfig('board-example')))"` 不报错，返回示例配置）
- [ ] **AC11 正则指南文档**：`docs/regex-guide.md` 存在且覆盖 spec F6 所有要点（验证：对照清单逐项确认——为什么用正则 / 最小语法 / YAML 双写 / U-Boot 场景示例 / 合并语义与去重 / regex-verify 命令用法 / 调试建议 / 常见错误）

---

## 验收说明

- **第四节（离线脚本）** 是必跑项，无硬件依赖，开发完成后立即验证
- **第五节（YAML 双写）** 用 node 一行命令验证，无硬件依赖
- **第六节（端到端）** 依赖真实板子在场，属用户验收阶段执行；时序行为（AC7 的 ≤5 秒、AC8 的立即返回）只能在此环节观测
- **AC1 兼容性** 是硬约束——若现有能正常工作的板子行为改变，判定不通过
- 任何一项不通过：修复后重跑该节全部条目（避免单项修复引入回归）

---
*本文档由 code-spec 技能辅助生成*
