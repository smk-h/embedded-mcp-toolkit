/**
 * =====================================================
 * U-Boot 进度条（连续 #）误判修复的回归验证脚本
 *
 *   事故背景（2026-08-27 真实日志）：
 *     serial_exec 在 U-Boot 会话执行 alg 升级命令，TFTP 下载阶段用连续
 *     # 刷进度条（Loading: ####...），通用提示符正则的"行尾 #"分支把
 *     进度帧误判为 Linux root 提示符，2级快路径 406ms 提前返回（真实
 *     执行约 42s），随后自校正凭"尾部不像 U-Boot 提示符"误清会话标记。
 *
 *   修复方案（本脚本验证对象）：
 *     1. PromptDetector.DEFAULT_PATTERN 行尾 # 分支加否定后顾 (?<!#)，
 *        连续 # 进度帧不再命中（通用层，与状态无关）
 *     2. U-Boot 会话的 2级快路径改用 createUbootPromptDetector 构造的
 *        受限检测器，只认 U-Boot 提示符集（结构层，marker 确定性优先）
 *     3. 自校正确认离开 U-Boot 只认内核启动特征（正向证据），删除
 *        「提示符排除法」负向判定（本条在 handler 层，本脚本不直接
 *        覆盖；1/2 层已保证 # 帧进不了 completedBy=prompt 路径）
 *
 *   验证方式：MockDevice 按时间轴回放真实日志帧序列（含 # 进度刷屏与
 *   延迟到达的 DONE marker），驱动真实 runExec 全流程：
 *     - 场景 A：修复后 U-Boot 会话必须等 marker 完成（不被进度条截胡）
 *     - 场景 B：旧正则对照组复现事故（证明 Mock 场景有效，修复回退会红）
 *     - 场景 C：U-Boot 普通命令与 marker 丢失时的快路径兜底不受影响
 *     - 场景 D：通用检测器（Linux 会话）下 # 刷屏同样等 marker
 *     - 场景 E/F：检测器单元级用例
 *
 *   用法：
 *     先 npm run build 编译 out/ 产物，再运行：
 *     node test/scripts/serial/uboot-hash-progress-test.mjs
 * ======================================================
 */

import assert from "node:assert/strict";

const { PromptDetector, UbootDetector, createUbootPromptDetector } =
  await import("../../../out/sdk/exec/prompt-detector.js");
const { runExec } = await import("../../../out/sdk/exec/exec-runner.js");

let passed = 0;
let failed = 0;

/**
 * 运行一条用例（支持异步）：通过则 passed+1，失败则 failed+1 并打印错误
 * @param {string} name 用例名
 * @param {Function} fn 用例断言逻辑（可 async，内部使用 node:assert）
 */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

/**
 * @brief 模拟串口设备：按时间轴回放输出帧
 *
 * runExec 写入命令后，设备从 write 时刻起按 atMs 调度吐帧；
 * 帧文本中 ${MARKER} 占位符在吐出时替换为 write 捕获到的真实 marker
 * （模拟设备原样执行 `echo "MARKER:$?"` 的行为）。
 */
class MockDevice {
  constructor(frameSpecs) {
    this.frameSpecs = frameSpecs;
    this.written = [];
    this.marker = null;
    this.startTime = null;
    this.cursor = 0;
  }

  write(data) {
    this.written.push(data);
    const m = data.match(/echo "(___MCP_EXEC_DONE_[a-z0-9]+___):\$\?"/);
    if (m) this.marker = m[1];
    if (this.startTime === null) this.startTime = Date.now();
  }

  read() {
    return this.drain();
  }

  drain() {
    if (this.startTime === null) return "";
    const now = Date.now() - this.startTime;
    let out = "";
    while (
      this.cursor < this.frameSpecs.length &&
      this.frameSpecs[this.cursor].atMs <= now
    ) {
      out += this.frameSpecs[this.cursor].text.replaceAll(
        "${MARKER}",
        this.marker ?? ""
      );
      this.cursor++;
    }
    return out;
  }

  async open() {
    return "";
  }

  async close() {}
}

