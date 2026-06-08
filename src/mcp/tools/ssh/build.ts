/**
 * @file MCP SSH Build 工具
 *
 * 在远端编译服务器上执行编译命令并等待完成，返回编译结果。
 * 通过完成标记（completion marker）机制检测编译结束，
 * 自动分类采集编译输出中的错误、警告和常规信息。
 * 适用于 make、cmake、shell 脚本等长时间编译场景。
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../infra/logger.js";
import { sessions } from "./shell.js";

/** @brief 编译完成标记，用于检测命令执行结束 */
const BUILD_MARKER = "___MCP_BUILD_DONE___";

/** @brief 输出行分类 */
type BuildCategory = "error" | "warning" | "info";

/** @brief 编译输出分类采集队列 */
interface BuildCollector {
  errors: string[];
  warnings: string[];
  info: string[];
}

/**
 * @brief 编译输出行分类器
 *
 * 根据关键字匹配将单行输出归类为 error / warning / info。
 * 优先匹配 error（更严重），其次 warning，其余归入 info。
 *
 * @param line  待分类的单行输出
 * @return 分类结果
 */
function classifyLine(line: string): BuildCategory {
  const lower = line.toLowerCase();

  // 错误模式匹配
  if (
    /\berror\b[:\s]/i.test(line) ||
    /\bfatal\b[:\s]/i.test(line) ||
    /undefined reference/i.test(line) ||
    /No rule to make/i.test(line) ||
    /make\[.+\]: \*\*\*/i.test(line) ||
    /cannot find/i.test(line) ||
    /collect2: error/i.test(line) ||
    /ld returned/i.test(line) ||
    /\bfailed\b[:\s]/i.test(line) ||
    /no such file or directory/i.test(line)
  ) {
    return "error";
  }

  // 警告模式匹配
  if (
    /\bwarning\b[:\s]/i.test(line) ||
    /\bwarn\b[:\s]/i.test(line) ||
    /\bdeprecated\b/i.test(line) ||
    /-W[a-z]+/i.test(lower)
  ) {
    return "warning";
  }

  return "info";
}

/**
 * @brief 创建空的编译输出采集器
 */
function createCollector(): BuildCollector {
  return { errors: [], warnings: [], info: [] };
}

/**
 * @brief 对编译输出按行分类并填入采集队列
 *
 * 遍历输出的每一行，调用 classifyLine 进行分类，
 * 按类别追加到 coletor 中各自对应的数组。
 *
 * @param collector  采集队列
 * @param rawOutput  去除了完成标记的完整编译输出
 */
function collectOutput(collector: BuildCollector, rawOutput: string): void {
  const lines = rawOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const category = classifyLine(trimmed);
    switch (category) {
      case "error":
        collector.errors.push(trimmed);
        break;
      case "warning":
        collector.warnings.push(trimmed);
        break;
      default:
        collector.info.push(trimmed);
        break;
    }
  }
}

/**
 * @brief 格式化分类采集结果为结构化文本
 *
 * 按优先级组织输出：
 *   1. 构建状态摘要（成功/失败、退出码、统计）
 *   2. 错误列表（带编号）
 *   3. 警告列表（带编号）
 *   4. 完整构建日志
 *
 * @param collector  分类采集队列
 * @param exitCode   编译退出码
 * @param rawOutput  完整原始输出
 * @param sessionId  会话 ID，用于标识结果归属
 * @return 结构化的编译结果文本
 */
function formatBuildResult(
  collector: BuildCollector,
  exitCode: number,
  rawOutput: string,
  sessionId: string
): string {
  const statusLabel = exitCode === 0 ? "BUILD SUCCESS" : "BUILD FAILED";
  const parts: string[] = [];

  // 状态摘要
  parts.push(`[session: ${sessionId}] ${statusLabel} (exit code: ${exitCode})`);
  parts.push(
    `Summary: ${collector.errors.length} error(s), ${collector.warnings.length} warning(s), ${collector.info.length} info line(s)`
  );

  // 错误列表
  parts.push("");
  parts.push(`=== ERRORS (${collector.errors.length}) ===`);
  if (collector.errors.length === 0) {
    parts.push("(none)");
  } else {
    for (let i = 0; i < collector.errors.length; i++) {
      parts.push(`[E${i + 1}] ${collector.errors[i]}`);
    }
  }

  // 警告列表
  parts.push("");
  parts.push(`=== WARNINGS (${collector.warnings.length}) ===`);
  if (collector.warnings.length === 0) {
    parts.push("(none)");
  } else {
    for (let i = 0; i < collector.warnings.length; i++) {
      parts.push(`[W${i + 1}] ${collector.warnings[i]}`);
    }
  }

  // 完整构建日志
  parts.push("");
  parts.push("=== BUILD LOG ===");
  parts.push(rawOutput || "(no output)");

  return parts.join("\n");
}

