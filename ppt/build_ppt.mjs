/* embedded-mcp-toolkit 项目介绍 PPT 重建脚本
 *
 * 用法（在本 ppt/ 目录下执行）：
 *   powershell -ExecutionPolicy Bypass -File build.ps1    # Windows 一键执行下面三步；文件被 PowerPoint 打开时会自动关闭
 *   ./linux_build.sh                                      # Linux/macOS 一键执行同样的三步
 *   npm i -D pptxgenjs                                    # 仅首次：本地安装依赖（ESM import 不走 NODE_PATH）
 *   node build_ppt.mjs                                    # 生成 .tmp/out_new.pptx（.tmp/ 为 gitignore 的构建缓存目录）
 *   python post_fix.py .tmp/out_new.pptx .tmp/out_fixed.pptx
 *                                                         # 后处理：修复 pptxgenjs 生成的 <a:pPr> 重复问题，否则 PowerPoint 打不开
 *   cp .tmp/out_fixed.pptx embedded-mcp-toolkit-项目介绍.pptx   # 覆盖成品
 *
 * 注意：
 *   - 页码分母写死在 header() 的 "N / 24" 里，增删页面后需同步修正页码
 *   - 架构图直接引用 ../docs/项目简介/img/*.svg（矢量，随 git 仓库分发，无额外素材依赖）
 *
 * 设计系统：深海军蓝 PRIMARY + 琥珀 ACCENT（串口/控制台主题），白底内容页，深色封面/封底
 * 母题：深色终端窗口（三个窗口圆点 + 等宽字体）；禁用标题下划线/色条/边条
 */
import pptxgen from "pptxgenjs";

const W = 13.33, H = 7.5, M = 0.62, CW = W - 2 * M;
const INK = "15263A";        // 深色页背景
const TERM = "1B2E42";       // 终端块背景
const PRIMARY = "1F3A54";    // 主色：标题/表头/结构
const ACCENT = "D99414";     // 琥珀：强调
const ACCENT_DK = "9A6606";  // 琥珀（白底小字）
const ACCENT_LT = "FBF2DC";  // 琥珀浅底（结论带）
const CARD = "F1F4F8";       // 冷灰卡片
const HAIR = "D8E0E8";       // 发丝线
const TEXT = "22303E";
const MUTED = "5D6B7A";
const LIGHT = "C7D3DE";      // 深底上的次要文字
const DIM = "8FA3B5";        // 终端注释灰
const GREEN = "2E7D46", RED = "C0392B";
const SANS = "微软雅黑", MONO = "Consolas";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "embedded-mcp-toolkit";
pres.title = "embedded-mcp-toolkit 项目介绍";

const T = (o) => Object.assign({ fontFace: SANS, color: TEXT }, o);
const MO = (o) => Object.assign({ fontFace: MONO }, o);
const bu = () => ({ code: "25B8", indent: 12 });

function header(s, part, title, page) {
  s.background = { color: "FFFFFF" };
  s.addText(part, T({ x: M, y: 0.4, w: 8, h: 0.32, fontSize: 12.5, bold: true, color: ACCENT_DK, fontFace: MONO, charSpacing: 2, margin: 0 }));
  s.addText(title, T({ x: M, y: 0.74, w: CW, h: 0.66, fontSize: 28, bold: true, color: PRIMARY, margin: 0 }));
  if (page) s.addText(page + " / 24", T({ x: W - 1.5, y: 7.06, w: 0.9, h: 0.3, fontSize: 12, color: MUTED, align: "right", margin: 0 }));
}

function card(s, x, y, w, h, fill) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill || CARD }, line: { type: "none" }, rectRadius: 0.07 });
}

// 深色终端窗口：三个圆点 + 内容由调用方继续添加
function terminal(s, x, y, w, h) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: TERM }, line: { type: "none" }, rectRadius: 0.09 });
  const dots = ["FF5F56", "FFBD2E", "27C93F"];
  dots.forEach((c, i) => s.addShape(pres.shapes.OVAL, { x: x + 0.26 + i * 0.2, y: y + 0.22, w: 0.1, h: 0.1, fill: { color: c }, line: { type: "none" } }));
}

function band(s, text, y, h, opts) {
  const o = opts || {};
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y, w: CW, h: h || 0.9, fill: { color: o.fill || ACCENT_LT }, line: { type: "none" }, rectRadius: 0.07 });
  s.addText(text.runs || text.txt, T({
    x: M + 0.32, y, w: CW - 0.64, h: h || 0.9, fontSize: o.fontSize || 16, bold: o.bold !== false,
    color: o.color || PRIMARY, valign: "middle", margin: 0,
  }));
}

/* ============ S1 封面 ============ */
{
  const s = pres.addSlide();
  s.background = { color: INK };
  s.addText("嵌入式开发 · MCP 协议 · AI 工具链", MO({ x: 0.95, y: 1.12, w: 8, h: 0.35, fontSize: 14, bold: true, color: "E8A93D", charSpacing: 2, margin: 0 }));
  s.addText("embedded-mcp-toolkit", MO({ x: 0.95, y: 1.72, w: 11.4, h: 1.05, fontSize: 47, bold: true, color: "FFFFFF", margin: 0 }));
  s.addText("让 AI 直接对话嵌入式板卡", T({ x: 0.95, y: 2.95, w: 11, h: 0.62, fontSize: 29, bold: true, color: "FFFFFF", margin: 0 }));
  s.addText("基于 MCP 协议的嵌入式板卡远程管理工具\n串口 / SSH / ADB / PowerShell 四通道统一抽象", T({ x: 0.95, y: 3.72, w: 8.5, h: 0.85, fontSize: 15, color: LIGHT, margin: 0, lineSpacingMultiple: 1.25 }));

  const chips = [["serial", 1.5], ["ssh", 1.06], ["adb", 1.06], ["powershell", 2.16]];
  let cx = 0.95;
  chips.forEach(([t, w]) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: 4.92, w, h: 0.5, fill: { color: "1E3348" }, line: { color: "3E566E", width: 1 }, rectRadius: 0.08 });
    s.addText(t, MO({ x: cx, y: 4.92, w, h: 0.5, fontSize: 13, color: "E8EDF2", align: "center", valign: "middle", margin: 0 }));
    cx += w + 0.27;
  });

  terminal(s, 8.62, 4.32, 4.1, 1.72);
  s.addText([
    { text: "$ /mcp list", options: MO({ fontSize: 12.5, color: DIM, breakLine: true }) },
    { text: "  embedded-board", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "  ✓ connected", options: MO({ fontSize: 12.5, bold: true, color: "6FCF97" }) },
  ], { x: 8.92, y: 4.78, w: 3.6, h: 1.1, margin: 0, lineSpacingMultiple: 1.35 });

  s.addText("技术分享 · 2026", T({ x: 0.95, y: 6.72, w: 5, h: 0.32, fontSize: 12.5, color: "7A8CA0", margin: 0 }));
}

