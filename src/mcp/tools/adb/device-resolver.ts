/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : device-resolver.ts
 * Author     : sumu
 * Date       : 2026/07/20
 * Version    : 1.0.0
 * Description: ADB 通道 deviceName 解析器
 *
 *   封装 deviceName 的降级解析策略，供 adb_shell_open 和 adb_exec 共用，
 *   确保日志目录名与会话表 deviceName 字段反映真实连接的设备，而非连接前的静态猜测值。
 *
 *   策略概览（详见 resolveAdbDeviceName 的 JSDoc）：
 *     1. args.device 传入时：若它本身是 serialNo 则反查为别名，否则原样使用
 *     2. args.device 未传时：用 realSerialNo 反查别名，反查不到用 serialNo 本身
 *     3. realSerialNo 无效时：固定占位符 "adb-unknown"
 *
 *   与 config.ts 的 resolveDeviceNameBySerialNo / isValidSerialNo 配合：
 *     - config.ts 提供"serialNo → 别名"的反查和"serialNo 是否有效"的判定（通用能力）
 *     - 本文件组合两者 + ADB 专属的 "adb-unknown" 占位符，形成 ADB 通道专用策略
 * ======================================================
 */
import {
  isValidSerialNo,
  resolveDeviceNameBySerialNo,
} from "../../../shared/config.js";
import { logger } from "../../../shared/logger.js";

/**
 * @brief ADB 通道 deviceName 解析（三级降级）
 *
 * 按以下优先级确定最终 deviceName（用作日志子目录名 + 会话表 deviceName 字段）：
 *
 *   1. argDevice 显式传入：
 *      1a. 若 argDevice 本身能被反查为别名（即调用方误传了 serialNo）→ 用反查到的别名
 *      1b. 否则（argDevice 是别名或未登记的标识）→ 原样使用，信任调用方
 *   2. argDevice 未传入 → 用 realSerialNo 决策：
 *      2a. realSerialNo 有效 + config 反查命中别名 → 用别名
 *      2b. realSerialNo 有效但未绑定 → 用 serialNo 字符串本身
 *   3.  realSerialNo 无效（如 ???????????? / (auto) / 空）→ 固定占位符 "adb-unknown"
 *
 * 优先级 1a 的存在是为了防御"AI 先调 adb_device_list 拿到 serialNo、再把它当 device
 * 参数传入"这一常见误用——结果仍会正确归位到别名目录，而非产生 serialNo 目录。
 *
 * "serialNo" 指 adb 序列号（device serial number），与"串口（serial port）"无关。
 *
 * @param argDevice       调用方显式传入的 device 参数（可选；可能是别名或误传的 serialNo）
 * @param realSerialNo    shell.open() 后实拿的真实 serialNo（或 adb devices 现场扫描结果）
 * @param fallbackDevice  连接前的静态猜测值（args.device ?? resolveDeviceName()），
 *                        仅用于日志对照上下文，不参与降级决策
 * @returns 最终的 deviceName，用作日志子目录名与会话表 deviceName 字段
 */
export function resolveAdbDeviceName(
  argDevice: string | undefined,
  realSerialNo: string,
  fallbackDevice: string
): string {
  // 优先级1：args.device 显式传入
  if (argDevice) {
    // 1a：argDevice 本身能被反查为别名 → 调用方误传了 serialNo，纠正为别名
    // 典型场景：AI 先调 adb_device_list 拿到 serialNo，再把它当 device 传入
    if (isValidSerialNo(argDevice)) {
      const aliasFromArg = resolveDeviceNameBySerialNo(argDevice);
      if (aliasFromArg) {
        logger.info(
          `[adb] deviceName resolved from args.device (serialNo→alias): ${argDevice} → ${aliasFromArg} (preliminary=${fallbackDevice}, realSerialNo=${realSerialNo})`
        );
        return aliasFromArg;
      }
    }
    // 1b：argDevice 是别名或未登记的标识 → 原样使用，信任调用方
    logger.info(
      `[adb] deviceName resolved from args.device: ${argDevice} (preliminary=${fallbackDevice}, realSerialNo=${realSerialNo})`
    );
    return argDevice;
  }

  // 优先级2a/2b：realSerialNo 有效 → 尝试反查别名，反查不到则用 serialNo 本身
  if (isValidSerialNo(realSerialNo)) {
    const alias = resolveDeviceNameBySerialNo(realSerialNo);
    if (alias) {
      // 2a：反查命中别名（如 serialNo 43b1e5fe7b186666 → board-lubancat）
      logger.info(
        `[adb] deviceName resolved from serialNo reverse-lookup: ${alias} (serialNo=${realSerialNo}, preliminary=${fallbackDevice})`
      );
      return alias;
    }
    // 2b：serialNo 有效但未在 config 绑定，直接用 serialNo 字符串作目录名
    logger.info(
      `[adb] deviceName resolved from raw serialNo (no config binding): ${realSerialNo} (preliminary=${fallbackDevice})`
    );
    return realSerialNo;
  }

  // 优先级3：realSerialNo 无效（硬件无序列号 / 未拿到 serialNo）→ 固定占位符
  // 同一块无序列号调试板的多次会话日志聚合在同一目录，便于排查
  logger.info(
    `[adb] deviceName resolved from placeholder (invalid serialNo="${realSerialNo}", preliminary=${fallbackDevice})`
  );
  return "adb-unknown";
}
