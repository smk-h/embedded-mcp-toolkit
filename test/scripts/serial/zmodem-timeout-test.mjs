/**
 * =====================================================
 * ZMODEM 传输超时行为验证（直连 out/ 构建产物）
 *
 *   不依赖 MCP server 进程，直接 import 已构建的 zmodemSend/zmodemReceive，
 *   用真实 SerialShell 连 board-b（COM3），验证修复后的超时/中止行为：
 *     - 上传超时能正确中止并返回 success:false
 *     - 下载超时不再假成功，残缺文件被删除
 *     - 超时后设备端 rz/sz 干净退出（CAN×5+BS×5）
 *
 *   用法：
 *     node test/scripts/serial/zmodem-timeout-test.mjs upload   <file> <timeoutSec>
 *     node test/scripts/serial/zmodem-timeout-test.mjs download <remotePath> <localOut> <timeoutSec>
 *
 *   前提：COM 口未被占用（若有 MCP 串口会话，需先 serial_close 释放）。
 * ======================================================
 */

import { SerialShell } from "../out/transports/serial.js";
import { zmodemSend, zmodemReceive } from "../out/services/zmodem/index.js";

const PORT = "COM3";
const BAUD_RATE = 115200;
const STTY_DISABLE_FLOW_CTRL = "stty -ixon -ixoff";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 打开串口 shell 并做一次同步探针，确保提示符稳定后再返回
 * @returns {Promise<SerialShell>} 已就绪的串口 shell
 */
async function openShell() {
  const shell = new SerialShell({ port: PORT, baudRate: BAUD_RATE });
  await shell.open();
  // 等 banner / 提示符
  await sleep(1500);
  shell.read(1);
  // 进测试目录 + 关流控，每步都彻底排空缓冲，确保 sz/rz 的首帧不被残留文本干扰
  shell.write("cd /tmp/zmodem-test", 1);
  await sleep(600);
  shell.read(1);
  shell.write(STTY_DISABLE_FLOW_CTRL, 1);
  await sleep(500);
  shell.read(1);
  // 发一个同步探针，确认提示符稳定后再返回（避免 sz 的 ZRQINIT 和回显混杂）
  shell.write("echo READY_$$", 1);
  await sleep(700);
  const probe = shell.read(1);
  if (!probe.includes("READY_")) {
    console.log(`[test] WARN: openShell probe unexpected: ${probe.replace(/\n/g, " | ")}`);
  }
  return shell;
}

/**
 * 排空串口残留数据并恢复干净的 shell 提示符，供下一次测试复用
 */
async function recoverShell(shell) {
  shell.read(1);
  shell.write("", 1);
  await sleep(800);
  for (let i = 0; i < 5; i++) {
    const drained = shell.read(1);
    if (!drained) break;
    await sleep(300);
  }
}

async function main() {
  const [, , mode, ...rest] = process.argv;
  if (!mode) {
    console.error(
      "usage: node test/scripts/serial/zmodem-timeout-test.mjs upload <file> <timeoutSec> | download <remotePath> <localOut> <timeoutSec>"
    );
    process.exit(2);
  }

  const shell = await openShell();
  const controller = new AbortController();

  try {
    if (mode === "upload") {
      const [localPath, timeoutSecStr] = rest;
      const timeoutSec = Number(timeoutSecStr);
      const timeoutMs = timeoutSec * 1000;
      console.log(`[test] upload ${localPath} timeout=${timeoutSec}s`);
      const t0 = Date.now();
      const timer = setTimeout(() => {
        console.log(`[test] >>> abort @ ${timeoutSec}s`);
        controller.abort();
      }, timeoutMs);
      try {
        const result = await zmodemSend(
          shell,
          localPath,
          "test_upload.bin",
          {
            onProgress: (p) =>
              console.log(`[test] progress ${p.bytes}/${p.total ?? "?"}`),
            signal: controller.signal,
          },
          "rz"
        );
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        console.log(
          `[test] RESULT success=${result.success} bytes=${result.bytes} ms=${result.durationMs} elapsed=${elapsed} error=${result.error ?? "(none)"}`
        );
      } finally {
        clearTimeout(timer);
        await recoverShell(shell);
        console.log("[test] shell recovered");
        // 验证：zmodemSend 返回后（其内部 finally 已发 CAN×5+BS×5 + drainPort）
        // 设备端 rz 是否已干净退出、shell 是否立即响应（修复前此处会 NO RESPONSE）
        shell.write("echo PROBE_AFTER_SEND_$?", 1);
        await sleep(1000);
        const probe = shell.read(1);
        console.log(
          `[test] post-send probe: ${probe ? "RESPONSIVE" : "NO RESPONSE (设备端仍卡死!)"}`
        );
        if (probe) console.log(`[test]   output: ${probe.replace(/\n/g, " | ")}`);
      }
    } else if (mode === "download") {
      const [remotePath, localOut, timeoutSecStr] = rest;
      const timeoutSec = Number(timeoutSecStr);
      const timeoutMs = timeoutSec * 1000;
      const sendCmd = `sz ${remotePath}`;
      console.log(`[test] download ${remotePath} -> ${localOut} timeout=${timeoutSec}s`);
      const t0 = Date.now();
      const timer = setTimeout(() => {
        console.log(`[test] >>> abort @ ${timeoutSec}s`);
        controller.abort();
      }, timeoutMs);
      try {
        const result = await zmodemReceive(
          shell,
          localOut,
          {
            onProgress: (p) =>
              console.log(`[test] progress ${p.bytes}/${p.total ?? "?"}`),
            signal: controller.signal,
          },
          sendCmd
        );
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        console.log(
          `[test] RESULT success=${result.success} bytes=${result.bytes} ms=${result.durationMs} elapsed=${elapsed} error=${result.error ?? "(none)"}`
        );
        // 报告本地落盘文件是否被清理（超时应删残缺文件）
        try {
          const fs = await import("node:fs/promises");
          const st = await fs.stat(localOut);
          console.log(`[test] local file EXISTS size=${st.size} (残缺文件未清理!)`);
        } catch {
          console.log("[test] local file removed (残缺文件已清理 ✓)");
        }
      } finally {
        clearTimeout(timer);
        await recoverShell(shell);
        console.log("[test] shell recovered");
      }
    } else {
      console.error(`unknown mode: ${mode}`);
      process.exit(2);
    }
  } finally {
    await shell.close();
    console.log("[test] serial closed");
  }
}

main().catch((err) => {
  console.error("[test] failed:", err);
  process.exit(1);
});
