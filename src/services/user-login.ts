/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : user-login.ts
 * Author     : sumu
 * Date       : 2026/06/02
 * Version    : 2.0
 * Description: 用户登录模块 —— 抽象串口/SSH 等通道下的用户名/密码登录流程。
 *              参考 PshHandler 的设计，将状态枚举、结果结构、登录通道接口统一封装。
 *              通过 UserLoginProfile 模板配置不同的登录样式（如标准用户名/密码、仅密码等）。
 *              提供 UserLoginStateMachine 状态机简化终端状态探测逻辑。
 * ======================================================
 */

import { logger } from "../shared/logger.js";

/** 用户登录状态枚举 */
export enum UserLoginStatus {
  /** 不需要登录，已可以直接操作设备 */
  NO_LOGIN_REQUIRED = "no_login_required",
  /** 等待输入用户名 */
  WAITING_USERNAME = "waiting_username",
  /** 等待输入密码 */
  WAITING_PASSWORD = "waiting_password",
  /** 登录成功 */
  LOGGED_IN = "logged_in",
  /** 密钥错误（用户名或密码不正确） */
  WRONG_KEY = "wrong_key",
  /** 状态异常，无法识别 */
  ERROR = "error",
  /** 未知状态 */
  UNKNOWN = "unknown",
}

/** 用户登录结果 */
export interface UserLoginResult {
  success: boolean;
  status: UserLoginStatus;
  output: string;
  error?: string;
}

/** 用户登录通道抽象（Serial / SSH 通用） */
export interface UserLoginChannel {
  write(cmd: string, clear?: number): void;
  read(clear?: number): string;
  close(): Promise<void>;
}

/** 用户登录配置 */
export interface UserLoginConfig {
  username: string;
  password: string;
}

/**
 * 登录序列中的单步操作
 *
 * 用户登录通常需要多步交互，每步包含：发送内容 → 等待响应 → 匹配期望。
 * 例如默认的登录序列：
 *   步骤1: send="{username}" → 期望匹配 "Password:"
 *   步骤2: send="{password}" → 期望不含 "incorrect"
 *   步骤3: send="{probe}"    → 期望匹配 "__SH_STATUS_PROBE__"
 *
 * send 字段支持以下占位符，运行时自动替换：
 *   {username} - 替换为 UserLoginConfig.username
 *   {password} - 替换为 UserLoginConfig.password
 *   {probe}    - 替换为 UserLoginProfile.probeCmd
 */
export interface UserLoginStep {
  /** 要发送的内容，支持 {username} / {password} / {probe} 占位符 */
  send: string;
  /** 发送后期望匹配的正则，用于判断该步是否成功 */
  expectPattern: string;
  /** 可选的错误匹配正则，匹配到则视为本步失败（如 "incorrect"） */
  errorPattern?: string;
  /** 本步超时（毫秒） */
  timeoutMs: number;
  /** 步骤描述 */
  description: string;
  /** 本步成功后对应的状态 */
  statusOnSuccess: UserLoginStatus;
  /** 本步失败后对应的状态 */
  statusOnError: UserLoginStatus;
}

/**
 * 用户登录 Profile 模板
 *
 * 不同设备可能有不同的登录流程（标准用户名/密码、仅密码、自定义提示符等），
 * 通过 profile 将这些差异配置化，使 UserLoginHandler 能适配多种登录样式。
 *
 * 参考 PshProfile 的设计：状态模式匹配 + 交互步骤序列。
 */
export interface UserLoginProfile {
  name: string;
  description: string;
  /** 登录成功后用于验证的探测命令，默认 "echo __SH_STATUS_PROBE__" */
  probeCmd: string;
  /** 登录交互步骤序列 */
  loginSequence: UserLoginStep[];
}

/**
 * 登录步骤延迟配置，按 UserLoginStatus 状态绑定。
 * 每个键对应登录流程中的一个目标状态，值为该步骤的等待时间（毫秒）。
 *
 * 与 profile 的关系：调用 UserLoginHandler.login() 时，stepDelays 中
 * status → timeoutMs 的映射会覆盖对应步骤在 profile 中定义的 timeoutMs，
 * 实现"不改 profile，仅调延迟"的便捷覆盖。
 */
