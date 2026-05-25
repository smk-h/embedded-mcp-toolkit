/**
 * PSH (Protect Shell) 终端状态枚举
 *
 * PSH 是嵌入式设备上的锁定 shell，启动后限制可用命令，
 * 需要通过特定流程（如 debug + 密码）解锁后才能获得完整 shell。
 *
 * 状态流转：
 *   LOCKED → (发送 debug) → UNLOCKING → (输入密码) → READY
 *                                              ↘ ERROR (密码错误，回到 LOCKED)
 */
export enum PshState {
  /** 已解锁，拥有完整 shell 权限 */
  READY = "ready",
  /** 锁定状态，只能执行受限命令（如 help、debug、dmesg） */
  LOCKED = "locked",
  /** 解锁中，正在等待用户输入密码/密钥 */
  UNLOCKING = "unlocking",
  /** 解锁出错（密码错误、输入无效等） */
  ERROR = "error",
  /** 无法判断当前状态 */
  UNKNOWN = "unknown",
}

/**
 * 解锁序列中的单步操作
 *
 * PSH 解锁通常需要多步交互，每步包含：发送内容 → 等待响应 → 匹配期望。
 * 例如 psh_busybox 的解锁序列：
 *   步骤1: send="debug" → 期望匹配 "Password:"
 *   步骤2: send=密钥(userInput) → 期望匹配 "Enter Debug Mode"
 */
export interface PshUnlockStep {
  /** 要发送的命令（userInput 步骤留空，由 unlock() 的 key 参数填充） */
  send: string;
  /** 发送后期望匹配的正则（用于判断该步是否成功） */
  expectPattern: string;
  /** 本步超时（毫秒） */
  timeoutMs: number;
  /** 步骤描述 */
  description: string;
  /** 是否为用户输入步骤（密钥），true 时 send 字段忽略，改用 key 参数 */
  userInput?: boolean;
}

/**
 * PSH Profile 行为特性配置
 *
 * 不同 PSH 设备可能有细微行为差异，通过 features 声明式描述，
 * 让解锁逻辑根据特性做条件分支，而非硬编码设备名判断。
 */
export interface PshFeatures {
  /** 非 TTY 环境下是否可绕过（某些 PSH 在非交互终端下行为不同） */
  bypassOnNonTty?: boolean;
  /** 输出中是否含信号干扰字符（串口连接时某些设备会混入控制字符） */
  signalResistant?: boolean;
}

/**
 * PSH Profile 配置
 *
 * 不同版本的 PSH 有不同的提示符、错误信息、Challenge 格式，
 * 通过 profile 将这些差异配置化，使 PshHandler 能适配多种 PSH 变体。
 * SSH 和串口共用同一个 profile，因为 PSH 的行为与传输层无关。
 */
export interface PshProfile {
  name: string;
  description: string;
  /** 各状态的正则匹配模式，用于从终端输出中识别当前 PSH 状态 */
  statePatterns: {
    /** 已解锁的特征（如 "built-in shell (ash)"、"Enter Debug Mode"） */
    ready: string[];
    /** 锁定状态的特征（如 "Protect Shell (psh)"、"Not Supported"） */
    locked: string[];
    /** 等待密码输入的特征（如 "Password:"、"key>"） */
    unlocking: string[];
    /** 解锁失败的特征（如 "Incorrect Password"、"Invalid key"） */
    error: string[];
  };
  /** 解锁交互步骤序列 */
  unlockSequence: PshUnlockStep[];
  /** Challenge Code 提取正则（psh: PSH-XXXX 格式；psh_busybox: Base64 字符串） */
  challengeCodePattern?: string;
  /** 行为特性开关，处理不同设备的细微差异 */
  features?: PshFeatures;
  /** 锁定状态下允许执行的命令列表（如 help、dmesg、debug） */
  allowedCommands?: string[];
}

/**
 * Shell 读写接口（SSH / Serial 通用）
 *
 * PSH 解锁流程不关心底层是 SSH 还是串口，
 * 只需要一个能 write + read 的通道。
 * SSH 的 SSHShell 和串口的 SerialShell 都满足此接口。
 */
