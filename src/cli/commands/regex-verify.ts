/**
 * @file src/cli/commands/regex-verify.ts
 * @brief embedded-mcp-toolkit regex-verify 命令
 *
 * 加载指定设备的 serial.uboot 配置，构造 UbootDetector（自动合并默认值），
 * 跑标准样本矩阵 + 用户自定义样本，展示每条匹配结果。
 *
 * 用于在不连真机的情况下验证 yaml 正则配置能否正确识别 U-Boot 各类输出。
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";
import { UbootDetector } from "../../mcp/shared/prompt-detector.js";
import type { UbootYaml } from "../../shared/config.js";

// ============================================================
// 选项
// ============================================================

/**
 * @brief regex-verify 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 */
export interface RegexVerifyOptions {
  device: string; // 设备名（.embedded/configs/devices/<device>.yaml）
  sample?: string[]; // 用户自定义样本（可多次 --sample）
  verbose: boolean; // 是否显示 detector 内部状态
}

// ============================================================
// 内部类型与常量
// ============================================================

/**
 * @brief 样本识别结果分类
 *
 * 与 UbootDetector 的四个 match 方法对应，加上"未识别"兜底。
 * 用于把样本的"期望分类"与"实际分类"对比判定 pass/fail。
 */
type SampleCategory =
  | "autoboot-anykey"
  | "autoboot-ctrlu"
  | "kernel"
  | "prompt"
  | "verify"
  | "none";

/**
 * @brief 标准样本矩阵
 *
 * 覆盖 U-Boot 启动到命令行的各类典型输出，每条样本带期望分类。
 * 期望为 "none" 的样本用于验证"不应误判"的反向场景。
 */
const STANDARD_SAMPLES: ReadonlyArray<{
  category: string;
  input: string;
  expect: SampleCategory;
}> = [
  // autoboot 提示
  {
    category: "autoboot",
    input: "Hit any key to stop autoboot: 3",
    expect: "autoboot-anykey",
  },
  {
    category: "autoboot",
    input: "Hit  any   key  to stop autoboot: 1",
    expect: "autoboot-anykey",
  },
  {
    category: "autoboot",
    input: "HIT ANY KEY TO STOP AUTOBOOT",
    expect: "autoboot-anykey",
  },
  {
    category: "autoboot",
    input: "Hit Ctrl+u to stop autoboot",
    expect: "autoboot-ctrlu",
  },
  {
    category: "autoboot",
    input: "Press SPACE to abort in 3s",
    expect: "none",
  },
  {
    category: "autoboot",
    input: "Autoboot in 3 seconds, hit any key to stop",
    expect: "none",
  },
  {
    category: "autoboot",
    input: "Hitankey to stop autoboot",
    expect: "none",
  },

  // 命令提示符
  { category: "prompt", input: "U-Boot 2016.03\n=>", expect: "prompt" },
  { category: "prompt", input: "\nU-Boot>", expect: "prompt" },
  { category: "prompt", input: "=>  ", expect: "prompt" },
  { category: "prompt", input: "=> something after", expect: "none" },
  { category: "prompt", input: "root@host:~# ", expect: "none" },
  { category: "prompt", input: "user@imx6:~$ ", expect: "none" },
  { category: "prompt", input: "rk3568:/ $ ", expect: "none" },
  { category: "prompt", input: "Marvell>>", expect: "none" },
  { category: "prompt", input: "hisilicon# ", expect: "none" },
  { category: "prompt", input: "exit\r\n", expect: "none" },

  // verify 环境变量键（printenv 输出片段）
  { category: "verify", input: "baudrate=115200", expect: "verify" },
  { category: "verify", input: "bootdelay=3", expect: "verify" },
  {
    category: "verify",
    input: "bootargs=console=ttyS0",
    expect: "none",
  },
  // 大小写不敏感：matchVerifyKey 内部 toLowerCase，故 BAUDRATE= 也命中（设计行为）
  { category: "verify", input: "BAUDRATE=115200", expect: "verify" },
  // 键名后必须紧跟 =：baudrate 后跟空格不算
  { category: "verify", input: "baudrate ", expect: "none" },
  // 子串匹配：set 命令里的 baudrate= 也会命中（边界，但验证层只在 printenv 后启用，实际不会触发）
  { category: "verify", input: "set baudrate=9600", expect: "verify" },

  // 内核启动（即判失败）
  { category: "kernel", input: "Starting kernel ...", expect: "kernel" },
  {
    category: "kernel",
    input: "Linux version 5.4.0 gcc 9.0",
    expect: "kernel",
  },
];

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 执行 regex-verify 命令
 * @details 加载设备配置 → 构造 UbootDetector（自动合并默认值）→
 *          跑标准样本矩阵 + 用户自定义样本 → 汇总 pass/fail。
 *
 * 退出码契约：所有标准样本通过返回 0；任一失败置 exitCode = 1，
 * 便于在 CI 或脚本中串联调用。
 *
 * @param opts 由 Commander 解析后传入的选项对象
 */
