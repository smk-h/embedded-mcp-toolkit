/**
 * @file render-puml.mjs
 * @brief 用 PlantUML 在线服务器把 .puml 渲染成 SVG 的通用脚本。
 *
 * 用法：
 *   node scripts/render-puml.mjs <puml文件> [puml文件...]
 *   node scripts/render-puml.mjs docs/A/*.puml docs/B/x.puml
 *   node scripts/render-puml.mjs foo.puml --out-dir ./custom-img
 *   node scripts/render-puml.mjs foo.puml --no-dividers
 *
 * 输出：
 *   默认写到每个 puml 同级的 img/ 目录（puml 在哪，img 就在哪）。
 *   --out-dir <dir> 可统一覆盖输出目录（所有 SVG 都写到该目录）。
 *
 * 实现：
 *   - 实现 PlantUML 的编码算法（UTF-8 → raw deflate → base64-PlantUML）
 *   - 保留 @inject:divider 后处理（在两个 cluster 中间注入垂直虚线 + 标签）
 *   - --no-dividers 可禁用 divider 注入
 *
 * @note 依赖 PlantUML 公网服务（plantuml.com）。仅文档构建期使用，不进生产依赖。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import https from "node:https";

// ---- PlantUML 编码算法 ----
// 与官方 plantuml.jar 的 SourceStringEncoder 完全一致:
//   UTF-8 → raw deflate(无 zlib header) → 每 3 字节输出 4 个字符
//   不足 3 字节时用 0 填充,每块恒定 4 字符
//   ⚠ PlantUML 用自定义字符集(0-9 在前,非标准 base64),勿与 A-Za-z 混淆
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function encode64(data) {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    // 越界字节按 0 处理(对齐官方 append3bytes 的 b2=0/b3=0 分支)
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += ALPHABET[b1 >> 2];
    out += ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
    out += ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
    out += ALPHABET[b3 & 0x3f];
  }
  return out;
}

function encodePlantUML(source) {
  const utf8 = Buffer.from(source, "utf-8");
  const deflated = zlib.deflateRawSync(utf8, { level: 9 });
  return encode64(deflated);
}

// ---- 渲染单文件:请求 PlantUML 在线服务 ----
function renderRemote(file) {
  const src = fs.readFileSync(file, "utf-8");
  // 检测 @startuml ... @enduml
  if (!/@startuml/i.test(src)) {
    throw new Error(`${file}: 缺少 @startuml`);
  }
  const encoded = encodePlantUML(src);
  const url = `https://www.plantuml.com/plantuml/svg/${encoded}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`${file}: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const svg = Buffer.concat(chunks).toString("utf-8");
          if (!svg.startsWith("<svg")) {
            reject(
              new Error(`${file}: 返回不是 SVG(可能 puml 有语法错误)`)
            );
            return;
          }
          resolve(svg);
        });
      })
      .on("error", reject);
  });
}

// ---- 后处理:分界线注入 ----
// 解析 puml 里的 ' @inject:divider between=A,B label="VS"
// 在渲染后的 SVG 中找到 A、B 两个 cluster 的 x 边界,在中间画一条垂直虚线
function injectDividers(svg, src) {
  const re = /@inject:divider\s+between=(\w+),(\w+)(?:\s+label="([^"]*)")?/g;
  let m;
  let out = svg;
  while ((m = re.exec(src)) !== null) {
    const [, a, b, label = ""] = m;
    out = drawDivider(out, a, b, label);
  }
  return out;
}

// 在两个 cluster 中间画一条垂直虚线 + 居中标签
function drawDivider(svg, nameA, nameB, label) {
  // 找 cluster 的边界:path d="Mx,y ... L右下x" —— 取 cluster 的整体宽度区间
  const boxA = clusterBox(svg, nameA);
  const boxB = clusterBox(svg, nameB);
  if (!boxA || !boxB) return svg;
  // 分界线 x = A 的右边界与 B 的左边界的中点
  const midX = Math.round((boxA.right + boxB.left) / 2);
  // y 覆盖两个 cluster 的并集高度
  const topY = Math.min(boxA.top, boxB.top);
  const botY = Math.max(boxA.bottom, boxB.bottom);

  // 插入到 </svg> 之前;用 rotate 把水平虚线思路改掉,这里直接画垂直线
  const line = `<line x1="${midX}" y1="${topY}" x2="${midX}" y2="${botY}" stroke="#B0B0B0" stroke-width="1.5" stroke-dasharray="6,5"/>`;
  const labelText = label
    ? `<text x="${midX}" y="${Math.round((topY + botY) / 2)}" fill="#888" font-size="13" font-family="'Segoe UI'" text-anchor="middle" dominant-baseline="middle" font-weight="600">${label}</text>`
    : "";
  return svg.replace(/<\/g>\s*<\/svg>$/, `${line}${labelText}</g></svg>`);
}

// 提取某个 cluster 的边界框 {left, right, top, bottom}
// cluster 的结构固定为: <!--cluster name--><g ...><path d="..." .../>
// 只取紧跟在 g 标签后的第一个 path(外框),避免误匹配内部元素
function clusterBox(svg, name) {
  const re = new RegExp(`<!--cluster ${name}--><g[^>]*><path d="([^"]+)"`, "");
  const m = svg.match(re);
  if (!m) return null;
  const nums = [...m[1].matchAll(/(?:M|L)([0-9.]+),([0-9.]+)/g)];
  if (nums.length === 0) return null;
  const xs = nums.map((n) => parseFloat(n[1]));
  const ys = nums.map((n) => parseFloat(n[2]));
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

// ---- 参数解析 ----
function parseArgs(argv) {
  const files = [];
  let outDir = null;
  let dividers = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") {
      outDir = argv[++i];
      if (!outDir) {
        console.error("--out-dir 需要一个参数");
        process.exit(1);
      }
    } else if (a === "--no-dividers") {
      dividers = false;
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
  return { files, outDir, dividers };
}

function printUsage() {
  console.error(
    [
      "用法: node scripts/render-puml.mjs <puml文件> [puml文件...] [选项]",
      "",
      "选项:",
      "  --out-dir <dir>  统一覆盖输出目录(默认: 各 puml 同级的 img/)",
      "  --no-dividers    禁用 @inject:divider 后处理",
      "  -h, --help       显示帮助",
      "",
      "示例:",
      "  node scripts/render-puml.mjs docs/串口ZMODEM文件传输设计/*.puml",
      "  node scripts/render-puml.mjs foo.puml --out-dir ./out-img",
    ].join("\n")
  );
}

// ---- 主流程 ----
async function main() {
  const { files, outDir, dividers } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    printUsage();
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const f of files) {
    const full = path.resolve(f);
    const base = path.basename(f, ".puml");
    // 默认输出: puml 同级的 img/; --out-dir 覆盖
    const dir = outDir ? path.resolve(outDir) : path.join(path.dirname(full), "img");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, base + ".svg");
    try {
      const rawSrc = fs.readFileSync(full, "utf-8");
      let svg = await renderRemote(full);
      if (dividers) {
        svg = injectDividers(svg, rawSrc);
      }
      fs.writeFileSync(out, svg, "utf-8");
      console.log(`✓ ${base}.puml → ${path.relative(process.cwd(), out)}  (${svg.length} bytes)`);
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
