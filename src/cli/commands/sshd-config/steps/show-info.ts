/**
 * @file src/cli/commands/sshd-config/steps/show-info.ts
 * @brief step6: 查看本机连接信息
 */

import { log } from "@clack/prompts";

import {
  MENU_INSTALL_SSH,
  MENU_GENERATE_KEY,
  MENU_CONFIG_SSHD,
} from "../types.js";
import { collectConnectionInfo } from "../../../shared/cli-helpers.js";

// ============================================================
// step6: 查看本机连接信息
// ============================================================

// 本机连接信息采集（用户名 + IPv4 列表）已迁至 src/cli/shared/cli-helpers.ts，
// 本文件直接 import collectConnectionInfo 复用。

/**
 * @brief 查看本机 Windows 的连接信息（用户名 / IP），供 Linux 端 ssh 连接参考
 * @details 纯只读，不修改任何状态。展示：
 *          (a) 当前 Windows 登录用户名（os.userInfo().username）
 *          (b) 本机所有 IPv4 地址（os.networkInterfaces()），过滤回环与虚拟网卡
 *          (c) 拼接一条可直接在 Linux 端执行的示例 ssh 命令（含 -i 指定专用密钥）
 *          多网卡环境下列出所有候选 IP，由用户根据网络拓扑自行判断选哪个。
 */
export async function doShowConnectionInfo(): Promise<void> {
  log.info("查看本机连接信息");

  const { sshUser, ipList } = collectConnectionInfo();

  // (a) 用户名
  log.info("Windows 用户名");
  log.message(`当前登录用户名: ${sshUser}(用于 Linux 端 ssh 登录)`);

  // (b) IPv4 地址列表
  log.info("本机 IPv4 地址");
  if (ipList.length === 0) {
    log.message("    未检测到可用的 IPv4 地址");
  } else {
    for (const entry of ipList) {
      log.message(`    ${entry.ip}(${entry.iface})`);
    }
  }

  // (c) 为每个 IP 拼接一条 Linux 端可直接执行的 ssh 命令（末尾标注网卡名）
  log.info("Linux 端连接本机命令(免密登录)示例");
  const keyPath = "~/.ssh/id_mcp_server";
  if (ipList.length === 0) {
    log.message(`    ssh -i ${keyPath} ${sshUser}@<Windows_IP>`);
  } else {
    for (const entry of ipList) {
      log.message(
        `    ssh -i ${keyPath} ${sshUser}@${entry.ip}(${entry.iface})`
      );
    }
  }
  log.success("以上信息可直接在 Linux 端使用，确保已生成专用密钥并配置 sshd");
  log.message(
    "    首次连接会提示主机密钥确认(Are you sure you want to continue connecting?)，输入 yes 即可，之后不再询问"
  );
  log.message(
    `    确保已依次执行 [${MENU_INSTALL_SSH}] 安装 → [${MENU_GENERATE_KEY}] 生成密钥 → [${MENU_CONFIG_SSHD}] 配置 sshd, 连接才能免密成功`
  );
}
