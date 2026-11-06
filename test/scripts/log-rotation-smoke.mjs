/**
 * @brief 日志分段（滚动）模块离线验证（无需真实设备）
 *
 * 验证 LOG_MAX_SIZE_MB 驱动的按大小分段能力：
 *   1. resolveMaxLogBytes：未配置/空串/非法回落默认；0/none/off 关闭；小数 MB 换算
 *   2. segmentLogPath：首段原样；_001/_012/_1000 补零；无扩展名同样可用
 *   3. FileLogger（会话日志）：跨分段写入不丢行、不拆行，文件名符合
 *      base.log → base_001.log → base_002.log，各段不超上限
 *   4. Logger（业务日志）：同上规则；logger.filePath 跟随滚动到当前分段
 *
 * 运行：node test/scripts/log-rotation-smoke.mjs（先 npm run build）
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, basename, dirname } from "path";

// 环境变量必须在首次日志写入前设定（logger 懒初始化，模块导入不触发）
const scratch = mkdtempSync(join(tmpdir(), "log-rotation-smoke-"));
const sessionDir = join(scratch, "session");
const bizDir = join(scratch, "biz");
process.env.LOG_SAVE = "1";
process.env.LOG_DIR = bizDir;
// 0.002MB ≈ 2097 字节，几百行即触发多次滚动
process.env.LOG_MAX_SIZE_MB = "0.002";

const { resolveMaxLogBytes, segmentLogPath, listLogSegments } = await import(
  "../../out/sdk/shared/log-rotation.js"
);
const { FileLogger } = await import("../../out/sdk/shared/file-logger.js");
const { logger } = await import("../../out/sdk/shared/logger.js");
const { registry } = await import("../../out/sdk/sessions/registry.js");
const { sessionInfoHandler } = await import(
  "../../out/sdk/tools/basic/session-info.js"
);

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

/** 递归读取目录下全部 .log 文件（业务日志按天分目录，需下钻日期子目录） */
function listLogs(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listLogs(full));
    } else if (entry.name.endsWith(".log")) {
      files.push({ name: entry.name, path: full, size: readFileSync(full).length });
    }
  }
  // 按路径码点排序：同一目录下等价于文件名字典序，首段（.log）排在 _001 之前
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 收集所有分段文件的行（去 BOM，跳过续接头部） */
function collectLines(files) {
  const lines = [];
  for (const file of files) {
    const raw = readFileSync(file.path, "utf8").replace(/^\uFEFF/, "");
    for (const line of raw.split("\n")) {
      if (line.startsWith("=~=~=")) continue;
      if (line.trim() === "") continue;
      lines.push(line);
    }
  }
  return lines;
}

