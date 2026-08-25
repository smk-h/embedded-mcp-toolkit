/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : download.ts
 * Author     : sumu
 * Date       : 2026/07/30
 * Version    : x.x.x
 * Description: HTTP 下载（MSI 离线安装包）
 *
 * 下载文件到本地，支持 HTTPS 重定向（GitHub releases 会 301/302 重定向到 CDN）。
 * ======================================================
 */

import { createWriteStream, unlinkSync } from "fs";
import { get as httpsGet } from "https";

// ============================================================
// HTTP 下载（MSI 离线安装包）
// ============================================================

/**
 * @brief 下载文件到本地（支持 HTTPS 重定向）
 * @details GitHub releases 会 301/302 重定向到 CDN，需手动跟随。
 *          下载失败时清理半成品文件。
 * @param url      下载地址
 * @param destPath 本地目标路径
 * @throws 网络错误或 HTTP 非 2xx 时抛出
 */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = createWriteStream(destPath);

    const req = httpsGet(url, (response) => {
      // 处理重定向（301 / 302）
      if (
        (response.statusCode === 301 || response.statusCode === 302) &&
        response.headers.location
      ) {
        file.close();
        const redirectUrl = response.headers.location;
        downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        try {
          unlinkSync(destPath);
        } catch {
          // 忽略清理失败
        }
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });

    req.on("error", (err) => {
      file.close();
      try {
        unlinkSync(destPath);
      } catch {
        // 忽略清理失败
      }
      reject(err);
    });
  });
}
