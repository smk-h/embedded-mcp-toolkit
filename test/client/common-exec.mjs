/**
 * =====================================================
 * exec 超时测试共享逻辑（ssh/serial/adb 三通道复用）
 *
 *   封装与通道无关的测试能力：
 *     1. callExec / callSendCtrl / callClose —— 按通道工具名调用 exec 相关工具
 *     2. extractSessionId / splitOutputAndAnnotation —— 解析返回
 *     3. probeCommands —— 运行前探测设备命令可用性，缺失命令的用例自动跳过
 *     4. runExecTestCases —— 11 个超时与返回值用例
 *
 *   设备差异处理：不同设备（Android/Linux/BusyBox）命令存在性与参数支持
 *   不同，用例执行前先探测依赖命令，缺失则标记「⊘ 跳过」而非「✘ 失败」。
 *
 *   各通道脚本只需提供「通道工具名映射」与 session_id，即可复用全部用例。
 * ======================================================
 */

import { pass, fail, skip, printResult } from "./common.mjs";

/**
 * @typedef {Object} ChannelTools 通道工具名映射
 * @property {string} exec        - exec 工具名（如 "ssh_shell_exec"）
 * @property {string} sendCtrl    - send_ctrl 工具名（如 "ssh_shell_send_ctrl"）
 * @property {string} close       - close 工具名（如 "ssh_shell_close"）
 * @property {string} logTag      - 日志/输出中标识通道的标签（如 "ssh"）
 */

/**
 * 从 open/login 返回文本中提取 session_id
 *
 * 兼容三通道的不同返回格式，统一取 "Session " 后第一个 token：
 *   - ssh/adb : "Session ssh_1 opened..."  / "Session adb_1 opened. Device: ..."
 *   - serial  : "Session serial_1 on COM3 (...)"  / "Session serial_1 opened on COM3 ..."
 *
 * @param {string} text - open/login 返回的完整文本
 * @returns {string|null} session_id，提取失败返回 null
 */