export type UserLoginStepDelays = Partial<Record<UserLoginStatus, number>>;

/** 默认步骤延迟（毫秒） */
export const DEFAULT_LOGIN_DELAYS: Record<string, number> = {
  [UserLoginStatus.WAITING_PASSWORD]: 5000,
  [UserLoginStatus.LOGGED_IN]: 5000,
};

/**
 * 内置用户登录 Profile
 *
 * 目前支持一种登录样式：
 * - default: 标准用户名/密码登录，通过 echo 探测验证登录成功
 *
 * 扩展方式：
 *   1. 在此处添加新的 profile 条目
 *   2. 通过 UserLoginHandler.fromProfile(name) 按名称使用
 *   3. 或直接 new UserLoginHandler(config, customProfile) 传入自定义 profile
 */
const BUILTIN_PROFILES: Record<string, UserLoginProfile> = {
  /**
   * 标准用户名/密码登录
   *
   * 典型交互流程：
   *   login: root
   *   Password: ******
   *   root@device:~# echo __SH_STATUS_PROBE__
   *   __SH_STATUS_PROBE__
   */
  default: {
    name: "default",
    description:
      "Standard username/password login with echo probe verification",
    probeCmd: "echo __SH_STATUS_PROBE__",
    loginSequence: [
      {
        send: "{username}",
        expectPattern: "Password:",
        timeoutMs: 5000,
        description: "Send username, wait for password prompt",
        statusOnSuccess: UserLoginStatus.WAITING_PASSWORD,
        statusOnError: UserLoginStatus.ERROR,
      },
      {
        send: "{password}",
        expectPattern: ".*",
        errorPattern: "incorrect",
        timeoutMs: 5000,
        description: "Send password, wait for verification",
        statusOnSuccess: UserLoginStatus.LOGGED_IN,
        statusOnError: UserLoginStatus.WRONG_KEY,
      },
      {
        send: "{probe}",
        expectPattern: "__SH_STATUS_PROBE__",
        timeoutMs: 5000,
        description: "Send probe command to verify login success",
        statusOnSuccess: UserLoginStatus.LOGGED_IN,
        statusOnError: UserLoginStatus.ERROR,
      },
    ],
  },

  /**
   * 仅密码登录（无需输入用户名）
   *
   * 部分嵌入式设备在串口连接后直接显示 Password: 提示符，
   * 不需要输入用户名，只需输入密码即可登录。
   *
   * 典型交互流程：
   *   Password: ******
   *   root@device:~# echo __SH_STATUS_PROBE__
   *   __SH_STATUS_PROBE__
   */
  "password-only": {
    name: "password-only",
    description: "Password-only login (no username required)",
    probeCmd: "echo __SH_STATUS_PROBE__",
    loginSequence: [
      {
        send: "{password}",
        expectPattern: ".*",
        errorPattern: "incorrect",
        timeoutMs: 5000,
        description: "Send password, wait for verification",
        statusOnSuccess: UserLoginStatus.LOGGED_IN,
        statusOnError: UserLoginStatus.WRONG_KEY,
      },
      {
        send: "{probe}",
        expectPattern: "__SH_STATUS_PROBE__",
        timeoutMs: 5000,
        description: "Send probe command to verify login success",
        statusOnSuccess: UserLoginStatus.LOGGED_IN,
        statusOnError: UserLoginStatus.ERROR,
      },
    ],
  },
};

/**
 * 从 profile 的 loginSequence 中提取状态→超时的映射
 *
 * 用于兼容旧的 UserLoginStepDelays 参数：将 steps 级别的 timeoutMs
 * 转换为状态级别的延迟映射，使调用方仍可通过 stepDelays 覆盖。
 * 优先级：重复状态的步骤取最后一个的 timeoutMs。
 *
 * @param profile - 用户登录 Profile 模板
 * @returns 状态→超时（毫秒）的映射表
 */