/* ============ S2 目录 ============ */
{
  const s = pres.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("目录", T({ x: M, y: 0.72, w: 4, h: 0.75, fontSize: 34, bold: true, color: PRIMARY, margin: 0 }));
  const items = [
    ["01", "为什么需要它", "从人肉调试到 MCP"],
    ["02", "什么是 MCP", "背景知识"],
    ["03", "项目架构", "三层结构 + 工具能力"],
    ["04", "部署方案", "本地同机 · 跨机远程"],
    ["05", "带来什么便利", "价值与边界"],
    ["06", "快速上手", "现场 Demo"],
    ["07", "总结与展望", "回顾与方向"],
  ];
  items.forEach(([n, t, sub], i) => {
    const col = i < 4 ? 0 : 1, row = i < 4 ? i : i - 4;
    const x = col === 0 ? 0.95 : 7.15, y = 1.98 + row * 1.3;
    s.addText(n, MO({ x, y: y + 0.02, w: 0.85, h: 0.5, fontSize: 22, bold: true, color: ACCENT_DK, margin: 0 }));
    s.addText(t, T({ x: x + 0.98, y, w: 4.3, h: 0.42, fontSize: 18.5, bold: true, color: TEXT, margin: 0 }));
    s.addText(sub, T({ x: x + 0.98, y: y + 0.46, w: 4.3, h: 0.3, fontSize: 12.5, color: MUTED, margin: 0 }));
    s.addShape(pres.shapes.LINE, { x, y: y + 0.98, w: 5.2, h: 0, line: { color: HAIR, width: 0.75 } });
  });
}

