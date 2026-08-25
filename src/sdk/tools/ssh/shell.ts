import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../../shared/logger.js";
import { SSHShell, type SSHShellConfig } from "../../../transports/ssh.js";
import {
  getPromptPattern,
  getExecTimeoutConfig,
  getSSHConfig,
  getKeyProviderConfig,
  resolveDeviceName,
} from "../../../shared/config.js";
import {
  PshState,
  PshStateMachine,
  PSH_STATE_DESC,
} from "../../../services/psh.js";
import { KeyProvider } from "../../../services/key-provider.js";
import { sshStore } from "./sessions.js";
import {
  CONTROL_CHAR_MAP,
  type ControlChar,
  PromptDetector,
} from "../../shared/prompt-detector.js";
// 过渡期反向依赖：send-ctrl / exec-runner 仍在 mcp/shared（整体迁移为后续阶段）
import { sendControlChar } from "../../../mcp/shared/send-ctrl.js";
import { runExec } from "../../../mcp/shared/exec-runner.js";

// ── ssh_shell_open ─────────────────────────────────────────

/**
 * @brief ssh_shell_open 工具配置
 *
 * 打开一个交互式 SSH Shell 会话，返回初始 banner 输出。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param timeout  连接超时时间（秒，默认 10）
 */
export const sshShellOpenConfig: SdkToolConfig = {
  description:
    "Open an interactive SSH shell session to the board. Returns the initial banner output.",
  inputSchema: {
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
      timeout: {
        type: "number",
        description: "Connection timeout in seconds (default: 10)",
      },
    },
  },
};

/**
 * @brief ssh_shell_open 处理函数
 *
 * 流程：
 *   1. 根据设备名获取 SSH 连接配置
 *   2. 创建 SSHShell 实例并建立连接
 *   3. 读取 banner 输出
 *   4. 将 shell 存入会话表，返回 session_id
 *
 * @param args  工具参数，包含 device 和 timeout
 * @return 响应文本，包含 session_id 和 banner 内容
 */
export async function sshShellOpenHandler(args: {
  device?: string;
  timeout?: number;
}) {
  logger.info(
    `[ssh_shell_open] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 10}`
  );
  const config: SSHShellConfig = getSSHConfig(args.device);
  const deviceName = args.device ?? process.env.DEVICE ?? "default";
  config.deviceName = deviceName;

  if (config.host === "none") {
    const msg = `Device '${deviceName}' does not support SSH (host is none).`;
    logger.warn(msg);
    return msg;
  }

  const shell = new SSHShell(config);

  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = sshStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  sshStore.create(shell, {
    type: "ssh",
    deviceName,
    connectionInfo: `${config.host}:${config.port ?? 22}`,
    logPath,
  });
  logger.info(`[ssh_shell_open] session opened: ${sessionId}`);

  return `Session ${sessionId} opened.\n${banner || "(no banner)"}`;
}

// ── ssh_shell_close ─────────────────────────────────────────

/**
 * @brief ssh_shell_close 工具配置
 *
 * 关闭指定的 SSH Shell 会话并释放连接资源。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 */
