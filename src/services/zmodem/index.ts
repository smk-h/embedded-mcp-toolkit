/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : sumu
 * Date       : 2026/07/24
 * Version    : 1.0.0
 * Description: ZMODEM 协议服务入口
 *
 *   re-export 协议桥接层的对外函数与类型，供 mcp/tools/serial/transfer.ts 调用。
 * ======================================================
 */

export { zmodemSend, zmodemReceive } from "./zmodem-bridge.js";
export type { ZmodemProgress, ZmodemTransferOptions } from "./zmodem-bridge.js";
