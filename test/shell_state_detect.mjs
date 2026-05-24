// ── 测试字符串（用于验证检测逻辑） ──────────────────────────
const TEST_UBOOT = `
U-Boot 2023.04
CPU:   ARM Cortex-A7
DRAM:  512 MiB
=>
`;

const TEST_READY = `
#
`;

const TEST_READY2 = `
root@davinci:~# 
`;

const TEST_READY3 = `
$
`;

const TEST_LOCKED = `
Protect Shell v2.0
System is LOCKED
locked>
`;

const TEST_UNLOCKING = `
Enter key to unlock: 0123456789abcdef
key>
`;

const TEST_UNLOCKING2 = `
Password:
`;

const TEST_ERROR = `
Invalid key
Returning to locked mode
`;

// ── 状态枚举 ──────────────────────────────────────────────
const State = {
  UBOOT: "uboot",
  READY: "ready",
  LOCKED: "locked",
  UNLOCKING: "unlocking",
  ERROR: "error",
  UNKNOWN: "unknown",
};

// ── 按优先级排列的检测规则 ──────────────────────────────────
// 顺序很重要：unlocking 要在 locked 之前（locked 提示中可能包含 ">"）
const RULES = [
  {
    state: State.UNLOCKING,
    patterns: [/Enter key to unlock/i, /^key>\s*$/m, /^Password:\s*$/m],
    desc: "psh 待输入密钥状态",
  },
  {
    state: State.ERROR,
    patterns: [/Invalid key/i, /Access denied/i, /Returning to locked mode/i],
    desc: "密钥错误 / 访问被拒绝",
  },
  {
    state: State.LOCKED,
    patterns: [/^locked>\s*$/m, /Protect Shell/i, /System is LOCKED/i, /Command not supported in locked mode/i],
    desc: "psh 待解锁状态",
  },
  {
    state: State.READY,
    patterns: [/[@:].*[#$]\s*$/m, /^[^>]*[#$]\s*$/m, /PSH_AUTH=1/i, /built-in shell \(ash\)/i],
    desc: "ash 正常 shell 状态",
  },
  {
    state: State.UBOOT,
    patterns: [/=>\s*$/m],
    desc: "U-Boot 状态",
  },
];

/**
 * 根据终端输出文本检测当前处于什么状态
 */
function detectState(output) {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(output))) {
      return { state: rule.state, description: rule.desc };
    }
  }
  return { state: State.UNKNOWN, description: "无法识别" };
}

// ── 测试 ──────────────────────────────────────────────────
function runTests() {
  const tests = [
    { label: "TEST_UBOOT", input: TEST_UBOOT, expected: State.UBOOT },
    { label: "TEST_READY (#)", input: TEST_READY, expected: State.READY },
    { label: "TEST_READY2 (root@...:~#)", input: TEST_READY2, expected: State.READY },
    { label: "TEST_READY3 ($)", input: TEST_READY3, expected: State.READY },
    { label: "TEST_LOCKED", input: TEST_LOCKED, expected: State.LOCKED },
    { label: "TEST_UNLOCKING", input: TEST_UNLOCKING, expected: State.UNLOCKING },
    { label: "TEST_UNLOCKING2 (Password:)", input: TEST_UNLOCKING2, expected: State.UNLOCKING },
    { label: "TEST_ERROR", input: TEST_ERROR, expected: State.ERROR },
  ];

  let allPassed = true;
  for (const { label, input, expected } of tests) {
    const result = detectState(input);
    const pass = result.state === expected;
    if (!pass) allPassed = false;
    console.log(`[${pass ? "✓" : "✗"}] ${label}: state=${result.state} (expected=${expected})`);
  }

  console.log(`\n${allPassed ? "✓ All tests passed!" : "✗ Some tests FAILED!"}`);
}

runTests();
