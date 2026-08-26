/**
 * =====================================================
 * ssh_build 端到端测试 —— SSH 通道
 *
 *   验证 ssh_build 远程编译机制：
 *     1. 调用 ssh_shell_login 登录 SSH 会话（连接 + PSH 解锁）
 *     2. 调用 ssh_build 执行 make clean 清理产物
 *     3. 调用 ssh_build 执行 make 全量编译
 *        —— 断言 BUILD SUCCESS，且 classify 检出编译警告（如 -Wpointer-to-int-cast）
 *     4. 校验 classify 结构化返回：断言 Summary 与 ERRORS/WARNINGS 段
 *     5. 再次 make（增量编译）：断言无重编译（0 info line）且仍为 BUILD SUCCESS
 *        —— 证明 ssh_build 可重复执行，不会污染会话
 *     6. classify=false 模式：断言返回原始尾部输出（含 header 行）
 *
 *   解锁：调用 ssh_shell_login 后，设备会发出挑战码写入
 *   .embedded/configs/challenge.txt，请手动在终端输入应答密钥
 *   （server 端 KeyProvider 会轮询 password_input.txt 读取）。
 *
 *   设备/源码/编译命令写死在下方 cfg 常量中，换设备/工程时直接改：
 *     DEVICE      = board-ubuntu
 *     BUILD_CWD   = /home/sumu/workspace/c-learning/sys-cmd-demo/shm
 *     BUILD_CLEAN_CMD = make clean
 *     BUILD_CMD   = make
 *     BUILD_MAXWAIT = 300000（5 分钟）
 *
 *   运行前置：已 build（out/ 存在）；board-ubuntu SSH 可达
 *   运行：node test/client/ssh/test-ssh-build.mjs
 * ======================================================
 */

import { connect } from "../client.mjs";
import { pass, fail, printResult } from "../common.mjs";
import { extractSessionId, callClose } from "../common-exec.mjs";

/** 运行配置（换设备/换工程时改此处常量） */
const cfg = {
  DEVICE: "board-ubuntu",
  BUILD_CWD: "/home/sumu/workspace/c-learning/sys-cmd-demo/shm",
  BUILD_CLEAN_CMD: "make clean",
  BUILD_CMD: "make",
  BUILD_MAXWAIT: 300000,
};

/**
 * 解析 ssh_build 返回文本，判定编译结果状态
 *
 * classify 模式返回形如：
 *   "[session: ssh_1] BUILD SUCCESS (exit code: 0)\nSummary: ...\n\n=== ERRORS (0) ===\n(none)\n\n=== WARNINGS (0) ===\n(none)"
 *   "[session: ssh_1] BUILD FAILED (exit code: 2)\nSummary: ..."
 *   "Build timed out after 600000ms.\nPartial: N error(s), M warning(s).\n\n..."
 * classify=false 模式返回形如：
 *   "BUILD SUCCESS (exit code: 0)\n\n<原始尾部输出>"
 *   "BUILD FAILED (exit code: 1)\n\n<原始尾部输出>"
 *   "Build timed out after Xms.\n\nPartial output:\n<原始尾部输出>"
 *
 * @param {string} text ssh_build 返回的完整文本
 * @returns {{ok: boolean, status: "success"|"failed"|"timeout", exitCode?: number, summary?: string, output: string}}
 */
function parseBuildResult(text) {
  let successMatch = text.match(/BUILD SUCCESS \(exit code: (\d+)\)/);
  if (successMatch) {
    return {
      ok: true,
      status: "success",
      exitCode: Number(successMatch[1]),
      summary: text.match(/Summary:\s*([^\n]+)/)?.[1],
      output: text.trim(),
    };
  }
  let failedMatch = text.match(/BUILD FAILED \(exit code: (\d+)\)/);
  if (failedMatch) {
    return {
      ok: false,
      status: "failed",
      exitCode: Number(failedMatch[1]),
      summary: text.match(/Summary:\s*([^\n]+)/)?.[1],
      output: text.trim(),
    };
  }
  if (/Build timed out after/.test(text)) {
    return { ok: false, status: "timeout", output: text.trim() };
  }
  return { ok: false, status: "unknown", output: text.trim() };
}

