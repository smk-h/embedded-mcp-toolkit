/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/05/21
 * Version    : x.x.x
 * Description: CLI 命令入口 — commander 命令树注册与分发
 * ======================================================
 */

import { Command } from "commander";
import { getAllConfig } from "../sdk/shared/config.js";
import { pkg } from "../sdk/shared/package-info.js";
import { startMcpServer } from "../mcp/server.js";
import { runInit, runUninstall } from "./commands/init.js";
import { runSplit } from "./commands/split.js";
import { registerDevCommand } from "./commands/dev/index.js";
import { runSshdConfig } from "./commands/sshd-config/index.js";
import {
  runCloudflared,
  runCloudflaredAction,
} from "./commands/cloudflared/index.js";
import { runRemoteMcpConfig } from "./commands/remote-mcp-config/index.js";
import { runCnb } from "./commands/cnb/index.js";
import { runRegexVerify } from "./commands/regex-verify.js";

/**
 * 命令层级结构：
 * ─────────────────────────────────────────────────────────────────────────────
 * embedded-mcp-toolkit
 * ├── mcp (★默认)                ← MCP 服务器模式（.action() + isDefault）
 * ├── init                       ← 初始化配置文件（.action()）
 * ├── uninstall                  ← 清理 init 生成的文件（.action()）
 * ├── split                      ← 拆分 config.yaml 为 devices/*.yaml（.action()）
 * ├── dev                        ← 设备配置管理父命令（无 .action()，聚合子命令）
 * │   ├── create                 ←   交互式创建新设备配置文件
 * │   └── list                   ←   列出全部设备（含模板）及三通道状态
 * ├── regex-verify               ← 自测设备 yaml 的 U-Boot 正则配置（.action()）
 * ├── sshd-config                ← 配置 Windows OpenSSH 免密登录环境（.action()）
 * ├── cloudflared                ← 启动和管理 cloudflared Quick Tunnel(父命令,无参数进菜单)
 * │   ├── start                  ←   后台启动隧道并从日志提取域名
 * │   ├── stop                   ←   停止隧道并清理状态文件
 * │   ├── status                 ←   查看隧道状态与域名
 * │   ├── log                    ←   查看隧道日志尾部
 * │   └── install                ←   安装 cloudflared(winget / 便携版)
 * ├── remote-mcp-config          ← 登录远程 Linux 配置 claude/zcode/opencode/dsh 的 MCP 桥接（.action()）
 * ├── cnb                        ← 一键打通 CNB 云环境与 Windows 本地 MCP（.action()）
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
  .option("-d, --device <name>", "默认设备名", "board-example")
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
// split 命令 —— 将单文件 config.yaml 拆分为 devices/*.yaml
// =============================================================================

/**
 * @brief 配置拆分命令
 * @details 读取源 config.yaml 的 devices 段，为每个设备生成独立的
 *          devices/<设备名>.yaml 文件，帮助用户从单文件布局迁移到分文件布局。
 *          目标文件已存在时默认跳过，加 --force 后才覆盖。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit split
 * embedded-mcp-toolkit split --config ./.embedded/configs/config.yaml
 * embedded-mcp-toolkit split --force
 */
program
  .command("split")
  .description("将单文件 config.yaml 的 devices 段拆分为 devices/*.yaml")
  .option(
    "-c, --config <path>",
    "源 config.yaml 路径",
    "./.embedded/configs/config.yaml"
  )
  .option("-f, --force", "覆盖已存在的设备文件", false)
  .action((opts) => {
    runSplit(opts);
  });

// =============================================================================
// dev 命令 —— 设备配置管理（接线聚合于 commands/dev/index.ts，含 create/list）
// =============================================================================

/**
 * @brief 设备配置管理父命令
 * @details dev 命名空间的父命令定义与 create/list 等子命令的注册统一收敛在
 *          commands/dev/index.ts（registerDevCommand），此处仅一行接入；
 *          各子命令的选项、描述与示例见该文件。
 *
 * @example
 * embedded-mcp-toolkit dev create -y
 * embedded-mcp-toolkit dev list
 */
registerDevCommand(program);

// =============================================================================
// regex-verify 命令 —— 自测设备 yaml 中的 U-Boot 正则配置
// =============================================================================