export const sshShellCloseConfig: SdkToolConfig = {
  description: "Close an SSH shell session and release the connection.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief ssh_shell_close 处理函数
 *
 * 流程：
 *   1. 从会话表中查找指定 session_id
 *   2. 调用 shell.close() 关闭连接
 *   3. 从会话表中移除该条目
 *
 * @param args  工具参数，包含 session_id
 * @return 响应文本，确认会话已关闭
 */
export async function sshShellCloseHandler(args: { session_id: string }) {
  logger.info(`[ssh_shell_close] session_id=${args.session_id}`);
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  await sshStore.withLock(args.session_id, async () => {
    await shell.close();
  });
  sshStore.remove(args.session_id);

  return `Session ${args.session_id} closed.`;
}

// ── ssh_shell_write ─────────────────────────────────────────

/**
 * @brief ssh_shell_write 工具配置
 *
 * 向指定的 SSH Shell 会话发送命令。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param command     要发送的命令字符串
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const sshShellWriteConfig: SdkToolConfig = {
  description:
    "Send a command to an SSH shell session. " +
    "Do NOT call this concurrently with ssh_shell_exec/ssh_shell_read on the same session_id — " +
    "concurrent access to the same SSH shell corrupts the output buffer.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
      command: {
        type: "string",
        description: "The command to send to the shell",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
    },
    required: ["session_id", "command"],
  },
};

/**
 * @brief ssh_shell_write 处理函数
 *
 * 向远端 shell 发送命令，根据 clear 参数控制缓冲区行为。
 * 注意：此函数仅发送命令，不等待输出，需配合 ssh_shell_read 读取结果。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 clear
 * @return 响应文本，确认命令已发送
 */
export async function sshShellWriteHandler(args: {
  session_id: string;
  command: string;
  clear?: number;
}) {
  logger.info(
    `[ssh_shell_write] session_id=${args.session_id} command=${args.command} clear=${args.clear ?? 1}`
  );
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return sshStore.withLock(args.session_id, async () => {
    shell.write(args.command, args.clear ?? 1);
    return `Command sent: ${args.command}`;
  });
}

// ── ssh_shell_read ──────────────────────────────────────────

/**
 * @brief ssh_shell_read 工具配置
 *
 * 读取指定 SSH Shell 会话的输出数据。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param clear       缓冲区清空标志（1=读取后清空，0=保留缓冲区，默认 1）
 */
export const sshShellReadConfig: SdkToolConfig = {
  description:
    "Read output from an SSH shell session. " +
    "Do NOT call this concurrently with ssh_shell_exec/ssh_shell_write on the same session_id — " +
    "concurrent access to the same SSH shell corrupts the output buffer.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer after reading, 0 = keep buffer",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief ssh_shell_read 处理函数
 *
 * 从会话的内部缓冲区读取输出数据。
 * clear=1 时读取后清空缓冲区，下次 read() 返回新数据；
 * clear=0 时保留缓冲区内容，可重复读取。
 *
 * @param args  工具参数，包含 session_id 和可选的 clear
 * @return 响应文本，包含读取到的输出内容
 */
export async function sshShellReadHandler(args: {
  session_id: string;
  clear?: number;
}) {
  logger.info(
    `[ssh_shell_read] session_id=${args.session_id} clear=${args.clear ?? 1}`
  );
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return sshStore.withLock(args.session_id, async () => {
    const output = shell.read(args.clear ?? 1);
    return output || "(no output)";
  });
}

// ── ssh_shell_exec ──────────────────────────────────────────

/**
 * @brief ssh_shell_exec 工具配置
 *
 * 向 SSH Shell 会话发送命令并等待输出，合并 write + delay + read 为一次调用。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param command     要执行的命令字符串
 * @param delay       发送后等待时间（毫秒，默认 1000）
 * @param clear       缓冲区清空标志（1=清空后收集，0=追加写入，默认 1）
 */
export const sshShellExecConfig: SdkToolConfig = {
  description:
    "Send a command to an SSH shell session and wait for the output. Combines write + delay + read in one call. " +
    "IMPORTANT: Do NOT issue concurrent commands to the same session_id — the SSH shell is a single " +
    "channel; concurrent calls will interleave output and corrupt results. " +
    "Always wait for the previous command to finish before sending the next one. " +
    "If you need parallel execution, open multiple sessions via ssh_shell_open.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
      command: {
        type: "string",
        description: "The command to send to the shell",
      },
      delay: {
        type: "number",
        description:
          "Minimum polling duration in milliseconds (default: 1000), kept for backward compat",
      },
      clear: {
        type: "number",
        description:
          "Buffer clear flag: 1 (default) = clear buffer before collecting, 0 = append to buffer",
      },
      maxDuration: {
        type: "number",
        description:
          "Execution cap in ms — ALWAYS estimate and pass a timeout matching the command's expected runtime; " +
          "do not omit it. Suggested ranges: instant info commands (ls/ip addr/cat/echo) 3000-5000; " +
          "medium tasks (apt install, dd, service restart) 30000-120000; " +
          "long builds/flashes (make, flash_image) up to 600000; " +
          "streaming/resident commands (ping/logcat/top, or sampling a fixed window of live output) " +
          "10000 (Ctrl+C auto-sent to stop). If omitted, safety-valve defaults apply: " +
          "resident commands 10000ms (sampling, Ctrl+C sent on timeout), " +
          "other commands 300000ms (5min fallback, NO interrupt sent — the command may still be running, " +
          "terminate via send_ctrl if needed). Timeout type is annotated in the returned output.",
      },
    },
    required: ["session_id", "command"],
  },
};

