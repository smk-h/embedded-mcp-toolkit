# serial_enter_uboot 配置化与提示符鲁棒性 Tasks

> **修订说明**（2026-07-19）：
> 1. 原方案引入了 fuzzyPattern / parsePatternString 做自动正则转换，经讨论后**整段砍掉**——
>    改为配置值直接写 JavaScript 正则源码字符串，由 `new RegExp(source, flags)` 构造。
>    理由：所见即所得、行为可预测、与项目已有 `promptPattern` 字段风格一致；正则编写门槛由配套文档补足。
> 2. 三字段（autobootPrompts / verifyEnvKeys / prompt）从"用户配置替换默认值"改为"**用户配置补充默认值**"——
>    数组用 concat/union，prompt 用联合正则。理由：符合"补充"直觉，用户加提示不丢默认识别能力；
>    未配置时合并结果等同默认值本身，AC1 兼容性不变。
> 本文档已据此重写。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/shared/config.ts` | `DeviceConfig.serial.uboot` 子段 + `UbootYaml` 类型 + `getUbootConfig` |
| 修改 | `src/mcp/shared/prompt-detector.ts` | 新增 `UbootDetector` 类 + `UbootDefaults` + `getDebugState` + `dedupPreserveOrder`；`PromptDetector` 类不动 |
| 修改 | `src/mcp/tools/serial/shell.ts` | `serialEnterUbootHandler` 改造，串联 `UbootDetector` |
| 修改 | `src/cli/index.ts` | 注册 `regex-verify` 命令（import + `.command().argument().option().action()`） |
| 新建 | `src/cli/commands/regex-verify.ts` | `runRegexVerify`（CLI 自测命令，spec F7） |
| 修改 | `.embedded/configs/config.example.yaml` | serial 段加 uboot 子段示例（正则字符串写法） |
| 修改 | `.embedded/configs/devices/board-example.yaml` | 同步 uboot 子段示例 |
| 新建 | `docs/regex-guide.md` | U-Boot 配置正则编写指南（含合并语义、去重、CLI 用法） |
| 新建 | `test/scripts/uboot-detector-test.mjs` | 临时验证脚本（node 内置 assert，验证 UbootDetector 逻辑） |

## T1: config.ts 扩展 uboot 配置 schema 与读取函数

**文件：** `src/shared/config.ts`
**依赖：** 无
**步骤：**
1. 在 `KeyProviderYaml` 接口下方新增 `UbootYaml` 接口（导出）：
   ```ts
   /**
    * U-Boot 进入检测配置（serial.uboot 子段）
    * 字段值直接写 JavaScript 正则源码字符串，由 new RegExp(source, flags) 构造。
    * 详见 docs/regex-guide.md。
    */
   export interface UbootYaml {
     autobootPrompts?: string[];   // autoboot 提示正则数组（构造时带 i 标志）
     prompt?: string;              // 命令提示符正则（构造时无 flags）
     verifyEnvKeys?: string[];     // 事后验证的环境变量键名（纯字面量）
   }
   ```
2. 在 `DeviceConfig.serial` 子段末尾加 `uboot?: UbootYaml`
3. 在 `getPromptPattern` 下方新增 `getUbootConfig`：
   ```ts
   export function getUbootConfig(name?: string): UbootYaml {
     const device = getDeviceConfig(name ?? resolveDeviceName());
     return device.serial?.uboot ?? {};
   }
   ```

**验证：** `npx tsc --noEmit` 编译通过

## T2: prompt-detector.ts 新增 UbootDetector 类与 UbootDefaults 常量

**文件：** `src/mcp/shared/prompt-detector.ts`
**依赖：** T1（UbootYaml 类型）
**步骤：**
1. 在文件顶部 import：`import type { UbootYaml } from "../../shared/config.js";`
2. 更新文件头 `Description`，把 `prompt-detector` 语义拓宽为"shell 状态/提示符检测"，并标注新增了 `UbootDetector`
3. 在文件末尾新增 `UbootDefaults` 常量（正则源码字符串，等价原硬编码）：
   ```ts
   const UbootDefaults = {
     autobootPrompts: [
       "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot",
       "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot",
     ],
     prompt: "(?:=>|U-Boot>)\\s*$",
     verifyEnvKeys: ["baudrate", "bootdelay"],
     verifyTimeoutMs: 4000,
     kernelBootPattern: "Starting\\s+kernel|Linux\\s+version",
   } as const;
   ```
4. 新增 `UbootDetector` 类，构造逻辑实现**三字段与默认值合并 + 去重**（spec F4）：
   - `autobootEntries`：合并数组后**字面去重保持顺序**——`dedupPreserveOrder([...默认, ...(用户 ?? [])])`，再 `map` 成 `{ re: new RegExp(s, "i"), interruptKey }`
   - `verifyKeys`：`Array.from(new Set([...默认, ...(用户 ?? [])]))` Set 去重，全部小写化
   - `promptRe`：用户值与默认值**字面相等**则直接用默认（跳过联合）；否则 `mergePromptPattern` 剥离尾部 `\s*$` 后 `(?:A|B)` 联合；剥离失败退化为简单联合；最后 `new RegExp(merged)`（无 flags）
   - `kernelBootRe`：直接 `new RegExp(UbootDefaults.kernelBootPattern, "i")`（不参与合并，用户无法配置）
   - `matchAutoboot` 遍历数组返回对应中断键（含 `Ctrl+u` 字样发 `\x15`，否则发换行；判断用 `/ctrl\\?\+u/i` 兼容转义/非转义）
   - `matchPrompt` / `matchVerifyKey` / `matchKernelBoot` 直接 test
   - 构造时若 `new RegExp` 抛错（无效正则），让错误向上传播给 handler
5. 新增模块级私有函数 `dedupPreserveOrder<T>(arr)`：用 Set 去重，保持首次出现顺序
6. 新增公共方法 `getDebugState()`：返回合并后实际生效的正则字符串快照（`source` + `flags`）和配置项，供 regex-verify 命令 `-v` 模式使用；不暴露 RegExp 实例避免外部修改
7. `PromptDetector` 类**不动**

**关键不变量**：用户 config 为 `undefined` 或三字段都为空时，合并结果等同默认值本身（`默认 + []` = `默认`），保证 AC1 兼容。用户配置与默认值字面相等时去重生效，不产生冗余（AC12）。

**验证：** `npx tsc --noEmit` 编译通过

## T3: serialEnterUbootHandler 改造，串联 UbootDetector

**文件：** `src/mcp/tools/serial/shell.ts`（`serialEnterUbootHandler`）
**依赖：** T1、T2
**步骤：**
1. import：从 `prompt-detector.js` 加 `UbootDetector`；从 `config.js` 加 `getUbootConfig`
2. 删除 handler 内硬编码的 `AUTOBOOT_ANY_KEY_RE` / `AUTOBOOT_CTRL_U_RE` / `UBOOT_PROMPT_RE`
3. 在 `const shell = result.shell;` 之后构造 detector：
   ```ts
   let detector: UbootDetector;
   try {
     detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
   } catch (err) {
     // 配置错误（无效正则等）立即返回，不进入轮询
     return { content: [text(`Failed to build U-Boot detector (config error): ${...}`)] };
   }
   ```
4. 重写主循环为三层流程：
   - 阶段 1：`detector.matchAutoboot` 命中即发对应中断键，记 `interruptedAt`
   - 阶段 2（主层）：`matchKernelBoot` 命中即失败；`matchPrompt` 命中即成功（via prompt）；主层窗口耗尽触发 printenv
   - 阶段 3（验证层）：`matchKernelBoot` 命中即失败；`matchVerifyKey` 命中即成功（via verify）；窗口耗尽返回失败（含 `Retry recommended`）
5. 返回文本：成功标注 via prompt/via verify；失败含 `Retry recommended`
6. 总超时兜底分支保留不变

**验证：**
1. `npx tsc --noEmit` 编译通过
2. `npm run format:check`（不通过则 `format:fix` 后再 check）
3. `npm run eslint:fix` 后改动文件无 error

## T4: 配置模板补 uboot 子段示例（正则字符串写法）

**文件：** `.embedded/configs/config.example.yaml`、`.embedded/configs/devices/board-example.yaml`
**依赖：** T1
**步骤：**
1. 在 `config.example.yaml` 的 serial 段末尾加 `uboot` 子段，字段值用正则源码字符串：
   ```yaml
   uboot:
     # 字段值直接写 JavaScript 正则源码字符串，由 new RegExp() 构造。
     # YAML 双引号字符串中反斜杠需双写：\\s+ 而非 \s+。
     # 详见 docs/regex-guide.md。
     autobootPrompts:            # 含 "Ctrl+u" 字样的条目 → 发 \x15；其余 → 发换行
       - "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot"
       - "Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot"
     prompt: "(?:=>|U-Boot>)\\s*$"   # 常见厂商：=> / Marvell>> / hisilicon# / STM32MP> / ZynqMP>
     verifyEnvKeys:                   # 提示符未命中时，发 printenv 验证的环境变量键（纯字面量）
       - "baudrate"
       - "bootdelay"
   ```
2. `devices/board-example.yaml` 同步加一份更详细的版本（含常见厂商提示符注释、多板子联合正则示例）
3. 保持原文件编码（UTF-8 LF）不变

**验证：** `node -e "import('js-yaml').then(...)"` 解析两份 yaml 无报错，uboot 字段存在

## T5: 新建 docs/regex-guide.md 正则编写指南

**文件：** `docs/regex-guide.md`（新建）
**依赖：** 无（可与 T3/T4 并行）
**步骤：** 按 spec F6 的要点清单编写，覆盖：
1. **为什么配置用正则**——U-Boot 输出多样（提示符、autoboot 文案、内核日志），正则提供统一识别能力
2. **最小必备语法**——只覆盖本项目实际用到的：
   - 字面量字符（`H`、`i`、`t`）
   - `\s+` 匹配一个或多个空白（容忍空格数量）
   - `$` 锚定行尾
   - `(?:A|B)` 联合多种可能
   - `\\.` 转义元字符（如 `.` 在提示符里要匹配字面点）
   - `i` 标志的作用（本项目 autoboot/kernelBoot 自动带，prompt 不带）
3. **YAML 中写正则的注意点**——重点章节：
   - 双引号字符串中反斜杠必须双写（`"\\s+"` 而非 `"\s+"`）
   - 单引号字符串不转义反斜杠（`'\s+'` 字面量即 `\s+`）——推荐用法
   - 给出双引号 vs 单引号的对比示例
4. **常见 U-Boot 场景的正则示例**：
   - autoboot 提示：`Hit\\s+any\\s+key\\s+to\\s+stop\\s+autoboot`
   - 命令提示符：标准 `=>` 用 `"=>"`；多厂商联合 `(?:=>|Marvell>>|hisilicon#)\\s*$`
   - 内核日志识别（仅供理解，本项目内置）
5. **调试建议**：
   - 用浏览器开发者工具 Console：`/Hit\s+any\s+key/.test("Hit any key")`
   - 用 Node：`node -e "console.log(/.../.test('...'))"`
   - 在线工具 regex101.com（选 ECMAScript flavor）
6. **常见错误**：
   - 忘了双写反斜杠（最常见）
   - 括号不闭合导致构造失败
   - 提示符正则没锚 `$` 导致命令输出中间被误判

**验证：** 对照 spec F6 要点清单逐项核对，文档完整可读

## T6: 编写临时验证脚本（UbootDetector 逻辑）

**文件：** `test/scripts/uboot-detector-test.mjs`（新建）
**依赖：** T2
**步骤：**
1. 用 node 内置 `node:assert` + 动态 import 编译产物（`out/mcp/shared/prompt-detector.js`）
2. 用例覆盖：
   - **默认值兼容（AC1）**：`new UbootDetector()` 能识别 `=>`、`U-Boot>` 结尾；autoboot 识别 `Hit any key`/`Hit Ctrl+u`；kernelBoot 识别 `Starting kernel`/`Linux version`
   - **正则直接生效（AC4）**：默认 autoboot 正则容忍多空格（`\s+` 的效果）
   - **配置覆盖（AC2/AC3/AC6）**：自定义 `autobootPrompts`、`prompt`、`verifyEnvKeys` 后行为改变
   - **配置错误（AC9）**：`new UbootDetector({ prompt: "((invalid" })` 抛错；空数组走默认值
3. 脚本输出汇总（passed/failed 计数 + 最终状态行）

**验证：**
1. 先 `npm run build`
2. 运行 `node test/scripts/uboot-detector-test.mjs`，期望输出 `All uboot-detector tests passed.`

## T7: 新建 regex-verify CLI 命令

**文件：** `src/cli/commands/regex-verify.ts`（新建）、`src/cli/index.ts`（注册）
**依赖：** T2（UbootDetector + getDebugState）
**步骤：**
1. 新建 `src/cli/commands/regex-verify.ts`，参考 `src/cli/commands/split.ts` 的代码骨架（文件头注释、`RegexVerifyOptions` interface、`runRegexVerify(opts)` 主函数、私有辅助函数）
2. 静态 import `UbootDetector`：`import { UbootDetector } from "../../mcp/shared/prompt-detector.js";`，以及 `import type { UbootYaml } from "../../shared/config.js";`
3. 实现 `runRegexVerify(opts)`：
   - 从 `.embedded/configs/devices/<opts.device>.yaml` 加载 `serial.uboot`（用 `js-yaml` 的 `load` + `readFileSync`）
   - `new UbootDetector(uboot)` 构造（自动合并默认值）
   - 跑 15 条标准样本矩阵（常量 `STANDARD_SAMPLES`，含 autoboot/prompt/verify/kernel 四类），每条 `classify` 后与期望对比打印 ✅/❌
   - `-v` 模式调 `detector.getDebugState()` 展示合并后实际生效的正则
   - `-s` 模式追加用户自定义样本（只展示识别结果，不判期望）
   - 退出码：全过 0、失败 1（`process.exitCode = 1`）
4. 错误处理：设备文件不存在 → 列出可用设备；正则非法 → 显示具体错误
5. 在 `src/cli/index.ts` 加 `import { runRegexVerify }`，注册命令：
   ```ts
   program
     .command("regex-verify")
     .description("自测设备 yaml 的 U-Boot 正则配置（加载 serial.uboot，跑样本矩阵）")
     .argument("<device>", "设备名（.embedded/configs/devices/<device>.yaml）")
     .option("-s, --sample <text>", "追加一条自定义测试样本（可多次使用）", collectFn, [])
     .option("-v, --verbose", "显示构造出的 detector 内部状态", false)
     .action((device, opts) => runRegexVerify({ device, ...opts }));
   ```
6. 更新 `src/cli/index.ts` 顶部"命令层级结构"注释，加 `regex-verify` 一行

**验证：**
1. `npx tsc --noEmit` 编译通过
2. `node ./bin/embedded-mcp-toolkit-cli.js regex-verify --help` 显示用法
3. `node ./bin/embedded-mcp-toolkit-cli.js regex-verify board-example` 跑 15 条样本，全过
4. `node ./bin/embedded-mcp-toolkit-cli.js regex-verify board-example -v` 显示合并后的正则
5. `node ./bin/embedded-mcp-toolkit-cli.js regex-verify board-xxx` 报错并列出可用设备

## T8: 全量构建与代码规范校验

**文件：** 全项目
**依赖：** T1-T7 全部完成
**步骤：**
1. `npm run clean && npm run build`——从干净状态编译
2. `npm run format:check`——不通过则 `format:fix` 后再 check
3. `npm run eslint:fix`——改动文件无新增 error
4. 重跑 `node test/scripts/uboot-detector-test.mjs`——确认最终代码仍通过
5. 重跑 `node ./bin/embedded-mcp-toolkit-cli.js regex-verify board-example`——确认 CLI 命令仍工作

**验证：** 上述五步全部通过

## 执行顺序

```
T1 ──┬──> T2 ──┬──> T3 ──┐
     │         │          ├──> T8
     ├──> T4 ──┤          │
     │         ├──> T7 ───┤
     └──> T5 ──┘          │
T2 ──┴──> T6 ─────────────┘
```

说明：
- T1 是所有任务的基础（类型定义）
- T2 依赖 T1（UbootYaml 类型）
- T3 依赖 T1、T2
- T4、T5 仅依赖 T1（或无依赖），可与 T3 并行
- T6 依赖 T2，需在 build 之后跑
- T7 依赖 T2（UbootDetector + getDebugState）
- T8 最后收口

## 关于"实机验证"的说明

本 task 的验证不包含连真实板子跑 `serial_enter_uboot`——那需要硬件在场，属于用户验收（checklist 阶段的端到端场景）。task 阶段只保证：
- 代码编译通过、规范一致
- UbootDetector 逻辑经脚本验证（覆盖 AC1/AC2/AC3/AC4/AC6/AC9 的可离线部分）
- AC5（YAML 反斜杠双写）由 T4 的 yaml 解析校验 + T5 文档说明共同覆盖
- AC10（模板更新）、AC11（文档）由 T4、T5 直接产出
- AC7/AC8（失败快速、kernel 即判失败）时序行为留给 checklist 端到端验证
