/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config-sshd.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: step3: 配置 Windows sshd
 * ======================================================
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { log } from "@clack/prompts";

import {
  SSHD_CONFIG_PATH,
  LOCAL_PUBKEY_REL,
  MENU_GENERATE_KEY,
  MENU_INSTALL_SSH,
} from "../types.js";
import { runPowerShell } from "../exec.js";
import { isSshdServiceRegistered } from "../sshd-service.js";
import { findActiveConfigLine, modifySshdConfig } from "../sshd-config-edit.js";

// ============================================================
// step3: 配置 Windows sshd
// ============================================================

/**
 * @brief 配置 Windows sshd 服务
 * @details 1. 把 .embedded/ssh/id_mcp_server.pub 追加到 ~/.ssh/authorized_keys（去重）
 *          2. 备份 C:\ProgramData\ssh\sshd_config → .bak（已存在不覆盖）
 *          3. 修改 sshd_config：开启公钥认证、指定 AuthorizedKeysFile、禁用
 *             Match Group administrators 分组规则
 *          4. 重启 sshd 使配置生效（先检查服务是否注册；未注册则跳过重启不回滚，仅提示）
 *          5. 回显最终关键配置项供用户核对
 */
export async function doConfigSshd(): Promise<boolean> {
  log.info("开始配置 Windows sshd 服务 ...");

  // 1. 读取本地公钥
  log.info("检查 本地 id_mcp_server(linux) 是否已经存在 ...");
  const pubKeyPath = resolve(process.cwd(), LOCAL_PUBKEY_REL);
  if (!existsSync(pubKeyPath)) {
    log.message(`    未找到公钥文件: ${pubKeyPath}`);
    log.message(`    请先执行 [${MENU_GENERATE_KEY}] 编译服务器生成密钥对`);
    return false;
  } else {
    log.message(`    已找到公钥文件: ${pubKeyPath}`);
  }
  const pubKey = readFileSync(pubKeyPath, "utf8").trim();

  // 2. 写入 authorized_keys（去重）
  log.info("写入 authorized_keys ...");
  const sshDir = resolve(homedir(), ".ssh");
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true });
    log.message(`    创建目录: ${sshDir}`);
  }
  const akPath = join(sshDir, "authorized_keys");
  const existingContent = existsSync(akPath)
    ? readFileSync(akPath, "utf8")
    : "";
  const existingLines = existingContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

  if (existingLines.includes(pubKey)) {
    log.message("    公钥已存在于 authorized_keys, 跳过");
  } else {
    // 确保末尾有换行再追加
    const prefix =
      existingContent === "" || existingContent.endsWith("\n")
        ? existingContent
        : existingContent + "\n";
    writeFileSync(akPath, prefix + pubKey + "\n", "utf8");
    log.message(`    公钥已写入: ${akPath}`);
  }
  log.info("配置 sshd_config ...");
  // 3. 检查 sshd_config 是否存在
  if (!existsSync(SSHD_CONFIG_PATH)) {
    log.message(`    未找到 sshd_config: ${SSHD_CONFIG_PATH}`);
    log.message(`    请先执行 [${MENU_INSTALL_SSH}] 安装 Windows SSH 服务`);
    return false;
  }

  // 4. 备份 sshd_config（已存在 .bak 不覆盖，保留首次备份）
  const bakPath = SSHD_CONFIG_PATH + ".bak";
  if (!existsSync(bakPath)) {
    copyFileSync(SSHD_CONFIG_PATH, bakPath);
    log.message(`    已备份: ${bakPath}`);
  } else {
    log.message(`    备份已存在，保留首次备份: ${bakPath}`);
  }

  // 5. 修改 sshd_config
  const originalConfig = readFileSync(SSHD_CONFIG_PATH, "utf8");
  const modifiedConfig = modifySshdConfig(originalConfig);
  writeFileSync(SSHD_CONFIG_PATH, modifiedConfig, "utf8");
  log.message(
    "    sshd_config 已修改(PubkeyAuthentication yes / AuthorizedKeysFile / 禁用 administrators 分组)"
  );

  // 6. 重启 sshd 使配置生效
  //    先检查 sshd 服务是否已注册：未注册时（如 sshd 以非服务方式运行）跳过重启，
  //    不回滚配置（配置本身已正确），仅提示用户手动重启或执行 [2] 安装服务。
  log.info("检查 sshd 服务是否已注册 ...");
  const svcRegistered = await isSshdServiceRegistered();

  if (!svcRegistered) {
    log.message("    sshd 服务未注册（可能以非服务方式运行），跳过自动重启");
    log.message("    配置已写入，请手动重启 sshd 使其生效：");
    log.message(
      `      若 sshd 以服务方式运行：先执行 [${MENU_INSTALL_SSH}] 安装服务`
    );
    log.message("      若 sshd 以进程方式运行：手动结束 sshd 进程后重新启动");
  } else {
    log.message("    sshd 服务已注册");
    log.info("重启 sshd 服务 ...");
    const restartResult = await runPowerShell("Restart-Service sshd -Force");
    if (!restartResult.success) {
      log.message(`    重启 sshd 失败: ${restartResult.stderr || "未知错误"}`);
      log.message("    正在回滚 sshd_config ...");
      try {
        writeFileSync(SSHD_CONFIG_PATH, originalConfig, "utf8");
        log.message("    sshd_config 已回滚");
      } catch (err) {
        log.message(
          `    回滚失败: ${err instanceof Error ? err.message : err}`
        );
      }
      return false;
    }
    log.message("    sshd 服务已重启");
  }

  // 7. 回显最终关键配置项
  log.info("最终关键配置");
  const finalConfig = readFileSync(SSHD_CONFIG_PATH, "utf8");
  const finalLines = finalConfig.split(/\r?\n/);

  const pubKeyLine = findActiveConfigLine(
    finalLines,
    /^\s*PubkeyAuthentication\s+/i
  );
  log.message(`    PubkeyAuthentication: ${pubKeyLine ?? "(未设置)"}`);

  const authKeysLine = findActiveConfigLine(
    finalLines,
    /^\s*AuthorizedKeysFile\s+/i
  );
  log.message(`    AuthorizedKeysFile:   ${authKeysLine ?? "(未设置)"}`);

  const matchAdminLine = finalLines.find((l) =>
    /^#\s*Match\s+Group\s+administrators/i.test(l)
  );
  log.message(
    `    Match Group admin:     ${matchAdminLine ? "已注释（禁用分组）" : "(未找到原始规则)"}`
  );

  log.success("Windows sshd 配置完成");
  return true;
}