/** @brief 事故日志的压缩时间轴回放（原 42s 压缩到 ~400ms） */
function algUpgradeFrames() {
  return [
    // 回显行（PTY echo，runExec 剥离首行）
    { atMs: 10, text: 'U-Boot> alg; echo "${MARKER}:$?"\r\n' },
    {
      atMs: 30,
      text:
        "upgrade subsys alg\r\n" +
        "ethernet@0x30900000: PHY(phyaddr=7, ethernet@0x30900000) link UP: DUPLEX=FULL : SPEED=1000M\r\n" +
        "Using ethernet@0x30900000 device\r\n" +
        "TFTP from server 10.29.78.7; our IP address is 10.29.78.8\r\n" +
        "Filename 'ss_alg.img'.\r\n" +
        "Load address: 0x141000000\r\n",
    },
    { atMs: 60, text: "Loading: " },
    // ↓ 事故点：旧正则在此帧把行尾连续 # 误判为 root 提示符
    { atMs: 90, text: "##########" },
    { atMs: 120, text: "##########" },
    {
      atMs: 160,
      text:
        "##############################  192 MiB\r\n" +
        "\t 23.3 MiB/s\r\n" +
        "done\r\n" +
        "Bytes transferred = 201326592 (c000000 hex)\r\n" +
        "subsys upgrading...\r\n",
    },
    {
      atMs: 220,
      text:
        "port1:phy link never came up\r\n" +
        "port1:no link\r\n" +
        "port3:link up\r\n" +
        "USB0:   Register 200017f NbrPorts 2\r\n" +
        "Starting the controller\r\n" +
        "USB XHCI 1.10\r\n" +
        "scanning bus 0 for devices... 1 USB Device(s) found\r\n" +
        "connect dev 01 succ\r\n" +
        "connect dev 00 fail\r\n" +
        "start upgrade dev 01\r\n",
    },
    { atMs: 350, text: "upgrade dev 01 success\r\n" },
    // 真实日志中 42s 后才出现的 DONE marker（exitCode=0）
    { atMs: 400, text: "${MARKER}:0\r\nU-Boot> " },
  ];
}

/** @brief 修复前的旧默认正则（事故版本），用于对照组复现 */
const OLD_DEFAULT_PATTERN =
  "(?:[^\\r\\n]*[:/]?\\s*[/~]\\s*[#$]\\s*|[^\\r\\n]*[#>$]\\s*|[^\\r\\n]*=>\\s*)$";

/** @brief runExec 公共参数（小 pollInterval 压缩测试时长） */
function execInput(device, promptDetector) {
  return {
    shell: device,
    command: "alg",
    delay: 50,
    clear: 1,
    maxDuration: 2000,
    pollInterval: 10,
    promptDetector,
    sendCtrl: () => {},
    logPrefix: "[test]",
    markerStyle: "plain",
  };
}

console.log("\n[A] 修复后：U-Boot 会话执行 alg（受限检测器）—— 必须等 marker，不被 # 进度条截胡");
await check("completedBy=marker（确定性路径，非 prompt 快路径）", async () => {
  const result = await runExec(
    execInput(new MockDevice(algUpgradeFrames()), createUbootPromptDetector())
  );
  assert.strictEqual(result.completedBy, "marker");
});
await check("exitCode=0（真实退出码随 marker 到达）", async () => {
  const result = await runExec(
    execInput(new MockDevice(algUpgradeFrames()), createUbootPromptDetector())
  );
  assert.strictEqual(result.exitCode, 0);
});
await check("等待跨过 # 刷屏帧（elapsedMs >= 300，远晚于事故点 ~90ms）", async () => {
  const result = await runExec(
    execInput(new MockDevice(algUpgradeFrames()), createUbootPromptDetector())
  );
  assert.ok(
    result.elapsedMs >= 300,
    `elapsedMs=${result.elapsedMs}，疑似在进度条处提前返回`
  );
});
await check("输出完整（含 upgrade success），不含 marker 本体", async () => {
  const result = await runExec(
    execInput(new MockDevice(algUpgradeFrames()), createUbootPromptDetector())
  );
  assert.ok(result.output.includes("upgrade dev 01 success"));
  assert.ok(!result.output.includes("___MCP_EXEC_DONE_"));
  assert.strictEqual(result.timedOut, false);
});

console.log("\n[B] 对照组：旧正则 + 相同帧序列 —— 复现事故（证明 Mock 场景有效）");
await check("旧正则在 # 进度帧处 completedBy=prompt 提前返回", async () => {
  const result = await runExec(
    execInput(
      new MockDevice(algUpgradeFrames()),
      new PromptDetector(OLD_DEFAULT_PATTERN)
    )
  );
  assert.strictEqual(result.completedBy, "prompt");
  assert.strictEqual(result.exitCode, null, "提前返回拿不到退出码");
});
await check("旧正则返回时升级尚未完成（输出不含 success，elapsedMs < 300）", async () => {
  const result = await runExec(
    execInput(
      new MockDevice(algUpgradeFrames()),
      new PromptDetector(OLD_DEFAULT_PATTERN)
    )
  );
  assert.ok(!result.output.includes("upgrade dev 01 success"));
  assert.ok(
    result.elapsedMs < 300,
    `elapsedMs=${result.elapsedMs}，对照组未复现提前返回`
  );
});

