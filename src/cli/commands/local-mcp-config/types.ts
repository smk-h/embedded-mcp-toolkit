/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/10/31
 * Version    : x.x.x
 * Description: local-mcp-config 命令的领域模型与常量
 *
 * 领域模型（BridgeServer / TargetFile / DesiredState / StatusResult /
 * ResolveCtx / ClientSpec 等）与 remote-mcp-config 完全同构，直接整包
 * re-export 复用——两个命令共享同一套落点数据表（targets.ts 的 CLIENTS）
 * 与读写框架，差异只在：
 *   - 写什么：本命令的 bridge = `cmd /c <remote-start-mcp.bat 绝对路径>`
 *     （bat 持有 cwd 与全部环境变量，是 env 的单一事实来源）；
 *   - 怎么写：本地 fs 直读直写（见本目录 file-ops.ts），不经 SFTP。
 * ======================================================
 */

export * from "../remote-mcp-config/types.js";

/**
 * @brief local-mcp-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。本期无命令行选项。
 */
export type LocalMcpConfigOptions = Record<string, never>;
