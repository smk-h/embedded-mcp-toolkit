/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : run.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cnb 命令主入口（线性流程编排）
 *
 * 把"Windows 本地 MCP 暴露给 CNB 云开发环境"的全流程收敛成一条命令：
 *   输入环境标识 → 确保隧道 → 本地生成密钥 → 推送私钥/写隧道 config →
 *   写 CodeBuddy MCP 配置 → 展示容器侧 ssh 命令 → 按 q 退出
 *
 * 与 sshd-config / remote-mcp-config 的菜单式命令不同，本命令是一次性线性流程
 * （用户诉求即"输入地址后一路跑完"），故不设主菜单，收尾统一用 waitForQuit 等待。
 *
 * 依赖方向说明：复用 cloudflared 的隧道状态/启动（同一隧道域）、sshd-config 的
 * authorized_keys 维护（同一份免密语义）、shared 的 SSH 传输层与交互辅助。
 * ======================================================
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { Client } from "ssh2";
import { text, isCancel, log } from "@clack/prompts";

import { sshDisconnect } from "../../shared/ssh.js";
import {
  clearScreen,
  collectConnectionInfo,
  waitForQuit,
} from "../../shared/cli-helpers.js";
import { isWindows } from "../../shared/platform.js";
import {
  CNB_DEFAULT_PROJECT_DIR,
  MCP_TEMPLATE_REL,
  START_SCRIPT_NAME,
} from "./constants.js";
import { type CnbOptions, type LocalEndpoint } from "./types.js";
import { connectCnbEnv, parseCnbAddress } from "./connect.js";
import { doLocalKey } from "./steps/local-key.js";
import { ensureTunnelDomain } from "./steps/tunnel.js";
import { doPushKey } from "./steps/push-key.js";
import { doMcpConfig } from "./steps/mcp-config.js";
import { printFinalSummary } from "./steps/summary.js";

// ============================================================
// 主入口
// ============================================================

/**
 * @brief 打印命令 banner（标题分隔线）
 */
function printBanner(): void {
  console.log("===================================");
  console.log("  embedded-mcp-toolkit cnb");
  console.log("===================================");
}

/**
 * @brief cnb 命令主入口
 * @details 平台校验 → 交互式线性流程 → 按 q 退出。流程内部各步骤自身的失败
 *          均以日志提示并在流程内消化，不向调用方抛异常。用户在步骤 1 取消输入
 *          （Ctrl+C）时视为主动放弃，直接退出；其余情况（含中途失败）保留终端，
 *          让用户看清结果提示后再按 q 退出。
 * @param opts 命令选项（dir 指定容器内项目根目录）
 */
export async function runCnb(opts: CnbOptions): Promise<void> {
  if (!isWindows()) {
    console.error("[err] 本命令仅支持 Windows");
    return;
  }

  clearScreen();
  printBanner();
  const shouldWait = await executeFlow(opts);
  if (!shouldWait) {
    return;
  }

  // 一次性流程无菜单可回，收尾等待用户按 q 退出
  log.info("流程结束，按 q 退出");
  await waitForQuit();
}

// ============================================================
// 流程编排
// ============================================================

/**
 * @brief 执行"打通 CNB 免密通道"的完整流程
 * @details 步骤与失败处理：
 *          1. 交互输入 CNB 环境标识，解析失败即中止；
 *          2. 采集 Windows 侧端点（用户名 + bat 路径）；
 *          3. 确保 Quick Tunnel 就绪并取得域名，失败即中止；
 *          4. 本地生成密钥对并写入 authorized_keys，失败即中止；
 *          5. 连接 CNB 环境（none 认证），失败即中止；
 *          6. 推送私钥 + 写隧道 config → 写 MCP 配置 → 展示结果，
 *             连接在 finally 中统一关闭。
 * @param opts 命令选项
 * @returns 是否需要在流程结束后等待用户按 q 退出（用户主动取消返回 false）
 */
async function executeFlow(opts: CnbOptions): Promise<boolean> {
  // 1. 输入 CNB 环境标识
  log.info("连接目标");
  const addressRaw = await text({
    message: "CNB 云开发环境 SSH 入口（环境标识@cnb.space）",
    placeholder: "cnb-ihg-xxxxx-xxx.xxxx-xxxx-xxxx-xxxx@cnb.space",
  });
  if (isCancel(addressRaw)) {
    log.message("    已取消");
    return false;
  }
  const envInfo = parseCnbAddress(String(addressRaw).trim());
  if (!envInfo) {
    log.message("    地址格式错误，应为 <环境标识>@cnb.space");
    return true;
  }
  log.message(`    ${envInfo.username}@${envInfo.host}:${envInfo.port}`);

  // 2. 采集 Windows 侧端点
  const { sshUser } = collectConnectionInfo();
  const batPath =
    `${process.cwd().replace(/\\/g, "/")}/${START_SCRIPT_NAME}`.replace(
      /\/+/g,
      "/"
    );
  const endpoint: LocalEndpoint = { sshUser, batPath };
  log.message(`    Windows 用户: ${sshUser}`);
  log.message(`    启动脚本:     ${batPath}`);
  if (!existsSync(resolve(process.cwd(), START_SCRIPT_NAME))) {
    log.message(`    警告: 未找到 ${START_SCRIPT_NAME}，MCP 启动可能失败`);
  }

  // 3. 确保隧道域名可用
  const domain = await ensureTunnelDomain();
  if (!domain) {
    return true;
  }

  // 4. 本地密钥对 + authorized_keys
  const localKey = await doLocalKey();
  if (!localKey) {
    return true;
  }

  // 5. 连接 CNB 环境
  let client: Client;
  try {
    log.info("连接 CNB 云开发环境 ...");
    client = await connectCnbEnv(envInfo);
    log.message("    连接成功（none 认证，无需密码）");
  } catch (err) {
    log.message(`    连接失败: ${err instanceof Error ? err.message : err}`);
    log.message("    请确认环境标识正确、开发环境已启动且网络可达");
    return true;
  }

  try {
    // 6. 推送私钥 + 写隧道 config
    const pushed = await doPushKey(client, domain, sshUser);
    if (!pushed) {
      return true;
    }

    // 7. 写 CodeBuddy MCP 配置（容器内项目根）
    const projectDir = opts.dir ?? CNB_DEFAULT_PROJECT_DIR;
    const remoteMcpPath = await doMcpConfig(client, endpoint, projectDir);
    if (!remoteMcpPath) {
      return true;
    }

    // 8. 结果展示
    printFinalSummary({
      endpoint,
      domain,
      remoteKeyPath: pushed.remoteKeyPath,
      remoteConfigPath: pushed.remoteConfigPath,
      remoteMcpPath,
      templatePath: resolve(process.cwd(), MCP_TEMPLATE_REL),
    });
  } catch (err) {
    log.message(`    执行失败: ${err instanceof Error ? err.message : err}`);
  } finally {
    sshDisconnect(client);
  }

  return true;
}