function delaysFromProfile(profile: UserLoginProfile): Record<string, number> {
  const delays: Record<string, number> = {};
  for (const step of profile.loginSequence) {
    if (step.statusOnSuccess) {
      delays[step.statusOnSuccess] = step.timeoutMs;
    }
  }
  return delays;
}

/**
 * 用户登录处理器
 *
 * 封装用户名/密码登录的交互序列，与底层传输无关。
 * 通过 UserLoginProfile 模板支持不同的登录样式。
 *
 * 使用方式：
 *   // 方式 1：使用内置 profile
 *   const handler = UserLoginHandler.fromProfile("default", {
 *     username: "root",
 *     password: "123456",
 *   });
 *   const result = await handler.login(channel);
 *
 *   // 方式 2：使用自定义 profile
 *   const handler = new UserLoginHandler(config, customProfile);
 *
 *   // 方式 3：兼容旧 API（默认使用 "default" profile）
 *   const handler = new UserLoginHandler(config);
 *   const result = await handler.login(channel, undefined, stepDelays);
 */
export class UserLoginHandler {
  readonly #config: UserLoginConfig;
  readonly #profile: UserLoginProfile;

  /**
   * @param config 登录凭据
   * @param profile 登录流程模板，不传则使用 "default" 内置 profile
   */
  constructor(config: UserLoginConfig, profile?: UserLoginProfile) {
    this.#config = config;
    this.#profile = profile ?? BUILTIN_PROFILES["default"];
  }

  get profile(): UserLoginProfile {
    return this.#profile;
  }

