/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : install.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: step1: 安装 Windows SSH 服务
 * ======================================================
 */

import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { select, isCancel, log } from "@clack/prompts";

import {
  OPENSSH_CAPABILITY_NAME,
  OPENSSH_MSI_URL,
  LOCAL_MSI_REL,
} from "../types.js";
import { runPowerShell, runCmd } from "../exec.js";
import { downloadFile } from "../download.js";
import { isSshdServiceRegistered, ensureSshdService } from "../sshd-service.js";

// ============================================================
// step1: 安装 Windows SSH 服务
// ============================================================

/**
 * @brief 安装 Windows OpenSSH Server
 * @details 先检测是否已安装（Get-Service sshd / Get-WindowsCapability），
 *          已安装则跳过。未安装时让用户选择安装方式（默认 MSI）：
 *          - MSI 分支（默认）：本地已存在 MSI 包则跳过下载，否则从 GitHub
 *            下载后调用 msiexec 静默安装。
 *          - 在线分支：调用 Add-WindowsCapability 安装（依赖 Windows Update，
 *            国内网络易卡，故不作为默认）。
 *          安装后启动 sshd 并设为开机自启。每步失败均打印中文提示并 return，
 *          不抛异常。
 */
export async function doInstallSsh(): Promise<boolean> {
  log.info("开始安装 Windows SSH ...");

  // 检测 sshd 服务是否已存在
  if (await isSshdServiceRegistered()) {
    log.message("    OpenSSH Server 已安装，跳过");
    return true;
  }

  // 检测 Windows Capability 状态
  const checkCap = await runPowerShell(
    `Get-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME} | Select-Object -ExpandProperty State`
  );
  if (checkCap.success && checkCap.stdout.includes("Installed")) {
    log.message("    OpenSSH Server 已安装(Capability)，跳过");
    return true;
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

  // MSI 缓存路径（与 step2 拉取的公钥同目录，使用模块常量便于 step5 卸载复用）
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
