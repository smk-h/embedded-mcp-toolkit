/**
 * 用户登录模块
 *
 * 抽象串口/SSH 等通道下的用户名/密码登录流程，
 * 参考 PshHandler 的设计，将状态枚举、结果结构、登录通道接口统一封装。
 */

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
 * 登录步骤延迟配置，按 UserLoginStatus 状态绑定。
 * 每个键对应登录流程中的一个目标状态，值为该步骤的等待时间（毫秒）。
 * - WAITING_PASSWORD: 发送用户名后等待密码提示
 * - LOGGED_IN:       发送密码后等待验证 + 探测命令后等待登录确认
 */
export type UserLoginStepDelays = Partial<Record<UserLoginStatus, number>>;

/** 默认步骤延迟（毫秒） */
export const DEFAULT_LOGIN_DELAYS: Record<string, number> = {
  [UserLoginStatus.WAITING_PASSWORD]: 5000,
  [UserLoginStatus.LOGGED_IN]: 5000,
};

/**
 * 用户登录处理器
 *
 * 封装用户名/密码登录的交互序列，与底层传输无关。
 */
export class UserLoginHandler {
  readonly #config: UserLoginConfig;

  constructor(config: UserLoginConfig) {
    this.#config = config;
  }

  /**
   * 执行用户名/密码登录序列
   *
   * 流程：
   *   1. 发送用户名，等待密码提示（WAITING_PASSWORD 状态）
   *   2. 检查输出是否含 "Password:"，若无则报错
   *   3. 发送密码，等待验证结果（LOGGED_IN 状态）
   *   4. 若输出含 "incorrect"，返回 WRONG_KEY
   *   5. 否则发送 echo 探测验证登录是否成功（LOGGED_IN 状态）
   *
   * @param channel     登录通道（Serial / SSH）
   * @param probeCmd    登录成功后用于验证的命令，默认 "echo __SH_STATUS_PROBE__"
   * @param stepDelays  按状态绑定的步骤延迟（毫秒），与 DEFAULT_LOGIN_DELAYS 合并
   */
  async login(
    channel: UserLoginChannel,
    probeCmd = "echo __SH_STATUS_PROBE__",
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

    const delays = { ...DEFAULT_LOGIN_DELAYS, ...stepDelays };

    // 步骤 1：发送用户名 → 等待进入 WAITING_PASSWORD 状态
    const passwordPromptDelay =
      delays[UserLoginStatus.WAITING_PASSWORD] ?? 5000;
    channel.write(username, 1);
    await this.#wait(passwordPromptDelay);
    const usernameOutput = channel.read(1);

    if (!usernameOutput.includes("Password:")) {
      console.log(
        "[UserLogin] 步骤1 完成, sh状态: %s",
        UserLoginStatus.ERROR
      );
      const msg = "登录异常，请查看日志";
      return {
        success: false,
        status: UserLoginStatus.ERROR,
        output: usernameOutput,
        error: msg,
      };
    }
    console.log(
      "[UserLogin] 步骤1 完成, sh状态: %s",
      UserLoginStatus.WAITING_PASSWORD
    );

    // 步骤 2：发送密码 → 等待进入 LOGGED_IN / WRONG_KEY 状态
    const passwordVerifyDelay = delays[UserLoginStatus.LOGGED_IN] ?? 5000;
    channel.write(password, 1);
    await this.#wait(passwordVerifyDelay);
    const passwordOutput = channel.read(1);

    if (passwordOutput.includes("incorrect")) {
      console.log(
        "[UserLogin] 步骤2 完成, sh状态: %s",
        UserLoginStatus.WRONG_KEY
      );
      const msg = "密钥错误，请检查用户名和密码后重试";
      return {
        success: false,
        status: UserLoginStatus.WRONG_KEY,
        output: passwordOutput,
        error: msg,
      };
    }
    console.log(
      "[UserLogin] 步骤2 完成, sh状态: %s",
      UserLoginStatus.LOGGED_IN
    );

    // 步骤 3：探测验证 → 确认 LOGGED_IN 状态
    channel.write(probeCmd, 1);
    await this.#wait(passwordVerifyDelay);
    const verifyOutput = channel.read(1);

    if (verifyOutput.includes("__SH_STATUS_PROBE__")) {
      console.log(
        "[UserLogin] 步骤3 完成, sh状态: %s",
        UserLoginStatus.LOGGED_IN
      );
      return {
        success: true,
        status: UserLoginStatus.LOGGED_IN,
        output: verifyOutput,
      };
    }

    console.log(
      "[UserLogin] 步骤3 完成, sh状态: %s",
      UserLoginStatus.ERROR
    );
    const msg = "登录失败，状态异常，请查看日志";
    return {
      success: false,
      status: UserLoginStatus.ERROR,
      output: verifyOutput,
      error: msg,
    };
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