  /**
   * 执行用户名/密码登录序列
   *
   * 根据 profile 中定义的 loginSequence 逐步执行登录：
   * 1. 遍历 loginSequence 中的每一步
   * 2. 解析 send 字段中的占位符（{username}/{password}/{probe}）
   * 3. 发送内容，等待 step.timeoutMs 毫秒后读取输出
   * 4. 检查输出是否匹配 expectPattern
   * 5. 如设置了 errorPattern 且匹配，返回错误状态
   * 6. 全部步骤完成后返回最终状态
   *
   * @param channel     登录通道（Serial / SSH）
   * @param probeCmd    登录成功后用于验证的命令，覆盖 profile.probeCmd
   * @param stepDelays  按状态覆盖步骤延迟（毫秒），与 profile 中的 timeoutMs 合并
   * @returns 登录结果，包含成功/失败状态、输出和错误信息
   */
  async login(
    channel: UserLoginChannel,
    probeCmd?: string,
    stepDelays?: UserLoginStepDelays
  ): Promise<UserLoginResult> {
    const { username, password } = this.#config;

    if (!username || !password) {
      const msg = "Missing username or password in config.";
      return {
        success: false,
        status: UserLoginStatus.ERROR,
        output: "",
        error: msg,
      };
    }

    const probe = probeCmd ?? this.#profile.probeCmd;
    const profileDelays = delaysFromProfile(this.#profile);
    const delays = { ...profileDelays, ...stepDelays };

    for (let i = 0; i < this.#profile.loginSequence.length; i++) {
      const step = this.#profile.loginSequence[i];
      const timeout = delays[step.statusOnSuccess] ?? step.timeoutMs;

      // 解析占位符
      const send = step.send
        .replace("{username}", username)
        .replace("{password}", password)
        .replace("{probe}", probe);

      channel.write(send, 1);
      logger.info(`[UserLogin] 步骤${i + 1} 发送: ${step.description}`);
      await this.#wait(timeout);
      const output = channel.read(1);

      // 检查错误模式
      if (step.errorPattern && output.includes(step.errorPattern)) {
        logger.info(
          `[UserLogin] 步骤${i + 1} 完成, sh状态: ${step.statusOnError}`
        );
        return {
          success: false,
          status: step.statusOnError,
          output,
          error: `Step ${i + 1} failed: detected error pattern "${step.errorPattern}"`,
        };
      }

      // 检查期望模式
      const expectRe = new RegExp(step.expectPattern, "im");
      if (!expectRe.test(output)) {
        logger.info(
          `[UserLogin] 步骤${i + 1} 完成, sh状态: ${step.statusOnError}`
        );
        return {
          success: false,
          status: step.statusOnError,
          output,
          error: `Step ${i + 1} failed: expect pattern "${step.expectPattern}" not matched`,
        };
      }

      logger.info(
        `[UserLogin] 步骤${i + 1} 完成, sh状态: ${step.statusOnSuccess}`
      );
    }

    // 全部步骤完成，返回成功
    const lastOutput = channel.read(0);
    return {
      success: true,
      status: UserLoginStatus.LOGGED_IN,
      output: lastOutput,
    };
  }

  /**
   * 从内置 profile 名创建 UserLoginHandler
   *
   * @param name   内置 profile 名称（"default" | "password-only"）
   * @param config 登录凭据
   * @returns 配置好的 UserLoginHandler 实例
   * @throws {Error} 当 profile 名称不存在时抛出
   */
  static fromProfile(name: string, config: UserLoginConfig): UserLoginHandler {
    const profile = BUILTIN_PROFILES[name];
    if (!profile) throw new Error(`Unknown user login profile: ${name}`);
    return new UserLoginHandler(config, profile);
  }

  /**
   * 异步等待指定毫秒数
   *
   * @param ms - 等待时间（毫秒）
   */
  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * 登录状态机输出指令
 *
 * 状态机分析输出后告诉调用方下一步该做什么。
 */
export interface StateMachineAction {
  send?: string; // 下一步要发送的命令（undefined 表示已达终态）
  waitMs: number; // 发送后等待多久再读取（毫秒）
  state: UserLoginStatus; // 当前检测到的状态
  done: boolean; // 是否为终态（不需继续交互）
}

/**
 * 登录状态机
 *
 * 将终端状态探测建模为有限状态机，替代 if-else 嵌套判断。
 * 状态机只负责**检测终端当前状态**，实际的用户名/密码交互由 UserLoginHandler 完成。
 *
 * 状态流转图:
 *
 *   start(banner)
 *       │
 *       ├─ banner 含 "login:" ──▶ WAITING_USERNAME (done，调用方走 UserLoginHandler)
 *       │
 *       └─ banner 无 "login:" ──▶ 发探测 echo __SH_STATUS_PROBE__
 *                    │
 *                    ▼ feed(探测输出)
 *   ┌────────────────┼──────────────────────────────┐
 *   │                │                              │
 *  含 probe      含 Password: + login:      含 Password: 不含 login:
 *  (已登录)      (探测被当密码→回到login)     (无法确定，需二次探测)
 *   │                │                              │
 *   ▼                ▼                              ▼
 *  READY       WAITING_USERNAME              发探测 confirm
 *  (done)     (done, 走 UserLoginHandler)           │
 *                                                   ▼ feed(confirm输出)
 *                                ┌──────────────────┼───────────────────┐
 *                                │                  │                   │
 *                              含 probe      incorrect /              异常
 *                              (登录成功)    Password: / login:
 *                                │                  │                   │
 *                                ▼                  ▼                   ▼
 *                              READY         WAITING_USERNAME         ERROR
 *                              (done)       (done, 走登录)            (done)
 *
 * 使用方式:
 *   const sm = new UserLoginStateMachine(profile);
 *
 *   // 1. banner 初始化
 *   let action = sm.start(banner);
 *
 *   // 2. 循环: 执行动作 → 读输出 → 喂入 → 获取下一动作
 *   while (!action.done) {
 *     channel.write(action.send, 1);
 *     await wait(action.waitMs);
 *     const output = channel.read(1);
 *     action = sm.feed(output);
 *   }
 *
 *   // 3. 根据终态继续
 *   if (action.state === UserLoginStatus.NO_LOGIN_REQUIRED) {
 *     // 已登录，直接进入交互
 *   } else if (action.state === UserLoginStatus.WAITING_USERNAME) {
 *     // 需要登录，交给 UserLoginHandler
 *     const handler = new UserLoginHandler(config, profile);
 *     await handler.login(channel);
 *   } else {
 *     // ERROR / UNKNOWN，处理异常
 *   }
 */
export class UserLoginStateMachine {
  private _state: UserLoginStatus = UserLoginStatus.UNKNOWN;
  private _probeCount = 0;
  private _profile: UserLoginProfile;

  constructor(profile?: UserLoginProfile) {
    this._profile = profile ?? BUILTIN_PROFILES["default"];
  }

  get state(): UserLoginStatus {
    return this._state;
  }

  /** 探测命令 */
  get probeCmd(): string {
    return this._profile.probeCmd;
  }

  /**
   * 用 banner 初始化状态机，返回下一步动作
   *
   * @param banner - 串口/SSH 连接后读取到的初始输出
   * @returns 下一步动作指令（发探测 或 已达终态）
   */
  start(banner: string): StateMachineAction {
    // 规则 1: banner 含 "login:" → 直接走登录
    if (/login:\s*$/im.test(banner)) {
      return this.#reply(UserLoginStatus.WAITING_USERNAME, "banner 含 login:");
    }

    // 规则 2: 无法从 banner 判断 → 发探测
    this._state = UserLoginStatus.UNKNOWN;
    this._probeCount = 1;
    return this.#probeAction();
  }

  /**
   * 喂入探测/命令输出，状态机根据当前状态 + 输出决定下一步
   *
   * @param output - 从通道读取到的终端输出
   * @returns 下一步动作指令（继续探测 或 已达终态）
   */
  feed(output: string): StateMachineAction {
    const hasProbe = output.includes("__SH_STATUS_PROBE__");
    const hasPassword = /Password:\s*$/im.test(output);
    const hasLogin = /login:\s*$/im.test(output);
    const hasIncorrect = /incorrect/i.test(output);

    // ── 探测结果分析 ──
    if (hasProbe && !hasPassword) {
      // 收到了探针回显且不在密码提示中 → 已登录
      return this.#reply(
        UserLoginStatus.NO_LOGIN_REQUIRED,
        "探针回显正常，已登录"
      );
    }

    if (hasPassword && hasLogin) {
      // 密码提示 + 登录提示同时出现 → 探测被当密码吃掉，回到登录
      return this.#reply(
        UserLoginStatus.WAITING_USERNAME,
        "探测被吞，终端回到 login:"
      );
    }

    if (hasPassword && !hasLogin) {
      // 只有密码提示 → 无法确定，二次探测
      this._probeCount++;
      if (this._probeCount > 2) {
        return this.#reply(UserLoginStatus.ERROR, "探测次数超限");
      }
      return this.#probeAction();
    }

    if (hasIncorrect) {
      // 含 incorrect → 探测被当密码，验证失败
      return this.#reply(
        UserLoginStatus.WAITING_USERNAME,
        "探测被当密码，验证失败"
      );
    }

    // 都不匹配 → 状态异常
    return this.#reply(UserLoginStatus.ERROR, "无法识别终端状态");
  }

  /** 重置状态机到初始状态 */
  reset(): void {
    this._state = UserLoginStatus.UNKNOWN;
    this._probeCount = 0;
  }

  // ── 私有 ──

  /**
   * 构建探测动作指令
   *
   * @returns 要求调用方发送探测命令的动作
   */
  #probeAction(): StateMachineAction {
    return {
      send: this.probeCmd,
      waitMs: DEFAULT_LOGIN_DELAYS[UserLoginStatus.WAITING_PASSWORD] ?? 5000,
      state: this._state,
      done: false,
    };
  }

  /**
   * 构建终态动作指令（done=true）
   *
   * @param state  - 检测到的终端状态
   * @param reason - 状态判定原因（用于日志）
   * @returns 终态动作指令
   */
  #reply(state: UserLoginStatus, reason: string): StateMachineAction {
    this._state = state;
    logger.info(`[UserLoginSM] ${reason} → ${state}`);
    return {
      send: undefined,
      waitMs: 0,
      state,
      done: true,
    };
  }
}