/**
 * @brief ssh_shell_exec 处理函数
 *
 * 通过 runExec 统一编排完成命令发送、轮询、提示符检测、超时熔断。
 * 常驻命令（top/ping）超时自动采样（发 Ctrl+C，返回采样超时标注）；
 * 普通命令靠提示符检测返回，仅提示符未匹配时走兜底超时（不发 Ctrl+C，返回兜底超时标注）。
 *
 * @param args  工具参数，包含 session_id、command 和可选的 delay、clear、maxDuration
 * @return 响应文本，包含命令执行后的输出内容（超时时按类型追加采样/兜底超时标注）
 */
export async function sshShellExecHandler(args: {
  session_id: string;
  command: string;
  delay?: number;
  clear?: number;
  maxDuration?: number;
}) {
  const delayVal = args.delay ?? 1000;
  const clearVal = args.clear ?? 1;
  const maxDurationVal = args.maxDuration;
  logger.info(
    `[ssh_shell_exec] session_id=${args.session_id} command=${args.command} delay=${delayVal} clear=${clearVal} maxDuration=${maxDurationVal ?? "(default)"}`
  );
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  const deviceName = resolveDeviceName();

  const promptDetector = new PromptDetector(getPromptPattern(deviceName));

  const execTimeoutConfig = getExecTimeoutConfig(deviceName);

  const sendCtrl = (key: ControlChar): void => {
    shell.write(CONTROL_CHAR_MAP[key], 1, false);
  };

  return sshStore.withLock(args.session_id, async () => {
    const execResult = await runExec({
      shell,
      command: args.command,
      delay: delayVal,
      clear: clearVal,
      maxDuration: maxDurationVal,
      promptDetector,
      sendCtrl,
      logPrefix: "[ssh_shell_exec]",
      execTimeoutConfig,
    });

    let output = execResult.output;
    if (execResult.timeoutKind === "none" && execResult.exitCode !== null) {
      output =
        (output ? output + "\n" : "") +
        `[exit code: ${execResult.exitCode}]`;
    } else if (execResult.timeoutKind === "sampling") {
      output =
        (output ? output + "\n" : "") +
        `[采样超时: 已收集 ${execResult.elapsedMs}ms 输出，已发送 Ctrl+C 终止常驻命令]`;
    } else if (execResult.timeoutKind === "fallback") {
      output =
        (output ? output + "\n" : "") +
        `[兜底超时: 已收集 ${execResult.elapsedMs}ms 输出，未发送中断（命令可能仍在运行），请用 send_ctrl 手动确认/终止]`;
    }

    return output || "(no output)";
  });
}

// ── ssh_shell_send_ctrl ─────────────────────────────────────

/**
 * @brief 控制字符可读名称映射（用于返回信息展示）
 */
const CTRL_LABEL: Readonly<Record<ControlChar, string>> = {
  c: "Ctrl+C",
  u: "Ctrl+U",
  d: "Ctrl+D",
  z: "Ctrl+Z",
};

/**
 * @brief ssh_shell_send_ctrl 工具配置
 *
 * 向 SSH Shell 会话发送控制字符（不追加换行），用于终止/控制前台命令。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 * @param key         控制字符类型：c(Ctrl+C)/u(Ctrl+U)/d(Ctrl+D)/z(Ctrl+Z)
 */
