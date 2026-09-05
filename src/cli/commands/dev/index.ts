/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/09/05
 * Version    : x.x.x
 * Description: dev 命令聚合 —— 设备配置管理子命令树注册
 *
 * dev 命名空间下全部子命令的 commander 接线点：父命令定义与
 * create/list/del 的注册集中于此，子命令实现模块（create/、list/、
 * del/）保持不依赖 commander。新增子命令时在此继续追加注册。
 * ======================================================
 */

import { Command } from "commander";

import { runCreate } from "./create/index.js";
import { runList } from "./list/index.js";
import { runDel } from "./del/index.js";

/**
 * @brief 注册 dev 设备配置管理命令树
 *
 * 聚合 .embedded/configs/devices/ 下设备配置文件的管理子命令，
 * 父命令本身无 .action()，仅作为命名空间（dev --help 查看子命令）。
 * 已挂载 create/list/del，后续继续扩展其它子命令。
 *
 * @par 子命令类型 父命令（无 .action()）—— 仅聚合子命令，直接运行显示帮助。
 *
 * @param program 根 commander 程序实例
 */
export function registerDevCommand(program: Command): void {
  const devCommand = program
    .command("dev")
    .description("管理 .embedded/configs/devices/ 下的设备配置文件");

  /**
   * @brief 设备配置创建子命令
   *
   * 读取 .embedded/configs/devices/board-example.yaml 模板，交互问答采集设备名与
   * 串口/SSH/ADB 连接参数，生成 <设备名>.yaml（保留模板注释与未涉及段）。
   * -y 快速模式免交互直接生成 board-default.yaml（同名自动递增后缀）。
   *
   * @par 子命令类型 dev 下的二级内联命令 —— 通过 .action() 在同一进程内执行回调。
   *
   * @example
   * embedded-mcp-toolkit dev create
   * embedded-mcp-toolkit dev create -y
   */
  devCommand
    .command("create")
    .description(
      "交互式创建新设备配置文件（基于 board-example.yaml 模板，保留注释）"
    )
    .option(
      "-y, --yes",
      "快速模式：免交互直接生成 board-default.yaml（同名自动递增后缀）",
      false
    )
    .action(async (opts) => {
      await runCreate(opts);
    });

  /**
   * @brief 设备列表子命令
   *
   * 只读扫描 .embedded/configs/devices/ 下全部设备 yaml（含模板
   * board-example），按通道禁用约定判定各通道是否启用，以
   * 端口@波特率 / 用户名@主机 / 序列号 展示连接参数（禁用显示 -），
   * 输出对齐表格并标注模板与默认设备；坏文件跳过并告警。
   *
   * @par 子命令类型 dev 下的二级内联命令 —— 通过 .action() 在同一进程内执行回调。
   *
   * @example
   * embedded-mcp-toolkit dev list
   */
  devCommand
    .command("list")
    .description("列出 devices/ 下全部设备（含模板）及串口/SSH/ADB 通道状态")
    .action(() => {
      runList();
    });

  /**
   * @brief 设备删除子命令
   *
   * 交互式删除 .embedded/configs/devices/ 下的设备配置文件：候选列表
   * （模板 board-example 禁止删除，扫描阶段即剔除）经关键词过滤 +
   * 上下键选择，confirm 二次确认（默认 No）后才真正删除。
   *
   * @par 子命令类型 dev 下的二级内联命令 —— 通过 .action() 在同一进程内执行回调。
   *
   * @example
   * embedded-mcp-toolkit dev del
   */
  devCommand
    .command("del")
    .description("交互式删除设备配置文件（关键词过滤 + 上下键选择 + 删除确认）")
    .action(async () => {
      await runDel();
    });
}
