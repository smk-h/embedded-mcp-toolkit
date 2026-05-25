import { interactiveShell, SSHShell, type SSHShellConfig } from "./ssh.js";
import { interactiveSerialShell, SerialShell, type SerialShellConfig } from "./serial.js";
import { PshHandler, PshState } from "./psh.js";
import { KeyProvider } from "./key-provider.js";
import { sanitizeTerminalOutput } from "./common.js";

const mode = process.argv[2];

if (mode === "ssh") {
  const config: SSHShellConfig = {
    host: process.env.BOARD_HOST ?? "10.29.78.13",
    port: parseInt(process.env.BOARD_PORT ?? "22", 10),
    username: process.env.BOARD_USERNAME ?? "root",
    password: process.env.BOARD_PASSWORD ?? "abcd1245",
  };
  interactiveShell(config).catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (mode === "serial") {
  const config: SerialShellConfig = {
    port: process.env.SERIAL_PORT ?? "COM4",
    baudRate: parseInt(process.env.SERIAL_BAUDRATE ?? "115200", 10),
  };
  interactiveSerialShell(config).catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (mode === "psh-demo-ssh") {
  /**
   * PSH 探测 + 解锁演示（SSH 方式）
   *
   * 流程：
   *   1. 连接 SSH，读取 banner
   *   2. 自动匹配 PSH profile（psh / psh_busybox）
   *   3. 探测当前 PSH 状态
   *   4. 如状态为 LOCKED，发送 debug 命令，
   *      将 QR 码 + Base64 Challenge 显示在终端
   *   5. 用户从终端输入密钥
   *   6. 发送密钥完成解锁，输出结果
   *
   * 环境变量：
   *   BOARD_HOST, BOARD_PORT, BOARD_USERNAME, BOARD_PASSWORD
   *
   * 使用方式：
   *   node ./out/index.js psh-demo
   */
  const config: SSHShellConfig = {
    host: process.env.BOARD_HOST ?? "192.168.16.105",
    port: parseInt(process.env.BOARD_PORT ?? "22", 10),
    username: process.env.BOARD_USERNAME ?? "root",
    password: process.env.BOARD_PASSWORD ?? "root",
  };

  (async () => {
    console.log("=== PSH Unlock Demo (SSH) ===\n");

    // 1. 连接 SSH
    console.log(`Connecting to ${config.host}:${config.port ?? 22} ...`);
    const shell = new SSHShell(config);
    const banner = await shell.open();
    console.log("--- SSH Banner ---\n%s\n---", sanitizeTerminalOutput(banner));

    // 2. 自动识别 PSH profile
    const handler = PshHandler.matchFromOutput(banner);
    if (!handler) {
      console.log("No PSH profile matched — shell may already be unlocked or not a PSH device.");
      await shell.close();
      return;
    }
    console.log("Matched profile: %s (%s)\n", handler.profile.name, handler.profile.description);

    // 3. 探测当前状态
    let detect = handler.detect(banner);
    console.log("Initial state : %s", detect.state);
    console.log("Is PSH       : %s", detect.isPsh);
    console.log("Challenge    : %s\n", detect.challengeCode ?? "(none)");

    if (detect.state === PshState.UNKNOWN) {
      console.log("State is UNKNOWN, sending probe command...");
      detect = await handler.probeState(shell);
      console.log("After probe   : %s", detect.state);
    }

    // 4. 若处于锁定状态，执行解锁
    if (detect.state === PshState.LOCKED) {
      console.log("=== Starting unlock sequence ===\n");

      const keyProvider = new KeyProvider({
        mode: (process.env.KEY_PROVIDER as "file" | "terminal") ?? "terminal",
        challengeFilePath: process.env.CHALLENGE_FILE ?? "challenge.txt",
        keyFilePath: process.env.KEY_FILE ?? "password_input.txt",
      });

      const result = await handler.unlock(
        shell,
        "", // key 参数用不到（走 onKeyRequest 回调）
        1500,
        (output: string) => keyProvider.getKey(output),
      );

      console.log("\nUnlock result:");
      console.log("  success      : %s", result.success);
      console.log("  state        : %s", result.state);
      console.log("  challenge    : %s", result.challengeCode ?? "(none)");
      console.log("  attemptsLeft : %s", result.attemptsLeft ?? "(none)");
      console.log("  error        : %s", result.error ?? "(none)");

      if (result.success) {
        shell.write("ls", 1);
        await new Promise((r) => setTimeout(r, 1500));
        const verify = shell.read(1);
        console.log("\nVerification output:\n%s", sanitizeTerminalOutput(verify));
      } else if (result.attemptsLeft && result.attemptsLeft > 0) {
        // 密码错误，可重试（提示用户重新运行）
        console.log("\nHint: wrong password, %d attempt(s) remaining. Re-run to try again.", result.attemptsLeft);
      }
    } else if (detect.state === PshState.READY) {
      console.log("Shell is already unlocked, no action needed.");
    } else if (detect.state === PshState.ERROR) {
      console.log("Shell is in ERROR state (previous unlock may have failed).");
    } else if (detect.state === PshState.UNLOCKING) {
      console.log("Shell is in UNLOCKING state — a password prompt was left dangling.");
    }

    console.log("\n=== Demo complete ===");
    await shell.close();
  })().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (mode === "psh-demo-serial") {
  /**
   * PSH 探测 + 解锁演示（串口方式）
   *
   * 流程：
   *   1. 打开串口连接，读取 banner
   *   2. 自动匹配 PSH profile（psh / psh_busybox）
   *   3. 探测当前 PSH 状态
   *   4. 如状态为 LOCKED，发送 debug 命令，
   *      将 QR 码 + Base64 Challenge 写入 challenge.txt
   *   5. 轮询 password_input.txt 等待外部工具写入密钥
   *   6. 发送密钥完成解锁，输出结果
   *
   * 环境变量：
   *   SERIAL_PORT, SERIAL_BAUDRATE
   *   KEY_PROVIDER (file|terminal), CHALLENGE_FILE, KEY_FILE
   *
   * 使用方式：
   *   node ./out/index.js psh-demo-serial
   */
  const serialConfig: SerialShellConfig = {
    port: process.env.SERIAL_PORT ?? "COM3",
    baudRate: parseInt(process.env.SERIAL_BAUDRATE ?? "115200", 10),
  };

  (async () => {
    console.log("=== PSH Unlock Demo (Serial) ===\n");

    // 1. 打开串口
    console.log(`Opening ${serialConfig.port} @ ${serialConfig.baudRate ?? 115200} ...`);
    const shell = new SerialShell(serialConfig);
    const banner = await shell.open();
    console.log("--- Serial Banner ---\n%s\n---", sanitizeTerminalOutput(banner));

    // 2. 自动识别 PSH profile + 探测状态
    // 串口设备可能已运行很久，banner 只有内核日志，没有 PSH 特征
    // 用 echo 命令探测：PSH 锁定状态下会返回 "Not Supported" 之类的错误
    let handler = PshHandler.matchFromOutput(banner);
    let detectOutput = banner;

    if (!handler) {
      console.log("No PSH profile matched from banner, probing with echo...");
      shell.write("echo __PSH_PROBE__", 1);
      await new Promise((r) => setTimeout(r, 1500));
      const probeOutput = shell.read(1);
      console.log("probeOutput=", sanitizeTerminalOutput(probeOutput));
      detectOutput = banner + "\n" + probeOutput;
      handler = PshHandler.matchFromOutput(detectOutput);
    }

    if (!handler) {
      console.log("No PSH profile matched — shell may already be unlocked or not a PSH device.");
      await shell.close();
      return;
    }
    console.log("Matched profile: %s (%s)\n", handler.profile.name, handler.profile.description);

    // 3. 检测当前状态（使用包含 echo 探测结果的完整输出）
    let detect = handler.detect(detectOutput);
    console.log("Detected state : %s", detect.state);
    console.log("Is PSH         : %s", detect.isPsh);
    console.log("Challenge      : %s\n", detect.challengeCode ?? "(none)");

    if (detect.state === PshState.UNKNOWN) {
      console.log("State is UNKNOWN, sending probe command...");
      detect = await handler.probeState(shell);
      console.log("After probe    : %s", detect.state);
    }

    // 4. 若处于锁定状态，执行解锁
    if (detect.state === PshState.LOCKED) {
      console.log("=== Starting unlock sequence ===\n");

      const keyProvider = new KeyProvider({
        mode: (process.env.KEY_PROVIDER as "file" | "terminal") ?? "terminal",
        challengeFilePath: process.env.CHALLENGE_FILE ?? "challenge.txt",
        keyFilePath: process.env.KEY_FILE ?? "password_input.txt",
      });

      const result = await handler.unlock(
        shell,
        "", // key 参数用不到（走 onKeyRequest 回调）
        1500,
        (output: string) => keyProvider.getKey(output),
      );

      console.log("\nUnlock result:");
      console.log("  success      : %s", result.success);
      console.log("  state        : %s", result.state);
      console.log("  challenge    : %s", result.challengeCode ?? "(none)");
      console.log("  attemptsLeft : %s", result.attemptsLeft ?? "(none)");
      console.log("  error        : %s", result.error ?? "(none)");

      if (result.success) {
        shell.write("ls", 1);
        await new Promise((r) => setTimeout(r, 1500));
        const verify = shell.read(1);
        console.log("\nVerification output:\n%s", sanitizeTerminalOutput(verify));
      } else if (result.attemptsLeft && result.attemptsLeft > 0) {
        console.log("\nHint: wrong password, %d attempt(s) remaining. Re-run to try again.", result.attemptsLeft);
      }
    } else if (detect.state === PshState.READY) {
      console.log("Shell is already unlocked, no action needed.");
    } else if (detect.state === PshState.ERROR) {
      console.log("Shell is in ERROR state (previous unlock may have failed).");
    } else if (detect.state === PshState.UNLOCKING) {
      console.log("Shell is in UNLOCKING state — a password prompt was left dangling.");
    }

    console.log("\n=== Demo complete ===");
    await shell.close();
  })().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  console.error("Usage: node index.js <ssh|serial|psh-demo|psh-demo-serial>");
  console.error("");
  console.error("  ssh              启动 SSH 交互式 shell");
  console.error("  serial           启动串口交互式 shell");
  console.error("  psh-demo-ssh     SSH 方式 PSH 探测 + 解锁演示");
  console.error("  psh-demo-serial  串口方式 PSH 探测 + 解锁演示");
  process.exit(1);
}