export const sshShellSendCtrlConfig: SdkToolConfig = {
  description:
    "Send a control character (Ctrl+C/U/D/Z) to an SSH shell session without appending a newline.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
      key: {
        type: "string",
        enum: ["c", "u", "d", "z"],
        description:
          "Control character: c=Ctrl+C(SIGINT), u=Ctrl+U(clear line), d=Ctrl+D(EOF), z=Ctrl+Z(suspend)",
      },
    },
    required: ["session_id", "key"],
  },
};

/**
 * @brief ssh_shell_send_ctrl 处理函数
 *
 * 复用共享 sendControlChar，以不追加换行的方式发送控制字符。
 *
 * @param args  工具参数，包含 session_id 和 key
 * @return 响应文本，确认控制字符已发送
 */
export async function sshShellSendCtrlHandler(args: {
  session_id: string;
  key: ControlChar;
}) {
  logger.info(
    `[ssh_shell_send_ctrl] session_id=${args.session_id} key=${args.key}`
  );
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return sshStore.withLock(args.session_id, async () => {
    const byte = await sendControlChar(shell, args.key);
    const label = CTRL_LABEL[args.key];
    return `${label} sent (${byte})`;
  });
}

// ── ssh_connections ────────────────────────────────────────

/**
 * @brief ssh_connections 工具配置
 *
 * 检查远端板卡上活跃的 SSH 连接，显示连接到 SSH 服务（端口 22）的客户端 IP。
 *
 * @param session_id  由 ssh_shell_open 返回的会话 ID
 */
export const sshConnectionsConfig: SdkToolConfig = {
  description:
    "Check active SSH connections on the remote board. Shows which client IPs are connected to the SSH service (port 22).",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_shell_open",
      },
    },
    required: ["session_id"],
  },
};

/**
 * @brief ssh_connections 处理函数
 *
 * 依次尝试 netstat、ss、/proc/net/tcp 三种方式获取 SSH 连接信息，
 * 首个返回有效结果的命令即停止，兼容不同嵌入式 Linux 环境。
 *
 * @param args  工具参数，包含 session_id
 * @return 响应文本，包含 SSH 连接信息
 */
export async function sshConnectionsHandler(args: { session_id: string }) {
  logger.info(`[ssh_shell_connection] session_id=${args.session_id}`);
  const shell = sshStore.get(args.session_id);
  if (!shell) {
    return `Session ${args.session_id} not found.`;
  }

  return sshStore.withLock(args.session_id, async () => {
    const commands = [
      "netstat -tn 2>/dev/null | grep :22",
      "ss -tn 2>/dev/null | grep :22",
      "cat /proc/net/tcp",
    ];

    let output = "";
    for (const cmd of commands) {
      shell.write(cmd, 1);
      await new Promise((r) => setTimeout(r, 1000));
      output = shell.read(1).trim();
      if (
        output &&
        !output.includes("not found") &&
        !output.includes("command not found")
      ) {
        break;
      }
    }

    return output || "No SSH connection info available.";
  });
}

// ── ssh_shell_login ──────────────────────────────────────────

/**
 * @brief ssh_shell_login 工具配置
 *
 * 一键登录 SSH：自动连接、检测 PSH 状态、如锁定则自动解锁，返回就绪会话。
 * 将 open + PSH 检测 + 解锁合并为单次调用，适用于需要快速获取可用 shell 的场景。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param key      解锁密钥（可选，提供时直接使用；未提供时走 KeyProvider 获取）
 * @param timeout  解锁步骤间等待时间（毫秒，默认 1500）
 */
