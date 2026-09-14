/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : install.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: 菜单 [2]: 安装 Windows SSH 服务
 * ======================================================
 */

import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { select, isCancel, log } from "@clack/prompts";

import {
  OPENSSH_CAPABILITY_NAME,
  OPENSSH_MSI_URL,
  LOCAL_MSI_REL,
} from "../constants.js";
import { runPowerShell, runCmd } from "../../../shared/exec.js";
import { downloadFile } from "../../../shared/download.js";
import { detectOpenSshInstallMethod } from "../sshd-detect.js";
import { ensureSshdService } from "../sshd-service.js";

// ============================================================
// 菜单 [2]: 安装 Windows SSH 服务
// ============================================================

/**
 * @brief 安装 Windows OpenSSH Server
 * @details 先用 detectOpenSshInstallMethod（服务 / exe 文件 / Capability 三信号交叉
 *          判定）探测是否已安装，已安装则跳过安装步骤。未安装时让用户选择安装方式
 *          （默认 MSI）：
 *          - MSI 分支（默认）：本地已存在 MSI 包则跳过下载，否则从 GitHub
 *            下载后调用 msiexec 静默安装。
 *          - 在线分支：调用 Add-WindowsCapability 安装（依赖 Windows Update，
 *            国内网络易卡，故不作为默认）。
 *          两条路径最终统一走 ensureSshdReady（注册 → 启动 → 开机自启）。
 *          每步失败均打印中文提示并 return，不抛异常。
 * @returns 安装并启动成功返回 true
 */
export async function doInstallSsh(): Promise<boolean> {
  log.info("开始安装 Windows SSH ...");

  // 安装检测：服务注册 / exe 文件 / Capability 三信号交叉判定（统一探测入口）
  const installInfo = await detectOpenSshInstallMethod();
  if (installInfo.method !== "unknown") {
    log.message(
      `    OpenSSH Server 已安装(${installInfo.methodLabel})，跳过安装`
    );
    return ensureSshdReady();
  }

  // 让用户选择安装方式（默认 MSI）
  // clack select：方向键选择、Enter 确认；value 复用原 "1"/"2" 分支判断
  const methodChoiceRaw = await select<string>({
    message: "选择安装方式",
    options: [
      {
        value: "1",
        label: "MSI 离线安装",
        hint: "默认，下载一次可重复使用",
      },
      {
        value: "2",
        label: "在线安装(Add-WindowsCapability)",
        hint: "依赖 Windows Update",
      },
    ],
    initialValue: "1",
  });
  // Ctrl+C 取消：直接返回主菜单
  if (isCancel(methodChoiceRaw)) {
    log.message("    已取消安装方式选择");
    return false;
  }
  const methodChoice = methodChoiceRaw;

  // MSI 缓存路径（与拉取公钥同目录，使用模块常量便于卸载步骤复用）
  const msiPath = resolve(process.cwd(), LOCAL_MSI_REL);
  const msiDir = dirname(msiPath);

  if (methodChoice === "2") {
    // ===== 在线安装分支 =====
    log.message("    在线安装 (Add-WindowsCapability)...");
    log.message("    依赖 Windows Update, 网络不佳时可能长时间卡住");
    const installOnline = await runPowerShell(
      `Add-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME}`
    );
    if (!installOnline.success) {
      log.error(`    在线安装失败: ${installOnline.stderr || "未知错误"}`);
      log.message("     可重新运行本项改选 MSI 离线安装");
      return false;
    }
    log.message("在线安装成功");
  } else {
    // ===== MSI 离线安装分支（默认）=====
    // 确保下载目录存在
    if (!existsSync(msiDir)) {
      mkdirSync(msiDir, { recursive: true });
    }

    try {
      // 本地已存在 MSI 包则跳过下载
      if (existsSync(msiPath)) {
        log.message(`    已存在 MSI 安装包，跳过下载: ${msiPath}`);
      } else {
        log.message(`    下载 MSI 安装包: ${OPENSSH_MSI_URL}`);
        await downloadFile(OPENSSH_MSI_URL, msiPath);
        log.message(`    下载完成: ${msiPath}`);
      }

      log.message("    执行 MSI 静默安装...");
      const installMsi = await runCmd("msiexec", [
        "/i",
        msiPath,
        "/quiet",
        "/norestart",
      ]);
      if (!installMsi.success) {
        log.message(`    MSI 安装失败: ${installMsi.stderr || "未知错误"}`);
        return false;
      }
      log.message("    MSI 安装成功");
    } catch (err) {
      log.message(
        `    MSI 下载/安装失败: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  return ensureSshdReady();
}

/**
 * @brief 确保 sshd 服务就绪：注册 → 启动 → 开机自启
 * @details 「服务已安装」与「本次刚装完」两条路径共用，避免已安装路径跳过启动步骤。
 * @returns 全部就绪返回 true
 */
async function ensureSshdReady(): Promise<boolean> {
  log.info("启动 sshd 服务 ...");
  // 确保 sshd 服务已注册（MSI 静默安装有时不注册服务，需用 sshd.exe install 补注册）
  const serviceReady = await ensureSshdService();
  if (!serviceReady) {
    log.warn("请手动注册 sshd 服务：<sshd.exe 路径> install");
    return false;
  }

  // 启动 sshd 服务
  log.message("    正在启动 sshd 服务...");
  const startResult = await runPowerShell("Start-Service sshd");
  if (!startResult.success) {
    log.message(`    启动 sshd 失败: ${startResult.stderr || "未知错误"}`);
    return false;
  }
  log.message("    sshd 服务已启动");

  // 设为开机自启
  log.info("设置 sshd 开机自启 ...");
  const autoResult = await runPowerShell(
    "Set-Service -Name sshd -StartupType Automatic"
  );
  if (!autoResult.success) {
    log.message(`    设置自启失败: ${autoResult.stderr || "未知错误"}`);
    return false;
  }
  log.message("    sshd 已设为开机自启");
  log.success("Windows SSH 服务安装完成");
  return true;
}