export interface PshChannel {
  write(cmd: string, clear?: number): void;
  read(clear?: number): string;
}

/** PSH 解锁结果 */
export interface PshUnlockResult {
  success: boolean;
  state: PshState;
  output: string;
  /** 提取到的 Challenge Code（psh: PSH-XXXX；psh_busybox: Base64 字符串） */
  challengeCode: string | null;
  /** 剩余尝试次数（如 "4 Times Left" 中的 4），密码错误时有效 */
  attemptsLeft: number | null;
  error?: string;
}

/** PSH 状态检测结果 */
export interface PshDetectResult {
  /** 当前终端是否为 PSH（通过 locked 特征判断） */
  isPsh: boolean;
  state: PshState;
  output: string;
  challengeCode: string | null;
  attemptsLeft: number | null;
}

/**
 * 内置 PSH Profile
 *
 * 目前支持两种 PSH 变体：
 * - psh: v2.1 版本，带 PSH-XXXX 格式 Challenge Code，提示符为 locked>
 * - psh_busybox: BusyBox 集成版本，带 QR 码 + Base64 Challenge，提示符为 #
 */
const BUILTIN_PROFILES: Record<string, PshProfile> = {
  /**
   * PSH v2.1 - 带 Challenge Code 的解锁方式
   *
   * 典型交互流程：
   *   locked> debug
   *   Challenge Code: PSH-2C80-D7A9-8CB8-CDEB
   *   Enter key to unlock: key> <密码>
   *   [PSH] Access Granted! Unlocking shell...
   *   root@device:~#
   */
  psh: {
    name: "psh",
    description: "Protect Shell v2.1 - Davinci locked shell with Challenge Code (PSH-XXXX format)",
    statePatterns: {
      ready: [
        "PSH_AUTH=1",
        "built-in shell \\(ash\\)",
        "Access Granted",
      ],
      locked: [
        "System is LOCKED",
        "^locked>\\s*$",
        "Command not supported in locked mode",
        "Type 'debug' to unlock",
      ],
      unlocking: [
        "Enter key to unlock",
        "^key>\\s*$",
        "Password:\\s*$",
      ],
      error: [
        "Invalid key",
        "Returning to locked mode",
        "Access denied",
      ],
    },
    challengeCodePattern: "PSH-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}",
    unlockSequence: [
      {
        send: "debug",
        expectPattern: "Password:|key>|Enter key|Challenge Code",
        timeoutMs: 10000,
        description: "Enter debug mode to trigger password prompt",
      },
      {
        send: "",
        expectPattern: "Access Granted|built-in shell|PSH_AUTH=1",
        timeoutMs: 15000,
        description: "Submit unlock password",
        userInput: true,
      },
    ],
    features: {
      bypassOnNonTty: true,
      signalResistant: true,
    },
    allowedCommands: ["help", "debug", "dmesg"],
  },

  /**
   * PSH (BusyBox) - 带 QR 码 + Base64 Challenge 的解锁方式
   *
   * 典型交互流程：
   *   # ls
   *   'ls' Not Supported, Try 'help'
   *   # debug
   *   ██████... (QR 码 ASCII 艺术) ...██████
   *   DAAAAAFNMYKtDZGbQW6Iv4hKZIp4wdB0lkY5UCHM2qqmg1ndseK... (Base64 Challenge)
   *   Password: <密码>
   *   Enter Debug Mode.
   *   BusyBox v1.37.0 built-in shell (ash)
   *   #
   *
   * 与 psh v2.1 的关键差异：
   *   - 提示符为 #（与普通 root shell 相同），而非 locked>
   *   - debug 后显示 QR 码 + Base64 编码的 Challenge，而非 PSH-XXXX 格式
   *   - 密码错误提示为 "Incorrect Password" / "input invaild len param" / "N Times Left"
   *   - 解锁成功提示为 "Enter Debug Mode"，而非 "Access Granted"
   */
  psh_busybox: {
    name: "psh_busybox",
    description: "Protect Shell (BusyBox) - locked shell with QR code + Base64 challenge",
    statePatterns: {
      ready: [
        "Enter Debug Mode",
        "built-in shell \\(ash\\)",
      ],
      locked: [
        "Protect Shell \\(psh\\)",
        "Not Supported.*Try 'help'",
        "davinci system commands",
      ],
      unlocking: [
        "Password:\\s*$",
      ],
      error: [
        "Incorrect Password",
        "input invaild len param",
        "\\d+ Times Left",
      ],
    },
    challengeCodePattern: "[A-Za-z0-9+/=]{40,}",
    unlockSequence: [
      {
        send: "debug",
        expectPattern: "Password:",
        timeoutMs: 10000,
        description: "Enter debug mode to trigger QR code + password prompt",
      },
      {
        send: "",
        expectPattern: "Enter Debug Mode|built-in shell|Incorrect Password|Times Left",
        timeoutMs: 15000,
        description: "Submit unlock password",
        userInput: true,
      },
    ],
    features: {
      signalResistant: true,
    },
    allowedCommands: ["help", "debug", "dmesg", "ps", "free"],
  },
};