export const sshShellLoginConfig: SdkToolConfig = {
  description:
    "One-click SSH login: connect, detect PSH state, auto-unlock if locked, and return a ready session. Combines open + PSH detect + unlock into a single call.",
  inputSchema: {
    type: "object",
    properties: {
      device: {
        type: "string",
        description: "Device name (optional, defaults to the active device)",
      },
      key: {
        type: "string",
        description:
          "Unlock key/password. If not provided, uses the configured KeyProvider (file IPC or terminal prompt)",
      },
      timeout: {
        type: "number",
        description: "Unlock step delay in milliseconds (default: 1500)",
      },
    },
  },
};

/**
 * @brief ssh_shell_login 处理函数 — 一键登录
 *
 * 使用 PshStateMachine 状态机驱动 profile 匹配、状态检测与解锁：
 *   1. 建立 SSH 连接，读取 banner
 *   2. 状态机 start(banner) → 自动匹配 profile
 *   3. 未匹配到则发探测 → feed(channel, output) → 再次匹配
 *   4. 匹配成功后自动 detect 状态 → UNKNOWN 时自动 probeState
 *   5. 状态明确后根据终态决定解锁或直接返回可用 session
 *
 * key 参数说明：
 *   - 传入 key：直接使用该密钥解锁，适用于密钥已知的自动化场景
 *   - 不传 key：通过 KeyProvider（文件 IPC 或终端提示）获取密钥，
 *     适用于交互式或外部工具提供密钥的场景
 *
 * @param args  工具参数，包含可选的 device、key 和 timeout
 * @return 响应文本，包含 session_id 和登录结果信息
 */
export async function sshShellLoginHandler(args: {
  device?: string;
  key?: string;
  timeout?: number;
}) {
  logger.info(
    `[ssh_shell_login] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 1500} key=${args.key ? "***" : "(none)"}`
  );
  const config: SSHShellConfig = getSSHConfig(args.device);
  const deviceName = args.device ?? process.env.DEVICE ?? "default";
  config.deviceName = deviceName;

  if (config.host === "none") {
    const msg = `Device '${deviceName}' does not support SSH (host is none).`;
    logger.warn(msg);
    return msg;
  }

  const stepDelay = args.timeout ?? 1500;

  // 预览 session id（= create 生成的 id），用于提前获取锁
  const lockId = sshStore.peekNextId();

  // 整个流程（open → 探测 → 解锁）都在锁保护内，
  // 避免注册到 store 后并发 exec/write/read 污染探测过程
  return sshStore.withLock(lockId, () =>
    sshShellLoginInner(args, config, deviceName, stepDelay)
  );
}

/**
 * @brief ssh_shell_login 的内部实现（在 session 锁保护内执行）
 */
