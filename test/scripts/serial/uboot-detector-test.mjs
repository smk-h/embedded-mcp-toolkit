/**
 * =====================================================
 * UbootDetector 离线验证脚本
 *
 *   项目无测试框架（无 vitest/jest），用 node:assert + 动态 import 编译产物
 *   覆盖 spec AC1/AC2/AC3/AC4/AC6/AC9 的可离线部分。
 *
 *   本脚本验证 UbootDetector 在"配置值直接是正则源码字符串 + 与默认值合并"模式下的行为：
 *     - 默认值覆盖主流 autoboot 措辞（prompt 等价原硬编码 /(?:=>|U-Boot>)\s*$/）
 *     - 配置值与默认值合并（非替换），用户条目在前（优先级更高），默认条目在后兜底，
 *       字面重复时保留用户条目、删默认副本（2026-09-03 起）
 *     - 无效正则构造抛错
 *
 *   用法：
 *     先 npm run build 编译 out/ 产物，再运行：
 *     node test/scripts/serial/uboot-detector-test.mjs
 *
 *   输出：按 [1]~[5] 分组打印各用例结果，最后汇总通过/失败数。
 * ======================================================
 */

import assert from "node:assert/strict";

const { UbootDetector } = await import(
  "../../../out/sdk/exec/prompt-detector.js"
);

let passed = 0;
let failed = 0;