export function extractSessionId(text) {
  const match = text.match(/Session\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * 提取返回文本中的纯输出与超时标注（便于断言真实输出）
 *
 * handler 在超时时追加 "[采样超时...]" 或 "[兜底超时...]" 行，本函数将其分离。
 *
 * @param {string} text - exec 返回的完整文本
 * @returns {{output: string, annotation: string}} 纯输出与超时标注（无标注时为空串）
 */
export function splitOutputAndAnnotation(text) {
  const lines = text.split("\n");
  let annotation = "";
  const outputLines = [];
  for (const line of lines) {
    if (line.startsWith("[采样超时") || line.startsWith("[兜底超时")) {
      annotation = line;
    } else {
      outputLines.push(line);
    }
  }
  return { output: outputLines.join("\n"), annotation };
}

/**
 * 调用 exec 工具并返回文本结果，默认打印执行的命令与工具返回内容
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {ChannelTools} tools
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [opts] - 可选参数
 * @param {number} [opts.maxDuration] - 可选 maxDuration 覆盖
 * @param {boolean} [opts.silent] - true 时不打印命令与返回（用于探测等内部调用）
 * @returns {Promise<{text: string, elapsed: number, result: object}>} 返回文本、耗时(ms)、原始 result
 */
export async function callExec(client, tools, sessionId, command, opts) {
  const maxDuration = opts?.maxDuration;
  const silent = opts?.silent ?? false;
  const start = Date.now();
  const args = { session_id: sessionId, command };
  if (maxDuration !== undefined) {
    args.maxDuration = maxDuration;
  }
  if (!silent) {
    console.log(`  ▶ exec: ${command}${maxDuration ? ` (maxDuration=${maxDuration})` : ""}`);
  }
  const result = await client.callTool({ name: tools.exec, arguments: args });
  const elapsed = Date.now() - start;
  const text = result.content.map((c) => c.text).join("\n");
  if (!silent) {
    printResult(result);
    console.log(`  ⏱ ${elapsed}ms`);
  }
  return { text, elapsed, result };
}

/**
 * 调用 send_ctrl 工具发控制字符（用于用例间清理残留进程）
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {ChannelTools} tools
 * @param {string} sessionId
 * @param {string} key - 控制字符 "c"/"u"/"d"/"z"
 */
export async function callSendCtrl(client, tools, sessionId, key) {
  await client.callTool({
    name: tools.sendCtrl,
    arguments: { session_id: sessionId, key },
  });
}

/**
 * 调用 close 工具关闭会话
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {ChannelTools} tools
 * @param {string} sessionId
 */
export async function callClose(client, tools, sessionId) {
  await client.callTool({
    name: tools.close,
    arguments: { session_id: sessionId },
  });
}

// ── 命令可用性探测（应对设备差异）─────────────────────────────

/**
 * @brief 设备命令可用性探测结果
 *
 * key 为命令名（首 token），value 为 true 表示设备上存在该命令。
 * 由 probeCommands 填充，供 requireCmd 守卫用例。
 */
const availableCommands = new Map();

/**
 * @brief 探测到的可写临时目录
 *
 * 不同系统临时目录不同（Linux:/tmp、Android:/data/local/tmp），由
 * probeCommands 探测后填充，供 tail 等需要临时文件的用例使用。
 */
let tempDir = "/tmp";

/**
 * @brief 探测设备上哪些命令可用
 *
 * 用 `command -v <cmd>` 逐个检测，存在则返回路径、不存在返回空。
 * 探测结果存入模块级 availableCommands，供 requireCmd 查询。
 *
 * 探测的命令清单覆盖全部用例依赖。即使设备未安装某命令，
 * command -v 也会瞬时返回（不挂起），探测本身安全快速。
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {ChannelTools} tools
 * @param {string} sessionId
 * @returns {Promise<Map<string, boolean>>} 命令→是否可用 的映射
 */
export async function probeCommands(client, tools, sessionId) {
  // 全部用例依赖的命令清单
  const cmdsToProbe = [
    "echo",
    "sleep",
    "ls",
    "rm",
    "ping",
    "top",
    "tail",
    "dmesg",
    "logcat",
    "head",
  ];
  availableCommands.clear();
  console.log("\n── 探测设备命令可用性 ──");
  for (const cmd of cmdsToProbe) {
    try {
      // 用注入确定性标记判定命令是否存在，规避内建/alias/路径差异：
      //   - 内建命令（echo）→ command -v 返回 "echo"（无路径）
      //   - alias（ls）→ 返回 "alias ls=..."（无路径）
      //   - 普通命令（head）→ 返回 "/usr/bin/head"（含路径）
      //   - 不存在（logcat）→ 返回空
      // 用 exit 码 + 注入标记，存在则输出 __MCP_CMD_OK__，不依赖输出内容格式
      const { text } = await callExec(
        client,
        tools,
        sessionId,
        `command -v ${cmd} >/dev/null 2>&1 && echo __MCP_CMD_OK__ || echo __MCP_CMD_NO__`,
        { silent: true }
      );
      const { output } = splitOutputAndAnnotation(text);
      const available = output.includes("__MCP_CMD_OK__");
      availableCommands.set(cmd, available);
    } catch {
      availableCommands.set(cmd, false);
    }
  }

  // 探测可写临时目录（tail 等用例需要）。优先级：/tmp > /data/local/tmp
  // Android 通常无 /tmp，Linux 通常无 /data/local/tmp，逐个尝试写入判定
  const tempCandidates = ["/tmp", "/data/local/tmp"];
  tempDir = "/tmp"; // 兜底
  for (const candidate of tempCandidates) {
    try {
      const probeFile = `${candidate}/.mcp-exec-probe`;
      const { text: writeText } = await callExec(
        client,
        tools,
        sessionId,
        `echo ok > ${probeFile} && cat ${probeFile} && rm -f ${probeFile}`,
        { silent: true }
      );
      const { output: writeOut } = splitOutputAndAnnotation(writeText);
      if (writeOut.includes("ok")) {
        tempDir = candidate;
        break;
      }
    } catch {
      // 该候选目录不可写，尝试下一个
    }
  }

  const summary = cmdsToProbe
    .map((c) => `${c}:${availableCommands.get(c) ? "✓" : "✗"}`)
    .join("  ");
  pass(`命令可用性: ${summary}  (临时目录: ${tempDir})`);
  return availableCommands;
}

/**
 * @brief 守卫：检查用例依赖的命令是否全部可用
 *
 * 供各用例在开头调用。任一依赖命令缺失则打印「⊘ 跳过」并返回 false，
 * 用例据此提前退出（不执行、不报失败）。
 *
 * @param {string} caseName 用例名（用于跳过提示）
 * @param {string[]} deps 依赖的命令名数组
 * @returns {boolean} true 表示依赖满足，可继续执行；false 表示已跳过
 */
function requireCmds(caseName, deps) {
  const missing = deps.filter((cmd) => !availableCommands.get(cmd));
  if (missing.length > 0) {
    skip(caseName, `设备缺少命令: ${missing.join(", ")}`);
    return false;
  }
  return true;
}

// ── 测试用例（通道无关，按 tools 映射调用）──────────────────────

/**
 * 用例 1：普通瞬时命令（echo），应正常返回无超时标注
 */
async function caseNormalInstant(client, tools, sessionId) {
  console.log("\n── 用例 1：普通瞬时命令（echo），应正常返回无超时标注 ──");
  if (!requireCmds("用例 1 echo", ["echo"])) return;
  const { text, elapsed } = await callExec(
    client,
    tools,
    sessionId,
    "echo hello-from-test"
  );
  const { output, annotation } = splitOutputAndAnnotation(text);

  if (output.includes("hello-from-test") && annotation === "") {
    pass(`echo 正常返回且无超时标注（${elapsed}ms）`);
  } else {
    fail("echo 应正常返回无标注", `elapsed=${elapsed}ms, annotation="${annotation}"`);
  }
}

/**
 * 用例 2：普通长命令（sleep 12），不应被 10 秒短超时误杀
 *
 * 改动前会被旧 10s 阈值误杀；改动后应正常完成（12s < 5min 兜底）。
 */
async function caseNormalLongCommand(client, tools, sessionId) {
  console.log("\n── 用例 2：普通长命令（sleep 15），不应被误杀 ──");
  if (!requireCmds("用例 2 sleep", ["sleep", "echo"])) return;
  const { text, elapsed } = await callExec(
    client,
    tools,
    sessionId,
    "sleep 15; echo long-done"
  );
  const { output, annotation } = splitOutputAndAnnotation(text);

  if (output.includes("long-done") && annotation === "") {
    pass(`长命令正常完成（${elapsed}ms），未被误杀（改动前会被 10s 截断）`);
  } else {
    fail("长命令应正常完成无标注", `elapsed=${elapsed}ms, annotation="${annotation}"`);
  }
}

/**
 * 用例 3：常驻命令（ping）采样超时，默认 10s 发 Ctrl+C
 *
 * 不带 -c 的 ping 永不返回提示符 → 采样超时 → 返回「采样超时」标注。
 */
async function caseResidentPingSampling(client, tools, sessionId) {
  console.log("\n── 用例 3：常驻命令（ping）采样超时，默认 10s 发 Ctrl+C ──");
  if (!requireCmds("用例 3 ping", ["ping"])) return;
  const { text, elapsed } = await callExec(
    client,
    tools,
    sessionId,
    "ping 127.0.0.1"
  );
  const { output, annotation } = splitOutputAndAnnotation(text);

  const isSampling =
    annotation.includes("采样超时") && annotation.includes("Ctrl+C");
  const hasPingOutput =
    output.includes("bytes") || output.includes("icmp_seq") || output.includes("PING");
  const inTimeWindow = elapsed >= 7000 && elapsed <= 16000;

  if (isSampling && hasPingOutput && inTimeWindow) {
    pass(`ping 采样超时正确（${elapsed}ms，发 Ctrl+C，有 ping 输出）`);
  } else {
    fail(
      "ping 应触发采样超时",
      `elapsed=${elapsed}ms, sampling=${isSampling}, hasOutput=${hasPingOutput}, annotation="${annotation}"`
    );
  }
}

/**
 * 用例 4：常驻命令（top）采样超时 + 会话恢复验证
 *
 * top 批处理持续输出 → 采样超时发 Ctrl+C；随后 exec echo 验证无残留污染。
 */
async function caseResidentTopAndRecovery(client, tools, sessionId) {
  console.log("\n── 用例 4：常驻命令（top）采样超时 + 会话恢复验证 ──");
  if (!requireCmds("用例 4 top", ["top", "echo"])) return;

  const { text: topText, elapsed: topElapsed } = await callExec(
    client,
    tools,
    sessionId,
    "top -b -n 9999"
  );
  const { annotation: topAnnotation } = splitOutputAndAnnotation(topText);

  if (
    !(topAnnotation.includes("采样超时") && topAnnotation.includes("Ctrl+C"))
  ) {
    fail("top 应触发采样超时", `annotation="${topAnnotation}"`);
    return;
  }
  pass(`top 采样超时正确（${topElapsed}ms）`);

  console.log("\n  ── 4b：验证会话恢复（top 终止后 exec echo）──");
  const { text: echoText } = await callExec(
    client,
    tools,
    sessionId,
    "echo recovered-clean"
  );
  const { output: echoOutput, annotation: echoAnnotation } =
    splitOutputAndAnnotation(echoText);

  if (
    echoOutput.includes("recovered-clean") &&
    echoAnnotation === "" &&
    !echoOutput.includes("%Cpu")
  ) {
    pass("会话恢复正常，无 top 残留污染");
  } else {
    fail("会话应恢复无污染", `annotation="${echoAnnotation}"`);
  }
}

/**
 * 用例 5：maxDuration 覆盖采样时长（ping + 5s）
 *
 * maxDuration 只覆盖时长，动作仍是「采样超时/发 Ctrl+C」。
 */
async function caseMaxDurationOverrideSampling(client, tools, sessionId) {
  console.log("\n── 用例 5：maxDuration 覆盖采样时长（ping + 5s）──");
  if (!requireCmds("用例 5 ping", ["ping"])) return;
  const { text, elapsed } = await callExec(client, tools, sessionId, "ping 127.0.0.1", {
    maxDuration: 5000,
  });
  const { annotation } = splitOutputAndAnnotation(text);

  const isSampling =
    annotation.includes("采样超时") && annotation.includes("Ctrl+C");
  const inTimeWindow = elapsed >= 3500 && elapsed <= 9000;

  if (isSampling && inTimeWindow) {
    pass(`maxDuration=5s 生效（${elapsed}ms 采样超时，动作仍发 Ctrl+C）`);
  } else {
    fail(
      "maxDuration 应缩短采样时长且动作不变",
      `elapsed=${elapsed}ms, sampling=${isSampling}, annotation="${annotation}"`
    );
  }
}

/**
 * 用例 6：兜底超时（普通命令 sleep + 3s maxDuration），不发 Ctrl+C
 *
 * sleep 是普通命令 → 走兜底分支不发 Ctrl+C。标注含「兜底超时」与「未发送中断」。
 * sleep 被截断后仍在后台睡眠，用例末尾发 Ctrl+C 清理。
 */
async function caseFallbackTimeoutNoInterrupt(client, tools, sessionId) {
  console.log("\n── 用例 6：兜底超时（普通命令 sleep + 3s maxDuration），不发 Ctrl+C ──");
  if (!requireCmds("用例 6 sleep", ["sleep"])) return;
  const { text, elapsed } = await callExec(client, tools, sessionId, "sleep 30", {
    maxDuration: 3000,
  });
  const { annotation } = splitOutputAndAnnotation(text);

  const isFallback =
    annotation.includes("兜底超时") && annotation.includes("未发送中断");
  const inTimeWindow = elapsed >= 2500 && elapsed <= 7000;

  if (isFallback && inTimeWindow) {
    pass(`兜底超时正确（${elapsed}ms，未发 Ctrl+C）`);
  } else {
    fail(
      "普通命令应走兜底超时不发 Ctrl+C",
      `elapsed=${elapsed}ms, fallback=${isFallback}, annotation="${annotation}"`
    );
  }

  console.log("  ── 清理：发送 Ctrl+C 终止可能残留的 sleep ──");
  await callSendCtrl(client, tools, sessionId, "c");
}

/**
 * 用例 7：常驻命令 tail -f（B 类参数模式）采样超时
 *
 * tail 带 -f 才常驻，验证参数模式识别。先写测试文件供 tail -f 跟踪。
 * 路径用 probeCommands 探测到的可写临时目录（Linux:/tmp、Android:/data/local/tmp）。
 */
async function caseTailFollowSampling(client, tools, sessionId) {
  console.log("\n── 用例 7：常驻命令 tail -f（B 类参数模式）采样超时 ──");
  if (!requireCmds("用例 7 tail", ["tail", "echo", "rm"])) return;

  const testFile = `${tempDir}/tail-test.txt`;
  await callExec(client, tools, sessionId, `echo line1 > ${testFile}`);

  const { text, elapsed } = await callExec(
    client,
    tools,
    sessionId,
    `tail -f ${testFile}`
  );
  const { output, annotation } = splitOutputAndAnnotation(text);

  const isSampling =
    annotation.includes("采样超时") && annotation.includes("Ctrl+C");
  const hasTailOutput = output.includes("line1");
  const inTimeWindow = elapsed >= 7000 && elapsed <= 16000;

  if (isSampling && hasTailOutput && inTimeWindow) {
    pass(`tail -f 采样超时正确（${elapsed}ms，B 类参数模式识别成功）`);
  } else {
    fail(
      "tail -f 应触发采样超时",
      `elapsed=${elapsed}ms, sampling=${isSampling}, hasOutput=${hasTailOutput}, annotation="${annotation}"`
    );
  }

  await callExec(client, tools, sessionId, `rm -f ${testFile}`);
}

/**
 * 用例 8：B 类瞬时命令对照（不带 follow 参数应判为普通命令）
 *
 * 验证 B 类识别的「不误判」：tail/dmesg 不带 -f/-w 时是瞬时命令，
 * 应正常返回、无采样超时标注（不会被误判为常驻）。
 * 与用例 7（tail -f 常驻）形成对照，完整覆盖 F1 的 B 类参数模式（AC6）。
 */
async function caseBclassInstantContrast(client, tools, sessionId) {
  console.log("\n── 用例 8：B 类瞬时对照（tail/dmesg 不带 follow 应正常返回）──");
  if (!requireCmds("用例 8 tail/dmesg", ["tail", "dmesg", "head", "echo", "rm"]))
    return;

  // 8a：tail 不带 -f 应正常返回（瞬时）
  console.log("  ── 8a：tail（不带 -f，应正常返回无标注）──");
  const testFile = `${tempDir}/tail-test.txt`;
  await callExec(client, tools, sessionId, `echo line1 > ${testFile}`);
  const { text: tailText, elapsed: tailElapsed } = await callExec(
    client,
    tools,
    sessionId,
    `tail ${testFile}`
  );
  const { output: tailOutput, annotation: tailAnnotation } =
    splitOutputAndAnnotation(tailText);
  if (tailOutput.includes("line1") && tailAnnotation === "") {
    pass(`tail（无 -f）正常返回无标注（${tailElapsed}ms）`);
  } else {
    fail("tail 无 -f 应正常返回无标注", `annotation="${tailAnnotation}"`);
  }

  // 8b：dmesg 不带 -w 应正常返回（瞬时）
  console.log("  ── 8b：dmesg（不带 -w，应正常返回无标注）──");
  const { text: dmesgText, elapsed: dmesgElapsed } = await callExec(
    client,
    tools,
    sessionId,
    "dmesg | head -1"
  );
  const { annotation: dmesgAnnotation } = splitOutputAndAnnotation(dmesgText);
  if (dmesgAnnotation === "") {
    pass(`dmesg（无 -w）正常返回无标注（${dmesgElapsed}ms）`);
  } else {
    fail("dmesg 无 -w 应正常返回无标注", `annotation="${dmesgAnnotation}"`);
  }

  await callExec(client, tools, sessionId, `rm -f ${testFile}`);
}

/**
 * 用例 9：A 类常驻命令轮测（logcat）
 *
 * 验证 A 类白名单识别：logcat 只要首 token 命中即常驻（F1）。
 * 用 logcat 验证 Android 系统日志的采样超时。
 */
async function caseLogcatSampling(client, tools, sessionId) {
  console.log("\n── 用例 9：A 类常驻命令（logcat）采样超时 ──");
  if (!requireCmds("用例 9 logcat", ["logcat"])) return;
  const { text, elapsed } = await callExec(client, tools, sessionId, "logcat");
  const { annotation } = splitOutputAndAnnotation(text);

  const isSampling =
    annotation.includes("采样超时") && annotation.includes("Ctrl+C");
  const inTimeWindow = elapsed >= 7000 && elapsed <= 16000;

  if (isSampling && inTimeWindow) {
    pass(`logcat 采样超时正确（${elapsed}ms，A 类白名单识别成功）`);
  } else {
    fail(
      "logcat 应触发采样超时",
      `elapsed=${elapsed}ms, sampling=${isSampling}, annotation="${annotation}"`
    );
  }
}

/**
 * 用例 10：maxDuration 拉长采样窗口（ping + 15s，对照 AC8）
 *
 * AC8 要求：ping + maxDuration=30s 约 30s 返回。这里用 15s 平衡测试时长，
 * 验证 maxDuration 可拉长采样窗口且动作仍是采样超时/发 Ctrl+C。
 */
async function caseMaxDurationExtendSampling(client, tools, sessionId) {
  console.log("\n── 用例 10：maxDuration 拉长采样窗口（ping + 15s）──");
  if (!requireCmds("用例 10 ping", ["ping"])) return;
  const { text, elapsed } = await callExec(client, tools, sessionId, "ping 127.0.0.1", {
    maxDuration: 15000,
  });
  const { annotation } = splitOutputAndAnnotation(text);

  const isSampling =
    annotation.includes("采样超时") && annotation.includes("Ctrl+C");
  // 15s 采样，应明显长于默认 10s（>12s）且不超 20s
  const inTimeWindow = elapsed >= 12000 && elapsed <= 20000;

  if (isSampling && inTimeWindow) {
    pass(`maxDuration=15s 生效（${elapsed}ms 采样超时，窗口已拉长）`);
  } else {
    fail(
      "maxDuration=15s 应拉长采样窗口",
      `elapsed=${elapsed}ms, sampling=${isSampling}, annotation="${annotation}"`
    );
  }
}

/**
 * 用例 11：普通命令 ls，正常返回无超时标注（回归验证）
 */
async function caseNormalLs(client, tools, sessionId) {
  console.log("\n── 用例 11：普通命令（ls），应正常返回无超时标注（回归验证）──");
  if (!requireCmds("用例 11 ls", ["ls"])) return;
  const { text, elapsed } = await callExec(client, tools, sessionId, "ls /");
  const { output, annotation } = splitOutputAndAnnotation(text);

  const hasListing =
    output.includes("bin") ||
    output.includes("etc") ||
    output.includes("usr") ||
    output.length > 10;
  if (hasListing && annotation === "") {
    pass(`ls 正常返回目录列表，无超时标注（${elapsed}ms）`);
  } else {
    fail("ls 应正常返回无标注", `annotation="${annotation}", outputLen=${output.length}`);
  }
}

/** 11 个用例的有序列表 */
const ALL_CASES = [
  caseNormalInstant, // 1
  caseNormalLongCommand, // 2
  caseResidentPingSampling, // 3
  caseResidentTopAndRecovery, // 4
  caseMaxDurationOverrideSampling, // 5
  caseFallbackTimeoutNoInterrupt, // 6
  caseTailFollowSampling, // 7
  caseBclassInstantContrast, // 8
  caseLogcatSampling, // 9
  caseMaxDurationExtendSampling, // 10
  caseNormalLs, // 11
];

/**
 * 运行全部 exec 测试用例
 *
 * 每个用例独立 try/catch，出错后发 Ctrl+C 清理，保证后续用例不受污染。
 *
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {ChannelTools} tools
 * @param {string} sessionId
 */
export async function runExecTestCases(client, tools, sessionId) {
  for (const testCase of ALL_CASES) {
    try {
      await testCase(client, tools, sessionId);
    } catch (err) {
      fail(testCase.name, err.message);
      try {
        await callSendCtrl(client, tools, sessionId, "c");
      } catch {
        // 忽略清理失败
      }
    }
  }
}
