/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : login.ts
 * Author     : sumu
 * Date       : 2026/08/25
 * Version    : x.x.x
 * Description: Serial 一键登录 SDK 工具（协议无关，MCP 注册见 src/mcp/tools.ts）
 *
 *   serial_shell_login：open + PSH 检测/解锁 + getty 用户登录三合一。
 *   PSH 状态机与用户登录序列的编排逻辑，以及会话注册辅助均在此文件。
 * ======================================================
 */

import type { SdkToolConfig } from "../../types.js";
import { logger } from "../../shared/logger.js";
import { getSerialConfig, getKeyProviderConfig } from "../../shared/config.js";
import {
  SerialShell,
  type SerialShellConfig,
} from "../../transports/serial.js";
import {
  PshState,
  PshStateMachine,
  PshHandler,
  PSH_STATE_DESC,
} from "../../auth/psh.js";
import { UserLoginHandler, UserLoginStatus } from "../../auth/user-login.js";
import { KeyProvider } from "../../auth/key-provider.js";
import { serialStore, portToSession, clearUbootSession } from "./sessions.js";
import { CONTROL_CHAR_MAP, UbootDetector } from "../../exec/prompt-detector.js";
import { getUbootConfig } from "../../shared/config.js";

// ── serial_shell_login ──────────────────────────────────────────

/**
 * @brief serial_shell_login 工具配置
 *
 * 一键登录串口：自动连接、检测 PSH 状态、如锁定则自动解锁，返回就绪会话。
 * 将 open + PSH 检测 + 解锁合并为单次调用，适用于需要快速获取可用串口 shell 的场景。
 *
 * @param device   设备名（可选，默认使用当前活跃设备）
 * @param key      解锁密钥（可选，提供时直接使用；未提供时走 KeyProvider 获取）
 * @param timeout  解锁步骤间等待时间（毫秒，默认 1500）
 */
