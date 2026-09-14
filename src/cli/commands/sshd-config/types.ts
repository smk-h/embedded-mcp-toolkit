/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: sshd-config 命令的类型与接口定义
 *
 * 仅承载类型/接口（编译期产物）；运行时常量、菜单枚举见 constants.ts。
 * ======================================================
 */

// ============================================================
// 类型与接口
// ============================================================

/**
 * @brief sshd-config 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 *          本期无命令行选项，保留接口以与 init/split 保持一致；后续扩展时改为
 *          具名 interface 即可。
 */
export type SshdConfigOptions = Record<string, never>;

/**
 * @brief OpenSSH 安装方式检测结果
 * @param method    安装方式枚举
 * @param methodLabel 给用户展示的中文标签
 * @param exePath   sshd.exe 的实际路径（已安装时），未找到为 null
 * @param detail    附加说明（如检测到但服务未注册等）
 */
export interface OpenSshInstallInfo {
  method: OpenSshInstallMethod;
  methodLabel: string;
  exePath: string | null;
  detail: string;
}

/**
 * @brief OpenSSH 安装方式枚举
 * @details 通过三信号（Capability State / 服务 ImagePath / exe 路径探测）综合判定。
 */
export type OpenSshInstallMethod = "msi" | "capability" | "unknown";
