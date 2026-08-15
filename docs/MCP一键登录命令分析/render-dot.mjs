/**
 * @file render-dot.mjs
 * @brief 用 QuickChart 在线 Graphviz 服务把 .dot 渲染成 SVG 的通用脚本。
 *
 * 用法：
 *   node scripts/render-dot.mjs <dot文件> [dot文件...]
 *   node scripts/render-dot.mjs docs/A/*.dot docs/B/x.dot
 *   node scripts/render-dot.mjs foo.dot --out-dir ./custom-img
 *
 * 输出：
 *   默认写到每个 dot 同级的 img/ 目录（dot 在哪，img 就在哪）。
 *   --out-dir <dir> 可统一覆盖输出目录（所有 SVG 都写到该目录）。
 *
 * 实现：
 *   - POST https://quickchart.io/graphviz  {"graph": <dot源码>, "format": "svg", "layout": "dot"}
 *   - 服务端渲染返回 SVG（graphviz 2.40.1）
 *   - dot 语法错误时服务返回 HTTP 400 + "Graph Error: ..." 文本，脚本提取后原样报出
 *
 * @note 依赖 QuickChart 公网服务。仅文档构建期使用，不进生产依赖。
 *       本机装有 graphviz 时也可 `dot -Tsvg x.dot -o img/x.svg` 本地渲染，
 *       但本地版本与在线服务(2.40.1)的布局可能有细微差异，同一项目固定一种方式。
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const ENDPOINT = "https://quickchart.io/graphviz";

// ---- 渲染单文件:请求 QuickChart 在线 Graphviz 服务 ----
function renderRemote(file) {
  const src = fs.readFileSync(file, "utf-8");
  // 粗检:必须是 graphviz 图定义(digraph/graph/strict 开头之一)
  if (!/^\s*(strict\s+)?(di)?graph\b/m.test(src)) {
    throw new Error("不是合法的 dot 文件(缺少 digraph/graph 定义)");
  }

  const body = JSON.stringify({ graph: src, format: "svg", layout: "dot" });
  const url = new URL(ENDPOINT);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const svg = Buffer.concat(chunks).toString("utf-8");
          // 语法错误: HTTP 400, body 是带 "Graph Error" 说明的 SVG
          const m = svg.match(/Graph Error[^\n<]*/);
          if (res.statusCode !== 200 || m) {
            reject(
              new Error(
                m ? decodeEntities(m[0].trim()) : `HTTP ${res.statusCode}`
              )
            );
            return;
          }
          if (!svg.includes("<svg")) {
            reject(new Error("返回不是 SVG"));
            return;
          }
          resolve(svg);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Graph Error 文本来自 SVG, 单引号等字符被转成 HTML 实体, 解码回可读形式
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// ---- 参数解析 ----
function parseArgs(argv) {
  const files = [];
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") {
      outDir = argv[++i];
      if (!outDir) {
        console.error("--out-dir 需要一个参数");
        process.exit(1);
      }
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("--")) {
      console.error(`未知选项: ${a}`);
      printUsage();
      process.exit(1);
    } else {
      files.push(a);
    }
  }
  return { files, outDir };
}

function printUsage() {
  console.error(
    [
      "用法: node scripts/render-dot.mjs <dot文件> [dot文件...] [选项]",
      "",
      "选项:",
      "  --out-dir <dir>  统一覆盖输出目录(默认: 各 dot 同级的 img/)",
      "  -h, --help       显示帮助",
      "",
      "示例:",
      "  node scripts/render-dot.mjs docs/项目简介/*.dot",
      "  node scripts/render-dot.mjs foo.dot --out-dir ./out-img",
    ].join("\n")
  );
}

// ---- 主流程 ----
async function main() {
  const { files, outDir } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    printUsage();
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const f of files) {
    const full = path.resolve(f);
    const base = path.basename(f, ".dot");
    // 默认输出: dot 同级的 img/; --out-dir 覆盖
    const dir = outDir ? path.resolve(outDir) : path.join(path.dirname(full), "img");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, base + ".svg");
    try {
      const svg = await renderRemote(full);
      fs.writeFileSync(out, svg, "utf-8");
      console.log(`✓ ${base}.dot → ${path.relative(process.cwd(), out)}  (${svg.length} bytes)`);
      ok++;
    } catch (e) {
      console.error(`✗ ${f}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n完成: ${ok} 成功, ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main();
