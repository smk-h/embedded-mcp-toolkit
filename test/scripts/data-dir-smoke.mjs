/**
 * @brief data-dir 模块离线验证（无需真实设备）
 *
 * 验证传输暂存目录约定（.embedded/tmp）：
 *   1. resolveEmbeddedRoot：默认 cwd/.embedded；EMBEDDED_DATA_DIR 可覆盖（相对/绝对）
 *   2. resolveTransferTmpDir：根目录下拼 tmp 子目录，不触碰文件系统
 *   3. ensureTransferTmpDir：目录不存在时创建（幂等，二次调用不报错）
 *   4. defaultDownloadLocalPath：文件名取远端 basename；目录尾斜杠时用
 *      download-* 兜底名；返回路径必定位于 tmp 目录下
 *   5. EMBEDDED_DATA_DIR 设为空串/纯空白时回落默认（避免误配成 cwd 根）
 *
 * 运行：node test/scripts/data-dir-smoke.mjs（先 npm run build）
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  resolveEmbeddedRoot,
  resolveTransferTmpDir,
  ensureTransferTmpDir,
  defaultDownloadLocalPath,
} from "../../out/sdk/shared/data-dir.js";

let passCount = 0;
let failCount = 0;

function assert(cond, name, detail) {
  if (cond) {
    passCount++;
    console.log(`  ✔ ${name}`);
  } else {
    failCount++;
    console.log(`  ✘ ${name}`);
    if (detail) console.log(`    → ${detail}`);
  }
}

async function main() {
  // ── 1. 默认根 = cwd/.embedded ──
  delete process.env.EMBEDDED_DATA_DIR;
  const defaultRoot = resolveEmbeddedRoot();
  assert(
    defaultRoot === resolve(process.cwd(), ".embedded"),
    "resolveEmbeddedRoot 默认 = cwd/.embedded",
    `got ${defaultRoot}`
  );
  assert(
    resolveTransferTmpDir() === join(defaultRoot, "tmp"),
    "resolveTransferTmpDir = <根>/tmp",
    `got ${resolveTransferTmpDir()}`
  );

  // ── 2. EMBEDDED_DATA_DIR 覆盖（相对 / 绝对 / 空白回落）──
  const scratch = mkdtempSync(join(tmpdir(), "data-dir-smoke-"));
  try {
    process.env.EMBEDDED_DATA_DIR = join(scratch, "custom-root");
    assert(
      resolveEmbeddedRoot() === join(scratch, "custom-root"),
      "EMBEDDED_DATA_DIR 绝对路径覆盖",
      `got ${resolveEmbeddedRoot()}`
    );
    assert(
      resolveTransferTmpDir() === join(scratch, "custom-root", "tmp"),
      "覆盖后 tmp 目录跟随根",
      `got ${resolveTransferTmpDir()}`
    );

    // ensure：目录不存在 → 创建；已存在 → 幂等
    const tmpDir = resolveTransferTmpDir();
    assert(!existsSync(tmpDir), "ensure 前 tmp 目录不存在");
    const ensured = ensureTransferTmpDir();
    assert(ensured === tmpDir && existsSync(tmpDir), "ensure 创建 tmp 目录");
    ensureTransferTmpDir();
    assert(existsSync(tmpDir), "ensure 二次调用幂等");

    // ── 3. 缺省下载路径 ──
    const p1 = defaultDownloadLocalPath("/var/log/dmesg.log");
    assert(
      p1 === join(tmpDir, "dmesg.log"),
      "缺省路径 = tmp/<远端 basename>",
      `got ${p1}`
    );
    const p2 = defaultDownloadLocalPath("/data/backup/");
    assert(
      p2 === join(tmpDir, "backup"),
      "远端路径尾斜杠时 basename 剥离后仍取名字",
      `got ${p2}`
    );
    const p3 = defaultDownloadLocalPath("/");
    const p4 = defaultDownloadLocalPath("");
    assert(
      p3.startsWith(join(tmpDir, "download-")) &&
        p4.startsWith(join(tmpDir, "download-")),
      "空远端路径/纯分隔符时用 download-* 兜底名",
      `got ${p3} / ${p4}`
    );
    assert(
      defaultDownloadLocalPath("firmware.bin") === join(tmpDir, "firmware.bin"),
      "纯文件名远端路径同样落 tmp",
      `got ${defaultDownloadLocalPath("firmware.bin")}`
    );

    // ── 4. 空白环境变量回落默认 ──
    process.env.EMBEDDED_DATA_DIR = "   ";
    assert(
      resolveEmbeddedRoot() === defaultRoot,
      "EMBEDDED_DATA_DIR 纯空白回落默认根",
      `got ${resolveEmbeddedRoot()}`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // ── 汇总 ──
  console.log(
    `\n结果: ${passCount} 通过, ${failCount} 失败 ${failCount === 0 ? "🎉" : "❌"}`
  );
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
