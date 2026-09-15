/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : sumu
 * Date       : 2026/09/15
 * Version    : x.x.x
 * Description: cnb 命令的类型与接口定义
 *
 * 仅承载类型/接口（编译期产物）；运行时常量见 constants.ts。
 * ======================================================
 */

// ============================================================
// 类型与接口
// ============================================================

/**
 * @brief cnb 命令的选项
 * @details 由 Commander 在 src/cli/index.ts 中解析命令行参数后传入。
 */
export interface CnbOptions {
  /** CNB 容器内项目根目录（落点：<dir>/.mcp.json），缺省使用 CNB_DEFAULT_PROJECT_DIR */
  dir?: string;
}

/**
 * @brief CNB 云开发环境连接信息
 * @details 由用户输入的紧凑地址 `<环境标识>@cnb.space` 解析而来；该入口为 none
 *          认证，无需密码或密钥。
 */
export interface CnbEnvInfo {
  host: string; // SSH 入口域名（cnb.space）
  port: number; // SSH 入口端口（22）
  username: string; // 环境标识（如 cnb-ihg-xxx@cnb.space 中 @ 之前的部分）
}

/**
 * @brief Windows 侧本地端点信息
 * @details MCP 桥接定义所需的两个要素：ssh 登录用户名与启动脚本绝对路径
 *          （正斜杠形式，JSON 无需转义，Windows 的 ssh / node 均支持）。
 */
export interface LocalEndpoint {
  sshUser: string; // Windows 当前登录用户名
  batPath: string; // remote-start-mcp.bat 的绝对路径（正斜杠）
}

/**
 * @brief 本地密钥对生成结果
 * @details pubKey 为公钥单行内容（已 trim），供写入 Windows authorized_keys。
 */
export interface LocalKeyResult {
  keyPath: string; // 本地私钥绝对路径
  pubPath: string; // 本地公钥绝对路径
  pubKey: string; // 公钥单行内容
}

/**
 * @brief 私钥与隧道配置的容器内落点
 * @details 由 push-key 步骤回传，供结果展示与 MCP 配置复用，避免上层重复
 *          展开容器家目录。
 */
export interface PushKeyResult {
  remoteKeyPath: string; // 容器内私钥绝对路径
  remoteConfigPath: string; // 容器内 ssh config 绝对路径
  home: string; // 容器家目录绝对路径
}