console.log("\n[C] U-Boot 会话常规路径回归（受限检测器不破坏正常行为）");
await check("普通命令 marker 照常命中（printenv）", async () => {
  const device = new MockDevice([
    { atMs: 10, text: 'U-Boot> printenv; echo "${MARKER}:$?"\r\n' },
    { atMs: 40, text: "baudrate=115200\r\nbootdelay=3\r\n${MARKER}:0\r\nU-Boot> " },
  ]);
  const result = await runExec(
    execInput(device, createUbootPromptDetector())
  );
  assert.strictEqual(result.completedBy, "marker");
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("baudrate=115200"));
});
await check("marker 丢失时 2级快路径仍锚定 U-Boot 提示符兜底（不等满超时）", async () => {
  // 模拟 hush 拒绝整行（subshell 括号语法），无 marker，只有错误与提示符
  const device = new MockDevice([
    { atMs: 10, text: "U-Boot> (\r\n" },
    { atMs: 40, text: "Unknown command '(' - try 'help'\r\nU-Boot> " },
  ]);
  const result = await runExec(
    execInput(device, createUbootPromptDetector())
  );
  assert.strictEqual(result.completedBy, "prompt");
  assert.ok(
    result.elapsedMs < 500,
    `elapsedMs=${result.elapsedMs}，快路径兜底失效`
  );
});

console.log("\n[D] 通用检测器（Linux 会话）下 # 刷屏同样等 marker（修复1通用层）");
await check("new PromptDetector() + 相同帧序列 → completedBy=marker", async () => {
  const result = await runExec(
    execInput(new MockDevice(algUpgradeFrames()), new PromptDetector())
  );
  assert.strictEqual(result.completedBy, "marker");
  assert.strictEqual(result.exitCode, 0);
});
await check("Linux root 提示符快路径不受影响（无 marker 时秒回）", async () => {
  const device = new MockDevice([
    { atMs: 10, text: "root@board:~# whoami\r\n" },
    { atMs: 40, text: "root\r\nroot@board:~# " },
  ]);
  const result = await runExec(execInput(device, new PromptDetector()));
  assert.strictEqual(result.completedBy, "prompt");
  assert.ok(result.elapsedMs < 500);
});

console.log("\n[E] PromptDetector.DEFAULT_PATTERN 单元用例（修复1）");
const pd = new PromptDetector();
await check("连续 # 进度帧不命中（Loading: ##########）", () => {
  assert.ok(!pd.detect("TFTP from server 10.29.78.7\r\nLoading: ##########"));
});
await check("两个 # 也不命中（Loading: ##）", () => {
  assert.ok(!pd.detect("Loading: ##"));
});
await check("# 刷屏带尾部空格不命中", () => {
  assert.ok(!pd.detect("Loading: ##########   "));
});
await check("root 提示符照常命中（root@board:~# ）", () => {
  assert.ok(pd.detect("root@board:~# "));
});
await check("裸 # 提示符照常命中（/ #）", () => {
  assert.ok(pd.detect("/ #"));
});
await check("$ 提示符照常命中（user@board:~$ ）", () => {
  assert.ok(pd.detect("user@board:~$ "));
});
await check("U-Boot 提示符照常命中（=> / U-Boot>）", () => {
  assert.ok(pd.detect("=>"));
  assert.ok(pd.detect("U-Boot> "));
});
await check("已知边界：恰好一个 # 的瞬时进度帧仍命中（窗口极短，由 marker 兜底）", () => {
  // 如实记录残留边界，不作为缺陷：Loading: # 的 # 前是空格
  assert.ok(pd.detect("Loading: #"));
});
await check("对照：旧正则把连续 # 进度帧误判为提示符（事故根因）", () => {
  const oldPd = new PromptDetector(OLD_DEFAULT_PATTERN);
  assert.ok(oldPd.detect("Loading: ##########"));
});

console.log("\n[F] createUbootPromptDetector 单元用例（修复2）");
const ubootPd = createUbootPromptDetector();
await check("只认 U-Boot 提示符（=> / U-Boot> / => 带尾空格）", () => {
  assert.ok(ubootPd.detect("=>"));
  assert.ok(ubootPd.detect("\r\nU-Boot> "));
  assert.ok(ubootPd.detect("=>  "));
});
await check("不认 Linux root 提示符（root@board:~# ）", () => {
  assert.ok(!ubootPd.detect("root@board:~# "));
});
await check("不认 # 进度帧（Loading: ##########）", () => {
  assert.ok(!ubootPd.detect("Loading: ##########"));
});
await check("用户自定义 prompt 合并生效（Marvell>>）", () => {
  const custom = createUbootPromptDetector({ prompt: "Marvell>>\\s*$" });
  assert.ok(custom.detect("\r\nMarvell>>"));
  assert.ok(custom.detect("=>"), "默认 => 仍应保留（合并语义）");
});
await check("UbootDetector.getPromptSource 与受限检测器行为一致", () => {
  const source = new UbootDetector().getPromptSource();
  const manual = new PromptDetector(source);
  assert.ok(manual.detect("U-Boot> "));
  assert.ok(!manual.detect("Loading: ##########"));
});

console.log(`\n========================================`);
console.log(`  ${passed} checks passed`);
if (failed === 0) {
  console.log("  All uboot-hash-progress tests passed.");
} else {
  console.log(`  ${failed} CHECK(S) FAILED`);
  process.exitCode = 1;
}
console.log(`========================================\n`);
