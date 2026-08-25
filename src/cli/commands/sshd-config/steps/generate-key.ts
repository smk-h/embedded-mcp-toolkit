/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : generate-key.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: step2: 编译服务器生成密钥对
 * ======================================================
 */

import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Client } from "ssh2";
import { text, password, confirm, isCancel, log } from "@clack/prompts";

import { LOCAL_PUBKEY_REL } from "../types.js";
import {
  parseServerAddress,
  sshConnect,
  sshExec,
  sshDownload,
  sshDisconnect,
  type LinuxServerInfo,
} from "../../../shared/ssh.js";

// ============================================================
// step2: 编译服务器生成密钥对
// ============================================================

/**
 * @brief 在 Linux 编译服务器上生成 SSH 密钥对并拉取公钥
 * @details 交互式收集 Linux 服务器连接信息（不落盘），SSH 登录后：
 *          1. 检测远端 sshd 是否运行（未运行则提示安装命令并退出）
 *          2. 以登录用户身份执行 ssh-keygen 生成密钥（已存在则询问覆盖）
 *          3. 通过 SFTP 把公钥拉取到本地 .embedded/ssh/id_mcp_server.pub
 *          SSH 操作基于 ssh2 在本文件内独立实现，不复用 SSHShell。
 */
export async function doGenerateKey(): Promise<boolean> {
  log.info("开始在编译服务器生成密钥对 ...");

  // 交互式收集连接信息（不落盘）
  // 紧凑格式 user@host[:port]，一次输入完成
  const addressRaw = await text({
    message: "编译服务器地址",
    placeholder: "user@host[:port],host 可为 IP 或主机别名，如 sumu@1.1.1.1:22",
  });
  if (isCancel(addressRaw)) {
    log.message("    已取消");
    return false;
  }
  const addressInput = addressRaw.trim();
  if (!addressInput) {
    log.message("    已取消");
    return false;
  }

  const parsed = parseServerAddress(addressInput);
  if (!parsed) {
    log.message(
      "    地址格式错误，应为 user@host[:port]（如 root@1.2.3.4 或 root@1.2.3.4:2222）"
    );
    return false;
  }

  const pwdRaw = await password({
    message: "登录密码",
  });
  if (isCancel(pwdRaw)) {
    log.message("    已取消");
    return false;
  }

  const info: LinuxServerInfo = { ...parsed, password: pwdRaw };

  // SSH 连接
  let client: Client;
  try {
    log.info(`连接 ${info.username}@${info.host}:${info.port} ...`);
    client = await sshConnect(info);
    log.message("    SSH 连接成功");
  } catch (err) {
    log.message(
      `    无法连接编译服务器: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }

  try {
    // 信息采集：获取当前登录用户、主机 IP、家目录，仅展示供用户核对连接目标
    const remoteUser = await sshExec(client, "whoami");
    const remoteIp = await sshExec(
      client,
      "hostname -I 2>/dev/null | awk '{print $1}' || hostname"
    );
    const remoteHome = await sshExec(client, "eval echo ~$USER");
    log.info("连接目标信息");
    log.message(`    当前用户: ${remoteUser || "(unknown)"}`);
    log.message(`    主机 IP: ${remoteIp || "(unknown)"}`);
    log.message(`    家目录: ${remoteHome || "(unknown)"}`);

    // 检测远端 sshd 是否运行
    const sshdCheck = await sshExec(
      client,
      "systemctl status sshd 2>/dev/null || service ssh status 2>/dev/null || echo NO_SSHD"
    );
    if (sshdCheck.includes("NO_SSHD")) {
      log.message("    远端 sshd 未运行");
      log.message("    请在编译服务器上安装并启动 sshd: ");
      log.message(
        "        Debian/Ubuntu: sudo apt install openssh-server && sudo systemctl start sshd"
      );
      log.message(
        "        RHEL/CentOS:   sudo dnf install openssh-server && sudo systemctl start sshd"
      );
      return false;
    }
    log.message("    远端 sshd 运行正常");

    // 检测密钥是否已存在（专用密钥名 id_mcp_server，避免覆盖用户通用密钥）
    // 注意：必须精确匹配 "EXISTS"，不能用 includes——"NOT_EXISTS" 也包含子串 "EXISTS"
    const keyCheck = await sshExec(
      client,
      "test -f ~/.ssh/id_mcp_server && echo EXISTS || echo NOT_EXISTS"
    );
    if (keyCheck === "EXISTS") {
      const overwrite = await confirm({
        message: "MCP 专用密钥已存在，是否覆盖?",
        active: "覆盖",
        inactive: "保留",
        initialValue: false,
      });
      if (isCancel(overwrite) || !overwrite) {
        log.message("    已取消，保留原密钥");
        return false;
      }
      // 先删除旧密钥文件，避免 ssh-keygen 触发交互式 "Overwrite (y/n)?" 确认
      // sshExec 基于 exec 通道，无法向远端 stdin 写入回应，ssh-keygen 会死等输入导致卡死
      log.message("    删除旧密钥文件 ...");
      await sshExec(
        client,
        "rm -f ~/.ssh/id_mcp_server ~/.ssh/id_mcp_server.pub"
      );
    }

    // 生成密钥对（专用密钥名 id_mcp_server）
    log.info("生成 MCP 专用 RSA 密钥对 (id_mcp_server) ...");
    await sshExec(
      client,
      'ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_mcp_server'
    );
    log.message("    密钥对生成成功");

    // 列出 ~/.ssh 目录所有文件，供用户确认密钥已正确生成
    const sshListing = await sshExec(client, "ls -la ~/.ssh 2>/dev/null");
    log.info("~/.ssh 目录内容");
    for (const line of sshListing.split("\n")) {
      if (line.trim()) {
        log.message(`    ${line}`);
      }
    }

    // 展开 ~ 为绝对路径（SFTP 不识别 ~）
    const pubPathRaw = await sshExec(client, "echo ~/.ssh/id_mcp_server.pub");
    const pubPathRemote = pubPathRaw.replace(/\s+/g, "");

    // 确保本地目录存在
    const localPubPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
    const localDir = dirname(localPubPath);
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }

    // SFTP 下载公钥
    log.info("拉取公钥到本地 ...");
    await sshDownload(client, pubPathRemote, localPubPath);
    log.message(`    公钥已保存: ${localPubPath}`);
    log.success("密钥对生成完成");
    return true;
  } catch (err) {
    log.message(`    操作失败: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    sshDisconnect(client);
  }
}
