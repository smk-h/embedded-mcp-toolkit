/**
 * @file src/cli/commands/remote-mcp-config/target.ts
 * @brief C4-前半. 落点描述符与 askTarget（落点路由）
 *
 * 获取远端家目录、拼接远端项目绝对路径、交互式选择客户端类型与配置范围并组装配置目标。
 */

import { Client } from "ssh2";
import { select, isCancel, log, text } from "@clack/prompts";

import {
  type Target,
  type McpClient,
  type ClaudeScope,
  SERVER_KEY,
} from "./types.js";
import { sshExec } from "../../shared/ssh.js";

// ============================================================
// C4-前半. 落点描述符与 askTarget（落点路由）
// ============================================================

/**
 * @brief 获取远端家目录绝对路径（展开 ~）
 * @details SFTP 不识别 ~，需先通过 ssh exec 取远端 $HOME。结果去空白。
 * @param client 已连接的 ssh2 Client
 * @returns 远端家目录绝对路径
 * @throws 获取失败时抛出
 */
export async function getRemoteHome(client: Client): Promise<string> {
  const home = await sshExec(client, "echo $HOME");
  return home.replace(/\s+/g, "");
}

/**
 * @brief 拼接远端项目绝对路径（规范化分隔符）
 * @details 用户输入的项目路径可能带尾斜杠，远端统一用 / 分隔。本项目路径与子文件
 *          相对路径拼接为绝对路径。
 * @param projectPath 项目绝对路径（用户输入）
 * @param relSub      项目内相对子路径（如 ".mcp.json"）
 * @returns 远端绝对路径
 */
export function joinRemotePath(projectPath: string, relSub: string): string {
  const base = projectPath.replace(/\/+$/, "");
  return `${base}/${relSub}`;
}

/**
 * @brief 交互式选择客户端类型与配置范围，组装配置目标
 * @details 落点路由（F3）：
 *          - claude → select(全局/项目)；项目则 text(项目绝对路径)
 *          - zcode  → 直接 text(项目绝对路径)（本期 zcode 仅项目级）
 *          按选择组装 Target：
 *            Claude 全局  → 1 文件：~/.claude.json（serverPath:["mcpServers"]）
 *            Claude 项目  → 2 文件：.mcp.json（serverPath）+ settings.local.json（enableArray）
 *            ZCode  项目  → 1 文件：.zcode/config.json（serverPath:["mcp","servers"]，withTypeEnabled）
 * @param client     已连接的 ssh2 Client（用于展开 ~）
 * @returns 配置目标；用户取消返回 null
 * @throws 获取远端家目录失败时抛出
 */
export async function askTarget(client: Client): Promise<Target | null> {
  // 1. 选择客户端
  const clientChoice = await select<McpClient>({
    message: "选择客户端类型",
    options: [
      { value: "claude", label: "Claude Code" },
      { value: "zcode", label: "ZCode" },
    ],
  });
  if (isCancel(clientChoice)) {
    log.message("    已取消");
    return null;
  }

  // 2. 按客户端类型确定范围与路径
  if (clientChoice === "zcode") {
    // zcode：直接项目级
    const projRaw = await text({
      message: "项目绝对路径（远端 Linux）",
      placeholder: "如 /home/sumu/my-project",
    });
    if (isCancel(projRaw)) {
      log.message("    已取消");
      return null;
    }
    const projectPath = projRaw.trim();
    if (!projectPath) {
      log.message("    项目路径为空");
      return null;
    }
    return {
      client: "zcode",
      files: [
        {
          remotePath: joinRemotePath(projectPath, ".zcode/config.json"),
          label: "ZCode 项目",
          serverPath: ["mcp", "servers"],
          withTypeEnabled: true,
        },
      ],
    };
  }

  // claude：选择全局/项目
  const scopeChoice = await select<ClaudeScope>({
    message: "选择配置范围",
    options: [
      { value: "global", label: "全局（~/.claude.json，所有项目可用）" },
      { value: "project", label: "项目（指定项目路径）" },
    ],
  });
  if (isCancel(scopeChoice)) {
    log.message("    已取消");
    return null;
  }

  if (scopeChoice === "global") {
    const home = await getRemoteHome(client);
    return {
      client: "claude",
      files: [
        {
          remotePath: `${home}/.claude.json`,
          label: "Claude 全局",
          serverPath: ["mcpServers"],
          withTypeEnabled: false,
        },
      ],
    };
  }

  // claude 项目
  const projRaw = await text({
    message: "项目绝对路径（远端 Linux）",
    placeholder: "如 /home/sumu/my-project",
  });
  if (isCancel(projRaw)) {
    log.message("    已取消");
    return null;
  }
  const projectPath = projRaw.trim();
  if (!projectPath) {
    log.message("    项目路径为空");
    return null;
  }
  return {
    client: "claude",
    files: [
      {
        remotePath: joinRemotePath(projectPath, ".mcp.json"),
        label: "Claude 项目（.mcp.json server 定义）",
        serverPath: ["mcpServers"],
        withTypeEnabled: false,
      },
      {
        remotePath: joinRemotePath(projectPath, ".claude/settings.local.json"),
        label: "Claude 项目（settings.local.json 使能）",
        serverPath: [],
        withTypeEnabled: false,
        enableArrayPath: ["enabledMcpjsonServers"],
        enableValue: SERVER_KEY,
      },
    ],
  };
}
