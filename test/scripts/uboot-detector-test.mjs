/**
 * =====================================================
 * File name  : uboot-detector-test.mjs
 * Date       : 2026/07/19
 * Description: UbootDetector 离线验证脚本
 *
 *   项目无测试框架（无 vitest/jest），用 node:assert + 动态 import 编译产物
 *   覆盖 spec AC1/AC2/AC3/AC4/AC6/AC9 的可离线部分。
 *
 *   本脚本验证 UbootDetector 在"配置值直接是正则源码字符串 + 与默认值合并"模式下的行为：
 *     - 默认值与原硬编码 AUTOBOOT_*_RE / UBOOT_PROMPT_RE 等价
 *     - 配置值与默认值合并（非替换），用户配置补充默认而非覆盖
 *     - 无效正则构造抛错
 *
 *   运行：先 npm run build，再 node test/scripts/uboot-detector-test.mjs
 * ======================================================
 */

import assert from "node:assert/strict";

const { UbootDetector } = await import(
  "../../out/mcp/shared/prompt-detector.js"
);

let passed = 0;
let failed = 0;
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

console.log("\n[2] UbootDetector 配置合并（AC2/AC3/AC6 — 用户配置补充默认，非替换）");
const d2 = new UbootDetector({
  autobootPrompts: ["Press\\s+SPACE\\s+to\\s+abort"],
  prompt: "Marvell>>\\s*$",
  verifyEnvKeys: ["mykey"],
});
check("自定义 autoboot 命中（AC2）", () => {
  assert.strictEqual(d2.matchAutoboot("Press SPACE to abort in 3s"), "\n");
});
check("默认 autoboot 仍命中（合并保留默认）", () => {
  // 合并语义：用户配置补充默认，默认的 Hit any key / Hit Ctrl+u 仍能识别
  assert.strictEqual(d2.matchAutoboot("Hit any key to stop autoboot"), "\n");
  assert.strictEqual(d2.matchAutoboot("Hit Ctrl+u to stop autoboot"), "\x15");
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
