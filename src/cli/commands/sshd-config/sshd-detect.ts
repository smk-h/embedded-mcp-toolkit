/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sshd-detect.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: OpenSSH 安装与服务探测（只读）
 *
 * 只读探测 Windows 端 OpenSSH 的安装情况：
 *   - findSshdExe                按候选路径探测 sshd.exe 实际位置
 *   - isSshdServiceRegistered    查询 sshd 服务是否已注册
 *   - detectOpenSshInstallMethod 三信号交叉判定安装方式（MSI / Capability / 未知）
 *
 * 本模块不修改任何系统状态；服务注册等变更操作见 sshd-service.ts。
 * ======================================================
 */

import { existsSync } from "fs";
import { log } from "@clack/prompts";

import { type OpenSshInstallInfo } from "./types.js";
import {
  CAPABILITY_SSHD_EXE,
  MSI_SSHD_EXE,
  SSHD_EXE_CANDIDATES,
  OPENSSH_CAPABILITY_NAME,
} from "./constants.js";
import { runPowerShell } from "../../shared/exec.js";

// ============================================================
// 只读探测
// ============================================================

/**
 * @brief 检查 sshd 服务是否已注册
 * @details 通过 Get-Service 查询 sshd 服务是否存在（Select-Object -ExpandProperty Name
 *          仅输出 "sshd" 或空）。统一安装 / 配置 / 卸载三处的服务检查逻辑。
 * @returns 已注册返回 true
 */
export async function isSshdServiceRegistered(): Promise<boolean> {
  const result = await runPowerShell(
    "Get-Service sshd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"
  );
  return result.success && result.stdout === "sshd";
}

/**
 * @brief 查找系统中存在的 sshd.exe 路径
 * @details 按候选路径列表逐个探测（MSI 目录优先，Windows 自带目录次之）。
 * @returns 找到的 sshd.exe 绝对路径；未找到返回 null
 */
export function findSshdExe(): string | null {
  for (const candidate of SSHD_EXE_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * @brief 检测 OpenSSH 的安装方式（MSI / Capability / 未知）
 * @details 综合三个信号交叉判定，任一单一信号都不足以区分 MSI 与 Capability。
 *          执行顺序按"快→慢"排列，能尽早判定就尽早返回，避免慢命令卡死：
 *
 *   信号 C（最快，同步）：findSshdExe() 文件探测
 *     方法：existsSync 探测 MSI_SSHD_EXE / CAPABILITY_SSHD_EXE 两个候选路径
 *
 *   信号 B（快，~100ms）：sshd 服务的 ImagePath
 *     命令：(Get-CimInstance Win32_Service -Filter "Name='sshd'").ImagePath
 *     - 含 "Program Files\OpenSSH" → MSI（MSI 安装器把文件释放到此目录）
 *     - 含 "System32\OpenSSH"      → Capability（Windows 组件目录）
 *     这是最可靠的区分信号：服务实际加载的 exe 路径不会撒谎。
 *
 *   判定优先级（实际执行顺序）：
 *     1. 先取信号 C（瞬时），再取信号 B（快）。
 *     2. 信号 B 命中 → 立即返回（最可靠 + 快）。
 *     3. 信号 B 未命中（服务未注册）→ 用信号 C 兜底判定。
 *     4. 信号 C 也无法判定 → 才调用慢速的信号 A。
 *
 *   信号 A（慢，可能数十秒）：Get-WindowsCapability 的 State
 *     命令：Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
 *           | Select-Object -ExpandProperty State
 *     - "Installed"  → 由 Windows 组件（Capability）安装，但部分 MSI 安装后也可能
 *       被 Capability 探测到（因 OpenSSH 文件落到了系统目录），故仅作"强提示"。
 *     - "NotPresent" → 肯定不是 Capability 方式装的。
 *     给独立 30 秒超时（runPowerShell 默认 5 分钟会卡死）。仅在 B、C 都无法判定
 *     时才调用，绝大多数场景不会执行到这里。
 *
 * @returns 安装方式信息（method / methodLabel / exePath / detail）
 */
export async function detectOpenSshInstallMethod(): Promise<OpenSshInstallInfo> {
  log.message("    正在检测安装方式...");
  // 信号 C：文件探测（同步，先拿到 exe 路径供后续填充）
  const exePath = findSshdExe();

  // 信号 B：读 sshd 服务的 ImagePath（服务实际加载的 exe 路径）
  //   Get-CimInstance 比 WMI 更现代；ImagePath 形如：
  //     "C:\Program Files\OpenSSH\sshd.exe" serves...（含 arguments）
  let svcImagePath: string | null = null;
  const svcRegistered = await isSshdServiceRegistered();
  if (svcRegistered) {
    const imgResult = await runPowerShell(
      "(Get-CimInstance Win32_Service -Filter \"Name='sshd'\").ImagePath"
    );
    if (imgResult.success && imgResult.stdout) {
      svcImagePath = imgResult.stdout;
    }
  }

  // —— 信号 B 优先：服务 ImagePath 是最可靠来源，且 Get-CimInstance 很快 ——
  if (svcImagePath) {
    // 取 ImagePath 中的 exe 路径（去掉首尾引号与尾部参数）
    const pathLower = svcImagePath.toLowerCase();
    if (pathLower.includes("program files\\openssh")) {
      return {
        method: "msi",
        methodLabel: "MSI",
        exePath,
        detail: svcRegistered
          ? "服务 ImagePath 指向 Program Files\\OpenSSH"
          : "exe 位于 Program Files\\OpenSSH（服务未注册）",
      };
    }
    if (pathLower.includes("system32\\openssh")) {
      return {
        method: "capability",
        methodLabel: "Capability",
        exePath,
        detail: svcRegistered
          ? "服务 ImagePath 指向 System32\\OpenSSH"
          : "exe 位于 System32\\OpenSSH（服务未注册）",
      };
    }
  }

  // —— 信号 C 兜底：仅靠文件路径（服务未注册时 B 不可用，跳过慢速的 A） ——
  if (exePath === MSI_SSHD_EXE) {
    return {
      method: "msi",
      methodLabel: "MSI",
      exePath,
      detail: "仅在 MSI 标准目录发现 sshd.exe",
    };
  }
  if (exePath === CAPABILITY_SSHD_EXE) {
    return {
      method: "capability",
      methodLabel: "Capability",
      exePath,
      detail: "仅在系统目录发现 sshd.exe",
    };
  }

  // —— 信号 A：Capability State（慢，仅在 B、C 都无法判定时才调用） ——
  //   Get-WindowsCapability -Online 要扫描 CBS 组件存储，某些机器上需要数十秒。
  //   给独立较短超时（30 秒），避免默认的 5 分钟卡死。
  log.message("    进一步查询 Capability 状态（可能需要数秒）...");
  let capabilityInstalled = false;
  const capResult = await runPowerShell(
    `Get-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY_NAME} | Select-Object -ExpandProperty State`,
    30000
  );
  if (capResult.success && capResult.stdout.includes("Installed")) {
    capabilityInstalled = true;
  }

  // Capability Installed 且 exe 不在 MSI 目录 → 判为 Capability
  if (capabilityInstalled && !existsSync(MSI_SSHD_EXE)) {
    return {
      method: "capability",
      methodLabel: "Capability",
      exePath,
      detail: "Get-WindowsCapability 报告 Installed",
    };
  }

  // 未安装 / 信号矛盾
  return {
    method: "unknown",
    methodLabel: "未知",
    exePath: null,
    detail:
      !svcRegistered && !exePath
        ? "未检测到 OpenSSH 安装"
        : "安装来源无法确定（信号矛盾）",
  };
}