/**
 * 从环境变量构建自定义 PshProfile
 *
 * 支持通过环境变量覆盖 prompt 特征和解锁序列，
 * 无需改代码即可适配新的 PSH 设备。
 *
 * 环境变量：
 *   PSH_LOCKED_PROMPT    - 锁定状态特征，多个用 | 分隔
 *   PSH_UNLOCKING_PROMPT - 解锁中状态特征，多个用 | 分隔
 *   PSH_READY_PROMPT     - 已解锁状态特征，多个用 | 分隔
 *   PSH_ERROR_PROMPT     - 错误状态特征，多个用 | 分隔
 *   PSH_UNLOCK_SEQUENCE  - 解锁序列，格式: "cmd1=>expect1||cmd2=>expect2"
 *                          空 cmd 表示 userInput 步骤（密钥输入）
 *   PSH_CHALLENGE_PATTERN - Challenge Code 提取正则
 */
function buildProfileFromEnv(): PshProfile | null {
  const lockedPrompt = process.env.PSH_LOCKED_PROMPT;
  const unlockingPrompt = process.env.PSH_UNLOCKING_PROMPT;
  const readyPrompt = process.env.PSH_READY_PROMPT;
  const errorPrompt = process.env.PSH_ERROR_PROMPT;
  const sequenceStr = process.env.PSH_UNLOCK_SEQUENCE;

  if (!lockedPrompt && !unlockingPrompt && !sequenceStr) {
    return null;
  }

  const statePatterns: PshProfile["statePatterns"] = {
    ready: readyPrompt ? readyPrompt.split("|").filter(Boolean) : [".*[@:].*[#$]\\s*$"],
    locked: lockedPrompt
      ? lockedPrompt.split("|").filter(Boolean)
      : ["locked>"],
    unlocking: unlockingPrompt
      ? unlockingPrompt.split("|").filter(Boolean)
      : ["key>"],
    error: errorPrompt
      ? errorPrompt.split("|").filter(Boolean)
      : ["invalid\\s+(key|password)", "access\\s+denied"],
  };

  const unlockSequence: PshUnlockStep[] = sequenceStr
    ? sequenceStr.split("||").map((step, idx) => {
        const parts = step.split("=>", 2);
        const send = (parts[0] ?? "").trim();
        const userInput = send === "";
        return {
          send: userInput ? "" : send,
          expectPattern: (parts[1] ?? ".*").trim(),
          timeoutMs: 5000,
          description: userInput ? `Step ${idx + 1} (user key)` : `Step ${idx + 1}`,
          userInput,
        };
      })
    : [];

  return {
    name: "custom",
    description: "User-defined PSH profile from environment variables",
    statePatterns,
    unlockSequence,
    challengeCodePattern: process.env.PSH_CHALLENGE_PATTERN,
  };
}