/**
 * @brief 构造包含完成标记的远端 shell 命令
 *
 * 如果指定了工作目录，先 cd 到该目录；
 * 编译命令的标准输出和标准错误合并后，追加完成标记（含退出码）。
 *
 * @param command  编译命令
 * @param cwd      工作目录（可选）
 * @param marker   完成标记字符串
 * @return 完整的远端 shell 命令
 */
function buildRemoteCommand(
  command: string,
  cwd: string | undefined,
  marker: string
): string {
  const buildCmd = `${command} 2>&1`;
  if (cwd) {
    return `(cd ${cwd} && ${buildCmd}); echo "${marker}:$?"`;
  }
  return `${buildCmd}; echo "${marker}:$?"`;
}

// ── ssh_build ────────────────────────────────────────────────

/**
 * @brief ssh_build 工具配置
 *
 * 在远端 SSH 会话中执行编译命令，轮询等待编译完成。
 * 自动分类采集编译输出中的错误、警告及常规信息，
 * 以结构化格式返回，便于 AI 进行后续分析。
 *
 * @param session_id    由 ssh_shell_open 或 ssh_shell_login 返回的会话 ID
 * @param command       要执行的编译命令（如 "make -j8"、"./build.sh"）
 * @param cwd           远端工作目录（可选，切换到该目录后再执行命令）
 * @param maxWait       最大等待时间（毫秒，默认 600000 即 10 分钟）
 * @param pollInterval  轮询间隔（毫秒，默认 2000）
 * @param classify      是否对输出进行分类采集（默认 true）
 */
export const sshBuildConfig = {
  description:
    "Execute a build command on the remote server via SSH, wait for completion, " +
    "classify errors/warnings, and return structured build results for AI analysis. " +
    "IMPORTANT: Each session supports only ONE build at a time. " +
    "For concurrent builds, open multiple sessions via ssh_shell_open and assign one build per session.",
  inputSchema: fromJsonSchema<{
    session_id: string;
    command: string;
    cwd?: string;
    maxWait?: number;
    pollInterval?: number;
    classify?: boolean;
  }>({
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "The session ID returned by ssh_shell_open or ssh_shell_login. " +
          "One session supports only one build at a time — " +
          "open multiple sessions for concurrent builds.",
      },
      command: {
        type: "string",
        description:
          "The build command to execute (e.g., 'make -j8', './build.sh')",
      },
      cwd: {
        type: "string",
        description:
          "Working directory on the remote server for the build command",
      },
      maxWait: {
        type: "number",
        description:
          "Maximum wait time in milliseconds (default: 600000 = 10 minutes)",
      },
      pollInterval: {
        type: "number",
        description:
          "Poll interval in milliseconds to check for build completion (default: 2000)",
      },
      classify: {
        type: "boolean",
        description:
          "Whether to classify output into errors/warnings/info queues (default: true)",
      },
    },
    required: ["session_id", "command"],
  }),
};

/**
 * @brief ssh_build 处理函数
 *
 * 流程：
 *   1. 查找已有 SSH 会话
 *   2. 构造远端命令（含工作目录切换和完成标记）
 *   3. 发送命令，启动数据收集
 *   4. 轮询缓冲区，检测完成标记，增量读取输出
 *   5. 解析退出码，剥离完成标记
 *   6. 按行分类输出为 error / warning / info 队列
 *   7. 以结构化格式返回编译结果
 *
 * @param args  工具参数
 * @return MCP 响应，包含结构化编译结果
 */
