/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : connect.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: CNB 环境地址解析与 none 认证连接
 *
 * 与 shared/ssh.ts 的 sshConnect 的差别：CNB 公网入口用 none 认证（既无密码
 * 也无密钥），故不能复用其"用户名 + 密码"的固定配置，这里单独实现一个只声明
 * authHandler: ["none"] 的连接入口。地址解析仍复用 parseServerAddress。
 * ======================================================
 */

import { Client } from "ssh2";

import { parseServerAddress } from "../../shared/ssh.js";
import { type CnbEnvInfo } from "./types.js";

// ============================================================
// 地址解析
// ============================================================

/**
 * @brief 解析用户输入的 CNB 环境标识
 * @details 输入形如 `cnb-ihg-xxx.xxxx@cnb.space`，复用 shared 的
 *          `<user>@<host>[:port]` 解析器；未显式给端口时默认 22。
 * @param input 用户输入的地址字符串
 * @returns 环境连接信息；格式非法返回 null
 */
export function parseCnbAddress(input: string): CnbEnvInfo | null {
  const parsed = parseServerAddress(input);
  if (!parsed) {
    return null;
  }
  return { host: parsed.host, port: parsed.port, username: parsed.username };
}

// ============================================================
// none 认证连接
// ============================================================

/**
 * @brief 以 none 认证连接 CNB 云开发环境
 * @details 显式声明 `authHandler: ["none"]`：不尝试任何密钥/密码/agent，直接走
 *          none 方法。该入口的凭证就是环境标识字符串本身（见方案文档一、3.4 节），
 *          因此连接"免密"，也无需在 Windows 侧准备任何密钥。
 * @param info CNB 环境连接信息
 * @returns 已连接的 ssh2 Client 实例
 * @throws 连接失败或认证方式不被接受时抛出
 */
export function connectCnbEnv(info: CnbEnvInfo): Promise<Client> {
  const client = new Client();
  return new Promise<Client>((resolve, reject) => {
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.connect({
      host: info.host,
      port: info.port,
      username: info.username,
      authHandler: ["none"],
      readyTimeout: 15000,
    });
  });
}