/**
 * @brief U-Boot 正则配置自测命令
 *
 * 加载指定设备的 serial.uboot 配置，构造 UbootDetector（自动合并默认值），
 * 跑标准样本矩阵 + 用户自定义样本，展示每条匹配结果。
 * 用于不连真机的情况下验证 yaml 正则能否正确识别 U-Boot 各类输出。
 */
program
  .command("regex-verify")
  .description(
    "自测设备 yaml 的 U-Boot 正则配置（加载 serial.uboot，跑样本矩阵）"
  )
  .argument("<device>", "设备名（.embedded/configs/devices/<device>.yaml）")
  .option(
    "-s, --sample <text>",
    "追加一条自定义测试样本（可多次使用）",
    (value: string, previous: string[]) => [...previous, value],
    []
  )
  .option("-v, --verbose", "显示构造出的 detector 内部状态", false)
  .action((device: string, opts: { sample: string[]; verbose: boolean }) => {
    runRegexVerify({
      device,
      sample: opts.sample,
      verbose: opts.verbose,
    });
  });

// =============================================================================
// sshd-config 命令 —— 交互式配置 Windows OpenSSH 免密登录环境
// =============================================================================

/**
 * @brief Windows SSH 免密登录配置命令
 * @details 交互式菜单引导完成"Linux 编译服务器 → Windows 免密登录"环境搭建。
 *          执行后先做管理员权限检查与平台校验，通过后展示菜单：
 *          [1] 一键完成全流程（安装→密钥→配置→模板）
 *          [2] 安装 Windows SSH 服务（在线/MSI 双途径）
 *          [3] 编译服务器生成密钥对（SFTP 拉取公钥到本地）
 *          [4] 配置 Windows sshd（写 authorized_keys、改 sshd_config、禁用 administrators 分组）
 *          [5] 检查 sshd 配置状态（只读诊断）
 *          [6] 卸载 Windows SSH 服务
 *          [7] 查看本机连接信息（用户名/IP）
 *          [8] 生成 Linux 端 MCP 配置模板
 *          [9] 清理 authorized_keys 失效公钥（CNB 等临时环境重建后残留公钥的批量清理）
 *          各项可独立重复执行，适用于"远程 Agent + 本地 MCP"部署场景。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit sshd-config
 */
program
  .command("sshd-config")
  .description("配置 Windows OpenSSH 免密登录环境（交互式菜单）")
  .action(() => {
    runSshdConfig({});
  });

// =============================================================================
// cloudflared 命令 —— 启动和管理 Windows 下的 cloudflared Quick Tunnel
// =============================================================================

/**
 * @brief cloudflared Quick Tunnel 管理命令
 * @details 把"暴露本机 sshd 给公网侧 AI 客户端"固化为单命令（方案背景见
 *          docs/MCP-CNB云环境访问Windows本地MCP方案.md 三、四、五章）。
 *          无参数进交互式菜单；子命令直达：
 *            start   后台启动隧道(spawn detached 常驻)并从日志提取域名
 *            stop    杀进程树并清理状态文件
 *            status  进程存活探测 + 域名展示(可从日志补录)
 *            log     查看隧道日志尾部
 *            install 安装 cloudflared(winget / 便携版)
 *          状态持久化于 .embedded/cloudflared/state.json,隧道目标默认
 *          ssh://127.0.0.1:22(--url 仅 start 提供;勿用 localhost,IPv6
 *          回环会导致 sshd 侧端点解析失败)。
 *
 * @par 子命令类型 父命令聚合 —— 仿 dev 命令：父命令自身带 .action()（无参数
 *          进交互菜单），子命令通过 .command() 挂载直达对应操作。
 *
 * @example
 * embedded-mcp-toolkit cloudflared            无参数进交互菜单
 * embedded-mcp-toolkit cloudflared start      后台启动隧道并提取域名
 * embedded-mcp-toolkit cloudflared status     查看状态与域名
 */
const cloudflaredCmd = program
  .command("cloudflared")
  .description(
    "启动和管理 Windows 下的 cloudflared Quick Tunnel(无参数进交互菜单)"
  );