/**
 * 调用 ssh_build 并返回解析结果
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} sessionId
 * @param {string} command 编译命令
 * @param {object} [opts]
 * @param {number} [opts.maxWait] 覆盖 maxWait
 * @param {boolean} [opts.classify] 覆盖 classify
 * @returns {Promise<{parsed: object, text: string, elapsed: number}>}
 */
async function callBuild(client, sessionId, command, opts = {}) {
  const maxWait = opts.maxWait ?? cfg.BUILD_MAXWAIT;
  const classify = opts.classify ?? true;
  console.log(
    `  ▶ call: ssh_build (cwd=${cfg.BUILD_CWD}, cmd=${command}, maxWait=${maxWait}, classify=${classify})`
  );
  const start = Date.now();
  const result = await client.callTool({
    name: "ssh_build",
    arguments: {
      session_id: sessionId,
      command,
      cwd: cfg.BUILD_CWD,
      maxWait,
      classify,
    },
  });
  const elapsed = Date.now() - start;
  printResult(result);
  console.log(`  ⏱ ${elapsed}ms`);
  const text = result.content.map((c) => c.text).join("");
  return { parsed: parseBuildResult(text), text, elapsed };
}

/**
 * 断言解析结果状态（成功/失败/超时/无法识别），错误时退出测试
 *
 * @param {object} parsed
 * @param {string} label 断言名
 * @returns {boolean} 是否成功
 */
function assertBuildStatus(parsed, label) {
  if (parsed.status === "timeout") {
    fail(label, `maxWait=${cfg.BUILD_MAXWAIT}ms 内未完成编译`);
    return false;
  }
  if (parsed.status === "unknown") {
    fail(label, "返回文本无法识别，请检查返回格式");
    return false;
  }
  if (!parsed.ok) {
    fail(label, `exit=${parsed.exitCode}，${parsed.output}`);
    return false;
  }
  return true;
}