/**
 * 运行一条用例：通过则 passed+1，失败则 failed+1 并打印错误信息
 * @param {string} name 用例名
 * @param {Function} fn 用例断言逻辑（内部使用 node:assert）
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("\n[1] UbootDetector 默认值（未传 config，AC1）");
const d = new UbootDetector();
check("默认 autoboot：Hit any key 返回换行（原硬编码等价）", () => {
  assert.strictEqual(d.matchAutoboot("Hit any key to stop autoboot: 1"), "\n");
});
check("默认 autoboot：多空格容忍（\\s+ 生效）", () => {
  assert.strictEqual(d.matchAutoboot("Hit  any   key  to stop autoboot"), "\n");
});
check("默认 autoboot：大小写不敏感（i 标志生效）", () => {
  assert.strictEqual(d.matchAutoboot("HIT ANY KEY TO STOP AUTOBOOT"), "\n");
});
check("默认 autoboot：Ctrl+u 优先于 any key（数组顺序）", () => {
  // Ctrl+u 在默认数组里排第一，优先命中
  assert.strictEqual(d.matchAutoboot("Hit Ctrl+u to stop autoboot"), "\x15");
});
check("默认 autoboot：未命中返回 null", () => {
  assert.strictEqual(d.matchAutoboot("Press SPACE to abort"), null);
});
check("默认 autoboot：Press 句首变体命中（2026-08-31 扩充）", () => {
  assert.strictEqual(d.matchAutoboot("Press any key to stop autoboot: 2"), "\n");
});
check("默认 autoboot：interrupt/abort 动词变体命中", () => {
  assert.strictEqual(d.matchAutoboot("Hit any key to interrupt autoboot"), "\n");
  assert.strictEqual(d.matchAutoboot("Press any key to abort autoboot"), "\n");
});
check("默认 autoboot：裸 key 措辞命中（无按键提示时回退发换行）", () => {
  assert.strictEqual(d.matchAutoboot("Hit key to stop autoboot: 3"), "\n");
});
check("默认 autoboot：Rockchip 括号后缀按键提示改发 \\x03（2026-09-03 选键规则）", () => {
  // Rockchip U-Boot 的按键藏在括号后缀里，正则命中的通用措辞本身不含按键；
  // 选键以命中行文本为准，行内 CTRL+C 字样优先于条目静态映射（换行）
  assert.strictEqual(
    d.matchAutoboot("Hit key to stop autoboot('CTRL+C')"),
    "\x03"
  );
  assert.strictEqual(
    d.matchAutoboot("Hit key to stop autoboot('CTRL+C'):  2  1  0"),
    "\x03",
    "带倒计时数字的完整实测文案"
  );
});
check("默认 autoboot：多行缓冲中命中行文本生效（LubanCat-2 实测现场）", () => {
  // 真实场景是整段累积输出，倒计时数字与提示同行，前后还有其他 U-Boot 日志
  const output =
    "Net:   eth0: ethernet@fe2a0000, eth1: ethernet@fe010000\n" +
    "Hit key to stop autoboot('CTRL+C'):  2  1  0 \n" +
    "Found U-Boot script /boot.scr\n";
  assert.strictEqual(d.matchAutoboot(output), "\x03");
  assert.strictEqual(
    d.matchedAutoboot(output)?.matchedLine,
    "Hit key to stop autoboot('CTRL+C'):  2  1  0",
    "matchedLine 只含命中行（去首尾空白），非全量缓冲"
  );
});
check("默认 autoboot：括号后缀按键提示的优先级 u > c > space", () => {
  assert.strictEqual(d.matchAutoboot("Hit key to stop autoboot(CTRL+U)"), "\x15");
  assert.strictEqual(d.matchAutoboot("Hit key to stop autoboot(CTRL-C)"), "\x03");
  assert.strictEqual(d.matchAutoboot("Hit key to stop autoboot('SPACE')"), " ");
});
check("默认 autoboot：按键提示字样只在命中行内生效（跨行不误判）", () => {
  // 历史日志行提到 ctrl+c 不影响本次选键——选键只看命中所在行
  const output = "debug: send ctrl+c to cancel\nHit any key to stop autoboot: 3";
  assert.strictEqual(d.matchAutoboot(output), "\n");
});
check("默认 autoboot：SPACE 措辞发空格", () => {
  assert.strictEqual(
    d.matchAutoboot("Press SPACE to stop autoboot in 3 seconds"),
    " "
  );
  assert.strictEqual(d.matchAutoboot("Hit SPACE to abort autoboot"), " ");
});
check("默认 autoboot：Ctrl+c 措辞发 \\x03", () => {
  assert.strictEqual(d.matchAutoboot("Press Ctrl+c to interrupt autoboot"), "\x03");
});
check("默认 autoboot：无 autoboot 字样的文案仍不命中", () => {
  assert.strictEqual(d.matchAutoboot("Press SPACE to abort"), null);
  assert.strictEqual(d.matchAutoboot("Hit any key to continue"), null);
});
check("默认 prompt：匹配 => 结尾（AC1 兼容）", () => {
  assert.ok(d.matchPrompt("U-Boot 2016.03\n=>"));
});
check("默认 prompt：匹配 U-Boot> 结尾（AC1 兼容）", () => {
  assert.ok(d.matchPrompt("\nU-Boot>"));
});
check("默认 prompt：=> 后跟空格仍命中（\\s*$ 生效）", () => {
  assert.ok(d.matchPrompt("=>  "));
});
check("默认 prompt：中间出现 => 不误判（$ 锚末尾）", () => {
  assert.ok(!d.matchPrompt("=> something after"));
});
check("默认 verifyEnvKeys：匹配 baudrate=（AC6）", () => {
  assert.ok(d.matchVerifyKey("baudrate=115200\nbootdelay=3"));
});
check("默认 verifyEnvKeys：匹配 bootdelay=", () => {
  assert.ok(d.matchVerifyKey("bootdelay=3"));
});
check("默认 verifyEnvKeys：不含等号不命中", () => {
  assert.ok(!d.matchVerifyKey("baudrate"));
});
check("countVerifyKeys：计数 ≥2 支撑 uboot 结论（detect 探测层判据）", () => {
  assert.strictEqual(
    d.countVerifyKeys("baudrate=115200\nbootdelay=3"),
    2,
    "两个默认键都命中"
  );
  assert.strictEqual(
    d.countVerifyKeys("arch=arm\nbaudrate=115200\nbootdelay=2\nbootcmd=bootm"),
    2,
    "四行输出只命中两个默认键"
  );
  assert.strictEqual(d.countVerifyKeys("bootdelay=3"), 1, "单键不足以定论");
  assert.strictEqual(
    d.countVerifyKeys("PATH=/bin\nHOME=/root"),
    0,
    "Linux 环境变量无键命中"
  );
  assert.strictEqual(d.countVerifyKeys("BAUDRATE=115200"), 1, "大小写不敏感");
});
check("matched* 系列：返回命中的具体判据（业务日志标注结论出处）", () => {
  assert.deepStrictEqual(
    d.matchedVerifyKeys("baudrate=115200\nbootdelay=3"),
    ["baudrate", "bootdelay"],
    "返回命中键名列表"
  );
  assert.deepStrictEqual(d.matchedVerifyKeys("PATH=/bin"), [], "无命中返回空数组");
  assert.strictEqual(
    d.matchedPrompt("U-Boot 2016.03\n=>"),
    "(?:=>|U-Boot>)\\s*$",
    "命中返回实际生效的提示符正则源码"
  );
  assert.strictEqual(d.matchedPrompt("=> something after"), null);
  const ab = d.matchedAutoboot("Hit Ctrl+u to stop autoboot");
  assert.ok(ab !== null, "命中 autoboot 返回条目");
  assert.strictEqual(ab.interruptKey, "\x15", "条目携带中断键");
  assert.ok(/Ctrl\\\+u/.test(ab.source), "条目携带命中的正则源码");
  assert.strictEqual(d.matchedAutoboot("Press SPACE to abort"), null);
  assert.ok(
    /Starting\\s\+kernel/.test(d.matchedKernelBoot("Starting kernel ...")),
    "命中返回内核启动正则源码"
  );
  assert.strictEqual(d.matchedKernelBoot("U-Boot 2016.03"), null);
});
check("matchedAutoboot：Rockchip 场景返回通用规则源码 + 行文本修正的中断键", () => {
  const ab = d.matchedAutoboot("Hit key to stop autoboot('CTRL+C'):  2  1  0");
  assert.ok(ab !== null, "命中 autoboot 条目");
  assert.strictEqual(ab.interruptKey, "\x03", "行内 CTRL+C 字样优先于静态映射");
  assert.ok(
    /any\\s\+key/.test(ab.source),
    "命中的仍是通用 'Hit key' 规则（按键来自行文本而非正则源码）"
  );
  assert.strictEqual(
    ab.matchedLine,
    "Hit key to stop autoboot('CTRL+C'):  2  1  0",
    "携带命中行文本（供业务日志展示'实际检测到的提示行'）"
  );
});
check("matchKernelBoot：Starting kernel（AC8）", () => {
  assert.ok(d.matchKernelBoot("Starting kernel ..."));
});
check("matchKernelBoot：Linux version（AC8）", () => {
  assert.ok(d.matchKernelBoot("Linux version 5.4.0 gcc 9.0"));
});
check("matchKernelBoot：大小写不敏感（i 标志）", () => {
  assert.ok(d.matchKernelBoot("STARTING KERNEL"));
});
check("matchKernelBoot：普通输出不命中", () => {
  assert.ok(!d.matchKernelBoot("U-Boot 2016.03"));
});

console.log("\n[2] UbootDetector 配置合并（AC2/AC3/AC6 — 用户在前、默认兜底，非替换）");
const d2 = new UbootDetector({
  autobootPrompts: ["Press\\s+SPACE\\s+to\\s+abort"],
  prompt: "Marvell>>\\s*$",
  verifyEnvKeys: ["mykey"],
});
check("自定义 autoboot 命中（AC2）", () => {
  // 含 SPACE 字样的条目发空格（2026-08-31 起按提示文案选键，
  // 旧版对其余条目一律发换行）
  assert.strictEqual(d2.matchAutoboot("Press SPACE to abort in 3s"), " ");
});
check("默认 autoboot 仍命中（合并保留默认）", () => {
  // 合并语义：用户配置在前，默认规则在后兜底，Hit any key / Hit Ctrl+u 仍能识别
  assert.strictEqual(d2.matchAutoboot("Hit any key to stop autoboot"), "\n");
  assert.strictEqual(d2.matchAutoboot("Hit Ctrl+u to stop autoboot"), "\x15");
});
check("用户条目排在默认规则之前（2026-09-03 起，数组顺序即匹配优先级）", () => {
  // 用户规则与默认通用规则都能命中文案时，用户规则先被尝试
  const dd = new UbootDetector({
    autobootPrompts: ["Hit\\s+key\\s+to\\s+stop\\s+autoboot.*CTRL\\+C"],
  });
  const ab = dd.matchedAutoboot(
    "Hit key to stop autoboot('CTRL+C'):  2  1  0"
  );
  assert.ok(ab !== null, "命中 autoboot 条目");
  assert.ok(/CTRL\\\+C/.test(ab.source), "命中的是用户规则而非默认通用规则");
  assert.strictEqual(ab.interruptKey, "\x03");
});
check("用户条目与默认字面重复时保留用户条目，删默认副本（保留前面的）", () => {
  const dd = new UbootDetector({
    autobootPrompts: [
      "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot", // 与默认 [0] 字面重复
      "MYBOARD\\s+autoboot",
    ],
  });
  const pats = dd.getDebugState().autobootPatterns.map((p) => p.source);
  assert.strictEqual(
    pats[0],
    "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot",
    "重复条目保留用户的（位置在前）"
  );
  assert.strictEqual(pats[1], "MYBOARD\\s+autoboot", "用户条目整体在最前");
  assert.strictEqual(
    pats.filter((s) => s === "Hit\\s+Ctrl\\+u\\s+to\\s+stop\\s+autoboot")
      .length,
    1,
    "默认数组中的重复副本被删除"
  );
  assert.ok(
    pats.includes(
      "(?:Hit|Press)\\s+(?:any\\s+key|a\\s+key|key)\\s+to\\s+(?:stop|interrupt|abort)\\s+autoboot"
    ),
    "其余默认规则仍保留兜底"
  );
});
check("自定义 prompt 命中（AC3）", () => {
  assert.ok(d2.matchPrompt("\nMarvell>>"));
});
check("默认 prompt => 仍命中（合并保留默认）", () => {
  // 合并语义：用户配 Marvell>> 后，默认的 => 和 U-Boot> 仍能识别
  assert.ok(d2.matchPrompt("\n=>"));
  assert.ok(d2.matchPrompt("\nU-Boot>"));
});
check("自定义 verifyEnvKeys 命中", () => {
  assert.ok(d2.matchVerifyKey("mykey=42"));
});
check("默认键 baudrate 仍命中（合并保留默认）", () => {
  // 合并语义：用户配 mykey 后，默认的 baudrate/bootdelay 仍能识别
  assert.ok(d2.matchVerifyKey("baudrate=115200"));
  assert.ok(d2.matchVerifyKey("bootdelay=3"));
});
check("verifyEnvKeys 去重生效（用户配 baudrate 不重复）", () => {
  // 用户配的键与默认键重复时，合并结果应去重，行为不变
  const dd = new UbootDetector({ verifyEnvKeys: ["baudrate"] });
  assert.ok(dd.matchVerifyKey("baudrate=1"));
});

console.log("\n[3] UbootDetector 边界（AC9）");
check("空 autobootPrompts 数组合并后等同默认值", () => {
  // 合并语义：默认 + [] = 默认
  const dd = new UbootDetector({ autobootPrompts: [] });
  assert.strictEqual(
    dd.matchAutoboot("Hit any key to stop autoboot"),
    "\n",
    "空数组合并后应等同默认值"
  );
});
check("空 verifyEnvKeys 数组合并后等同默认值", () => {
  const dd = new UbootDetector({ verifyEnvKeys: [] });
  assert.ok(dd.matchVerifyKey("baudrate=1"), "空数组合并后应等同默认值");
});
check("无效正则（括号不闭合）构造抛错（AC9）", () => {
  assert.throws(
    () => new UbootDetector({ prompt: "((invalid" }),
    // new RegExp 抛 SyntaxError
    (err) => err instanceof SyntaxError || /invalid|unterminated/i.test(err.message)
  );
});

console.log("\n[4] 正则直接生效（AC4：不做预处理）");
check("配置 3\\.14 匹配字面 3.14 不匹配 3X14（. 被转义）", () => {
  const dd = new UbootDetector({ prompt: "3\\.14" });
  assert.ok(dd.matchPrompt("3.14"), "应匹配字面 3.14");
  assert.ok(!dd.matchPrompt("3X14"), "不应匹配 3X14");
});
check("配置 3.14（未转义 .）匹配 3X14（正则元字符生效）", () => {
  const dd = new UbootDetector({ prompt: "3.14" });
  assert.ok(dd.matchPrompt("3X14"), ". 作为任意字符匹配 X");
  assert.ok(dd.matchPrompt("3.14"), "也能匹配字面 3.14");
});
check("多板子联合正则 (?:=>|Marvell>>|hisilicon#)\\s*$", () => {
  const dd = new UbootDetector({
    prompt: "(?:=>|Marvell>>|hisilicon#)\\s*$",
  });
  assert.ok(dd.matchPrompt("=>"));
  assert.ok(dd.matchPrompt("Marvell>>"));
  assert.ok(dd.matchPrompt("hisilicon#"));
  assert.ok(!dd.matchPrompt("STM32MP>"), "STM32MP> 不在联合范围内");
});

console.log("\n[5] UbootDefaults.prompt 默认兼容性核对（AC1）");
check("默认 prompt 等价原硬编码 /(?:=>|U-Boot>)\\s*$/", () => {
  // 原硬编码正则的几个关键用例
  assert.ok(d.matchPrompt("=>"), "末尾 =>");
  assert.ok(d.matchPrompt("U-Boot>"), "末尾 U-Boot>");
  assert.ok(d.matchPrompt("=>  "), "=> 后跟空格");
  assert.ok(!d.matchPrompt("=>x"), "=> 后跟非空格不命中");
});

console.log(`\n========================================`);
console.log(`  ${passed} checks passed`);
if (failed === 0) {
  console.log("  All uboot-detector tests passed.");
} else {
  console.log(`  ${failed} CHECK(S) FAILED`);
}
console.log(`========================================\n`);
