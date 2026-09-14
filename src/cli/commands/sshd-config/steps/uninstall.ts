/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : uninstall.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: 菜单 [6]: 卸载 Windows SSH 服务
 * ======================================================
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { log } from "@clack/prompts";

import {
  LOCAL_PUBKEY_REL,
  LOCAL_MSI_REL,
  OPENSSH_CAPABILITY_NAME,
} from "../constants.js";
import { runPowerShell, runCmd } from "../../../shared/exec.js";
import {
  isSshdServiceRegistered,
  detectOpenSshInstallMethod,
} from "../sshd-detect.js";
import { removeAuthorizedKey } from "../authorized-keys.js";
import { restoreSshdConfigFromBackup } from "../sshd-config.js";
import { prompt } from "../../../shared/cli-helpers.js";

// ============================================================
// 菜单 [6] 辅助：卸载流程专用工具函数
// ============================================================

/**
 * @brief 打开"程序和功能"并等待用户手动卸载后按回车继续
 * @details 封装三处相同的"开 appwiz.cpl + 等待回车"逻辑。
 *          手动卸载是异步过程，程序无法感知结束时机，故用 prompt 阻塞等待。
 *
 *          实现说明：.cpl 不能直接 spawn（报 EFTYPE），也不能用 control.exe
 *          （它启动控制面板后固定返回退出码 1，execFile 会误判为失败）。
 *          用 `cmd /c start "" "appwiz.cpl"` 是 Windows 打开文件/程序的标准方式：
 *          start 自身立即返回退出码 0，控制面板窗口正常弹出。
 * @returns 打开失败时返回 false（已打印错误提示）
 */
async function openAppwizAndAwait(): Promise<boolean> {
  log.message('    正在打开"程序和功能"，请在窗口中找到 OpenSSH 手动卸载...');
  const openResult = await runCmd("cmd", ["/c", "start", "", "appwiz.cpl"]);
  if (!openResult.success) {
    log.message(`    打开"程序和功能"失败: ${openResult.stderr || "未知错误"}`);
    log.message('    可手动运行 appwiz.cpl 或通过"设置 > 应用"卸载');
    return false;
  }
  log.message('    已打开"程序和功能"，请在窗口中卸载 OpenSSH');
  log.message("    卸载完成后按回车继续...");
  await prompt("  ");
  return true;
}

// ============================================================
// 菜单 [6]: 卸载 Windows SSH 服务
// ============================================================

/**
 * @brief 卸载 Windows OpenSSH Server
 * @details 先用 detectOpenSshInstallMethod 判定安装方式，再按来源选卸载策略：
 *          - msi        → 优先 msiexec /x 静默卸载（需本地有 MSI 包），否则 appwiz.cpl
 *          - capability → Remove-WindowsCapability（系统组件卸载）
 *          - unknown    → 直接打开 appwiz.cpl 让用户手动卸载
 *
 *          卸载流程顺序（先停服务再卸载，避免运行中的 sshd 占用文件）：
 *          0. 停止 sshd 服务（Stop-Service sshd -Force）
 *          1. 按安装方式卸载 OpenSSH（msiexec / Remove-WindowsCapability / appwiz.cpl）
 *          2. 删除 sshd 服务残留（卸载有时不删服务，sc.exe delete 补删）
 *          3. 从 authorized_keys 移除 MCP 专用公钥（对应配置步骤的写入）
 *          4. 从 .bak 备份恢复 sshd_config（对应配置步骤的修改）
 *          authorized_keys 与 sshd_config 的增删/备份恢复分别委托
 *          authorized-keys.ts / sshd-config.ts，与写入侧保持对称。
 *
 *          不自动删除 C:\ProgramData\ssh 与 C:\Program Files\OpenSSH 目录：
 *          前者可能含用户自定义配置，避免误删；仅在末尾提示可手动删除。
 */
