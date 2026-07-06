import { Command } from "commander";
import { interactiveShell, pshDemoSsh } from "../transports/ssh.js";
import {
  interactiveSerialShell,
  pshDemoSerial,
  userLoginDemoSerial,
} from "../transports/serial.js";
import {
  getSSHConfig,
  getSerialConfig,
  getAllConfig,
} from "../shared/config.js";
import { startMcpServer } from "../mcp/server.js";
import { runInit, runUninstall } from "./commands/init.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * 命令层级结构：
 * ─────────────────────────────────────────────────────────────────────────────
 * embedded-mcp-toolkit
 * ├── mcp (★默认)                ← MCP 服务器模式（.action() + isDefault）
 * ├── init                       ← 初始化配置文件（.action()）
 * ├── config                     ← 打印当前配置（.action()）
 * ├── demo                       ← 演示父命令（无 .action()，聚合子命令）
 * │   ├── ssh                    ←   SSH 演示二级父命令
 * │   │   ├── interact           ←     SSH 交互终端演示
 * │   │   └── unlock             ←     SSH PSH 加解锁演示
 * │   └── serial                 ←   串口演示二级父命令
 * │       ├── interact           ←     串口交互终端演示
 * │       └── unlock             ←     串口 PSH 加解锁演示
 *
 * 所有命令均为内联子命令（commander 1-param + .action()），同一进程内运行，
 * 不 fork 独立可执行子进程。
 * =============================================================================
 */
const program = new Command(); // 这里可以直接传入,或者在后面用 .name() 设置，后者可以覆盖 package.json 中的 name 字段，更灵活。
/**
 * @brief 获取完整版本信息
 * @details 从 package.json 读取版本号及依赖列表，生成详细的版本输出字符串，
 *          供 Commander 的 `--version` 选项使用。
 * @returns 包含包名、版本号、生产依赖和开发依赖的格式化字符串
 */
function getVersionInfo(): string {
  const deps = Object.entries(pkg.dependencies)
    .map(([name, version]) => `  ${name}: ${version}`)
    .join("\n");
  const devDeps = Object.entries(pkg.devDependencies)
    .map(([name, version]) => `  ${name}: ${version}`)
    .join("\n");
  return `${pkg.name}: ${pkg.version}\n\ndependencies:\n${deps}\n\ndevDependencies:\n${devDeps}`;
}

program
  .name("embedded-mcp-toolkit") // 1.帮助信息的标题（--help 输出顶部） 2. --version 输出中作为前缀
  .description("MCP Server for remote management of embedded Linux boards")
  .version(getVersionInfo())
  .configureHelp({
    showGlobalOptions: true,
  });

/**
 * @brief MCP 服务器模式（默认命令）
 * @details 以 MCP（Model Context Protocol）服务器模式运行，供 AI 客户端通过标准
 *          MCP 协议调用嵌入式设备的远程管理工具。
 *          通过 `{ isDefault: true }` 设为默认子命令：直接运行本程序与执行
 *          `embedded-mcp-toolkit mcp` 完全等价，无需额外的 `program.action()`。
 *
 * @par 子命令类型 顶层内联命令 + 默认命令 —— 通过 `.action()` 在同一进程内执行，
 *                `isDefault` 使其在无子命令匹配时自动触发。
 *
 * @example
 * embedded-mcp-toolkit
 * embedded-mcp-toolkit mcp
 */