/* ============ S3 调试的变迁：以前 vs 现在 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "SSH的调试变迁：从人眼中转，到 AI 直调", 3);

  // 左列：以前——人当「中间人」
  s.addText([
    { text: "以前   ", options: MO({ fontSize: 14, bold: true, color: MUTED }) },
    { text: "人当「中间人」", options: T({ fontSize: 17, bold: true, color: PRIMARY }) },
  ], { x: M, y: 1.52, w: 5.9, h: 0.4, margin: 0 });
  terminal(s, M, 2.0, 5.9, 2.62);
  s.addText([
    { text: "$ ssh root@192.168.16.105", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "    ← 人：开终端、登录板卡", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~# free", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "       ← 人：手敲命令", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "Mem: 506864 94152 293068 …", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "   ← 人：眼挑数字", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~#", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "             ← 人：判断「发下一条」", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 2.6, w: 5.3, h: 1.85, margin: 0, paraSpaceAfter: 5 });
  s.addText([
    { text: "日志靠复制粘贴中转；烧写、重启、看日志，全程守着终端", options: { bullet: bu(), breakLine: true } },
    { text: "过滤噪声、判断结束、维持状态——全靠人脑实时顶上", options: { bullet: bu() } },
  ], T({ x: M + 0.05, y: 4.8, w: 5.85, h: 1.0, fontSize: 12.5, valign: "top", paraSpaceAfter: 6, margin: 0 }));

  // 右列：现在——AI 自己拿日志
  s.addText([
    { text: "现在   ", options: MO({ fontSize: 14, bold: true, color: ACCENT_DK }) },
    { text: "AI 自己拿日志", options: T({ fontSize: 17, bold: true, color: PRIMARY }) },
  ], { x: 6.85, y: 1.52, w: 5.9, h: 0.4, margin: 0 });
  card(s, 6.85, 2.0, 5.86, 2.62);
  s.addText([
    { text: "你  ", options: T({ fontSize: 12.5, bold: true, color: MUTED }) },
    { text: "看下板子内存还剩多少", options: T({ fontSize: 13, color: TEXT, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
    { text: "ssh root@board \"free\"", options: MO({ fontSize: 13, bold: true, color: PRIMARY }) },
    { text: "　一次调用、一次响应", options: T({ fontSize: 12, color: MUTED, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
    { text: "总内存 495 MB，可用约 316 MB，无 Swap——直接给结论", options: T({ fontSize: 13, color: TEXT, breakLine: true }) },
    { text: "你  ", options: T({ fontSize: 12.5, bold: true, color: MUTED }) },
    { text: "再看下 CPU 负载呢？", options: T({ fontSize: 13, color: TEXT, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
    { text: "load average 0.08——一条命令的事", options: T({ fontSize: 13, color: TEXT }) },
  ], { x: 7.17, y: 2.26, w: 5.25, h: 2.1, margin: 0, valign: "middle", paraSpaceAfter: 8 });
  s.addText([
    { text: "Claude Code / ZCode / OpenCode 自带 shell，命令随口就能跑", options: { bullet: bu(), breakLine: true } },
    { text: "一次性命令直调完全够用——人不用再复制粘贴", options: { bullet: bu() } },
  ], T({ x: 6.9, y: 4.8, w: 5.8, h: 1.0, fontSize: 12.5, valign: "top", paraSpaceAfter: 6, margin: 0 }));

  band(s, { txt: "复制粘贴可以消失——但嵌入式调试还有一个绕不开的那条通道是串口", fontSize: 16 }, 6.18, 0.78);
}

/* ============ S4 串口的调试变迁：一条命令变成一段脚本 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "串口的调试变迁：一条命令，变成一段脚本", 4);
  s.addText([
    { text: "换到串口试试——同样是「读一次内存」，AI 直调的样子变成了这样：", options: T({ fontSize: 13.5 }) },
  ], { x: M, y: 1.5, w: CW, h: 0.36, margin: 0 });

  // 左：SSH / ADB 一条命令
  card(s, M, 1.98, 4.5, 2.5);
  s.addText("SSH / ADB：一条命令", T({ x: M + 0.3, y: 2.24, w: 3.9, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "ssh root@board \"free\"", options: MO({ fontSize: 13, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "adb shell free", options: MO({ fontSize: 13, bold: true, color: PRIMARY }) },
  ], { x: M + 0.3, y: 2.78, w: 3.9, h: 0.75, margin: 0, paraSpaceAfter: 8 });
  s.addText("一次调用、一次响应，输出干净、拿来就用", T({ x: M + 0.3, y: 3.72, w: 3.9, h: 0.6, fontSize: 12.5, color: MUTED, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));

  // 右：Serial 一段脚本
  terminal(s, 5.36, 1.98, 7.35, 2.5);
  s.addText([
    { text: "$port = New-Object System.IO.Ports.SerialPort COM3,115200,None,8,one", options: MO({ fontSize: 11.5, color: "E8EDF2", breakLine: true }) },
    { text: "$port.Open()", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
    { text: "   ← 开端口（排他）", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "$port.WriteLine(\"free\")", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
    { text: "    ← 写命令", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "Start-Sleep -Milliseconds 800", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
    { text: "  ← 等多久？猜的", options: T({ fontSize: 11.5, bold: true, color: "E8A93D", breakLine: true }) },
    { text: "$port.ReadExisting()", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
    { text: "       ← 读缓冲：完没完不知道", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "$port.Close()", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
  ], { x: 5.7, y: 2.44, w: 6.7, h: 1.9, margin: 0, valign: "top", paraSpaceAfter: 3 });

  // 下：读回来的原始输出
  terminal(s, M, 4.62, CW, 1.42);
  s.addText([
    { text: "free", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "                                ← 命令回显（噪声）", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "Mem: 506864 94152 293068 …", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "         ← 真正的数据夹在中间", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~#", options: MO({ fontSize: 12.5, color: "E8EDF2" }) },
    { text: "                    ← 提示符 = 唯一的「结束」线索", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 5.14, w: CW - 0.7, h: 0.85, margin: 0, paraSpaceAfter: 3 });

  band(s, { txt: "SSH 是一条命令，串口是每轮都要重写的脚本——Sleep 多少全靠猜，慢命令直接截断", fontSize: 15.5 }, 6.2, 0.75);
}

/* ============ S5 困境①：串口不是请求-响应 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "困境①：串口不是「请求-响应」模型", 5);
  s.addText([
    { text: "U-Boot 引导、内核启动、无 SSH 的早期设备都只认它——而它是一段", options: T({ fontSize: 13.5 }) },
    { text: "裸字节流", options: T({ fontSize: 13.5, bold: true, color: ACCENT_DK }) },
    { text: "，根子上有三个结构问题：", options: T({ fontSize: 13.5 }) },
  ], { x: M, y: 1.5, w: CW, h: 0.36, margin: 0 });
  const probs = [
    ["问题 1 · 没有结束信号", "读到的字节不告诉你「输出完没完」：短命令读全了，慢命令就是截断的半截，而文本毫无破绽"],
    ["问题 2 · 输出只在瞬间存在", "boot 日志只刷一次，必须当时握着端口；反复开关端口还可能触发 DTR 复位——「临时开一下」本身就不安全"],
    ["问题 3 · 每轮重写一遍", "就算 AI 会写：开端口、循环读、判结束、清洗——每轮从头写、重新猜超时，行为不可复现"],
  ];
  const cw = 3.87;
  probs.forEach(([t, b], i) => {
    const x = M + i * (cw + 0.24);
    card(s, x, 1.98, cw, 2.35);
    s.addText(t, T({ x: x + 0.26, y: 2.2, w: cw - 0.52, h: 0.34, fontSize: 14.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(b, T({ x: x + 0.26, y: 2.64, w: cw - 0.52, h: 1.55, fontSize: 12.5, valign: "top", margin: 0, lineSpacingMultiple: 1.18 }));
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: 4.55, w: CW, h: 0.7, fill: { type: "none" }, line: { color: ACCENT, width: 1 }, rectRadius: 0.06 });
  s.addText([
    { text: "同源问题   ", options: MO({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
    { text: "logcat / top / ping / tail -f 这类常驻命令永不返回提示符——「等多久算采够了」全靠猜", options: T({ fontSize: 13 }) },
  ], { x: M + 0.3, y: 4.55, w: CW - 0.6, h: 0.7, valign: "middle", margin: 0 });

  band(s, { txt: "当然也可以脚本尾部加一个 echo cmd_end 字符串，……但是这套逻辑写下来，就已经在重新实现这个 MCP 的「终端模拟器」了", fontSize: 15 }, 5.55, 0.95);
}

/* ============ S5 不便②：临时进程状态活不过一轮 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "困境②：临时进程，状态活不过一轮", 6);
  terminal(s, M, 1.56, 6.15, 2.95);
  s.addText([
    { text: "ssh root@board \"cd /tmp\"", options: MO({ fontSize: 12.5, color: "E8EDF2", breakLine: true }) },
    { text: "    → 这次进了 /tmp", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "ssh root@board \"ls\"", options: MO({ fontSize: 12.5, color: "E8EDF2", breakLine: true }) },
    { text: "    → 又回到 ~，/tmp 白进了", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "ssh root@board \"export FOO=1\"", options: MO({ fontSize: 12.5, color: "E8EDF2", breakLine: true }) },
    { text: "    → 环境变量也丢了", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 2.2, w: 5.5, h: 2.1, margin: 0, paraSpaceAfter: 5 });

  card(s, 7.0, 1.56, 5.71, 2.95);
  s.addText("病根", T({ x: 7.32, y: 1.82, w: 5.0, h: 0.4, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "Host 每轮让 AI 跑的 PowerShell 都是临时进程，用完即弃", options: { bullet: bu(), breakLine: true } },
    { text: "而调试的节奏是「观察 → 决策 → 再观察」——每一次「看」都是新进程、新连接", options: { bullet: bu(), breakLine: true } },
    { text: "cd /work/build && source env-setup.sh 这类环境前缀每轮原样重发，漏一个 source 错得还很隐蔽", options: { bullet: bu() } },
  ], T({ x: 7.32, y: 2.34, w: 5.05, h: 2.0, fontSize: 12.5, valign: "top", paraSpaceAfter: 9, margin: 0 }));

  card(s, M, 4.72, CW, 1.28, ACCENT_LT);
  s.addText("交互式程序罩不住", T({ x: M + 0.32, y: 4.72, w: 2.7, h: 1.28, fontSize: 15.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
  s.addText("U-Boot、menuconfig、gdb 不是「命令序列」而是「对话」——要发一句、看一句地往返，一次性命令的模型根本串不起来", T({ x: M + 3.2, y: 4.72, w: CW - 3.55, h: 1.28, fontSize: 13, valign: "middle", margin: 0, lineSpacingMultiple: 1.2 }));
  band(s, { txt: "病根是同一个：每轮的命令都跑在临时进程里——而调试需要的是一个「持续在线的读者」", fontSize: 15.5 }, 6.22, 0.75);
}

/* ============ S6 困境③：多设备管理，「写个 skill」够吗 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "困境③：多设备管理，「写个 skill」够吗？", 7);
  s.addText("真用起来磨人的是设备——四道关摆在 AI 直调面前：", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  const hw = CW / 2 - 0.12;
  // 左：多设备的四道关
  card(s, M, 1.98, hw, 3.62);
  s.addText("多设备的四道关", T({ x: M + 0.3, y: 2.24, w: hw - 0.6, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  const gatesL = [
    "参数关：哪块板在哪个口、波特率多少、IP 是什么——每次都得用户交代，靠AI记忆不靠谱",
    "姿势关：SSH/ADB 拼命令即可；serial 裸字节流要判结束",
    "占用关：串口排他——上轮没关干净本轮打不开，还可能 DTR 复位",
    "并发关：盯 A 板同时操作 B 板——多条会话的开关与清场没人兜底",
  ];
  s.addText(gatesL.map((r, j) => ({ text: r, options: { bullet: bu(), breakLine: j < gatesL.length - 1 } })), T({ x: M + 0.3, y: 2.74, w: hw - 0.6, h: 1.4, fontSize: 12.5, valign: "top", paraSpaceAfter: 8, margin: 0 }));
  terminal(s, M + 0.3, 4.15, hw - 0.6, 1.32);
  s.addText([
    { text: "# skill · devices.md", options: MO({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "- COM3 → A 板 / 115200", options: MO({ fontSize: 11.5, color: "E8EDF2", breakLine: true }) },
    { text: "- board-b → 192.168.16.105", options: MO({ fontSize: 11.5, color: "E8EDF2" }) },
  ], { x: M + 0.6, y: 4.59, w: hw - 1.2, h: 0.75, margin: 0, paraSpaceAfter: 2 });

  // 右：写个 skill 能过几关？
  const rx = M + hw + 0.24;
  card(s, rx, 1.98, hw, 3.62);
  s.addText("写个 skill 能过几关？", T({ x: rx + 0.3, y: 2.24, w: hw - 0.6, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "✓ ", options: T({ fontSize: 13, bold: true, color: GREEN }) },
    { text: "参数关——", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "设备清单写进 skill 文档", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "　　　AI 每次加载就知道连谁、用什么参数", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "✗ ", options: T({ fontSize: 13, bold: true, color: RED }) },
    { text: "姿势关——", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "SSH/ADB 拼命令即可；serial 状态机每轮现写", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "　　　知识 ≠ 能力——困境①原样重演", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "✗ ", options: T({ fontSize: 13, bold: true, color: RED }) },
    { text: "占用关——", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "托管端口必须是活着的进程，文档做不到", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "✗ ", options: T({ fontSize: 13, bold: true, color: RED }) },
    { text: "并发关——", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "持有端口、仲裁冲突、异常清场，都得是常驻者", options: T({ fontSize: 12.5, color: TEXT }) },
  ], { x: rx + 0.3, y: 2.74, w: hw - 0.6, h: 2.7, margin: 0, valign: "top", paraSpaceAfter: 8 });

  band(s, {
    runs: [
      { text: "让 AI 自己养常驻串口会话？可以——但那意味着写一个常驻进程：", options: T({ fontSize: 14.5, bold: true, color: PRIMARY, breakLine: true }) },
      { text: "管排他、持端口、判结束、多设备仲裁——", options: T({ fontSize: 14.5, bold: true, color: PRIMARY }) },
      { text: "写完这一套，就是在重新实现这个 MCP", options: T({ fontSize: 14.5, bold: true, color: ACCENT_DK }) },
    ]
  }, 5.78, 0.95);
}

/* ============ S7 困境④：AI 在编译服务器，串口线在工位机 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "困境④：AI 在编译服务器，串口线在工位机", 8);
  s.addText([
    { text: "Claude Code / OpenCode / ZCode 为了直接摸到代码，通常就跑在 Linux 编译服务器上——", options: T({ fontSize: 13.5 }) },
    { text: "两条路，各难一半：", options: T({ fontSize: 13.5, bold: true, color: ACCENT_DK }) },
  ], { x: M, y: 1.5, w: CW, h: 0.36, margin: 0 });

  const opts = [
    ["方案 A · AI 搬到 Windows", "代码从编译服务器挂载过来", [
      ["✓", "代码经 Z:\\ 网络挂载读写——能用", GREEN],
      ["✓", "串口、USB-ADB 就在手边，AI 够得着，甚至可以powershell直调", GREEN],
      ["✗", "编译仍在服务器：每次 make 都要远程绕一圈", RED],
      ["✗", "网络挂载 I/O 慢，大仓库尤其难受(其实一般也不一定明显)", RED],
    ], "编辑别扭、编译绕圈，两头不讨好"],
    ["方案 B · AI 跑在编译服务器", "团队的主流形态", [
      ["✓", "代码就在本地：编辑 → 编译 → 测试一气呵成", GREEN],
      ["✓", "工具链、依赖、产物都在手边，最顺畅", GREEN],
      ["✗", "串口线、USB-ADB 只插在 Windows 工位机", RED],
      ["✗", "Linux 侧没有任何路径碰到 COM 口 / USB", RED],
    ], "编译方便了，串口、USB这些没了，linux服务器碰不到这些"],
  ];
  const hw = CW / 2 - 0.12;
  opts.forEach(([t, sub, rows, tag], i) => {
    const x = M + i * (hw + 0.24);
    card(s, x, 1.98, hw, 3.62);
    s.addText(t, T({ x: x + 0.3, y: 2.26, w: hw - 0.6, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(sub, T({ x: x + 0.3, y: 2.68, w: hw - 0.6, h: 0.3, fontSize: 12, color: MUTED, margin: 0 }));
    s.addText(rows.map(([mark, txt, cc], j) => ([
      { text: mark + "  ", options: T({ fontSize: 13, bold: true, color: cc }) },
      { text: txt, options: T({ fontSize: 13, color: TEXT, breakLine: j < rows.length - 1 }) },
    ])).flat(), { x: x + 0.3, y: 3.12, w: hw - 0.6, h: 1.85, margin: 0, valign: "top", paraSpaceAfter: 12 });
    s.addText("→ " + tag, T({ x: x + 0.3, y: 5.08, w: hw - 0.6, h: 0.34, fontSize: 13, bold: true, color: ACCENT_DK, margin: 0 }));
  });
  band(s, { txt: "不是协议难写，是物理上没有那条线缆——必须有一个进程守在设备旁，让 AI 远程过来用", fontSize: 16 }, 5.86, 0.8);
}

/* ============ S7 解决思路 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 01 · 为什么需要它", "解决思路：一个常驻的会话守护进程", 9);
  const boxes = [
    { x: 0.62, w: 2.5, t: "AI 编程助手", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: false },
    { x: 3.97, w: 3.05, t: "MCP Server（常驻）", fill: PRIMARY, line: null, tc: "FFFFFF", mono: false },
    { x: 7.87, w: 2.6, t: "ssh / serial / adb", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: true },
    { x: 11.32, w: 1.39, t: "目标板", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: false },
  ];
  boxes.forEach(b => {
    const opt = { x: b.x, y: 1.6, w: b.w, h: 0.88, fill: { color: b.fill }, rectRadius: 0.08 };
    opt.line = b.line ? { color: b.line, width: 1.25 } : { type: "none" };
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, opt);
    s.addText(b.t, (b.mono ? MO : T)({ x: b.x, y: 1.6, w: b.w, h: 0.88, fontSize: b.mono ? 13 : 14.5, bold: true, color: b.tc, align: "center", valign: "middle", margin: 0 }));
  });
  [3.12, 7.02, 10.47].forEach(x => s.addShape(pres.shapes.LINE, { x, y: 2.04, w: 0.85, h: 0, line: { color: PRIMARY, width: 2, endArrowType: "triangle" } }));
  s.addText([
    { text: "一个长期活着的进程：连接、端口、会话状态都握在它手里", options: T({ fontSize: 13.5 }) },
    { text: "——观察-决策循环直接在既有上下文里跑", options: T({ fontSize: 13.5, color: MUTED }) },
  ], { x: M, y: 2.62, w: CW, h: 0.34, margin: 0 });

  s.addText("困境 → 解法 对照", T({ x: M, y: 3.08, w: 5, h: 0.34, fontSize: 15, bold: true, color: PRIMARY, margin: 0 }));
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13, valign: "middle" };
  const c = (t, o) => ({ text: t, options: Object.assign({ fontSize: 12.5, valign: "middle", color: TEXT }, o) });
  s.addTable([
    [c("困境", hdr), c("MCP Server 的解法", hdr)],
    [c("串口：无结束信号、输出只在瞬间存在", { bold: true }), { text: [{ text: "终端模拟器：滤回显、剥 ANSI、提示符检测判结束；端口常驻持有，boot 日志随时可读", options: T({ fontSize: 12.5 }) }] }],
    [c("多设备四道关：参数、姿势、占用、并发", { bold: true }), { text: [{ text: "devices/*.yaml 声明设备，AI 按名切换；Server 常驻托管端口与会话", options: T({ fontSize: 12.5 }) }] }],
    [c("交互式程序 + 常驻命令", { bold: true }), { text: [{ text: "write / read / send_ctrl 往返交互；提示符检测 + 双超时，常驻命令采样后自动 Ctrl+C", options: T({ fontSize: 12.5 }) }] }],
    [c("AI 在 Linux、设备插在 Windows", { bold: true }), { text: [{ text: "Server 守在设备旁握着物理通道，Linux 侧经 SSH 隧道把 stdio 延长过来", options: T({ fontSize: 12.5 }) }] }],
  ], {
    x: M, y: 3.5, w: CW, colW: [4.1, 7.99], rowH: [0.42, 0.58, 0.58, 0.58, 0.58],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "这个「常驻的会话守护进程」正是 MCP 标准里的角色——MCP Server，也就是本项目 embedded-mcp-toolkit", fontSize: 15 }, 6.42, 0.62);
}

/* ============ S7 什么是 MCP ============ */
{
  const s = pres.addSlide();
  header(s, "PART 02 · 背景知识", "什么是 MCP？", 10);
  band(s, { txt: "MCP（Model Context Protocol）＝ AI 界的 USB 协议", fontSize: 23 }, 1.66, 1.1);
  const feats = [
    ["开放标准", "规范 AI 应用与外部数据源、工具之间的连接方式"],
    ["统一调用", "让 LLM 以标准化方式调用外部能力，无需为每个工具单独写集成代码"],
    ["即插即用", "只要工具遵循 MCP 标准，任何支持 MCP 的 AI 应用都能接入"],
  ];
  const cw = 3.87;
  feats.forEach(([t, b], i) => {
    const x = M + i * (cw + 0.24);
    card(s, x, 3.08, cw, 2.15);
    s.addText(t, T({ x: x + 0.3, y: 3.4, w: cw - 0.6, h: 0.4, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(b, T({ x: x + 0.3, y: 3.9, w: cw - 0.6, h: 1.15, fontSize: 13, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));
  });
  s.addText("本项目的定位：一个遵循 MCP 标准的 MCP Server", T({ x: M, y: 5.68, w: CW, h: 0.45, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("官网：modelcontextprotocol.io", MO({ x: M, y: 6.2, w: CW, h: 0.32, fontSize: 12.5, color: MUTED, margin: 0 }));
}

/* ============ S8 MCP 三大角色 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 02 · 背景知识", "MCP 三大角色与连接关系", 11);
  // 直接引用 docs/项目简介/img/mcp-architecture.svg（矢量，684x409pt）
  const h = 4.9, w = h * (684 / 409);
  s.addImage({ path: "../docs/项目简介/img/mcp-architecture.svg", x: (W - w) / 2, y: 1.66, w, h });
  s.addText("每个 MCP Client 与一个 MCP Server 一一对应（1:1）；Host 内可同时管理多个 Client", T({ x: M, y: 6.72, w: CW, h: 0.32, fontSize: 12.5, color: MUTED, align: "center", margin: 0 }));
}

/* ============ S9 toolkit 是什么 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 03 · 项目架构", "embedded-mcp-toolkit 是什么", 12);
  card(s, M, 1.62, 5.9, 4.55);
  s.addText("角色定位", T({ x: M + 0.32, y: 1.94, w: 5.0, h: 0.42, fontSize: 17, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "角色：一个 MCP Server（独立进程）", options: { bullet: bu(), breakLine: true } },
    { text: "能力：经串口 / SSH / ADB / PowerShell 四条通道管理嵌入式设备", options: { bullet: bu(), breakLine: true } },
    { text: "特性：多会话并发 · 流式输出切片 · 一键登录", options: { bullet: bu(), breakLine: true } },
    { text: "　　　（PSH 动态口令）· 进程退出自动清理", options: { breakLine: true } },
    { text: "不绑定 Host：Claude Code / ZCode / OpenCode 皆可接入", options: { bullet: bu(), breakLine: true } },
    { text: "开箱即用：npm 安装后一条 init 命令生成配置骨架", options: { bullet: bu() } },
  ], T({ x: M + 0.32, y: 2.56, w: 5.26, h: 3.4, fontSize: 13.5, valign: "top", paraSpaceAfter: 14, margin: 0 }));

  s.addText("四大通道", T({ x: 6.95, y: 1.62, w: 4, h: 0.42, fontSize: 17, bold: true, color: PRIMARY, margin: 0 }));
  const chans = [
    ["serial 串口", "UART · U-Boot 控制台 · ZMODEM 传文件"],
    ["SSH", "远程 Linux 板卡 · 编译服务器"],
    ["ADB", "Android 设备调试"],
    ["PowerShell", "Windows 本机操作"],
  ];
  chans.forEach(([n, d], i) => {
    const y = 2.28 + i * 1.0;
    s.addText(n, MO({ x: 6.95, y, w: 5.6, h: 0.36, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(d, T({ x: 6.95, y: y + 0.38, w: 5.6, h: 0.3, fontSize: 13, color: MUTED, margin: 0 }));
    if (i < 3) s.addShape(pres.shapes.LINE, { x: 6.95, y: y + 0.82, w: 5.55, h: 0, line: { color: HAIR, width: 0.75 } });
  });
}

/* ============ S10 功能总览 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 03 · 项目架构", "功能总览：四大通道 + 基础工具", 13);
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const cat = (t) => ({ text: t, options: { fontSize: 13, bold: true, color: PRIMARY, valign: "middle" } });
  const tool = (t) => ({ text: t, options: { fontFace: MONO, fontSize: 12, color: TEXT, valign: "middle" } });
  const what = (t) => ({ text: t, options: { fontSize: 12.5, color: TEXT, valign: "middle" } });
  s.addTable([
    [{ text: "类别", options: Object.assign({}, hdr) }, { text: "代表工具", options: Object.assign({}, hdr) }, { text: "解决什么", options: Object.assign({}, hdr) }],
    [cat("串口 serial"), tool("open / close / write / read / exec /\nlogin / enter_uboot / upload / download"), what("UART、U-Boot 控制台、ZMODEM 传文件")],
    [cat("SSH"), tool("open / close / exec / login / connection"), what("远程 Linux 板卡、编译服务器")],
    [cat("ADB"), tool("device_list / exec / shell_*"), what("Android 设备调试")],
    [cat("PowerShell"), tool("exec"), what("Windows 本机操作(一次性命令)")],
    [cat("基础"), tool("version / device_info"), what("版本与设备配置查询")],
    [cat("Windows 扫描"), tool("port_scan / network_scan"), what("COM 口、网卡 / IP 扫描")],
  ], {
    x: M, y: 1.7, w: CW, colW: [2.3, 5.2, 4.59],
    rowH: [0.5, 0.72, 0.6, 0.6, 0.6, 0.6, 0.6],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  s.addText("serial / ssh / adb 三条通道共享同一套 shell_exec 执行语义——一次实现，处处可用", T({ x: M, y: 6.5, w: CW, h: 0.34, fontSize: 12.5, color: MUTED, margin: 0 }));
}

/* ============ S11 核心机制 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 03 · 项目架构", "核心机制：提示符检测 + 双超时策略", 14);
  card(s, M, 1.62, 5.75, 2.72);
  s.addText("机制（*_shell_exec 三通道共享）", T({ x: M + 0.3, y: 1.9, w: 5.1, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "常驻命令识别：按首 token 判定（内置白名单 ping / logcat / top / …，可扩展）", options: { bullet: bu(), breakLine: true } },
    { text: "结束判定：检测到 shell 提示符（$ / # / => …）→ 立即返回", options: { bullet: bu() } },
  ], T({ x: M + 0.3, y: 2.42, w: 5.15, h: 1.75, fontSize: 13, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  card(s, 6.6, 1.62, 6.11, 2.72);
  s.addText("双超时策略", T({ x: 6.9, y: 1.9, w: 5.4, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "普通命令　", options: T({ fontSize: 13.5, bold: true, color: TEXT }) },
    { text: "5 分钟兜底 · 不发 Ctrl+C · 异常安全阀", options: T({ fontSize: 13.5, color: MUTED, breakLine: true }) },
    { text: "常驻命令　", options: T({ fontSize: 13.5, bold: true, color: TEXT }) },
    { text: "10 秒采样 · 自动发 Ctrl+C · 中性采样结果", options: T({ fontSize: 13.5, color: MUTED }) },
  ], { x: 6.9, y: 2.44, w: 5.55, h: 1.6, margin: 0, valign: "top", paraSpaceAfter: 12 });

  terminal(s, M, 4.72, CW, 0.95);
  s.addText([
    { text: "输出末尾追加 ", options: T({ fontSize: 13.5, color: "E8EDF2" }) },
    { text: "[采样超时: ...] / [兜底超时: ...]", options: MO({ fontSize: 13, color: "E8EDF2" }) },
    { text: " 语义标注——AI 不再误判", options: T({ fontSize: 13.5, color: "E8EDF2" }) },
  ], { x: M + 0.34, y: 5.08, w: CW - 0.7, h: 0.52, valign: "middle", margin: 0 });

  s.addText("★ 现场演示：top 采样一次——最能体现「领域流程固化」的价值", T({ x: M, y: 6.0, w: CW, h: 0.4, fontSize: 13.5, bold: true, color: ACCENT_DK, margin: 0 }));
}

/* ============ S12 一键登录 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 03 · 项目架构", "一键登录：把领域流程固化进一个工具", 15);
  card(s, M, 1.62, 5.75, 2.28);
  s.addText("痛点", T({ x: M + 0.3, y: 1.9, w: 5.0, h: 0.4, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "带 PSH 的设备登录：challenge → 动态口令 → 解锁", options: { bullet: bu(), breakLine: true } },
    { text: "步骤多、每轮都要重推——AI 和人都很痛苦", options: { bullet: bu() } },
  ], T({ x: M + 0.3, y: 2.42, w: 5.15, h: 1.3, fontSize: 13.5, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  card(s, 6.6, 1.62, 6.11, 2.28, ACCENT_LT);
  s.addText("方案", T({ x: 6.9, y: 1.9, w: 5.4, h: 0.4, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "serial_shell_login / ssh_shell_login", options: MO({ fontSize: 14.5, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "一个工具调用完成全套登录流程", options: T({ fontSize: 13.5, color: TEXT }) },
  ], { x: 6.9, y: 2.42, w: 5.5, h: 1.3, margin: 0, valign: "top", paraSpaceAfter: 8 });

  s.addText("配套能力", T({ x: M, y: 4.22, w: 4, h: 0.36, fontSize: 15, bold: true, color: PRIMARY, margin: 0 }));
  const caps = [
    ["KeyProvider 密钥管理", "支持 file（文件 IPC）与 terminal（终端交互）两种模式", false],
    ["PSH 动态口令", "自动处理 PSH 动态口令生成的密钥", false],
    ["serial_enter_uboot", "重启设备并进入 U-Boot 命令行（适配各厂商提示符，可配置正则）", true],
  ];
  caps.forEach(([n, d, mono], i) => {
    const y = 4.7 + i * 0.78;
    s.addText(n, mono ? MO({ x: M, y, w: 3.4, h: 0.34, fontSize: 14, bold: true, color: TEXT, margin: 0 }) : T({ x: M, y, w: 3.4, h: 0.34, fontSize: 14, bold: true, color: TEXT, margin: 0 }));
    s.addText(d, T({ x: 4.2, y: y + 0.02, w: 8.5, h: 0.34, fontSize: 13, color: MUTED, margin: 0 }));
    if (i < 2) s.addShape(pres.shapes.LINE, { x: M, y: y + 0.56, w: CW, h: 0, line: { color: HAIR, width: 0.75 } });
  });
}

/* ============ S13 部署形态总览 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 04 · 部署方案", "部署形态总览：两种用法", 16);
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const dim = (t, mono) => ({ text: t, options: { fontSize: 12.5, bold: true, color: PRIMARY, fontFace: mono ? MONO : SANS, valign: "middle" } });
  const v = (t, mono) => ({ text: t, options: { fontSize: 12.5, color: TEXT, fontFace: mono ? MONO : SANS, valign: "middle" } });
  s.addTable([
    [{ text: "维度", options: Object.assign({}, hdr) }, { text: "用法一：本地同机", options: Object.assign({}, hdr) }, { text: "用法二：跨机远程", options: Object.assign({}, hdr) }],
    [dim("AI 客户端位置"), v("Windows 工位机"), v("Linux 机器")],
    [dim("MCP Server 位置"), v("同一台 Windows"), v("Windows 工位机（握着物理设备）")],
    [dim("连接方式"), v("stdio 子进程直连，零网络"), v("SSH 隧道转发 stdio，跨 TCP :22")],
    [dim(".mcp.json 的 command", true), v("node", true), v("ssh", true)],
    [dim("适用场景"), v("开发者自己调试、单人单机"), v("AI 跑在 Linux 编译机，设备连在 Windows 工位机")],
  ], {
    x: M, y: 1.7, w: CW, colW: [2.7, 4.6, 4.79],
    rowH: [0.5, 0.68, 0.68, 0.68, 0.68, 0.68],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "无论怎么部署：工具、配置、运行时行为完全一致——只是连接介质的差别", fontSize: 15.5 }, 6.05, 0.85);
}

/* ============ S14 部署方案一 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 04 · 部署方案", "部署方案一：本地同机（用法一）", 17);
  // 直接引用 docs/项目简介/img/usage1-local.svg（矢量，1604x658pt）
  const iw = 7.63, ih = iw * (658 / 1604);
  s.addImage({ path: "../docs/项目简介/img/usage1-local.svg", x: M, y: 1.62 + (5.15 - ih) / 2, w: iw, h: ih });
  const cx = M + iw + 0.28, cwd = W - M - cx;
  card(s, cx, 1.62, cwd, 5.15);
  s.addText("要点", T({ x: cx + 0.28, y: 1.9, w: cwd - 0.56, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "两条并行通路：源码编辑绕过 MCP，设备操作经 MCP", options: { bullet: bu(), breakLine: true } },
    { text: "关键边界：stdio（Host↔Server）、本机↔外部设备", options: { bullet: bu(), breakLine: true } },
    { text: "编译服务器双角色：源码仓库（Z: 挂载）+ 编译机", options: { bullet: bu(), breakLine: true } },
    { text: "部署闭环：编辑 → 编译 → 烧写 / 部署到目标板", options: { bullet: bu() } },
  ], T({ x: cx + 0.28, y: 2.42, w: cwd - 0.56, h: 4.1, fontSize: 12.5, valign: "top", paraSpaceAfter: 12, margin: 0 }));
}

/* ============ S15 部署方案二 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 04 · 部署方案", "部署方案二：跨机远程（用法二）", 18);
  // 直接引用 docs/项目简介/img/usage2-remote.svg（矢量，839x712pt）
  const ih = 5.15, iw = ih * (839 / 712);
  s.addImage({ path: "../docs/项目简介/img/usage2-remote.svg", x: M, y: 1.62, w: iw, h: ih });
  const cx = M + iw + 0.28, cwd = W - M - cx;
  card(s, cx, 1.62, cwd, 5.15);
  s.addText("要点", T({ x: cx + 0.28, y: 1.9, w: cwd - 0.56, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "为什么：COM3 / USB-ADB / PowerShell 绑定 Windows，Linux 够不到", options: { bullet: bu(), breakLine: true } },
    { text: "链路实质：JSON-RPC 写进 ssh stdin → TCP:22 → remote-start-mcp.bat 拉起的 node 进程，响应原路写回", options: { bullet: bu(), breakLine: true } },
    { text: "宿主端点提示：检测 SSH_CONNECTION，经 instructions + host_info 传达端点（仅 username@ip）", options: { bullet: bu(), breakLine: true } },
    { text: "编译路由指引：方式二下引导 AI 用本机交叉编译，避免绕圈", options: { bullet: bu() } },
  ], T({ x: cx + 0.28, y: 2.42, w: cwd - 0.56, h: 4.1, fontSize: 12.5, valign: "top", paraSpaceAfter: 12, margin: 0 }));
}

/* ============ S16 部署落地 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 04 · 部署方案", "部署落地：一键打通免密的两条对偶命令", 19);
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13, valign: "middle" };
  const cmd = (t) => ({ text: t, options: { fontFace: MONO, fontSize: 12.5, bold: true, color: PRIMARY, valign: "middle" } });
  const c = (t, o) => ({ text: t, options: Object.assign({ fontSize: 12.5, valign: "middle", color: TEXT }, o) });
  s.addTable([
    [c("命令", hdr), c("跑在哪", hdr), c("角色", hdr), c("职责", hdr)],
    [cmd("sshd-config"), c("Windows"), c("Windows 当 SSH server"), c("装 OpenSSH Server、生成密钥对、配 authorized_keys、生成 Linux 端 .mcp.json 模板")],
    [cmd("remote-mcp-config"), c("Windows"), c("Windows 当 SSH 客户端"), c("从 Windows 登录 Linux，把桥接 server 写入 Claude / ZCode 配置文件")],
  ], {
    x: M, y: 1.7, w: CW, colW: [2.5, 1.7, 3.0, 4.89],
    rowH: [0.48, 0.92, 0.92],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  card(s, M, 4.32, CW, 1.06);
  s.addText("产物", T({ x: M + 0.3, y: 4.32, w: 1.1, h: 1.06, fontSize: 14, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
  s.addText([
    { text: "Linux 端出现桥接 server 定义——", options: T({ fontSize: 13 }) },
    { text: "command: ssh", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: " + 一条连到 Windows 并启动 remote-start-mcp.bat 的完整命令", options: T({ fontSize: 13 }) },
  ], { x: M + 1.5, y: 4.32, w: CW - 1.9, h: 1.06, valign: "middle", margin: 0 });

  card(s, M, 5.66, CW, 1.06, ACCENT_LT);
  s.addText("本地 / 远程共用同一个 remote-start-mcp.bat launcher：锚定 cwd + 设 5 个 env + stdio 启动——双击或被 ssh 拉起，跑的是同一进程、同一份配置", T({ x: M + 0.32, y: 5.66, w: CW - 0.64, h: 1.06, fontSize: 13.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
}

/* ============ S17 PowerShell 直调 vs 本 MCP ============ */
{
  const s = pres.addSlide();
  header(s, "PART 05 · 带来什么便利", "PowerShell 直调 vs 本 MCP", 20);
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const cap = (t) => ({ text: t, options: { fontSize: 13, color: TEXT, valign: "middle" } });
  const no = () => ({ text: "✕", options: { fontSize: 17, bold: true, color: RED, align: "center", valign: "middle" } });
  const yes = () => ({ text: "✓", options: { fontSize: 17, bold: true, color: GREEN, align: "center", valign: "middle" } });
  s.addTable([
    [{ text: "能力", options: Object.assign({}, hdr) }, { text: "PowerShell 直调", options: Object.assign({}, hdr, { align: "center" }) }, { text: "本 MCP", options: Object.assign({}, hdr, { align: "center" }) }],
    [cap("持久会话（多串口 / SSH 并发）"), no(), yes()],
    [cap("流式输出切片（提示符检测 + 超时熔断）"), no(), yes()],
    [cap("常驻命令取采样（logcat / top）"), no(), yes()],
    [cap("PSH 一键解锁登录"), no(), yes()],
  ], {
    x: M, y: 1.75, w: CW, colW: [5.2, 3.4, 3.49],
    rowH: [0.52, 0.76, 0.76, 0.76, 0.76],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "「人复制粘贴、状态留不下来」 → 「AI 直接对话板子、会话持久常驻」", fontSize: 16.5 }, 5.72, 1.0);
}

/* ============ S18 诚实的边界 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 05 · 带来什么便利", "诚实的边界：什么场景用 MCP，什么场景不用", 21);
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const sc = (t, mono) => ({ text: t, options: { fontSize: 12.5, color: TEXT, fontFace: mono ? MONO : SANS, valign: "middle" } });
  const rec = (t, good) => ({ text: t, options: { fontSize: 12.5, bold: true, color: good ? GREEN : RED, valign: "middle" } });
  const why = (t) => ({ text: t, options: { fontSize: 12.5, color: TEXT, valign: "middle" } });
  s.addTable([
    [{ text: "场景", options: Object.assign({}, hdr) }, { text: "推荐", options: Object.assign({}, hdr) }, { text: "理由", options: Object.assign({}, hdr) }],
    [sc("adb install / adb push / ssh host \"一次性命令\"", true), rec("PowerShell 直调", false), why("无状态，MCP 多此一举")],
    [sc("扫端口、看网卡、跑本地脚本"), rec("PowerShell 直调", false), why("Host 本身就有 shell 能力")],
    [sc("串口交互、U-Boot、保持 PTY 的长会话"), rec("MCP 工具", true), why("有状态长连接 + 流切片")],
    [sc("PSH 登录、多板卡并发调试"), rec("MCP 工具", true), why("领域流程固化 + 多会话管理")],
    [sc("logcat / top 取采样", true), rec("MCP 的 exec", true), why("解决「不知道命令何时结束」")],
  ], {
    x: M, y: 1.7, w: CW, colW: [5.1, 2.6, 4.39],
    rowH: [0.5, 0.66, 0.66, 0.66, 0.66, 0.66],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "如果你用 PowerShell 自己维护长会话、处理 PTY、识别提示符、走 PSH 登录——本质上就是在重新实现这个 MCP。这正是它存在的理由。", fontSize: 14, bold: true }, 5.85, 1.05);
}

/* ============ S19 快速上手 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 06 · 快速上手", "快速上手：五分钟跑通最小闭环", 22);
  terminal(s, M, 1.62, 6.55, 5.3);
  s.addText([
    { text: "# 1. 安装（npm）", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "mkdir mcp-toolkit && cd mcp-toolkit", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "npm i @smai-kit/embedded-mcp-toolkit", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "./node_modules/.bin/embedded-mcp-toolkit init", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 2. 配置设备：复制 devices/board-example.yaml 填好参数", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 3. 启动 AI 客户端并连接", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "claude", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "/mcp list", options: MO({ fontSize: 12, color: "E8EDF2" }) },
    { text: "   # 看到 embedded-board ✓ connected", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 4. 自然语言对话", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "\"串口一键登录 board-test\"", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "\"在串口执行 uname -a\"", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "\"重启进入 uboot\"", options: MO({ fontSize: 12, color: "E8EDF2", breakLine: true }) },
    { text: "\"用 top 采样一下\"", options: MO({ fontSize: 12, color: "E8EDF2" }) },
  ], { x: M + 0.34, y: 2.26, w: 5.9, h: 4.4, margin: 0, valign: "top", paraSpaceAfter: 2 });

  card(s, 7.42, 1.62, 5.29, 5.3, ACCENT_LT);
  s.addText("演示建议", T({ x: 7.74, y: 1.94, w: 4.6, h: 0.42, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("现场跑一个「串口一键登录 → 发命令 → 读输出 → 常驻命令采样」的最小闭环：", T({ x: 7.74, y: 2.52, w: 4.65, h: 0.85, fontSize: 13.5, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));
  s.addText([
    { text: "① 串口一键登录", options: { breakLine: true } },
    { text: "② 在串口执行 uname -a", options: { breakLine: true } },
    { text: "③ 重启进入 uboot", options: { breakLine: true } },
    { text: "④ top 采样一次", options: {} },
  ], T({ x: 7.74, y: 3.6, w: 4.65, h: 1.9, fontSize: 14.5, color: TEXT, valign: "top", paraSpaceAfter: 12, margin: 0 }));
  s.addText("一气呵成，最有说服力。", T({ x: 7.74, y: 5.9, w: 4.65, h: 0.4, fontSize: 14, bold: true, color: PRIMARY, margin: 0 }));
}

/* ============ S20 总结与展望 ============ */
{
  const s = pres.addSlide();
  header(s, "PART 07 · 总结与展望", "总结与展望", 23);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: 1.58, w: CW, h: 1.18, fill: { color: PRIMARY }, line: { type: "none" }, rectRadius: 0.07 });
  s.addText("embedded-mcp-toolkit 用一个常驻的 MCP Server，把嵌入式调试里「有状态、跨轮、易出错」的部分全部固化——让 AI 真正「直接对话板子」", T({ x: M + 0.32, y: 1.58, w: CW - 0.64, h: 1.18, fontSize: 15.5, bold: true, color: "FFFFFF", valign: "middle", margin: 0 }));

  const hi = [
    ["01", "四通道统一抽象", "serial · ssh · adb · powershell"],
    ["02", "提示符检测+双超时", "解决「命令何时结束」"],
    ["03", "领域流程固化", "PSH 一键登录 · U-Boot · ZMODEM"],
    ["04", "两种部署形态", "本地零网络 / 跨机 SSH 隧道"],
    ["05", "工程化完备", "会话并发 · 自动清理"],
  ];
  const cw = 2.34;
  hi.forEach(([n, t, d], i) => {
    const x = M + i * (cw + 0.1);
    card(s, x, 3.02, cw, 2.5);
    s.addText(n, MO({ x: x + 0.22, y: 3.28, w: 1.5, h: 0.4, fontSize: 16, bold: true, color: ACCENT_DK, margin: 0 }));
    s.addText(t, T({ x: x + 0.22, y: 3.78, w: cw - 0.44, h: 0.75, fontSize: 14.5, bold: true, color: TEXT, valign: "top", margin: 0 }));
    s.addText(d, (i === 0 ? MO : T)({ x: x + 0.22, y: 4.55, w: cw - 0.44, h: 0.85, fontSize: 12, color: MUTED, valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));
  });
  band(s, { txt: "展望：更多通道 / 协议支持 · 更多领域流程固化 · 远程 Server 形态（Streamable HTTP）探索", fontSize: 14.5 }, 5.88, 0.9);
}

/* ============ S21 谢谢聆听 ============ */
{
  const s = pres.addSlide();
  s.background = { color: INK };
  s.addText("嵌入式开发 · MCP 协议 · AI 工具链", MO({ x: 0.95, y: 1.35, w: 8, h: 0.35, fontSize: 14, bold: true, color: "E8A93D", charSpacing: 2, margin: 0 }));
  s.addText("谢谢聆听", T({ x: 0.95, y: 2.05, w: 10, h: 1.0, fontSize: 46, bold: true, color: "FFFFFF", margin: 0 }));
  s.addText("embedded-mcp-toolkit · 让 AI 直接对话嵌入式板卡", T({ x: 0.95, y: 3.3, w: 10, h: 0.5, fontSize: 18, color: LIGHT, margin: 0 }));
  s.addText("技术分享 · 2026", T({ x: 0.95, y: 6.72, w: 5, h: 0.32, fontSize: 12.5, color: "7A8CA0", margin: 0 }));
}

pres.writeFile({ fileName: ".tmp/out_new.pptx" }).then(() => console.log("OK out_new.pptx"));