export const serialShellLoginConfig: SdkToolConfig = {
  description:
    "One-click serial login: connect, detect PSH state, auto-unlock if locked, and return a ready session. Combines open + PSH detect + unlock into a single call.",
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
 * @brief serial_shell_login 处理函数 — 串口一键登录
 *
 * 使用 PshStateMachine 状态机替代手动 if-else 探测逻辑：
 *   1. 打开串口（或复用已有 session），读取 banner
 *   2. 状态机自动完成 profile 匹配 + 状态检测（含探测/二次确认）
 *   3. 根据状态机终态分支处理：
 *      - READY       → PSH 已解锁或无 PSH，直接返回可用 session
 *      - LOCKED      → 执行解锁序列（key 参数直接传入，或走 KeyProvider 回调）
 *      - UNLOCKING   → 悬挂的密码提示，提供 key 完成输入
 *      - ERROR       → 前次解锁失败，关闭连接并提示
 *      - UNKNOWN     → 状态不明，返回 session 但可能需手动交互
 *   4. 解锁成功后将 shell 存入会话表，返回 session_id
 *
 * key 参数说明：
 *   - 传入 key：直接使用该密钥解锁，适用于密钥已知的自动化场景
 *   - 不传 key：通过 KeyProvider（文件 IPC 或终端提示）获取密钥，
 *     适用于交互式或外部工具提供密钥的场景
 *
 * @param args  工具参数，包含可选的 device、key 和 timeout
 * @return MCP 响应，包含 session_id 和登录结果信息
 */
export async function serialShellLoginHandler(args: {
  device?: string;
  key?: string;
  timeout?: number;
}) {
  logger.info(
    `[serial_shell_login] device=${args.device ?? "(default)"} timeout=${args.timeout ?? 1500} key=${args.key ? "***" : "(none)"}`
  );
  const deviceName = args.device ?? process.env.DEVICE ?? "default";
  const baseConfig: SerialShellConfig = getSerialConfig(args.device);

  if (baseConfig.port === "none") {
    const msg = `Device '${deviceName}' does not support serial (port is none).`;
    logger.warn(msg);
    return msg;
  }

  const stepDelay = args.timeout ?? 1500;

  // ===== 打开串口（或复用已有 session）=====
  const existingId = portToSession.get(baseConfig.port);

  // 锁的 sessionId：复用已有 session 用 existingId，新建 session 用预览 id（= create 生成的 id）
  const lockId = existingId ?? serialStore.peekNextId();

  // 整个 session 操作流程（open/复用 → 探测 → 解锁 → 注册）都在锁保护内，
  // 避免并发 exec/write/read/send_ctrl 注入命令或污染 buffer
  return serialStore.withLock(lockId, () =>
    serialShellLoginInner(args, deviceName, baseConfig, stepDelay, existingId)
  );
}

/**
 * @brief serial_shell_login 的内部实现（在 session 锁保护内执行）
 *
 * 从 session 复用/新建判定到最终注册返回的完整流程。所有 shell 操作
 * （read/write/sendRaw/状态机探测/解锁序列）都在调用方的 withLock 保护内。
 */
async function serialShellLoginInner(
  args: { device?: string; key?: string; timeout?: number },
  deviceName: string,
  baseConfig: SerialShellConfig,
  stepDelay: number,
  existingId: string | undefined
) {
  let newSessionId: string | undefined;
  let shell: SerialShell;
  let banner: string;

  // 失败时清理新建会话的辅助函数
  const cleanupNewSession = async (): Promise<void> => {
    if (newSessionId) {
      await shell.close();
      serialStore.remove(newSessionId);
      portToSession.delete(baseConfig.port);
    }
  };

  if (existingId && serialStore.get(existingId)) {
    shell = serialStore.get(existingId)!;
    banner = shell.read(0);
  } else {
    shell = new SerialShell({
      port: baseConfig.port,
      baudRate: baseConfig.baudRate,
      dataBits: baseConfig.dataBits as 8 | 5 | 6 | 7 | undefined,
      stopBits: baseConfig.stopBits as 1 | 1.5 | 2 | undefined,
      parity: baseConfig.parity as "none" | "even" | "odd" | undefined,
      lineEnding: baseConfig.lineEnding,
      deviceName,
    });
    try {
      banner = await shell.open();
    } catch (err) {
      return `Serial open failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    // open 成功后立即注册会话并启用日志，确保解锁/探测过程的串口数据被保存
    // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
    const newId = serialStore.peekNextId();
    const logPath = shell.fileLogger.enableFromEnv(newId, deviceName);
    serialStore.create(shell, {
      type: "serial",
      deviceName,
      connectionInfo: `${baseConfig.port} @ ${baseConfig.baudRate ?? 115200}`,
      logPath,
    });
    newSessionId = newId;
    portToSession.set(baseConfig.port, newId);
  }

  // ── U-Boot 标记前置同步（登录交互发生之前，2026-08-28 issue #36）──
  // 与 serialExecHandler 自校正同思路：banner（复用会话为 read(0) 非破坏
  // 读取，包含之前缓冲区未消费的全部内容；新建会话经 open() 采集后缓冲
  // 区为空）里含内核启动特征（Starting kernel / Linux version）即证明设
  // 备已离开 U-Boot，直接清除标记。登录后续各阶段（唤醒/探测/状态机
  // feed/登录序列）都是消费性读取，证据一旦被吞事后校正失据，故判定必
  // 须在消费前完成。
  syncUbootMarkFromBanner(shell, banner, existingId);

  // ===== 用户登录判定（先于 PSH 探测，二者互斥）=====
  // 正常系统登录（getty/login）停在 "login:" 提示符；PSH 设备提示符为 locked> / #，
  // 不会出现 login:。先发一个回车唤醒 getty 重绘 login: 提示符（对 shell / PSH 无害），
  // 命中 login: 则走用户名/密码登录；否则照常走 PSH 状态机。
  if (await detectUserLoginPrompt(shell, banner, stepDelay)) {
    logger.info(`[serial_shell_login] 检测到 login: 提示符, 走用户登录`);
    return performUserLogin(
      shell,
      baseConfig,
      existingId,
      deviceName,
      stepDelay
    );
  }

  // ===== 状态机驱动 profile 匹配 + 状态检测 =====
  const sm = new PshStateMachine("serial");
  let action = sm.start(banner);

  while (!action.done) {
    shell.write(action.send!, 1);
    await new Promise((r) => setTimeout(r, action.waitMs));
    const probeOut = shell.read(1);
    // 探测命令被 login 提示符当用户名吞掉 → 转用户登录
    if (probeOut && isLoginPrompt(probeOut)) {
      return performUserLogin(
        shell,
        baseConfig,
        existingId,
        deviceName,
        stepDelay
      );
    }
    action = await sm.feed(shell, probeOut);
  }

  const handler = action.handler;
  logger.info(
    `[serial_shell_login] PshSM 检测完成 → state=${action.state} (${PSH_STATE_DESC[action.state]}), profile=${handler?.profile.name ?? "(无)"}`
  );

  // ===== 根据状态机终态分支处理 =====

  // --- 已解锁 / 无 PSH ---
  if (action.state === PshState.READY) {
    logger.info(
      `[serial_shell_login] shell已可用, profile=${handler?.profile.name ?? "(无)"}`
    );
    const detail = handler
      ? `(PSH already unlocked)\nProfile: ${handler.profile.name}`
      : "(no PSH detected, shell is ready)";
    return registerSession(
      shell,
      baseConfig.port,
      existingId,
      deviceName,
      detail
    );
  }

  // --- 解锁中：悬挂的密码提示，需 key 完成输入 ---
  if (action.state === PshState.UNLOCKING) {
    // 兜底：若 PshSM 误判（探测被 login 提示符当用户名/密码吞掉），
    // 而设备配置了 loginUsername/loginPassword，则转用户登录流程
    if (baseConfig.loginUsername && baseConfig.loginPassword) {
      logger.info(
        `[serial_shell_login] UNLOCKING但配置了login凭据, 转用户登录`
      );
      return performUserLogin(
        shell,
        baseConfig,
        existingId,
        deviceName,
        stepDelay
      );
    }
    if (!args.key) {
      logger.warn(`[serial_shell_login] PSH处于UNLOCKING状态但未提供密钥`);
      if (!existingId) {
        await cleanupNewSession();
      }
      return "PSH is in UNLOCKING state (dangling password prompt). Provide a key to complete login.";
    }
    logger.info(
      `[serial_shell_login] PSH处于UNLOCKING状态, 使用提供的密钥完成解锁`
    );
    shell.write(args.key, 1);
    await new Promise((r) => setTimeout(r, stepDelay));
    const output = shell.read(1);
    const state = handler?.detectState(output) ?? PshState.UNKNOWN;
    if (state === PshState.READY) {
      logger.info(`[serial_shell_login] UNLOCKING状态解锁成功`);
      return registerSession(
        shell,
        baseConfig.port,
        existingId,
        deviceName,
        `(PSH unlock completed from UNLOCKING state)\nProfile: ${handler!.profile.name}`
      );
    }
    logger.error(
      `[serial_shell_login] UNLOCKING状态解锁失败, finalState=${state}`
    );
    if (!existingId) await shell.close();
    return `PSH unlock from UNLOCKING state failed. State: ${state}\nOutput: ${output}`;
  }

  // --- 错误状态：前次解锁失败 ---
  if (action.state === PshState.ERROR) {
    logger.error(`[serial_shell_login] PSH处于ERROR状态`);
    if (!existingId) await shell.close();
    return "PSH is in ERROR state (previous unlock may have failed). Close and retry.";
  }

  // --- 锁定状态：执行解锁序列 ---
  if (action.state === PshState.LOCKED) {
    if (!handler) {
      logger.warn(`[serial_shell_login] PSH已锁定但无匹配handler`);
      if (!existingId) {
        await cleanupNewSession();
      }
      return "PSH LOCKED but no matching handler found.";
    }

    const unlockKey = args.key ?? "";
    const onKeyRequest = args.key
      ? undefined
      : (output: string) => {
          const keyProvider = new KeyProvider(
            getKeyProviderConfig("serial", args.device)
          );
          return keyProvider.getKey(output);
        };

    logger.info(
      `[serial_shell_login] 开始解锁 (profile=${handler.profile.name}, key=${args.key ? "已提供" : "走KeyProvider"})`
    );
    const result = await handler.unlock(
      shell,
      unlockKey,
      stepDelay,
      onKeyRequest
    );

    if (result.success) {
      logger.info(`[serial_shell_login] 解锁成功`);
      return registerSession(
        shell,
        baseConfig.port,
        existingId,
        deviceName,
        `(PSH unlock succeeded)\nProfile: ${handler.profile.name}\nChallenge: ${result.challengeCode ?? "(none)"}`
      );
    }

    logger.error(
      `[serial_shell_login] 解锁失败, state=${result.state}, error=${result.error ?? "无"}`
    );
    if (!existingId) await shell.close();
    return `PSH unlock failed.\nState: ${result.state}\nChallenge: ${result.challengeCode ?? "(none)"}\nAttempts left: ${result.attemptsLeft ?? "(unknown)"}\nError: ${result.error ?? "(none)"}`;
  }

  // --- 未知状态：探测后仍无法判断，返回 session 但可能需手动交互 ---
  logger.info(`[serial_shell_login] PSH状态不明, 可能需手动交互`);
  const detail = handler
    ? `(PSH state unknown)\nProfile: ${handler.profile.name}`
    : "(PSH state unknown)";
  return registerSession(
    shell,
    baseConfig.port,
    existingId,
    deviceName,
    detail
  );
}

/**
 * @brief 登录前置：banner 含内核启动特征即清除 U-Boot 标记（零副作用）
 *
 * 与 serialExecHandler 的自校正（shell.ts: matchKernelBoot(execResult.
 * flushed + execResult.output)）同一判据：缓冲区里存在 Starting kernel /
 * Linux version 即证明设备已越过 U-Boot，清除会话标记，后续 serial_exec
 * 恢复 subshell 包装。
 *
 * banner 来源与证据范围：
 *   - 复用会话：read(0) 非破坏读取，天然包含之前缓冲区未消费的全部内容
 *     （issue #36：U-Boot 下 reset 重启后约 1.7 万字节内核日志滞留 buffer，
 *     命中即清标记）
 *   - 新建会话：open() 采集 banner 后缓冲区为空，通常不命中；且新会话
 *     ID 无残留标记，本函数此时为空操作
 *
 * 只做正向清标记，不做反向补设：U-Boot 下回显可伪造各类输出，而 kernel
 * 启动特征无法在 U-Boot 会话中自然出现，采信无误伤风险。
 *
 * @param shell       会话 shell（此时尚未发生任何登录交互）
 * @param banner      连接/复用时采集到的缓冲区内容
 * @param existingId  复用会话 ID（新建会话时为 undefined，直接跳过）
 */
function syncUbootMarkFromBanner(
  shell: SerialShell,
  banner: string,
  existingId: string | undefined
): void {
  if (!existingId || !banner) {
    return;
  }
  try {
    const detector = new UbootDetector(getUbootConfig(shell.getDeviceName()));
    if (detector.matchKernelBoot(banner)) {
      clearUbootSession(existingId);
      logger.info(
        `[serial_shell_login] kernel boot evidence in banner, cleared U-Boot mark for session ${existingId}`
      );
    }
  } catch (err) {
    // uboot 配置含非法正则时不应阻断登录主流程，跳过本次同步
    logger.warn(
      `[serial_shell_login] uboot config error, skip mark sync: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * @brief login: 提示符判定正则（正常系统登录，getty/login 标准提示符）
 *
 * 匹配行尾的 "login:"（getty 的标准用户名提示）。PSH 设备提示符为 locked> / #，
 * 不会命中此正则，因此可作为用户登录与 PSH 的互斥判定条件。
 */
const LOGIN_PROMPT_RE = /login:\s*$/im;

/**
 * @brief 判定一段终端输出是否停在 "login:" 提示符
 *
 * 纯文本判定，不产生任何终端交互（不发命令、不读端口）。
 *
 * @param text 终端累积输出
 * @returns true = 已停在 login: 提示符（需走用户登录）
 */
function isLoginPrompt(text: string): boolean {
  return LOGIN_PROMPT_RE.test(text);
}

/**
 * @brief 探测终端是否处于用户登录提示符（先于 PSH 探测的互斥判定）
 *
 * 流程：
 *   1. banner 已含 "login:" → 直接判定命中（不打扰终端）
 *   2. banner 匹配 PSH profile → 判定不命中（PSH 设备优先走 PSH 流程）
 *   3. 否则发一个回车唤醒 getty 重绘 login: 提示符（对 shell / PSH 无害），
 *      再结合唤醒输出判定
 *
 * @param shell     串口 shell 实例
 * @param banner    连接后读取到的初始输出
 * @param stepDelay 唤醒后的等待时间（毫秒）
 * @returns true = 终端处于 login: 提示符，应走用户登录
 */
async function detectUserLoginPrompt(
  shell: SerialShell,
  banner: string,
  stepDelay: number
): Promise<boolean> {
  if (isLoginPrompt(banner)) {
    return true;
  }
  if (PshHandler.matchFromOutput(banner, "serial")) {
    return false;
  }
  shell.write("", 1);
  await new Promise((r) => setTimeout(r, stepDelay));
  const wakeOut = shell.read(1);
  return !!wakeOut && isLoginPrompt(banner + "\n" + wakeOut);
}

/**
 * @brief 串口用户名/密码登录（正常系统登录，非 PSH）
 *
 * 终端停在 "login:" 提示符（getty/login 标准登录）时调用。
 * 复用 UserLoginHandler 的登录序列：发用户名 → 等待 Password: → 发密码 → 探测验证。
 * 登录成功后注册会话并返回，失败时关闭新建会话并返回错误信息。
 *
 * @param shell     串口 shell 实例
 * @param config    串口配置（需含 loginUsername / loginPassword）
 * @param existingId 已有会话 ID（复用时不关闭）
 * @param deviceName 设备名
 * @param stepDelay 步骤间等待时间（毫秒）
 * @return MCP 响应，成功含 session_id，失败含原因
 */
async function performUserLogin(
  shell: SerialShell,
  config: SerialShellConfig,
  existingId: string | undefined,
  deviceName: string,
  stepDelay: number
) {
  const username = config.loginUsername ?? "";
  const password = config.loginPassword ?? "";
  if (!username || !password) {
    logger.warn(
      `[serial_shell_login] 用户登录失败: 未配置 loginUsername/loginPassword`
    );
    if (!existingId) await shell.close();
    return "User login required but loginUsername/loginPassword not configured for this device.";
  }

  logger.info(`[serial_shell_login] 用户登录开始 (username=${username})`);

  // 终端复位：若探测命令被 login 提示符当用户名吞掉，终端停在 Password:。
  // 发送 Ctrl+C 中止当前登录并返回 login:，避免用户名被当成密码输入。
  const danglingPassword = /Password:\s*$/im;
  let pending = shell.read(0);
  for (
    let attempt = 0;
    attempt < 3 && danglingPassword.test(pending);
    attempt++
  ) {
    logger.info(
      `[serial_shell_login] 检测到悬挂的 Password:, 发 Ctrl+C 复位登录`
    );
    shell.write(CONTROL_CHAR_MAP["c"], 1, false);
    await new Promise((r) => setTimeout(r, stepDelay));
    pending = shell.read(1);
  }

  const handler = new UserLoginHandler({ username, password });
  const stepDelays: Record<string, number> = {
    [UserLoginStatus.WAITING_PASSWORD]: stepDelay,
    [UserLoginStatus.LOGGED_IN]: stepDelay,
  };
  const result = await handler.login(shell, undefined, stepDelays);

  if (!result.success) {
    logger.error(
      `[serial_shell_login] 用户登录失败, status=${result.status}, error=${result.error ?? "无"}`
    );
    if (!existingId) await shell.close();
    return `User login failed.\nStatus: ${result.status}\nError: ${result.error ?? "(none)"}\nOutput: ${result.output}`;
  }

  logger.info(`[serial_shell_login] 用户登录成功`);
  return registerSession(
    shell,
    config.port,
    existingId,
    deviceName,
    `(user login succeeded)\nUser: ${username}`
  );
}

/** 注册 session（复用已有或新建），返回统一的 MCP 响应 */
function registerSession(
  shell: SerialShell,
  port: string,
  existingId: string | undefined,
  deviceName: string,
  detail: string
) {
  // 若已通过 portToSession 注册（如提前在 shell.login 中注册），直接复用
  const registeredId = existingId ?? portToSession.get(port);
  if (registeredId && serialStore.get(registeredId)) {
    logger.info(
      `[serial_shell_login] session reused: ${registeredId} port=${port}`
    );
    return `Session ${registeredId} on ${port} (existing, ${detail})`;
  }
  // 先用预览 ID 建日志文件拿到路径，再 create 一次性写入元数据（含 logPath）
  const sessionId = serialStore.peekNextId();
  const logPath = shell.fileLogger.enableFromEnv(sessionId, deviceName);
  serialStore.create(shell, {
    type: "serial",
    deviceName,
    connectionInfo: `${port} @ ${shell.getPort()}`,
    logPath,
  });
  portToSession.set(port, sessionId);
  logger.info(`[serial_shell_login] session opened: ${sessionId} port=${port}`);
  return `Session ${sessionId} opened on ${port} ${detail}`;
}