export function runRegexVerify(opts: RegexVerifyOptions): void {
  logCommand("regex-verify", opts);

  const devicesDir = resolve(process.cwd(), ".embedded", "configs", "devices");

  console.log(`\n🔍 embedded-mcp-toolkit 正则自测：${opts.device}\n`);

  // 1. 加载设备配置
  let uboot: UbootYaml;
  let sourcePath: string;
  try {
    const result = loadDeviceConfig(opts.device, devicesDir);
    uboot = result.uboot;
    sourcePath = result.sourcePath;
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof DeviceNotFoundError) {
      const devices = listDevices(devicesDir);
      if (devices.length > 0) {
        console.error(`\n   可用设备：${devices.join(", ")}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(`   配置文件: ${shortPath(sourcePath)}`);

  // 2. 显示提取到的 uboot 配置
  console.log(`\n   提取的 serial.uboot 配置：`);
  if (Object.keys(uboot).length === 0) {
    console.log("   （未配置 uboot 子段，将完全使用内置默认值）");
  } else {
    for (const [k, v] of Object.entries(uboot)) {
      console.log(`     ${k}: ${JSON.stringify(v)}`);
    }
  }

  // 3. 构造 detector（自动合并默认值）
  let detector: UbootDetector;
  try {
    detector = new UbootDetector(uboot);
  } catch (err) {
    console.error(
      `\n❌ 配置错误，无法构造检测器：${
        err instanceof Error ? err.message : err
      }`
    );
    console.error("   提示：检查 yaml 中的正则是否合法（括号闭合、转义正确）");
    process.exitCode = 1;
    return;
  }

  // 4. verbose 模式展示构造结果（合并默认值后实际生效的正则）
  if (opts.verbose) {
    const state = detector.getDebugState();
    console.log(`\n   构造的 UbootDetector 内部状态（合并默认值后实际生效）：`);

    console.log(`     autoboot 正则（按数组顺序匹配，命中即返回对应中断键）：`);
    state.autobootPatterns.forEach((p, i) => {
      const keyDesc =
        p.interruptKey === "\x15" ? "\\x15 (Ctrl+u)" : "\\n (换行)";
      const flagsDesc = p.flags ? ` / flags: "${p.flags}"` : "";
      console.log(
        `       [${i}] /${p.source}/${flagsDesc}  →  中断键: ${keyDesc}`
      );
    });

    const promptFlagsDesc = state.prompt.flags
      ? ` / flags: "${state.prompt.flags}"`
      : "";
    console.log(`     prompt 正则: /${state.prompt.source}/${promptFlagsDesc}`);

    const kernelFlagsDesc = state.kernelBoot.flags
      ? ` / flags: "${state.kernelBoot.flags}"`
      : "";
    console.log(
      `     kernelBoot 正则: /${state.kernelBoot.source}/${kernelFlagsDesc}`
    );

    console.log(
      `     verifyKeys: [${state.verifyKeys.map((k) => `"${k}"`).join(", ")}]`
    );
    console.log(`     verifyTimeoutMs: ${state.verifyTimeoutMs}ms`);
  }

  // 5. 跑标准样本
  console.log(`\n   标准样本测试：`);
  let passed = 0;
  let failed = 0;
  for (const sample of STANDARD_SAMPLES) {
    const actual = classify(detector, sample.input);
    const ok = actual === sample.expect;
    const mark = ok ? "✅" : "❌";
    if (ok) passed++;
    else failed++;
    const inputPreview = preview(sample.input);
    console.log(
      `   ${mark} [${sample.category.padEnd(8)}] ` +
        `期望=${sample.expect.padEnd(16)} 实际=${actual.padEnd(16)} ` +
        `输入=${JSON.stringify(inputPreview)}`
    );
  }
  console.log(`\n   标准样本：${passed} passed, ${failed} failed`);

  // 6. 跑用户自定义样本
  if (opts.sample && opts.sample.length > 0) {
    console.log(`\n   用户自定义样本（只展示识别结果，不判期望）：`);
    for (const s of opts.sample) {
      const result = classify(detector, s);
      console.log(
        `   ➡️  [user    ] 识别为=${result.padEnd(16)} 输入=${JSON.stringify(
          preview(s)
        )}`
      );
    }
  }

  // 7. 汇总
  console.log(`\n   ${"─".repeat(40)}`);
  if (failed === 0) {
    console.log(`   ✅ 所有标准样本通过（${passed}/${passed}）`);
  } else {
    console.log(`   ❌ ${failed} 个标准样本未通过（共 ${passed + failed} 个）`);
    process.exitCode = 1;
  }
  console.log(`   ${"─".repeat(40)}\n`);
}

// ============================================================
// 私有辅助函数
// ============================================================

/**
 * @brief 设备配置未找到错误
 *
 * 用自定义错误类区分"文件不存在"与其他加载错误，
 * 以便在 catch 分支决定是否列出可用设备。
 */
class DeviceNotFoundError extends Error {
  constructor(deviceName: string, devicesDir: string) {
    super(`找不到设备配置文件 ${devicesDir}/${deviceName}.yaml`);
    this.name = "DeviceNotFoundError";
  }
}

/**
 * @brief 加载设备配置的 serial.uboot 子段
 * @param deviceName 设备名（不含 .yaml 扩展名）
 * @param devicesDir 设备配置目录绝对路径
 * @returns uboot 子段（未配置时返回空对象）+ 源文件路径
 * @throws {DeviceNotFoundError} 设备文件不存在时抛出
 * @throws {Error} YAML 解析失败时抛出
 */
function loadDeviceConfig(
  deviceName: string,
  devicesDir: string
): { uboot: UbootYaml; sourcePath: string } {
  const deviceFile = resolve(devicesDir, `${deviceName}.yaml`);
  if (!existsSync(deviceFile)) {
    throw new DeviceNotFoundError(deviceName, devicesDir);
  }
  const raw = readFileSync(deviceFile, "utf8");
  const doc = load(raw) as { serial?: { uboot?: UbootYaml } } | null;
  const uboot = doc?.serial?.uboot ?? {};
  return { uboot, sourcePath: deviceFile };
}

/**
 * @brief 列出设备目录下所有可用设备名
 * @param devicesDir 设备配置目录
 * @returns 设备名数组（去 .yaml 扩展名）；目录不存在时返回空数组
 */
function listDevices(devicesDir: string): string[] {
  if (!existsSync(devicesDir)) return [];
  return readdirSync(devicesDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.(ya?ml)$/, ""));
}

/**
 * @brief 用 detector 对样本分类
 *
 * 按优先级判定：先 autoboot（影响中断键），再 kernel（即判失败），
 * 再 prompt（主层），最后 verify（事后验证）。
 *
 * 注意：本命令是"能力自测"，展示每类特征能否被识别，不模拟
 * serial_enter_uboot 的完整时序（实际时序受 autoboot 阶段/主层/验证层
 * 的状态机控制，见 prompt-detector.ts 的 UbootDetector）。
 *
 * @param detector 已构造的 UbootDetector 实例
 * @param input 待分类的样本字符串
 * @returns 识别分类
 */
function classify(detector: UbootDetector, input: string): SampleCategory {
  if (detector.matchAutoboot(input) === "\n") return "autoboot-anykey";
  if (detector.matchAutoboot(input) === "\x15") return "autoboot-ctrlu";
  if (detector.matchKernelBoot(input)) return "kernel";
  if (detector.matchPrompt(input)) return "prompt";
  if (detector.matchVerifyKey(input)) return "verify";
  return "none";
}

/**
 * @brief 截断过长样本用于单行展示
 * @param input 原始字符串
 * @param max 最大长度（默认 60）
 * @returns 截断后的字符串（超长时尾部加 "..."）
 */
function preview(input: string, max = 60): string {
  return input.length > max ? input.slice(0, max - 3) + "..." : input;
}

/**
 * @brief 把路径缩短为相对 cwd 的形式，便于日志展示
 * @param absPath 绝对路径
 * @returns 相对路径（若不在 cwd 子树内则返回原绝对路径）
 */
function shortPath(absPath: string): string {
  const cwd = process.cwd();
  if (absPath.startsWith(cwd)) {
    return "." + absPath.slice(cwd.length).replace(/\\/g, "/");
  }
  return absPath;
}

/**
 * @brief 把命令选项重新拼成命令字符串用于日志
 *
 * 不用 process.argv.join(" ")，避免暴露 node 内部路径。
 * 参考 split.ts/init.ts 的同名函数风格。
 *
 * @param name 命令名
 * @param opts 选项对象
 */
function logCommand(name: string, opts: RegexVerifyOptions): void {
  const parts: string[] = [`embedded-mcp-toolkit ${name} ${opts.device}`];
  if (opts.sample && opts.sample.length > 0) {
    for (const s of opts.sample) {
      parts.push(`--sample "${s}"`);
    }
  }
  if (opts.verbose) parts.push("--verbose");
  console.log(`$ ${parts.join(" ")}`);
}