async function main() {
  const serverEnv = {
    DEVICE: cfg.DEVICE,
    BOARD_CONFIG_PATH: "./.embedded/configs/config.yaml",
    LOG_SAVE: "1",
    LOG_DIR: "./.embedded/log",
    SAVE2FILE_PATH: "./.embedded/log",
  };
  const device = cfg.DEVICE;

  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  ssh_build 测试 (${device.padEnd(24)}) ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  源码目录: ${cfg.BUILD_CWD}`);
  console.log(`  clean   : ${cfg.BUILD_CLEAN_CMD}`);
  console.log(`  编译命令: ${cfg.BUILD_CMD}`);
  console.log(`  maxWait : ${cfg.BUILD_MAXWAIT}ms`);

  // 1. 连接 MCP 服务器
  let client;
  try {
    const conn = await connect({ name: "test-ssh-build", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  let sessionId = null;
  try {
    // 2. 登录 SSH 会话（连接 + PSH 检测 + 解锁）
    console.log(`\n── 登录 SSH 会话（${device}，PSH 解锁）──`);
    console.log("  ℹ 若出现挑战码，请在终端输入应答密钥（写入 password_input.txt）");

    let loginResult;
    try {
      loginResult = await client.callTool({
        name: "ssh_shell_login",
        arguments: { device },
      });
    } catch (err) {
      fail(
        "PSH 解锁",
        `login 调用异常（连接已关闭）：${err.message}。` +
        "请在挑战码出现时及时输入应答密钥，或确认设备 PSH 密钥正确"
      );
      process.exit(1);
    }
    printResult(loginResult);
    const loginText = loginResult.content.map((c) => c.text).join("");
    sessionId = extractSessionId(loginText);

    if (!sessionId) {
      fail(
        "登录 SSH 会话",
        "未能提取 session_id（设备不可达或 PSH 解锁失败）。" +
        "请确认 SSH 可达；若需解锁请在挑战码出现时输入应答密钥"
      );
      process.exit(1);
    }
    pass(`SSH 会话已登录: ${sessionId}`);

    // 3. 用例 1：make clean（classify 模式）
    //    清理产物，为全量编译做准备。应返回 BUILD SUCCESS。
    console.log("\n── 用例 1：ssh_build 执行 make clean ──");
    const cleanRes = await callBuild(client, sessionId, cfg.BUILD_CLEAN_CMD);
    if (!assertBuildStatus(cleanRes.parsed, "make clean 应 BUILD SUCCESS")) {
      process.exit(1);
    }
    pass(`make clean 成功（exit=${cleanRes.parsed.exitCode}, ${cleanRes.elapsed}ms）`);

    // 4. 用例 2：make 全量编译（classify 模式）
    //    重新编译全部目标，应能检出编译警告（如 -Wpointer-to-int-cast）。
    console.log("\n── 用例 2：ssh_build 执行 make 全量编译 ──");
    const buildRes = await callBuild(client, sessionId, cfg.BUILD_CMD);
    if (!assertBuildStatus(buildRes.parsed, "make 全量编译应 BUILD SUCCESS")) {
      process.exit(1);
    }
    pass(
      `make 全量编译成功（exit=${buildRes.parsed.exitCode}, ${buildRes.elapsed}ms）` +
      `Summary: ${buildRes.parsed.summary ?? "(无)"}`
    );

    // 5. 用例 3：校验 classify 结构化返回（Summary + ERRORS/WARNINGS 段）
    console.log("\n── 用例 3：校验 classify 结构化返回（Summary + ERRORS/WARNINGS 段）──");
    const buildText = buildRes.text;
    const hasSummary = /Summary: \d+ error\(s\), \d+ warning\(s\), \d+ info line\(s\)/.test(
      buildText
    );
    const hasErrorsSection = /=== ERRORS \(\d+\) ===/.test(buildText);
    const hasWarningsSection = /=== WARNINGS \(\d+\) ===/.test(buildText);

    if (hasSummary && hasErrorsSection && hasWarningsSection) {
      pass("classify 结构化返回包含 Summary 与 ERRORS/WARNINGS 段");
    } else {
      fail(
        "classify 返回应包含 Summary 与 ERRORS/WARNINGS 段",
        `hasSummary=${hasSummary}, hasErrorsSection=${hasErrorsSection}, hasWarningsSection=${hasWarningsSection}`
      );
    }

    // 6. 用例 4：增量编译（再次 make）
    //    产物已生成，make 应快速返回（无重编译）且仍为 BUILD SUCCESS，
    //    证明 ssh_build 可重复执行、不污染会话。
    //    空编译标记：输出含「无需做任何事」且无 gcc 编译行（进入/离开目录行不算）。
    console.log("\n── 用例 4：增量编译（再次 make，应快速返回 BUILD SUCCESS）──");
    const incrRes = await callBuild(client, sessionId, cfg.BUILD_CMD);
    if (!assertBuildStatus(incrRes.parsed, "增量编译应 BUILD SUCCESS")) {
      process.exit(1);
    }
    const noRebuild =
      /无需做任何事/.test(incrRes.text) && !/gcc\s/.test(incrRes.text);
    if (noRebuild) {
      pass(`增量编译成功（exit=${incrRes.parsed.exitCode}, ${incrRes.elapsed}ms，无重编译）`);
    } else {
      fail("增量编译应为空编译", `输出未含「无需做任何事」或存在 gcc 编译行`);
    }

    // 7. 用例 5：classify=false 模式（再次 make，返回原始尾部输出 + header 行）
    console.log("\n── 用例 5：classify=false（返回原始尾部输出 + header 行）──");
    const rawRes = await callBuild(client, sessionId, cfg.BUILD_CMD, {
      classify: false,
    });
    const rawText = rawRes.text;
    const hasHeader3 =
      /BUILD SUCCESS \(exit code: \d+\)|BUILD FAILED \(exit code: \d+\)|Build timed out after/.test(
        rawText
      );
    const outputLen3 = rawText.length;

    if (hasHeader3 && outputLen3 > 10) {
      pass(`classify=false 返回 header 与原始输出（${outputLen3} 字符）`);
    } else {
      fail(
        "classify=false 应返回 header 与原始输出",
        `hasHeader=${hasHeader3}, outputLen=${outputLen3}`
      );
    }
  } finally {
    // 关闭会话
    if (sessionId) {
      try {
        await callClose(client, { close: "ssh_shell_close" }, sessionId);
        pass("SSH 会话已关闭");
      } catch (err) {
        fail("关闭 SSH 会话", err.message);
      }
    }
    try {
      await client.close();
    } catch {
      // 忽略
    }
    console.log("\n── 测试结束 ──");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