async function main() {
  // ── 1. resolveMaxLogBytes ──
  process.env.LOG_MAX_SIZE_MB = "0.002";
  assert(
    resolveMaxLogBytes() === 2097,
    "LOG_MAX_SIZE_MB=0.002 → 2097 字节",
    `got ${resolveMaxLogBytes()}`
  );
  for (const off of ["0", "none", "off", "OFF"]) {
    process.env.LOG_MAX_SIZE_MB = off;
    assert(resolveMaxLogBytes() === 0, `LOG_MAX_SIZE_MB=${off} → 不限`, `got ${resolveMaxLogBytes()}`);
  }
  for (const bad of ["", "abc", "-5"]) {
    process.env.LOG_MAX_SIZE_MB = bad;
    assert(
      resolveMaxLogBytes() === 10 * 1024 * 1024,
      `LOG_MAX_SIZE_MB="${bad}" → 默认 10MB`,
      `got ${resolveMaxLogBytes()}`
    );
  }
  delete process.env.LOG_MAX_SIZE_MB;
  assert(
    resolveMaxLogBytes() === 10 * 1024 * 1024,
    "未配置 LOG_MAX_SIZE_MB → 默认 10MB",
    `got ${resolveMaxLogBytes()}`
  );

  // ── 2. segmentLogPath ──
  const base = "/tmp/log/2026-10-30_155702.log";
  assert(segmentLogPath(base, 0) === base, "part=0 保持原文件名");
  assert(
    basename(segmentLogPath(base, 1)) === "2026-10-30_155702_001.log",
    "part=1 → _001 后缀",
    basename(segmentLogPath(base, 1))
  );
  assert(
    basename(segmentLogPath(base, 12)) === "2026-10-30_155702_012.log",
    "part=12 → _012 补零",
    basename(segmentLogPath(base, 12))
  );
  assert(
    basename(segmentLogPath(base, 1000)) === "2026-10-30_155702_1000.log",
    "part=1000 → _1000 自然加宽",
    basename(segmentLogPath(base, 1000))
  );
  assert(
    basename(segmentLogPath("/tmp/noext", 3)) === "noext_003",
    "无扩展名路径同样追加后缀",
    basename(segmentLogPath("/tmp/noext", 3))
  );

  // ── 3. FileLogger（会话日志）分段 ──
  process.env.LOG_MAX_SIZE_MB = "0.002";
  const maxBytes = resolveMaxLogBytes();
  const sessionBase = join(sessionDir, "2026-10-30_155702.log");
  const fl = new FileLogger();
  fl.enable(sessionBase);
  assert(fl.currentPath === sessionBase, "enable 后 currentPath = 首段路径", fl.currentPath);

  const TOTAL = 200;
  const payload =
    Array.from({ length: TOTAL }, (_, i) => `${String(i).padStart(3, "0")}-${"A".repeat(80)}`)
      .join("\n") + "\n";
  // 按 137 字节切块喂入，模拟串口/SSH 的任意 chunk 边界（跨行、断行）
  for (let i = 0; i < payload.length; i += 137) {
    fl.write(payload.slice(i, i + 137));
  }
  fl.disable();
  // 写流 end() 是异步的：等文件真正 flush 落盘再校验
  await new Promise((r) => setTimeout(r, 200));

  const sessionFiles = listLogs(sessionDir);
  assert(sessionFiles.length > 1, "会话日志已滚动出多个分段", `files=${sessionFiles.length}`);
  assert(
    sessionFiles[0].name === "2026-10-30_155702.log",
    "首段沿用原始文件名",
    sessionFiles[0]?.name
  );
  assert(
    sessionFiles[1]?.name === "2026-10-30_155702_001.log",
    "第二段为 _001",
    sessionFiles[1]?.name
  );
  assert(
    sessionFiles.every((f, i) => f.name === segmentLogPath(sessionBase, i).split("/").pop()),
    "分段命名序列连续（_001/_002/…）",
    sessionFiles.map((f) => f.name).join(", ")
  );
  // 每段（除末段）写满到接近上限；单行不拆分，允许超出最后一行的余量
  const overshoot = sessionFiles.some((f) => f.size > maxBytes + 200);
  assert(!overshoot, "各分段大小不超过上限 + 单行余量", sessionFiles.map((f) => f.size).join(", "));

  const sessionLines = collectLines(sessionFiles);
  const seen = new Set();
  let malformed = 0;
  for (const line of sessionLines) {
    const m = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (\d{3})-A{80}$/.exec(line);
    if (!m) {
      malformed++;
      continue;
    }
    seen.add(m[1]);
  }
  assert(malformed === 0, "跨段/跨 chunk 后每行仍完整（无拆行）", `malformed=${malformed}`);
  assert(seen.size === TOTAL, `全部 ${TOTAL} 行均落盘且不重复`, `got ${seen.size}`);

  // ── 4. Logger（业务日志）分段 ──
  // 屏蔽 stderr 输出，避免测试刷屏
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const BIZ_TOTAL = 200;
  for (let i = 0; i < BIZ_TOTAL; i++) {
    logger.info(`biz-${String(i).padStart(3, "0")}-${"B".repeat(80)}`);
  }
  const bizActive = logger.filePath;
  process.stderr.write = origStderrWrite;

  const bizFiles = listLogs(bizDir);
  assert(bizFiles.length > 1, "业务日志已滚动出多个分段", `files=${bizFiles.length}`);
  // 目录规则：{LOG_DIR}/{YYYY-MM-DD}/{YYYY-MM-DD_HHMMSS[_NNN]}.log
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(basename(dirname(bizFiles[0].path))),
    "业务日志落在 YYYY-MM-DD 日期子目录",
    dirname(bizFiles[0].path)
  );
  assert(
    bizFiles.every((f) => basename(dirname(f.path)) === basename(dirname(bizFiles[0].path))),
    "同一次运行的业务日志分段同处一个日期目录",
    bizFiles.map((f) => dirname(f.path)).join(", ")
  );
  assert(
    bizFiles.every((f) => f.size <= maxBytes + 200),
    "业务日志各分段大小不超过上限 + 单行余量",
    bizFiles.map((f) => f.size).join(", ")
  );
  assert(
    !bizActive || basename(bizActive) === bizFiles[bizFiles.length - 1].name,
    "logger.filePath 指向当前（最新）分段",
    `${bizActive} vs ${bizFiles[bizFiles.length - 1].name}`
  );

  const bizLines = collectLines(bizFiles);
  const bizSeen = new Set();
  let bizMalformed = 0;
  for (const line of bizLines) {
    const m = /\[INFO\] biz-(\d{3})-B{80}$/.exec(line);
    if (!m) {
      if (line.includes("biz-")) bizMalformed++;
      continue;
    }
    bizSeen.add(m[1]);
  }
  assert(bizMalformed === 0, "业务日志跨段每行仍完整（无拆行）", `malformed=${bizMalformed}`);
  assert(
    bizSeen.size === BIZ_TOTAL,
    `业务日志全部 ${BIZ_TOTAL} 条均落盘且不重复`,
    `got ${bizSeen.size}`
  );

  // ── 5. listLogSegments / session_info 分段提示 ──
  const segInfo = listLogSegments(sessionBase);
  assert(
    segInfo.count === sessionFiles.length,
    "listLogSegments 段数与磁盘一致",
    `${segInfo.count} vs ${sessionFiles.length}`
  );
  assert(
    segInfo.paths[0] === sessionFiles[0].path,
    "listLogSegments 首项为最旧的首段",
    segInfo.paths[0]
  );
  assert(
    segInfo.latest === sessionFiles[sessionFiles.length - 1].path,
    "listLogSegments latest 指向序号最大的最新段",
    segInfo.latest
  );
  assert(
    listLogSegments(join(sessionDir, "missing_2026-01-01_000000.log")).count === 0,
    "listLogSegments 无匹配文件时返回空（不抛异常）"
  );

  // session_info 输出：既要给首段路径，也要给最新段与段数
  const origStderrWrite2 = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  registry.register({
    id: "smoke_1",
    type: "serial",
    deviceName: "board-smoke",
    connectionInfo: "COM1@115200",
    createdAt: new Date().toISOString(),
    logPath: sessionBase,
  });
  const infoText = sessionInfoHandler({ session_id: "smoke_1" });
  registry.register({
    id: "smoke_2",
    type: "serial",
    deviceName: "board-smoke",
    connectionInfo: "COM2@115200",
    createdAt: new Date().toISOString(),
  });
  const disabledText = sessionInfoHandler({ session_id: "smoke_2" });
  process.stderr.write = origStderrWrite2;

  assert(
    infoText.includes("Log latest:") && infoText.includes(segInfo.latest),
    "session_info 的 Log latest 指向最新分段",
    infoText
  );
  assert(
    infoText.includes(`Log segments: ${sessionFiles.length} on disk`),
    "session_info 的 Log segments 给出段数与新旧说明",
    infoText
  );
  assert(
    disabledText.includes("(file logging disabled)") &&
      !disabledText.includes("Log latest:"),
    "未启用日志的会话不输出分段行",
    disabledText
  );

  // ── 6. 会话日志目录/文件名规则（enableFromEnv） ──
  const rawRoot = join(scratch, "raw");
  process.env.SAVE2FILE_PATH = rawRoot;
  const origStderrWrite3 = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const flWithDevice = new FileLogger();
  const envLogPath = flWithDevice.enableFromEnv("serial_1", "board-smoke");
  flWithDevice.disable();
  const flNoDevice = new FileLogger();
  const envLogPathNoDevice = flNoDevice.enableFromEnv("ssh_2");
  flNoDevice.disable();
  process.stderr.write = origStderrWrite3;
  delete process.env.SAVE2FILE_PATH;

  const toRel = (p) => (p ? p.slice(rawRoot.length + 1).replace(/\\/g, "/") : "");
  const withDevice = toRel(envLogPath);
  const noDevice = toRel(envLogPathNoDevice);
  assert(
    /^board-smoke\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}_\d{9}-serial_1\.log$/.test(withDevice),
    "会话日志 = {device}/{YYYY-MM-DD}/{YYYY-MM-DD_HHMMSSsss}-{session}.log",
    withDevice
  );
  // 目录日期与文件名日期必须同源（跨零点建会话时不允许错位到两天）
  const [, dirDay, fileDay] = withDevice.match(
    /^board-smoke\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})_\d{9}-serial_1\.log$/
  ) ?? [];
  assert(dirDay !== undefined && dirDay === fileDay, "目录日期 = 文件名日期", withDevice);
  assert(
    /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}_\d{9}-ssh_2\.log$/.test(noDevice),
    "缺设备名时降级为 {YYYY-MM-DD}/{YYYY-MM-DD_HHMMSSsss}-{session}.log",
    noDevice
  );

  // ── 7. host_info 数据源：业务日志首段 / 当前段 / 分段扫描 ──
  const { resolveLogPaths } = await import("../../out/sdk/host/log-paths.js");
  const lp = resolveLogPaths();
  assert(lp.business.enabled, "LOG_SAVE 启用时 business.enabled 为 true");
  assert(
    lp.business.base !== null && basename(lp.business.base) === bizFiles[0].name,
    "business.base 指向首段（无 _NNN 后缀）",
    String(lp.business.base)
  );
  assert(
    lp.business.file !== null && lp.business.file === logger.filePath,
    "business.file 指向 logger 当前写入段",
    `${lp.business.file} vs ${logger.filePath}`
  );
  assert(
    lp.business.base !== null &&
      listLogSegments(lp.business.base).latest === lp.business.file,
    "按 business.base 扫描到的最新段 = 当前写入段",
    `${lp.business.base ? listLogSegments(lp.business.base).latest : null} vs ${lp.business.file}`
  );

  console.log(`\n${passCount} passed, ${failCount} failed`);
  return failCount === 0;
}

let ok = false;
try {
  ok = await main();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