cloudflaredCmd
  .command("start")
  .description("后台启动隧道(进程常驻,与 CLI 生命周期解耦)并从日志提取域名")
  .option(
    "-u, --url <url>",
    "隧道目标 URL,默认 ssh://127.0.0.1:22(勿用 localhost)",
    "ssh://127.0.0.1:22"
  )
  .action((opts) => {
    runCloudflaredAction("start", { url: opts.url });
  });

cloudflaredCmd
  .command("stop")
  .description("停止隧道(杀整棵进程树)并清理状态文件")
  .action(() => {
    runCloudflaredAction("stop", {});
  });

cloudflaredCmd
  .command("status")
  .description("查看隧道状态与域名(域名缺失时自动从日志补录)")
  .action(() => {
    runCloudflaredAction("status", {});
  });

cloudflaredCmd
  .command("log")
  .description("查看隧道日志尾部(排查域名未分配/进程退出)")
  .action(() => {
    runCloudflaredAction("log", {});
  });

cloudflaredCmd
  .command("install")
  .description("安装 cloudflared(winget / 便携版到 .embedded/bin)")
  .action(() => {
    runCloudflaredAction("install", {});
  });

cloudflaredCmd.action(() => {
  runCloudflared({});
});

// =============================================================================
// remote-mcp-config 命令 —— 登录远程 Linux 配置 claude/zcode/opencode/dsh 的 MCP 桥接
// =============================================================================

/**
 * @brief 远程 MCP 桥接配置命令
 * @details 与 sshd-config 对偶：从本机 SSH 登录远程 Linux 服务器，交互式地在远端
 *          配置 claude/zcode/opencode/dsh 的 MCP 桥接 server（ssh 转发到本机的
 *          remote-start-mcp.bat）。覆盖六类落点：Claude 全局（~/.claude.json）、
 *          Claude 项目（.mcp.json + settings.local.json）、ZCode 项目（.zcode/config.json）、
 *          DSH 项目（.dsh/dshmm/mcp.json）、opencode 全局（~/.config/opencode/opencode.json）、
 *          opencode 项目（.opencode/opencode.json）。配置前先读取展示
 *          状态，支持配置/查看/删除。所有文件操作通过 SFTP 完成，远端无需预装 node。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit remote-mcp-config
 */
program
  .command("remote-mcp-config")
  .description(
    "登录远程 Linux 配置 claude/zcode/opencode/dsh 的 MCP 桥接（交互式菜单）"
  )
  .action(() => {
    runRemoteMcpConfig({});
  });

// =============================================================================
// cnb 命令 —— 一键打通 CNB 云开发环境与 Windows 本地 MCP
// =============================================================================

/**
 * @brief CNB 云环境免密通道配置命令
 * @details 把"CNB 容器 ssh 到 Windows 本地 MCP"的部署流程固化为单命令
 *          （方案背景见 docs/MCP-CNB云环境访问Windows本地MCP方案.md）：
 *          交互输入 CNB 环境标识 → 确保 Cloudflare Quick Tunnel → 本地生成
 *          id_mcp_cnb_server 密钥对并写入本机 authorized_keys → 免密登录容器、
 *          推送私钥并写入隧道 ssh config → 生成 CodeBuddy MCP 配置写入容器项目根
 *          → 展示容器侧 ssh 命令，按 q 退出。
 *          命令可重复执行：CNB 容器每次重建后重跑即可恢复免密通道。
 *
 * @par 子命令类型 顶层内联命令 —— 通过 `.action()` 在同一进程内执行回调。
 *
 * @example
 * embedded-mcp-toolkit cnb
 * embedded-mcp-toolkit cnb --dir /workspace/my-project
 */
program
  .command("cnb")
  .description(
    "一键打通 CNB 云开发环境与 Windows 本地 MCP（免密 + 隧道 + MCP 配置）"
  )
  .option(
    "-d, --dir <path>",
    "CNB 容器内项目根目录（写入 <dir>/.mcp.json，默认 /workspace）"
  )
  .action((opts) => {
    runCnb({ dir: opts.dir });
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
    process.env.BOARD_CONFIG_PATH ??= "./.embedded/configs/config.yaml";
    process.env.LOG_SAVE ??= "1";
    process.env.LOG_DIR ??= "./.embedded/log";
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