export async function sshBuildHandler(args: {
  session_id: string;
  command: string;
  cwd?: string;
  maxWait?: number;
  pollInterval?: number;
  classify?: boolean;
}) {
  // ── 参数默认值 ──
  const maxWait: number = args.maxWait ?? 600000;   // 最大等待 10 分钟
  const pollInterval: number = args.pollInterval ?? 2000; // 每 2 秒轮询一次
  const doClassify: boolean = args.classify ?? true;      // 默认开启输出分类

  logger.info(
    `[ssh_build] session_id=${args.session_id} cwd=${args.cwd ?? "(none)"} command=${args.command} maxWait=${maxWait} pollInterval=${pollInterval} classify=${doClassify}`
  );

  // ── 步骤 1：查找 SSH 会话 ──
  const shell = sessions.get(args.session_id);
  if (!shell) {
    return { content: [text(`Session ${args.session_id} not found.`)] };
  }

  // ── 步骤 2：构造远端命令 ──
  // fullCommand 形如：
  //   cd <cwd> || { echo "___MCP_BUILD_DONE___:1"; exit 1; }; <command> 2>&1; echo "___MCP_BUILD_DONE___:$?"
  // 或（无 cwd）：
  //   <command> 2>&1; echo "___MCP_BUILD_DONE___:$?"
  //
  // 其中 cd 失败分支的 echo "___MCP_BUILD_DONE___:1" 会在 PTY 回显中出现 :1，
  // 而 :1 会被 ___MCP_BUILD_DONE___:(\d+) 正则匹配，导致误检测。
  // 因此必须在检测完成标记之前剥离 PTY 回显行（见步骤 4）。
  const fullCommand: string = buildRemoteCommand(
    args.command,
    args.cwd,
    BUILD_MARKER
  );

  // ── 步骤 3：发送命令 ──
  // 先排空残留数据，再用 clear=0（追加模式）写入命令，overflow=true 确保缓冲满时保留最新数据
  shell.drain();
  shell.write(fullCommand, 0);

  // ── 步骤 4：剥离 PTY 回显 ──
  // PTY 会将用户输入的命令原样回显，回显是发送命令后收到的第一行数据（以 \n 结尾）。
  // 回显中 cd 失败分支的 echo "___MCP_BUILD_DONE___:1" 会被后续正则误匹配，
  // 因此先剥离回显行，\n 之后的所有数据才是真实构建输出。
  let allOutput: string = "";
  let echoBuffer: string = "";
  let echoRetries = 10;
  while (echoRetries > 0) {
    echoRetries--;
    await new Promise(r => setTimeout(r, 200));
    echoBuffer += shell.drain();
    const nlIdx = echoBuffer.indexOf("\n");
    if (nlIdx !== -1) {
      allOutput = echoBuffer.substring(nlIdx + 1);
      break;
    }
  }

  // ── 步骤 5：回显剥离完成后，轮询缓冲区检测完成标记 ──
  const deadline: number = Date.now() + maxWait;
  let exitCode: number | null = null;
  const markerRegex = new RegExp(`${BUILD_MARKER}:(\\d+)`);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    allOutput += shell.drain();

    const match = allOutput.match(markerRegex);
    if (match) {
      exitCode = parseInt(match[1], 10);
      allOutput = allOutput.substring(0, allOutput.search(markerRegex)).trimEnd();
      break;
    }
  }

  // ── 步骤 6：超时处理 ──
  // 如果在截止时间内未检测到完成标记，视为编译超时
  if (exitCode === null) {
    const collector = createCollector();
    if (doClassify) {
      collectOutput(collector, allOutput);
      return {
        content: [
          text(
            `Build timed out after ${maxWait}ms.\n` +
              `Partial: ${collector.errors.length} error(s), ${collector.warnings.length} warning(s).\n\n` +
              formatBuildResult(collector, -1, allOutput, args.session_id)
          ),
        ],
      };
    }
    return {
      content: [
        text(
          `Build timed out after ${maxWait}ms.\n\nPartial output:\n${allOutput || "(no output)"}`
        ),
      ],
    };
  }

  // ── 步骤 7：构建成功/失败，格式化输出 ──
  const status: string = exitCode === 0 ? "BUILD SUCCESS" : "BUILD FAILED";
  logger.info(
    `[ssh_build] completed exitCode=${exitCode} outputLength=${allOutput.length}`
  );

  if (doClassify) {
    // 按行分类：error / warning / info
    const collector = createCollector();
    collectOutput(collector, allOutput);
    logger.info(
      `[ssh_build] classified: ${collector.errors.length} errors, ${collector.warnings.length} warnings, ${collector.info.length} info lines`
    );
    return {
      content: [
        text(
          formatBuildResult(collector, exitCode, allOutput, args.session_id)
        ),
      ],
    };
  }

  // 不分类时直接返回原始输出
  return {
    content: [
      text(
        `${status} (exit code: ${exitCode})\n\n${allOutput || "(no output)"}`
      ),
    ],
  };
}