/**
 * PSH (Protect Shell) 解锁处理器
 *
 * 统一处理 SSH 和串口连接下的 PSH 解锁流程。
 * PSH 的状态判定、Challenge Code 提取、解锁序列执行
 * 与传输层无关，因此抽象为独立模块。
 *
 * 核心设计原则：
 * 1. 纯输出分析优先 — detectState/detect 只分析已有输出，不发送任何数据，
 *    避免在 Password: 等待状态下发送探测数据导致输入污染
 * 2. 传输层无关 — 通过 PshChannel 接口抽象读写操作，SSH 和串口共用同一套逻辑
 * 3. Profile 配置化 — 不同 PSH 变体的差异通过 profile 配置，而非硬编码
 *
 * 使用方式：
 *   const handler = PshHandler.fromProfile("psh_busybox");
 *   const detect = handler.detect(banner);
 *   if (detect.isPsh && detect.state === PshState.LOCKED) {
 *     const result = await handler.unlock(channel, "123456");
 *   }
 */
export class PshHandler {
  readonly #profile: PshProfile;
  readonly #compiled: {
    ready: RegExp[];
    locked: RegExp[];
    unlocking: RegExp[];
    error: RegExp[];
    challenge: RegExp | null;
  };

  constructor(profile: PshProfile) {
    this.#profile = profile;
    // 将 profile 中的字符串正则预编译为 RegExp，避免每次调用时重复编译
    this.#compiled = {
      ready: profile.statePatterns.ready.map((p) => new RegExp(p, "im")),
      locked: profile.statePatterns.locked.map((p) => new RegExp(p, "im")),
      unlocking: profile.statePatterns.unlocking.map((p) => new RegExp(p, "im")),
      error: profile.statePatterns.error.map((p) => new RegExp(p, "im")),
      challenge: profile.challengeCodePattern
        ? new RegExp(profile.challengeCodePattern, "im")
        : null,
    };
  }

  get profile(): PshProfile {
    return this.#profile;
  }

  /** 锁定状态下允许执行的命令列表 */
  get allowedCommands(): string[] {
    return this.#profile.allowedCommands ?? [];
  }

  /** 行为特性配置 */
  get features(): PshFeatures | undefined {
    return this.#profile.features;
  }

  /**
   * 检测输出是否来自 PSH 终端
   *
   * 通过 locked 状态的特征模式判断当前终端是否为 PSH。
   * 对于 psh_busybox，# 提示符与普通 root shell 相同，
   * 因此依赖 "Not Supported" / "davinci system commands" 等特征区分。
   */
  isPsh(output: string): boolean {
    return this.#compiled.locked.some((p) => p.test(output));
  }

  /**
   * 检测当前 PSH 状态
   *
   * 纯输出分析，不发送任何数据，可安全在 Password: 等待状态下调用。
   *
   * 匹配优先级：READY > ERROR > UNLOCKING > LOCKED > UNKNOWN
   * - READY 优先：避免解锁成功后的输出中残留 LOCKED 特征导致误判
   * - ERROR 优先于 UNLOCKING：密码错误时输出中可能同时包含 "Password:" 和 "Incorrect Password"
   * - UNLOCKING 优先于 LOCKED：debug 后输出中可能同时包含 "Protect Shell" 和 "Password:"
   *
   * 注意：psh_busybox 的锁定提示符为 #，与普通 root shell 相同，
   * 因此不能仅凭 # 判断状态，需要结合上下文（如 "Not Supported" 响应）。
   */
  detectState(output: string): PshState {
    if (this.#compiled.ready.some((p) => p.test(output))) return PshState.READY;
    if (this.#compiled.error.some((p) => p.test(output))) return PshState.ERROR;
    if (this.#compiled.unlocking.some((p) => p.test(output))) return PshState.UNLOCKING;
    if (this.#compiled.locked.some((p) => p.test(output))) return PshState.LOCKED;
    return PshState.UNKNOWN;
  }

  /**
   * 综合检测：是否为 PSH + 当前状态 + Challenge Code + 剩余次数
   *
   * 仅基于已有输出分析，不发送任何探测数据。
   * 适用于连接后读取 banner/缓冲区内容来判断初始状态。
   */
  detect(output: string): PshDetectResult {
    const state = this.detectState(output);
    // 即使状态为 UNKNOWN，只要输出中包含 PSH locked 特征，也认为当前是 PSH
    const isPsh = state !== PshState.UNKNOWN || this.isPsh(output);

    return {
      isPsh,
      state,
      output,
      challengeCode: this.extractChallengeCode(output),
      attemptsLeft: this.extractAttemptsLeft(output),
    };
  }

  /**
   * 从输出中提取 Challenge Code
   *
   * 对于 psh: 提取 PSH-XXXX-XXXX-XXXX-XXXX 格式的 Challenge Code
   * 对于 psh_busybox: 提取 QR 码后的 Base64 编码字符串（40 字符以上）
   */
  extractChallengeCode(output: string): string | null {
    if (!this.#compiled.challenge) return null;
    const match = output.match(this.#compiled.challenge);
    return match ? match[0] : null;
  }

  /**
   * 检测输出中是否包含 QR 码
   *
   * psh_busybox 的 debug 命令会显示 QR 码 ASCII 艺术，
   * 通过 ██ 字符块判断。可用于确认 debug 命令已被 PSH 接收。
   */
  hasQrCode(output: string): boolean {
    return /██/.test(output);
  }

  /**
   * 提取剩余尝试次数
   *
   * psh_busybox 密码错误时显示 "N Times Left"（如 "4 Times Left"），
   * 提取此数字用于判断是否还有重试机会。
   */
  extractAttemptsLeft(output: string): number | null {
    const match = output.match(/(\d+)\s+Times?\s+Left/i);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * 执行 PSH 解锁
   *
   * 根据 profile 中定义的 unlockSequence 逐步执行解锁：
   * 1. 遍历 unlockSequence 中的每一步
   * 2. 对于 userInput 步骤，用传入的 key 替代 send 字段，
   *    如果提供了 onKeyRequest 回调，则从回调获取密钥（支持交互式输入）
   * 3. 发送命令后等待 stepDelay 毫秒，读取输出
   * 4. 检查输出是否匹配该步的 expectPattern
   *    - 匹配成功：继续下一步
   *    - 匹配失败但状态为 ERROR：立即返回失败
   *    - 匹配失败且非 ERROR：额外等待一轮，再读取输出
   * 5. 每步结束后检查是否已进入 READY 状态（提前退出）
   *
   * 关键设计：解锁过程中不发送任何 echo 探测标记，
   * 避免 Password: 等待状态下探测数据被当作密码输入导致污染。
   * 这是串口解锁的核心问题——任何带换行符的数据在 Password: 提示下
   * 都会被 PSH 当作密码读入。
   *
   * @param channel   读写通道（SSH 或 Serial）
   * @param key       解锁密钥（当 onKeyRequest 未提供时使用此密钥）
   * @param stepDelay 步骤间等待时间（毫秒），默认 1000
   * @param onKeyRequest 密钥请求回调（可选），在 userInput 步骤时调用，
   *                     参数为当前已收集的输出（含 QR 码/Challenge），
   *                     返回值作为密钥。未提供时使用 key 参数。
   */
  async unlock(
    channel: PshChannel,
    key: string,
    stepDelay = 1000,
    onKeyRequest?: (output: string) => string | Promise<string>,
  ): Promise<PshUnlockResult> {
    const sequence = this.#profile.unlockSequence;
    if (!sequence || sequence.length === 0) {
      return {
        success: false,
        state: PshState.UNKNOWN,
        output: "",
        challengeCode: null,
        attemptsLeft: null,
        error: "No unlock sequence defined in profile",
      };
    }

    let lastOutput = "";
    let prevOutput = ""; // 上一步的输出，供 userInput 步骤的 onKeyRequest 回调使用

    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i];
      // userInput 步骤：优先从 onKeyRequest 回调获取密钥
      let send: string;
      if (step.userInput) {
        if (onKeyRequest) {
          // prevOutput 包含上一步（如 debug）的完整输出（QR 码 + Challenge + Password:）
          send = await onKeyRequest(prevOutput);
        } else {
          send = key;
        }
      } else {
        send = step.send;
      }

      // 发送命令，clear=1 清空缓冲区后开始收集新输出
      channel.write(send, 1);
      console.log("[send cmd]:", send);
      await this.#wait(stepDelay);

      lastOutput = channel.read(1);
      // console.log("lastOutput:", lastOutput);
      const state = this.detectState(lastOutput);

      // 检查输出是否匹配该步的期望模式
      const expectRe = new RegExp(step.expectPattern, "im");
      if (!expectRe.test(lastOutput)) {
        // 未匹配期望，检查是否进入 ERROR 状态（密码错误等）
        if (state === PshState.ERROR) {
          return {
            success: false,
            state,
            output: lastOutput,
            challengeCode: this.extractChallengeCode(lastOutput),
            attemptsLeft: this.extractAttemptsLeft(lastOutput),
            error: `Step ${i + 1} failed: error state detected`,
          };
        }
        // 未出错但未匹配期望，可能是输出还没到，额外等待一轮
        await this.#wait(stepDelay);
        lastOutput += channel.read(0); // clear=0 追加读取，保留已有内容
      }

      // 每步结束后检查是否已解锁成功（提前退出，无需执行后续步骤）
      if (state === PshState.READY) {
        return {
          success: true,
          state: PshState.READY,
          output: lastOutput,
          challengeCode: null,
          attemptsLeft: null,
        };
      }

      // 保存本步输出，供下一步的 onKeyRequest 回调使用
      prevOutput = lastOutput;
    }

    // 所有步骤执行完毕，做最终状态检查
    const finalState = this.detectState(lastOutput);
    return {
      success: finalState === PshState.READY,
      state: finalState,
      output: lastOutput,
      challengeCode: this.extractChallengeCode(lastOutput),
      attemptsLeft: this.extractAttemptsLeft(lastOutput),
      error: finalState !== PshState.READY
        ? `Unlock sequence completed but state is ${finalState}`
        : undefined,
    };
  }

  /**
   * 静默探测 PSH 状态
   *
   * 采用"先读后发"策略，避免在 Password: 等待状态下发送探测数据：
   * 1. 先读取通道中已有的输出（clear=0 不清空），尝试从中判断状态
   * 2. 如果已有输出足以判断状态，直接返回（不发送任何数据）
   * 3. 如果无法判断，才发送探测命令
   *
   * 对于串口连接，这个策略至关重要：
   * 当 PSH 处于 Password: 等待状态时，任何带换行符的数据都会被当作密码读入，
   * 导致 "input invaild len param" 或 "Incorrect Password" 错误。
   *
   * @param channel   读写通道
   * @param probeCmd  探测命令（默认 "echo __PSH_STATE_PROBE__"）
   * @param timeoutMs 超时时间（毫秒），默认 3000
   */
  async probeState(
    channel: PshChannel,
    probeCmd = "echo __PSH_STATE_PROBE__",
    timeoutMs = 3000,
  ): Promise<PshDetectResult> {
    // 第一步：静默读取已有输出，尝试判断状态
    const pending = channel.read(0);
    if (pending) {
      const result = this.detect(pending);
      if (result.state !== PshState.UNKNOWN) {
        return result;
      }
    }

    // 第二步：已有输出无法判断，发送探测命令
    channel.write(probeCmd, 1);
    await this.#wait(Math.min(timeoutMs, 2000));
    const output = channel.read(1);

    return this.detect(output);
  }

  /**
   * 启发式兜底状态检测
   *
   * 当 profile 匹配不到任何已知模式时，用通用关键词做状态判断。
   * 适用于未知 PSH 变体，作为 detectState 的 fallback。
   *
   * 匹配优先级与 detectState 一致：READY > ERROR > UNLOCKING > LOCKED > UNKNOWN
   */
  static heuristicDetect(output: string): PshState {
    if (/[@:].*[#$]\s*$/m.test(output) || /PSH_AUTH=1/.test(output)) {
      return PshState.READY;
    }
    if (/invalid\s+(key|password|code)/i.test(output) || /access\s+denied/i.test(output) ||
        /incorrect\s+password/i.test(output)) {
      return PshState.ERROR;
    }
    if (/enter\s+(key|password|code|pin)/i.test(output) || /^key>\s*$/m.test(output) || /^password:\s*$/im.test(output)) {
      return PshState.UNLOCKING;
    }
    if (/locked/i.test(output) || /system\s+is\s+locked/i.test(output) || /^locked>\s*$/m.test(output) ||
        /command not supported/i.test(output) || /not available in/i.test(output)) {
      return PshState.LOCKED;
    }
    return PshState.UNKNOWN;
  }

  /**
   * 构建综合提示符匹配正则
   *
   * 将 ready/locked/unlocking 三种状态的 pattern 合并为一个正则，
   * 用于在等待输出时判断"是否有任何提示符出现"，
   * 可替代固定 stepDelay 的轮询方式，实现更精确的输出等待。
   */
  buildPromptPattern(): RegExp {
    const parts: string[] = [];
    for (const p of this.#compiled.ready) parts.push(p.source);
    for (const p of this.#compiled.locked) parts.push(p.source);
    for (const p of this.#compiled.unlocking) parts.push(p.source);
    return new RegExp(parts.join("|"), "mi");
  }

  /** 从内置 profile 名创建 PshHandler */
  static fromProfile(name: string): PshHandler {
    const profile = BUILTIN_PROFILES[name];
    if (!profile) throw new Error(`Unknown PSH profile: ${name}`);
    return new PshHandler(profile);
  }

  /**
   * 从环境变量构建 PshHandler
   *
   * 优先级：
   *   1. PSH_PROFILE 环境变量指定的内置 profile
   *   2. 从 PSH_LOCKED_PROMPT / PSH_UNLOCKING_PROMPT / PSH_READY_PROMPT /
   *      PSH_ERROR_PROMPT / PSH_UNLOCK_SEQUENCE 环境变量构建自定义 profile
   *   3. 兜底使用启发式 profile（无 unlockSequence，仅做状态检测）
   */
  static fromEnv(): PshHandler {
    const profileName = process.env.PSH_PROFILE;

    // 1. 按名字选择内置 profile
    if (profileName) {
      const builtin = BUILTIN_PROFILES[profileName];
      if (builtin) return new PshHandler(builtin);
    }

    // 2. 从环境变量构建自定义 profile
    const custom = buildProfileFromEnv();
    if (custom) return new PshHandler(custom);

    // 3. 兜底：启发式 profile
    return new PshHandler({
      name: "heuristic",
      description: "Heuristic detection (no explicit profile)",
      statePatterns: {
        ready: [".*[@:].*[#$]\\s*$"],
        locked: ["locked>", "System is LOCKED", "Command not supported"],
        unlocking: ["key>", "Enter key", "password:"],
        error: ["invalid\\s+(key|password)", "access\\s+denied"],
      },
      unlockSequence: [],
    });
  }

  /**
   * 从输出自动匹配内置 profile
   *
   * 遍历所有内置 profile，用各自的 locked 特征模式匹配输出，
   * 返回第一个匹配的 profile 创建的 PshHandler。
   * 适用于连接后读取 banner 自动识别 PSH 类型的场景。
   */
  static matchFromOutput(output: string): PshHandler | null {
    for (const [, profile] of Object.entries(BUILTIN_PROFILES)) {
      const locked = profile.statePatterns.locked.map((p) => new RegExp(p, "im"));
      if (locked.some((p) => p.test(output))) {
        return new PshHandler(profile);
      }
    }
    return null;
  }

  #wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