export async function doUninstallSsh(): Promise<void> {
  log.info("卸载 Windows SSH 服务");

  // 检测安装方式（同时确认是否已安装）
  log.info("检测安装方式 ...");
  const info = await detectOpenSshInstallMethod();
  if (info.method === "unknown" && info.exePath === null) {
    log.message("    未检测到 OpenSSH 安装，无需卸载");
    return;
  }
  log.message(`    检测到安装方式: ${info.methodLabel}(${info.detail})`);

  // ===== 步骤 0：先停止 sshd 服务（后续卸载/删文件时避免被运行中进程占用） =====
  if (await isSshdServiceRegistered()) {
    log.info("停止 sshd 服务 ...");
    const stopResult = await runPowerShell(
      "Stop-Service sshd -Force -ErrorAction SilentlyContinue"
    );
    if (stopResult.success) {
      log.message("    sshd 服务已停止");
    } else {
      // 停止失败不阻断后续流程（服务可能已是停止状态或权限受限）
      log.message("    停止 sshd 服务失败（可能已停止），继续后续步骤");
    }
  } else {
    log.message("    sshd 服务未注册，跳过停止");
  }

  // ===== 步骤 1：按安装方式卸载 OpenSSH =====
  if (info.method === "capability") {
    // ===== Capability 方式：用系统组件卸载 =====
    log.info("通过 Remove-WindowsCapability 卸载...");
    const capResult = await runPowerShell(
      `Remove-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME}`
    );
    if (!capResult.success) {
      log.message(`    Capability 卸载失败: ${capResult.stderr || "未知错误"}`);
      log.message('    请打开"程序和功能"手动卸载');
      await openAppwizAndAwait();
    } else {
      log.message("    Capability 卸载成功");
    }
  } else if (info.method === "msi") {
    // ===== MSI 方式：优先 msiexec /x 静默卸载，否则 appwiz.cpl =====

    const msiPath = resolve(process.cwd(), LOCAL_MSI_REL);
    if (existsSync(msiPath)) {
      log.info(`使用 MSI 包卸载: ${msiPath}`);
      const uninstallResult = await runCmd("msiexec", [
        "/x",
        msiPath,
        "/quiet",
        "/norestart",
      ]);
      if (uninstallResult.success) {
        log.message("    MSI 卸载成功");
      } else {
        log.message(
          `     MSI 卸载失败: ${uninstallResult.stderr || "未知错误"}`
        );
        log.message(`    请改用下方打开的"程序和功能"手动卸载`);
        await openAppwizAndAwait();
      }
    } else {
      // 本地没有 MSI 包，只能走图形界面
      log.message(`    未找到本地 MSI 包（${msiPath}），无法静默卸载`);
      await openAppwizAndAwait();
    }
  } else {
    // ===== unknown：无法确定来源，交给用户手动卸载 =====
    log.message("    无法确定安装来源，需手动卸载");
    await openAppwizAndAwait();
  }

  // ===== 步骤 2：删除 sshd 服务残留（卸载有时不删服务，sc.exe delete 补删） =====
  if (await isSshdServiceRegistered()) {
    log.info("sshd 服务仍存在，正在删除服务...");
    const delResult = await runCmd("sc.exe", ["delete", "sshd"]);
    if (delResult.success) {
      log.message("    sshd 服务已删除");
    } else {
      // sc.exe 的错误信息输出到 stdout 而非 stderr（且为 GBK 编码可能乱码），
      // 优先取 stderr，其次 stdout，最后兜底 exitCode
      const errMsg =
        delResult.stderr || delResult.stdout || `退出码 ${delResult.exitCode}`;
      log.message(`    删除 sshd 服务失败: ${errMsg}`);
      log.message("    可手动执行: sc.exe delete sshd");
    }
  } else {
    log.message("    sshd 服务已不存在");
  }

  // ===== 步骤 3：从 authorized_keys 移除 MCP 专用公钥（对应配置步骤的写入） =====
  log.info("从 authorized_keys 移除 MCP 专用公钥 ...");
  const pubKeyPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  if (!existsSync(pubKeyPath)) {
    log.message("    未找到本地公钥文件，跳过 authorized_keys 清理");
  } else {
    const pubKey = readFileSync(pubKeyPath, "utf8").trim();
    if (!pubKey) {
      log.message("    本地公钥文件为空，跳过 authorized_keys 清理");
    } else {
      removeAuthorizedKey(pubKey);
    }
  }

  // ===== 步骤 4：从 .bak 备份恢复 sshd_config（对应配置步骤的修改） =====
  log.info("从 .bak 备份恢复 sshd_config ...");
  restoreSshdConfigFromBackup();

  log.success("    Windows SSH 服务卸载完成");
  log.message(
    "    配置目录 C:\\ProgramData\\ssh 未自动清理（可能含自定义配置）"
  );
  log.message("    如需彻底清除，请手动删除该目录");
}