async function sshShellLoginInner(
  args: { device?: string; key?: string; timeout?: number },
  config: SSHShellConfig,
  deviceName: string,
  stepDelay: number
) {
  // ===== 步骤 1：建立 SSH 连接 =====
  const shell = new SSHShell(config);
  let banner: string;
  try {
    banner = await shell.open();
  } catch (err) {
    return `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // open 成功后立即注册会话，确保后续解锁/探测过程可被其他工具访问
  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = sshStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  sshStore.create(shell, {
    type: "ssh",
    deviceName,
    connectionInfo: `${config.host}:${config.port ?? 22}`,
    logPath,
  });
  logger.info(`[ssh_shell_login] session opened: ${sessionId}`);

  // ===== 步骤 2~3：状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("ssh");
  let action = sm.start(banner);

  while (!action.done) {
    shell.write(action.send!, 1);
    await new Promise((r) => setTimeout(r, action.waitMs));
    const output = shell.read(1);
    action = await sm.feed(shell, output);
  }

  // ===== 步骤 4：根据状态机终态决定后续动作 =====
  const handler = action.handler;
  logger.info(
    `[ssh_shell_login] PshSM 检测完成 → state=${action.state} (${PSH_STATE_DESC[action.state]}), profile=${handler?.profile.name ?? "(无)"}`
  );

  switch (action.state) {
    case PshState.LOCKED: {
      if (!handler) {
        logger.warn(`[ssh_shell_login] PSH 已锁定但无匹配 handler, 关闭连接`);
        await shell.close();
        sshStore.remove(sessionId);
        return "PSH detected as LOCKED but no handler available.";
      }

      // key 参数决定密钥获取方式：
      //   传入 key → 直接使用，不走 KeyProvider 回调
      //   未传 key → 通过 KeyProvider（文件 IPC 或终端提示）获取
      const unlockKey = args.key ?? "";
      const onKeyRequest = args.key
        ? undefined
        : (output: string) => {
            const keyProvider = new KeyProvider(
              getKeyProviderConfig("ssh", args.device)
            );
            return keyProvider.getKey(output);
          };

      logger.info(
        `[ssh_shell_login] 开始解锁 (profile=${handler.profile.name}, key=${args.key ? "已提供" : "走KeyProvider"})`
      );
      const result = await handler.unlock(
        shell,
        unlockKey,
        stepDelay,
        onKeyRequest
      );

      if (result.success) {
        logger.info(`[ssh_shell_login] 解锁成功, session=${sessionId}`);
        return `Session ${sessionId} opened (PSH unlock succeeded).\nProfile: ${handler.profile.name}\nChallenge: ${result.challengeCode ?? "(none)"}`;
      }

      logger.error(
        `[ssh_shell_login] 解锁失败, state=${result.state}, error=${result.error ?? "无"}`
      );
      await shell.close();
      sshStore.remove(sessionId);
      return `PSH unlock failed.\nState: ${result.state}\nChallenge: ${result.challengeCode ?? "(none)"}\nAttempts left: ${result.attemptsLeft ?? "(unknown)"}\nError: ${result.error ?? "(none)"}`;
    }

    case PshState.READY: {
      logger.info(
        `[ssh_shell_login] shell已可用, session=${sessionId}, profile=${handler?.profile.name ?? "(无)"}`
      );
      return `Session ${sessionId} opened (PSH already unlocked).\nProfile: ${handler?.profile.name ?? "(none)"}`;
    }

    case PshState.UNLOCKING: {
      if (!args.key) {
        logger.warn(
          `[ssh_shell_login] PSH处于UNLOCKING状态但未提供密钥, 关闭连接`
        );
        await shell.close();
        sshStore.remove(sessionId);
        return "PSH is in UNLOCKING state (dangling password prompt). Provide a key to complete login.";
      }
      logger.info(
        `[ssh_shell_login] PSH处于UNLOCKING状态, 使用提供的密钥完成解锁`
      );
      shell.write(args.key, 1);
      await new Promise((r) => setTimeout(r, stepDelay));
      const output = shell.read(1);
      const finalState = handler
        ? handler.detectState(output)
        : PshState.UNKNOWN;
      if (finalState === PshState.READY) {
        logger.info(
          `[ssh_shell_login] UNLOCKING状态解锁成功, session=${sessionId}`
        );
        return `Session ${sessionId} opened (PSH unlock completed from UNLOCKING state).\nProfile: ${handler?.profile.name ?? "(none)"}`;
      }
      logger.error(
        `[ssh_shell_login] UNLOCKING状态解锁失败, finalState=${finalState}`
      );
      await shell.close();
      sshStore.remove(sessionId);
      return `PSH unlock from UNLOCKING state failed. State: ${finalState}\nOutput: ${output}`;
    }

    case PshState.ERROR: {
      logger.error(`[ssh_shell_login] PSH处于ERROR状态, 关闭连接`);
      await shell.close();
      sshStore.remove(sessionId);
      return "PSH is in ERROR state (previous unlock may have failed). Close and retry.";
    }

    default: {
      // UNKNOWN 或其他未明确状态
      logger.info(
        `[ssh_shell_login] PSH状态不明, session=${sessionId}, 可能需手动交互`
      );
      return `Session ${sessionId} opened (PSH state unknown, shell may need manual interaction).\nProfile: ${handler?.profile.name ?? "(none)"}\nBanner: ${banner}`;
    }
  }
}
