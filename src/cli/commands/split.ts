/**
 * @file src/cli/commands/split.ts
 * @brief embedded-mcp-toolkit split 命令
 *
 * 将单文件 config.yaml 的 devices 段拆分为 devices/<设备名>.yaml 独立文件，
 * 帮助现有用户从旧的单文件布局迁移到分文件布局。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { load, dump } from "js-yaml";

// ============================================================
// 选项
// ============================================================

/**
 * @brief split 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 */
export interface SplitOptions {
  config: string; // 源 config.yaml 路径
  force: boolean; // 是否覆盖已存在的设备文件
}

// ============================================================
// 主流程
// ============================================================

/**
 * @brief 执行 split 命令
 * @details 读取源 config.yaml 的 devices 段，为每个设备生成独立的
 *          devices/<设备名>.yaml 文件。具备覆盖保护：目标已存在时
 *          默认跳过，--force 时覆盖。
 *
 * @param opts 由 Commander 解析后传入的选项对象
 */
export function runSplit(opts: SplitOptions): void {
  logCommand("split", opts);

  const configPath = resolve(opts.config);
  const devicesDir = resolve(dirname(configPath), "devices");

  console.log(`
✂️  embedded-mcp-toolkit 配置拆分`);
  console.log(`   源配置: ${shortPath(configPath)}`);
  console.log(`   设备目录: ${shortPath(devicesDir)}`);
  console.log(`   覆盖模式: ${opts.force ? "强制覆盖" : "跳过已存在"}\n`);

  // 读取并解析源 config.yaml
  let root: Record<string, unknown>;
  try {
    root = load(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `❌ 无法读取源配置: ${shortPath(configPath)} — ${
        err instanceof Error ? err.message : err
      }`
    );
    return;
  }

  const devices = root.devices as Record<string, unknown> | undefined;
  if (!devices || Object.keys(devices).length === 0) {
    console.log("⚠️  源配置的 devices 段为空或不存在，无可拆分设备");
    return;
  }

  // 确保 devices/ 目录存在
  if (!existsSync(devicesDir)) {
    mkdirSync(devicesDir, { recursive: true });
    console.log(`  ✅ 创建目录: ${shortPath(devicesDir)}/`);
  }

  // 逐设备导出
  let created = 0;
  let overwritten = 0;
  let skipped = 0;
  for (const [deviceName, deviceConfig] of Object.entries(devices)) {
    const destPath = join(devicesDir, `${deviceName}.yaml`);
    const exists = existsSync(destPath);

    if (exists && !opts.force) {
      console.log(`  ⏭  跳过（已存在）: ${deviceName}`);
      skipped++;
      continue;
    }

    // 序列化为 YAML 文本（文件根直接是设备配置，不重复 devices 包裹层）
    const yamlContent = dump(deviceConfig, {
      indent: 2,
      lineWidth: 0, // 不自动换行，保留长字符串单行
    });
    writeFileSync(destPath, yamlContent, "utf8");

    if (exists) {
      console.log(`  🔄 覆盖: ${deviceName}`);
      overwritten++;
    } else {
      console.log(`  ✅ 创建: ${deviceName}`);
      created++;
    }
  }

  console.log(
    `\n✅ 拆分完成：创建 ${created}，覆盖 ${overwritten}，跳过 ${skipped}`
  );
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * @brief 将绝对路径转为相对工作目录的简短形式
 * @details 路径在 cwd 内时显示相对路径（如 ./.embedded/configs/...），
 *          在 cwd 外时回退为绝对路径，便于跨盘符场景查看。
 *
 * @param absPath 绝对路径
 * @returns 简短路径字符串
 */
function shortPath(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  // 相对路径更长或跨越盘符（以 .. 开头）时，保留绝对路径更直观
  const short =
    rel.startsWith("..") || rel.length >= absPath.length ? absPath : `./${rel}`;
  // Windows 下 relative() 返回反斜杠，统一为正斜杠，避免 ./a\b\c 混杂
  return short.replace(/\\/g, "/");
}

/**
 * @brief 打印命令调用信息
 * @details 与 init.ts 的 logCommand 风格一致，便于排查命令行参数解析。
 *
 * @param cmd  子命令名（"split"）
 * @param opts 由 Commander 解析后的选项对象
 */
function logCommand(cmd: string, opts: object): void {
  const parts: string[] = [`embedded-mcp-toolkit ${cmd}`];
  for (const [key, value] of Object.entries(opts)) {
    if (value === false || value === undefined) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    if (value === true) {
      parts.push(flag);
    } else {
      parts.push(`${flag} ${value}`);
    }
  }
  const cmdLine = parts.join(" ");
  console.log(`[${cmd}] 命令: ${cmdLine}`);
  console.log(`[${cmd}] 参数个数: ${process.argv.slice(2).length}`);
  console.log(`[${cmd}] 解析后参数:`, JSON.stringify(opts, null, 2));
}
