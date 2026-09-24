/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : target.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: C4-前半. 落点描述符与 askTarget（落点路由）
 *
 * 获取远端家目录、拼接远端项目绝对路径、交互式选择客户端类型与配置范围并组装配置目标。
 * ======================================================
 */

import { Client } from "ssh2";
import { select, isCancel, log, text } from "@clack/prompts";

import {
  type Target,
  type TargetFile,
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
 * @brief 交互式输入远端项目绝对路径
 * @returns 项目绝对路径；用户取消或为空返回 null
 */
async function askProjectPath(): Promise<string | null> {
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
  return projectPath;
}

/**
 * @brief 构造项目级 `.mcp.json` 落点描述符（Claude 与 CodeBuddy 共用）
 * @details 两个客户端读写的是**同一个** `<项目根>/.mcp.json` 的 `mcpServers`，
 *          写的是**同一个** server key，因此 server 形态必须完全一致，否则同一
 *          文件会随"最后跑的是哪个落点"而在两种形态间抖动。故两者都**不写**
 *          `type`：Claude 省略时默认 stdio，CodeBuddy 含 `command` 时自动推断
 *          为 stdio，功能等价。（CodeBuddy 全局 `mcp.json` 是独占文件，与 Claude
 *          无交集，仍显式写 `type:"stdio"`。）
 * @param projectPath 远端项目绝对路径
 * @param label       用户可见的落点描述（用于区分是哪个客户端发起的配置）
 * @returns `.mcp.json` 落点描述符
 */
function projectMcpJsonFile(projectPath: string, label: string): TargetFile {
  return {
    remotePath: joinRemotePath(projectPath, ".mcp.json"),
    label,
    serverPath: ["mcpServers"],
    serverStyle: "split",
  };
}

/** @brief 支持「全局」落点的客户端（即 GLOBAL_SCOPE_LABEL 的键集合） */
type GlobalScopeClient = "claude" | "opencode" | "codebuddy";

/**
 * @brief 各客户端「全局」落点的选项 label（含落点文件说明）
 * @details scope 选项的文案随客户端而变（三选一），收敛在此映射，避免在
 *          askTarget 里堆叠嵌套三元。键集合恰是支持全局落点的三个客户端。
 */
const GLOBAL_SCOPE_LABEL: Record<GlobalScopeClient, string> = {
  claude: "全局（~/.claude.json，所有项目可用）",
  opencode: "全局（~/.config/opencode/opencode.json，所有项目可用）",
  codebuddy: "全局（~/.codebuddy/mcp.json，所有项目可用）",
};

/**
 * @brief 交互式选择客户端类型与配置范围，组装配置目标
 * @details 落点路由（F3）：
 *          - claude    → select(全局/项目)；项目则 text(项目绝对路径)
 *          - zcode     → 直接 text(项目绝对路径)（本期 zcode 仅项目级）
 *          - dsh       → 直接 text(项目绝对路径)（本期 dsh 仅项目级）
 *          - opencode  → select(全局/项目)；项目则 text(项目绝对路径)
 *          - codebuddy → select(全局/项目)；项目则 text(项目绝对路径)
 *          按选择组装 Target：
 *            Claude    全局 → 1 文件：~/.claude.json（serverPath:["mcpServers"]）
 *            Claude    项目 → 2 文件：.mcp.json（serverPath）+ settings.local.json（enableArray）
 *            CodeBuddy 全局 → 1 文件：~/.codebuddy/mcp.json（serverPath:["mcpServers"]，
 *                             serverType:"stdio" 且不写 enabled）
 *            CodeBuddy 项目 → 1 文件：.mcp.json（与 Claude 项目级**同一个文件、
 *                             同一种形态**，共用 projectMcpJsonFile 构造）
 *            ZCode     项目 → 1 文件：.zcode/config.json（serverPath:["mcp","servers"]，
 *                             serverType:"stdio"）
 *            DSH       项目 → 1 文件：.dsh/dshmm/mcp.json（serverPath:["mcpServers"]，
 *                             serverType:"stdio" 且不写 enabled，另带置空的 cwd）
 *            opencode  全局 → 1 文件：~/.config/opencode/opencode.json（serverPath:["mcp"]，
 *                             serverStyle:"array"，serverType:"local"）
 *            opencode  项目 → 1 文件：.opencode/opencode.json（serverPath:["mcp"]，
 *                             serverStyle:"array"，serverType:"local"）
 *          全局落点均需展开 ~（SFTP 不识别 ~），故依赖 client 取远端 $HOME。
 * @note  CodeBuddy 全局固定写**不带点**的 mcp.json。官方 CLI 的用户级优先级为
 *          ~/.codebuddy/.mcp.json > ~/.codebuddy/mcp.json > ~/.codebuddy.json，
 *          但 CodeBuddy IDE 只认不带点的 ~/.codebuddy/mcp.json（实测结论见
 *          src/cli/commands/cnb/constants.ts 的 REMOTE_MCP_FILE_NAME 注释），
 *          故不带点者是 IDE 与 CLI 两个宿主都生效的唯一路径。
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
      { value: "opencode", label: "opencode" },
      { value: "dsh", label: "DSH (DeepSeek Harness)" },
      { value: "codebuddy", label: "CodeBuddy" },
    ],
  });
  if (isCancel(clientChoice)) {
    log.message("    已取消");
    return null;
  }

  // zcode / dsh：仅项目级
  if (clientChoice === "zcode" || clientChoice === "dsh") {
    const projectPath = await askProjectPath();
    if (!projectPath) return null;

    if (clientChoice === "dsh") {
      return {
        client: "dsh",
        files: [
          {
            remotePath: joinRemotePath(projectPath, ".dsh/dshmm/mcp.json"),
            label: "DSH 项目（.dsh/dshmm/mcp.json）",
            serverPath: ["mcpServers"],
            serverStyle: "split",
            serverType: "stdio",
            // dsh 的 server 对象不含 enabled 字段
            serverEnabled: false,
            // cwd 非必需，按约定保留字段并置空
            cwd: "",
          },
        ],
      };
    }

    return {
      client: "zcode",
      files: [
        {
          remotePath: joinRemotePath(projectPath, ".zcode/config.json"),
          label: "ZCode 项目",
          serverPath: ["mcp", "servers"],
          serverStyle: "split",
          serverType: "stdio",
        },
      ],
    };
  }

  // 2. claude / opencode / codebuddy：选择全局/项目
  const scopeChoice = await select<ClaudeScope>({
    message: "选择配置范围",
    options: [
      { value: "global", label: GLOBAL_SCOPE_LABEL[clientChoice] },
      { value: "project", label: "项目（指定项目路径）" },
    ],
  });
  if (isCancel(scopeChoice)) {
    log.message("    已取消");
    return null;
  }

  // 全局落点
  if (scopeChoice === "global") {
    const home = await getRemoteHome(client);

    // opencode 全局：~/.config/opencode/opencode.json
    if (clientChoice === "opencode") {
      return {
        client: "opencode",
        files: [
          {
            remotePath: `${home}/.config/opencode/opencode.json`,
            label: "opencode 全局（~/.config/opencode/opencode.json）",
            serverPath: ["mcp"],
            serverStyle: "array",
            serverType: "local",
            rootSchema: "https://opencode.ai/config.json",
          },
        ],
      };
    }

    // CodeBuddy 全局：~/.codebuddy/mcp.json（不带点，IDE 与 CLI 都读这个）
    if (clientChoice === "codebuddy") {
      return {
        client: "codebuddy",
        files: [
          {
            remotePath: `${home}/.codebuddy/mcp.json`,
            label: "CodeBuddy 全局（~/.codebuddy/mcp.json）",
            serverPath: ["mcpServers"],
            serverStyle: "split",
            serverType: "stdio",
            // CodeBuddy 的 server 对象不含 enabled 字段
            serverEnabled: false,
          },
        ],
      };
    }

    // Claude 全局：~/.claude.json
    return {
      client: "claude",
      files: [
        {
          remotePath: `${home}/.claude.json`,
          label: "Claude 全局",
          serverPath: ["mcpServers"],
          serverStyle: "split",
        },
      ],
    };
  }

  // 项目级
  const projectPath = await askProjectPath();
  if (!projectPath) return null;

  // opencode 项目：.opencode/opencode.json
  if (clientChoice === "opencode") {
    return {
      client: "opencode",
      files: [
        {
          remotePath: joinRemotePath(projectPath, ".opencode/opencode.json"),
          label: "opencode 项目（.opencode/opencode.json）",
          serverPath: ["mcp"],
          serverStyle: "array",
          serverType: "local",
          rootSchema: "https://opencode.ai/config.json",
        },
      ],
    };
  }

  // CodeBuddy 项目：.mcp.json（与 Claude 项目级同一个文件，形态必须一致）
  if (clientChoice === "codebuddy") {
    return {
      client: "codebuddy",
      files: [
        projectMcpJsonFile(
          projectPath,
          "CodeBuddy 项目（.mcp.json，与 Claude 共用）"
        ),
      ],
    };
  }

  // claude 项目
  return {
    client: "claude",
    files: [
      projectMcpJsonFile(projectPath, "Claude 项目（.mcp.json server 定义）"),
      {
        remotePath: joinRemotePath(projectPath, ".claude/settings.local.json"),
        label: "Claude 项目（settings.local.json 使能）",
        serverPath: [],
        serverStyle: "split",
        enableArrayPath: ["enabledMcpjsonServers"],
        enableValue: SERVER_KEY,
      },
    ],
  };
}