program
  .command("mcp", { isDefault: true })
  .description("MCP 服务器模式（默认）")
  .action(() => {
    startMcpServer().catch((err: unknown) => {
      console.error(
        "MCP Server fatal:",
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    });
  });

/**
 * @brief 初始化配置文件
 * @details 在当前工作目录生成默认的配置文件模板（.mcp.json），
 *          方便用户快速开始使用本工具。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit init
 * embedded-mcp-toolkit init --device my-board
 * embedded-mcp-toolkit init --target /path/to/project --force
 * embedded-mcp-toolkit init --claude-only
 * embedded-mcp-toolkit init --opencode-only
 * .\node_modules\.bin\embedded-mcp-toolkit init
 */
program
  .command("init")
  .description("在任意目录初始化配置文件")
  .option(
    "-t, --target <path>",
    "目标目录（默认：当前工作目录）",
    process.cwd()
  )
  .option("-d, --device <name>", "默认设备名", "board-b")
  .option("--claude-only", "仅生成 Claude Code 配置", false)
  .option("--opencode-only", "仅生成 OpenCode 配置", false)
  .option("-f, --force", "覆盖已存在的文件", false)
  .action((opts) => {
    runInit(opts);
  });

/**
 * @brief 卸载清理
 * @details 删除 init 命令生成的所有文件，还原目录到初始化前的状态。
 *          支持 --claude-only / --opencode-only 分别清理对应配置。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit uninstall
 * embedded-mcp-toolkit uninstall --target /path/to/project --force
 * embedded-mcp-toolkit uninstall --claude-only
 * embedded-mcp-toolkit uninstall --opencode-only
 * .\node_modules\.bin\embedded-mcp-toolkit uninstall
 */
program
  .command("uninstall")
  .description("删除 init 命令生成的所有文件")
  .option(
    "-t, --target <path>",
    "目标目录（默认：当前工作目录）",
    process.cwd()
  )
  .option("--claude-only", "仅清理 Claude Code 相关文件", false)
  .option("--opencode-only", "仅清理 OpenCode 相关文件", false)
  .option("-f, --force", "跳过确认提示直接删除", false)
  .action(async (opts) => {
    await runUninstall(opts);
  });

// =============================================================================
// demo 父命令 —— 统一收纳所有演示/验证类子命令
// =============================================================================

/**
 * @brief 演示与验证命令（父命令）
 * @details 作为父命令统一聚合所有演示和验证类子命令，自身不执行操作。
 *          按传输方式分为 `ssh` 和 `serial` 两个二级父命令，
 *          各自下挂 `interact`（交互终端演示）和 `unlock`（PSH 解锁演示）。
 *
 * @par 子命令类型 内联父命令 —— 只聚合子命令，自身无 `.action()` 回调。
 *
 * @example
 * embedded-mcp-toolkit demo ssh interact
 * embedded-mcp-toolkit demo ssh unlock
 * embedded-mcp-toolkit demo serial interact
 * embedded-mcp-toolkit demo serial unlock
 */
const demoCmd = program
  .command("demo")
  .description("演示与验证命令(ssh / serial)");

// ---- demo ssh ----

/**
 * @brief SSH 演示命令（二级父命令）
 * @details 聚合 SSH 连接方式下的所有演示子命令，自身不执行操作。
 *          包含 `interact`（交互终端演示）和 `unlock`（PSH 加解锁演示）。
 *
 * @par 子命令类型 内联父命令 —— 作为 `demo` 的子命令，只聚合，无 `.action()`。
 *
 * @example
 * embedded-mcp-toolkit demo ssh interact
 * embedded-mcp-toolkit demo ssh unlock
 */
const demoSSHCmd = demoCmd
  .command("ssh")
  .description("SSH 演示命令(interact / unlock)");

/**
 * @brief SSH 交互终端演示
 * @details 通过 SSH 协议连接到目标嵌入式设备，启动交互式终端会话（演示模式）。
 *          连接参数从配置文件中读取。
 *
 * @par 子命令类型 内联子命令 —— 三级子命令，通过 `.action()` 在同一进程内执行。
 *
 * @example
 * embedded-mcp-toolkit demo ssh interact
 */
demoSSHCmd
  .command("interact")
  .description("SSH 交互终端演示")
  .action(() => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-b";
    process.env.BOARD_CONFIG_PATH ??= "./.embedded/configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./.embedded/log";
    interactiveShell(getSSHConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });

/**
 * @brief SSH PSH 加解锁演示
 * @details 通过 SSH 连接到设备后，自动探测 PSH（Protected SHell）状态并尝试解锁，
 *          用于加解锁流程的验证与演示。
 *
 * @par 子命令类型 内联子命令 —— 三级子命令，通过 `.action()` 在同一进程内执行。
 *
 * @example
 * embedded-mcp-toolkit demo ssh unlock
 */
demoSSHCmd
  .command("unlock")
  .description("SSH PSH 加解锁演示")
  .action(() => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-b";
    process.env.BOARD_CONFIG_PATH ??= "./.embedded/configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./.embedded/log";
    pshDemoSsh(getSSHConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });

// ---- demo serial ----

/**
 * @brief 串口演示命令（二级父命令）
 * @details 聚合串口连接方式下的所有演示子命令，自身不执行操作。
 *          包含 `interact`（交互终端演示）和 `unlock`（PSH 加解锁演示）。
 *
 * @par 子命令类型 内联父命令 —— 作为 `demo` 的子命令，只聚合，无 `.action()`。
 *
 * @example
 * embedded-mcp-toolkit demo serial interact
 * embedded-mcp-toolkit demo serial unlock
 */
const demoSerialCmd = demoCmd
  .command("serial")
  .description("串口演示命令(interact / unlock)");

/**
 * @brief 串口交互终端演示
 * @details 通过串口（UART）连接到目标嵌入式设备，启动交互式终端会话（演示模式）。
 *          串口参数从配置文件中读取。
 *
 * @par 子命令类型 内联子命令 —— 三级子命令，通过 `.action()` 在同一进程内执行。
 *
 * @example
 * embedded-mcp-toolkit demo serial interact
 */
demoSerialCmd
  .command("interact")
  .description("串口交互终端演示")
  .action(() => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-b";
    process.env.BOARD_CONFIG_PATH ??= "./configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./log";
    interactiveSerialShell(getSerialConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });

/**
 * @brief 串口 PSH 加解锁演示
 * @details 通过串口连接到设备后，自动探测 PSH（Protected SHell）状态并尝试解锁，
 *          用于加解锁流程的验证与演示。
 *
 * @par 子命令类型 内联子命令 —— 三级子命令，通过 `.action()` 在同一进程内执行。
 *
 * @example
 * embedded-mcp-toolkit demo serial unlock
 */
demoSerialCmd
  .command("unlock")
  .description("串口 PSH 加解锁演示")
  .action(() => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-b";
    process.env.BOARD_CONFIG_PATH ??= "./.embedded/configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./.embedded/log";
    pshDemoSerial(getSerialConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });

/**
 * @brief 串口用户登录演示
 * @details 通过串口连接到设备后，自动探测是否需要用户名/密码登录并完成认证，
 *          用于串口登录流程的验证与演示。
 *
 * @par 子命令类型 内联子命令 —— 三级子命令，通过 `.action()` 在同一进程内执行。
 *
 * @example
 * embedded-mcp-toolkit demo serial login
 */
demoSerialCmd
  .command("login")
  .description("串口用户登录演示")
  .action(() => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-lubancat";
    process.env.BOARD_CONFIG_PATH ??= "./.embedded/configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./.embedded/log";
    userLoginDemoSerial(getSerialConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });

/**
 * @brief 打印当前配置信息
 * @details 读取并格式化输出当前默认设备的完整配置，包括 SSH、串口
 *          以及对应的 KeyProvider 配置，方便用户检查和调试。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit config
 */
program
  .command("config")
  .description("打印当前默认设备的配置信息")
  .option("-b, --board <name>", "设备名，不指定则使用默认设备")
  .action((opts) => {
    // 使用 ??= 确保不影响已显式设置的环境变量。
    process.env.DEVICE ??= "board-b";
    process.env.BOARD_CONFIG_PATH ??= "./configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./log";
    const cfg = getAllConfig(opts.board);
    console.log(`Device: ${cfg.deviceName}`);
    console.log("");
    console.log("[SSH]");
    console.log(JSON.stringify(cfg.ssh, null, 2));
    console.log("");
    console.log("[Serial]");
    console.log(JSON.stringify(cfg.serial, null, 2));
    console.log("");
    console.log("[SSH KeyProvider]");
    console.log(JSON.stringify(cfg.sshKeyProvider, null, 2));
    console.log("");
    console.log("[Serial KeyProvider]");
    console.log(JSON.stringify(cfg.serialKeyProvider, null, 2));
  });

program.parse();
