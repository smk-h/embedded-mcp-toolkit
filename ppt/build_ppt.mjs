/* embedded-mcp-toolkit 项目介绍 PPT 重建脚本（v2 · 39 页）
 *
 * 用法（在本 ppt/ 目录下执行）：
 *   powershell -ExecutionPolicy Bypass -File build.ps1    # Windows 一键执行三步；文件被 PowerPoint 打开时会自动关闭
 *   ./linux_build.sh                                      # Linux/macOS 一键执行同样的三步
 *   npm i -D pptxgenjs                                    # 仅首次：本地安装依赖（ESM import 不走 NODE_PATH）
 *   node build_ppt.mjs                                    # 生成 .tmp/out_new.pptx（.tmp/ 为 gitignore 的构建缓存目录）
 *   python post_fix.py .tmp/out_new.pptx .tmp/out_fixed.pptx
 *                                                         # 后处理：修复 pptxgenjs 生成的 <a:pPr> 重复问题，否则 PowerPoint 打不开
 *   cp .tmp/out_fixed.pptx embedded-mcp-toolkit-项目介绍.pptx   # 覆盖成品
 *
 * 注意：
 *   - 页码动态生成：TOTAL 常量在文件末尾与实际页数断言，增删页面改 TOTAL 即可
 *   - 架构图直接引用 ../docs/项目简介/img/*.svg（矢量，随 git 仓库分发，无额外素材依赖）
 *   - 大纲与叙事主线见同目录 PPT大纲.md
 *
 * 设计系统：深海军蓝 PRIMARY + 琥珀 ACCENT（串口/控制台主题），全片白底（含封面/封底）
 * 母题：浅色终端窗口（三个窗口圆点 + 等宽字体）；禁用标题下划线/色条/边条
 *
 * 叙事主线（八部分 39 页，围绕三个问题组织）：
 *   Q1 它是什么、有什么用 —— PART 01（效果先行 → 角色定位 → 能力总览）
 *   Q2 解决了什么困境、为什么 AI 自己解决不了、为什么一定要 MCP、怎么解决
 *      —— PART 02 背景（先承认一次性命令够用，把矛盾聚焦到串口与跨轮交互）
 *      —— PART 03 困境（五个坑，逐个「现象 → 病根 → 为什么 AI 搞不定」）
 *      —— PART 04 为什么是 MCP（共同病根收敛 + 三次拷问排除替代方案 + 推演）
 *      —— PART 05 机制对账（五机制逐一对账 + 领域流程固化）
 *   Q3 怎么部署、推荐哪种 —— PART 06（总览 → 两形态 → 落地命令 → 明确推荐）
 *      —— PART 07 边界与选型（能力分界 / 场景选型 / 诚实边界）
 *      —— PART 08 上手与总结（五分钟跑通 · 三问三答）
 */
import pptxgen from "pptxgenjs";

const W = 13.33, H = 7.5, M = 0.62, CW = W - 2 * M;
const PRIMARY = "1F3A54";    // 主色：标题/表头/结构
const ACCENT = "D99414";     // 琥珀：强调
const ACCENT_DK = "9A6606";  // 琥珀（白底小字）
const ACCENT_LT = "FBF2DC";  // 琥珀浅底（结论带）
const CARD = "F1F4F8";       // 冷灰卡片
const HAIR = "D8E0E8";       // 发丝线
const TEXT = "22303E";
const MUTED = "5D6B7A";
const TERM_FG = "22303E";    // 终端块命令文字（浅底）
const DIM = "5D6B7A";        // 终端块注释灰（浅底）
const GREEN = "2E7D46", RED = "C0392B";
const SANS = "微软雅黑", MONO = "Consolas";

const TOTAL = 39;            // 全片页数（与实际 addSlide 次数断言）
let PAGE = 0;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "embedded-mcp-toolkit";
pres.title = "embedded-mcp-toolkit 项目介绍";

const T = (o) => Object.assign({ fontFace: SANS, color: TEXT }, o);
const MO = (o) => Object.assign({ fontFace: MONO }, o);
const bu = () => ({ code: "25B8", indent: 12 });

function newSlide() {
  PAGE += 1;
  const s = pres.addSlide();
  s.__page = PAGE;
  return s;
}

function header(s, part, title) {
  s.background = { color: "FFFFFF" };
  s.addText(part, T({ x: M, y: 0.4, w: 8, h: 0.32, fontSize: 12.5, bold: true, color: ACCENT_DK, fontFace: MONO, charSpacing: 2, margin: 0 }));
  s.addText(title, T({ x: M, y: 0.74, w: CW, h: 0.66, fontSize: 28, bold: true, color: PRIMARY, margin: 0 }));
  s.addText(s.__page + " / " + TOTAL, T({ x: W - 1.5, y: 7.06, w: 0.9, h: 0.3, fontSize: 12, color: MUTED, align: "right", margin: 0 }));
}

function card(s, x, y, w, h, fill) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill || CARD }, line: { type: "none" }, rectRadius: 0.07 });
}

// 浅色终端窗口：三个圆点 + 内容由调用方继续添加
function terminal(s, x, y, w, h) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: CARD }, line: { color: HAIR, width: 1 }, rectRadius: 0.09 });
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

// 白底结构框 + 居中文字（o.line=null 表示实心无边线）
function box(s, x, y, w, h, t, o) {
  o = o || {};
  const opt = { x, y, w, h, fill: { color: o.fill || "FFFFFF" }, rectRadius: 0.08 };
  opt.line = o.line === null ? { type: "none" } : { color: o.line || PRIMARY, width: 1.25 };
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, opt);
  s.addText(t, (o.mono ? MO : T)({ x, y, w, h, fontSize: o.fontSize || 14.5, bold: o.bold !== false, color: o.tc || PRIMARY, align: "center", valign: "middle", margin: 0 }));
}

function arrowR(s, x, y, len) {
  s.addShape(pres.shapes.LINE, { x, y, w: len, h: 0, line: { color: PRIMARY, width: 2, endArrowType: "triangle" } });
}

function arrowD(s, x, y, len) {
  s.addShape(pres.shapes.LINE, { x, y, w: 0, h: len, line: { color: PRIMARY, width: 2, endArrowType: "triangle" } });
}

/* ============ S1 封面 ============ */
{
  const s = newSlide();
  s.background = { color: "FFFFFF" };
  s.addText("嵌入式开发 · MCP 协议 · AI 工具链", MO({ x: 0.95, y: 1.12, w: 8, h: 0.35, fontSize: 14, bold: true, color: ACCENT_DK, charSpacing: 2, margin: 0 }));
  s.addText("embedded-mcp-toolkit", MO({ x: 0.95, y: 1.72, w: 11.4, h: 1.05, fontSize: 47, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("让 AI 直接对话嵌入式板卡", T({ x: 0.95, y: 2.95, w: 11, h: 0.62, fontSize: 29, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("一个常驻的 MCP Server：把串口 / SSH / ADB / PowerShell 四条通道\n统一成 AI 可调用的标准工具——连接、端口、会话状态全程常驻", T({ x: 0.95, y: 3.72, w: 9.2, h: 0.85, fontSize: 15, color: MUTED, margin: 0, lineSpacingMultiple: 1.25 }));

  const chips = [["serial", 1.5], ["ssh", 1.06], ["adb", 1.06], ["powershell", 2.16]];
  let cx = 0.95;
  chips.forEach(([t, w]) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: 4.92, w, h: 0.5, fill: { color: CARD }, line: { color: HAIR, width: 1 }, rectRadius: 0.08 });
    s.addText(t, MO({ x: cx, y: 4.92, w, h: 0.5, fontSize: 13, color: PRIMARY, align: "center", valign: "middle", margin: 0 }));
    cx += w + 0.27;
  });

  terminal(s, 8.62, 4.32, 4.1, 1.72);
  s.addText([
    { text: "$ /mcp list", options: MO({ fontSize: 12.5, color: DIM, breakLine: true }) },
    { text: "  embedded-board", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "  ✓ connected", options: MO({ fontSize: 12.5, bold: true, color: GREEN }) },
  ], { x: 8.92, y: 4.78, w: 3.6, h: 1.1, margin: 0, lineSpacingMultiple: 1.35 });

  s.addText("技术分享 · 2026", T({ x: 0.95, y: 6.72, w: 5, h: 0.32, fontSize: 12.5, color: MUTED, margin: 0 }));
}

/* ============ S2 目录：三问导航 ============ */
{
  const s = newSlide();
  s.background = { color: "FFFFFF" };
  s.addText("目录", T({ x: M, y: 0.6, w: 4, h: 0.7, fontSize: 32, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("读完这份材料，你应该能回答三个问题", T({ x: M, y: 1.28, w: 9, h: 0.32, fontSize: 13.5, color: MUTED, margin: 0 }));
  const items = [
    ["01", "认识它", "它是什么、有什么用——先看效果", "Q1"],
    ["02", "背景", "调试方式的演变：从人肉中转到 AI 直调", ""],
    ["03", "困境", "五个绕不开的坑：为什么 AI 自己解决不了", "Q2"],
    ["04", "为什么是 MCP", "三次拷问排除替代方案，推演出必然", "Q2"],
    ["05", "机制对账", "每个机制填平哪个困境", "Q2"],
    ["06", "部署", "两种形态、优缺点与明确推荐", "Q3"],
    ["07", "边界与选型", "能力分界 · 场景选型 · 诚实的边界", "Q3"],
    ["08", "上手与总结", "五分钟跑通 · 三问三答", ""],
  ];
  items.forEach(([n, t, sub, q], i) => {
    const col = i < 4 ? 0 : 1, row = i < 4 ? i : i - 4;
    const x = col === 0 ? 0.95 : 7.15, y = 1.86 + row * 1.3;
    s.addText(n, MO({ x, y: y + 0.02, w: 0.85, h: 0.5, fontSize: 22, bold: true, color: ACCENT_DK, margin: 0 }));
    s.addText(t, T({ x: x + 0.98, y, w: 3.8, h: 0.42, fontSize: 18.5, bold: true, color: TEXT, margin: 0 }));
    if (q) s.addText(q, MO({ x: x + 4.35, y: y + 0.04, w: 0.75, h: 0.36, fontSize: 12.5, bold: true, color: ACCENT_DK, align: "center", margin: 0 }));
    s.addText(sub, T({ x: x + 0.98, y: y + 0.46, w: 5.0, h: 0.3, fontSize: 12.5, color: MUTED, margin: 0 }));
    s.addShape(pres.shapes.LINE, { x, y: y + 0.98, w: 5.2, h: 0, line: { color: HAIR, width: 0.75 } });
  });
  s.addText("Q1 它是什么、有什么用　　Q2 解决了什么困境、为什么非要一个 MCP　　Q3 怎么部署、推荐哪种", MO({ x: M, y: 7.02, w: CW, h: 0.3, fontSize: 11.5, color: MUTED, margin: 0 }));
}

/* ============ S3 (PART 01) 先看效果：一段真实的 AI 对话 ============ */
{
  const s = newSlide();
  header(s, "PART 01 · 认识它", "先看效果：一段真实的 AI 对话");

  // 左：对话 + 工具调用链
  card(s, M, 1.62, 7.3, 4.42);
  s.addText([
    { text: "你  ", options: T({ fontSize: 13, bold: true, color: MUTED }) },
    { text: "串口登录 board-a，看看内存还剩多少", options: T({ fontSize: 13.5, color: TEXT, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 13, bold: true, color: ACCENT_DK }) },
    { text: "serial_shell_login(device=\"board-a\")", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "　　已解锁并登录，会话 serial_1 就绪", options: T({ fontSize: 12, color: MUTED, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 13, bold: true, color: ACCENT_DK }) },
    { text: "serial_exec(\"free\")", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "　　总内存 495 MB，可用约 316 MB，无 Swap", options: T({ fontSize: 13, color: TEXT, breakLine: true }) },
    { text: "你  ", options: T({ fontSize: 13, bold: true, color: MUTED }) },
    { text: "再用 top 采样 10 秒看看负载", options: T({ fontSize: 13.5, color: TEXT, breakLine: true }) },
    { text: "AI  ", options: T({ fontSize: 13, bold: true, color: ACCENT_DK }) },
    { text: "serial_exec(\"top\")", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "　　[采样超时: 已收集 10000ms 输出，已发送 Ctrl+C]", options: MO({ fontSize: 11.5, color: MUTED, breakLine: true }) },
    { text: "　　load average 0.08——无异常进程", options: T({ fontSize: 13, color: TEXT }) },
  ], { x: M + 0.34, y: 1.94, w: 6.65, h: 3.85, margin: 0, valign: "middle", paraSpaceAfter: 8 });

  // 右：这段对话里人做了什么
  card(s, 8.16, 1.62, 4.55, 4.42, ACCENT_LT);
  s.addText("这段对话里，人做了什么？", T({ x: 8.48, y: 1.94, w: 3.9, h: 0.66, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "没碰终端——串口是 AI 自己开的", options: { bullet: bu(), breakLine: true } },
    { text: "没复制粘贴——日志 AI 自己读", options: { bullet: bu(), breakLine: true } },
    { text: "没判断「命令结束没」——AI 自己识别", options: { bullet: bu(), breakLine: true } },
    { text: "没管登录流程——PSH 解锁一次调用完成", options: { bullet: bu(), breakLine: true } },
    { text: "top 永不返回？AI 自己采样 10 秒后收回提示符", options: { bullet: bu() } },
  ], T({ x: 8.48, y: 2.72, w: 3.95, h: 3.1, fontSize: 12.5, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  band(s, { txt: "这不是演示脚本——AI 调的是真实的 MCP 工具。为了撑起这段对话，背后要跨过一串坑，这就是今天的内容", fontSize: 15.5 }, 6.3, 0.72);
}

/* ============ S4 (PART 01) 它是什么 ============ */
{
  const s = newSlide();
  header(s, "PART 01 · 认识它", "它是什么：一个常驻的 MCP Server");

  card(s, M, 1.62, 5.9, 4.55);
  s.addText("角色定位", T({ x: M + 0.32, y: 1.94, w: 5.0, h: 0.42, fontSize: 17, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "角色：一个 MCP Server（独立常驻进程）", options: { bullet: bu(), breakLine: true } },
    { text: "能力：经串口 / SSH / ADB / PowerShell 四条通道管理嵌入式设备", options: { bullet: bu(), breakLine: true } },
    { text: "特性：多会话并发 · 流式输出切片 · 一键登录（PSH 动态口令）· 进程退出自动清理", options: { bullet: bu(), breakLine: true } },
    { text: "不绑定 Host：Claude Code / ZCode / OpenCode 皆可接入", options: { bullet: bu(), breakLine: true } },
    { text: "开箱即用：npm 安装后一条 init 命令生成配置骨架", options: { bullet: bu() } },
  ], T({ x: M + 0.32, y: 2.56, w: 5.26, h: 3.4, fontSize: 13.5, valign: "top", paraSpaceAfter: 14, margin: 0 }));

  // 右：纵向链路图
  const bx = 7.6, bw = 4.4;
  const nodes = [
    { y: 1.72, t: "AI 编程助手", fill: "FFFFFF", tc: PRIMARY, line: PRIMARY, mono: false },
    { y: 2.94, t: "MCP Server（常驻）", fill: PRIMARY, tc: "FFFFFF", line: null, mono: false },
    { y: 4.16, t: "serial / ssh / adb / powershell", fill: "FFFFFF", tc: PRIMARY, line: PRIMARY, mono: true },
    { y: 5.38, t: "目标板 / 设备", fill: "FFFFFF", tc: PRIMARY, line: PRIMARY, mono: false },
  ];
  nodes.forEach(n => {
    box(s, bx, n.y, bw, 0.78, n.t, { fill: n.fill, tc: n.tc, line: n.line, mono: n.mono });
  });
  [2.5, 3.72, 4.94].forEach(y => arrowD(s, bx + bw / 2, y, 0.44));
  band(s, { txt: "全片的关键词是「常驻」——连接、端口、会话状态都握在这个进程手里，后面所有困境的解都系于它", fontSize: 15 }, 6.42, 0.68);
}

/* ============ S5 (PART 01) 有什么用：能力总览 ============ */
{
  const s = newSlide();
  header(s, "PART 01 · 认识它", "有什么用：四通道 × 工具族总览");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const cat = (t) => ({ text: t, options: { fontSize: 13, bold: true, color: PRIMARY, valign: "middle" } });
  const tool = (t) => ({ text: t, options: { fontFace: MONO, fontSize: 12, color: TEXT, valign: "middle" } });
  const what = (t) => ({ text: t, options: { fontSize: 12.5, color: TEXT, valign: "middle" } });
  s.addTable([
    [{ text: "类别", options: Object.assign({}, hdr) }, { text: "代表工具", options: Object.assign({}, hdr) }, { text: "解决什么", options: Object.assign({}, hdr) }],
    [cat("串口 serial"), tool("open / close / write / read / exec /\nlogin / enter_uboot / upload / download"), what("UART、U-Boot 控制台、ZMODEM 传文件")],
    [cat("SSH"), tool("open / close / exec / login / connection\nbuild / sftp_upload / sftp_download"), what("远程 Linux 板卡、编译服务器、结构化编译")],
    [cat("ADB"), tool("device_list / exec / shell_*"), what("Android 设备调试（一次性 + 交互会话）")],
    [cat("PowerShell"), tool("exec"), what("Windows 本机操作（仅跨机远程场景注册）")],
    [cat("基础"), tool("version / device_info / session_info / host_info"), what("版本、设备配置、会话与宿主端点查询")],
    [cat("Windows 扫描"), tool("port_scan / network_scan / subnet_check"), what("COM 口、网卡 / IP、子网可达性")],
  ], {
    x: M, y: 1.7, w: CW, colW: [2.3, 5.2, 4.59],
    rowH: [0.5, 0.78, 0.72, 0.6, 0.6, 0.6, 0.6],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  s.addText([
    { text: "40+ 工具，但只有一个执行内核：", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "serial / ssh / adb 三条通道共享同一套 exec 语义（一次实现，处处可用）；power_shell_exec 与 ssh_build 按场景智能注册，工具不出现即从源头杜绝绕行", options: T({ fontSize: 12.5, color: MUTED }) },
  ], { x: M, y: 6.55, w: CW, h: 0.5, margin: 0, lineSpacingMultiple: 1.15 });
}

/* ============ S6 (PART 02) 以前：人当「中间人」 ============ */
{
  const s = newSlide();
  header(s, "PART 02 · 背景", "以前：人当「中间人」");

  terminal(s, M, 1.62, 6.2, 3.3);
  s.addText([
    { text: "$ ssh root@192.168.16.105", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "    ← 人：开终端、登录板卡", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~# free", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "       ← 人：手敲命令", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "Mem: 506864 94152 293068 …", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "   ← 人：眼挑数字", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~#", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "             ← 人：判断「发下一条」", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 2.3, w: 5.6, h: 2.4, margin: 0, paraSpaceAfter: 6 });

  card(s, 7.06, 1.62, 5.65, 3.3);
  s.addText("人肉中转的日常", T({ x: 7.38, y: 1.9, w: 5.0, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "日志靠复制粘贴中转：板子 → 终端 → 聊天框 → AI → 再敲回终端", options: { bullet: bu(), breakLine: true } },
    { text: "过滤噪声、判断结束、维持状态——全靠人脑实时顶上", options: { bullet: bu(), breakLine: true } },
    { text: "烧写、重启、看日志，全程守着终端不敢走开", options: { bullet: bu() } },
  ], T({ x: 7.38, y: 2.44, w: 5.05, h: 2.3, fontSize: 13, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  band(s, { txt: "AI 再强，够不着板子就只能隔着人转述——人是日志的搬运工", fontSize: 16 }, 5.6, 0.85);
}

/* ============ S7 (PART 02) 现在：AI 直调已够用 ============ */
{
  const s = newSlide();
  header(s, "PART 02 · 背景", "现在：AI 直调，一次性命令已够用");

  card(s, M, 1.62, 6.2, 3.3);
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
  ], { x: M + 0.34, y: 1.92, w: 5.55, h: 2.7, margin: 0, valign: "middle", paraSpaceAfter: 8 });

  card(s, 7.06, 1.62, 5.65, 3.3);
  s.addText("复制粘贴的税，消失了", T({ x: 7.38, y: 1.9, w: 5.0, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "Claude Code / ZCode / OpenCode 自带 shell，命令随口就能跑", options: { bullet: bu(), breakLine: true } },
    { text: "ssh / adb 是干净的「请求-响应」：一次调用、一次响应，输出拿来就用", options: { bullet: bu(), breakLine: true } },
    { text: "一次性命令直调完全够用——人不用再当搬运工", options: { bullet: bu() } },
  ], T({ x: 7.38, y: 2.44, w: 5.05, h: 2.3, fontSize: 13, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  band(s, { txt: "先承认这一点：读取类、一次性操作，不需要任何 MCP。但嵌入式调试绕不开的那条通道是串口——它是另一个世界", fontSize: 15 }, 5.6, 0.85);
}

/* ============ S8 (PART 02) 串口是另一个世界 ============ */
{
  const s = newSlide();
  header(s, "PART 02 · 背景", "串口是另一个世界：一条命令，变成一段脚本");
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
    { text: "$port = New-Object System.IO.Ports.SerialPort COM3,115200,None,8,one", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "$port.Open()", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "   ← 开端口（排他）", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "$port.WriteLine(\"free\")", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "    ← 写命令", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "Start-Sleep -Milliseconds 800", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "  ← 等多久？猜的", options: T({ fontSize: 11.5, bold: true, color: ACCENT_DK, breakLine: true }) },
    { text: "$port.ReadExisting()", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "       ← 读缓冲：完没完不知道", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "$port.Close()", options: MO({ fontSize: 11.5, color: TERM_FG }) },
  ], { x: 5.7, y: 2.44, w: 6.7, h: 1.9, margin: 0, valign: "top", paraSpaceAfter: 3 });

  // 下：读回来的原始输出
  terminal(s, M, 4.62, CW, 1.42);
  s.addText([
    { text: "free", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "                                ← 命令回显（噪声）", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "Mem: 506864 94152 293068 …", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "         ← 真正的数据夹在中间", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@board:~#", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "                    ← 提示符 = 唯一的「结束」线索", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 5.14, w: CW - 0.7, h: 0.85, margin: 0, paraSpaceAfter: 3 });

  band(s, { txt: "SSH 是一条命令，串口是每轮都要重写的脚本——Sleep 多少全靠猜，慢命令直接截断", fontSize: 15.5 }, 6.2, 0.75);
}

/* ============ S9 (PART 03) 困境总览 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境总览：五个绕不开的坑");
  s.addText("接下来逐个讲透：现象 → 病根 → 为什么 AI 自己解决不了", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, color: MUTED, margin: 0 }));

  const gates = [
    ["①", "串口没有「结束信号」", "信息缺失", "「是全部还是半截」——这个信息根本不在输出里，AI 再聪明也推不出来"],
    ["②", "临时进程，状态活不过一轮", "架构缺失", "Host 的 shell 每轮用完即弃，跨轮状态、交互对话、中间态观测无处安放"],
    ["③", "常驻命令不知何时结束", "信息缺失", "ping / logcat / top 永不返回提示符——等多久算「采够了」全凭猜"],
    ["④", "多设备管理的四道关", "工程缺失", "参数、姿势、占用、并发——没有任何机制替 AI 兜底"],
    ["⑤", "AI 与设备分居两台机器", "物理缺失", "AI 在 Linux 编译服务器，串口线插在 Windows 工位机——物理上没有那条线缆"],
  ];
  gates.forEach(([no, t, tag, b], i) => {
    const col = i < 3 ? i : i - 3, row = i < 3 ? 0 : 1;
    const x = M + col * (3.87 + 0.24), y = 2.02 + row * 2.14;
    card(s, x, y, 3.87, 1.92);
    s.addText([
      { text: no + "  ", options: MO({ fontSize: 15, bold: true, color: ACCENT_DK }) },
      { text: t, options: T({ fontSize: 14.5, bold: true, color: PRIMARY }) },
    ], { x: x + 0.26, y: y + 0.18, w: 3.35, h: 0.4, margin: 0 });
    s.addText("病根：" + tag, MO({ x: x + 0.26, y: y + 0.6, w: 3.35, h: 0.3, fontSize: 11.5, bold: true, color: RED, margin: 0 }));
    s.addText(b, T({ x: x + 0.26, y: y + 0.94, w: 3.38, h: 0.9, fontSize: 11.5, color: TEXT, valign: "top", margin: 0, lineSpacingMultiple: 1.12 }));
  });

  band(s, { txt: "①③是信息问题，②是架构问题，④是工程问题，⑤是物理问题——五者里只有「协议难写」不存在：都不是靠 AI 更聪明能解决的", fontSize: 13.5 }, 6.16, 0.78);
}

/* ============ S10 (PART 03) 困境①：串口没有「结束信号」 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境①：串口没有「结束信号」");
  s.addText([
    { text: "U-Boot 引导、内核启动、无 SSH 的早期设备都只认串口——而它是一段", options: T({ fontSize: 13.5 }) },
    { text: "裸字节流", options: T({ fontSize: 13.5, bold: true, color: ACCENT_DK }) },
    { text: "：无消息边界、无校验确认、无流控、无多路复用", options: T({ fontSize: 13.5 }) },
  ], { x: M, y: 1.5, w: CW, h: 0.36, margin: 0 });

  // 左：读到半截
  terminal(s, M, 1.98, 6.0, 2.62);
  s.addText([
    { text: "$port.WriteLine(\"ls -R /\")", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "Start-Sleep -Milliseconds 800; $port.ReadExisting()", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "ls -R /", options: MO({ fontSize: 12, color: TERM_FG }) },
    { text: "          ← 回显", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "bin/  dev/  driver/  etc/  keys/ …", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "（输出到这里戛然而止）", options: T({ fontSize: 11.5, bold: true, color: ACCENT_DK }) },
    { text: "← 是读全了？还是 800ms 不够只读到半截？", options: T({ fontSize: 11.5, color: DIM }) },
  ], { x: M + 0.34, y: 2.42, w: 5.4, h: 2.0, margin: 0, valign: "top", paraSpaceAfter: 4 });

  // 右：病根分析
  card(s, 6.85, 1.98, 5.86, 2.62);
  s.addText("为什么 AI 也无能为力", T({ x: 7.15, y: 2.24, w: 5.2, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "ReadExisting() 只是把缓冲里当前的字节倒出来，不告诉你「完没完」", options: { bullet: bu(), breakLine: true } },
    { text: "短命令读全了，慢命令就是截断的半截——而文本本身毫无破绽", options: { bullet: bu(), breakLine: true } },
    { text: "唯一的结束线索是提示符回来——识别它要持续轮询 + 模式匹配，写成一个状态机", options: { bullet: bu(), breakLine: true } },
    { text: "回显、ANSI 颜色码先占 token，脑内过滤的结果还带随机性", options: { bullet: bu() } },
  ], T({ x: 7.15, y: 2.74, w: 5.3, h: 1.75, fontSize: 12.5, valign: "top", paraSpaceAfter: 9, margin: 0 }));

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: 4.82, w: CW, h: 0.95, fill: { type: "none" }, line: { color: ACCENT, width: 1 }, rectRadius: 0.06 });
  s.addText([
    { text: "关键点   ", options: MO({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
    { text: "「是全部还是半截」这个信息根本不在输出里——不是 AI 不够聪明，是信息缺失：再聪明的模型也无法从「没有」中推出来", options: T({ fontSize: 13.5, bold: true }) },
  ], { x: M + 0.3, y: 4.82, w: CW - 0.6, h: 0.95, valign: "middle", margin: 0 });

  band(s, { txt: "SSH 的「一次调用、一次响应」在串口上根本不存在——结束判定必须有人实现", fontSize: 15.5 }, 6.05, 0.8);
}

/* ============ S11 (PART 03) 困境①续：瞬时输出 + 哨兵也不行 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境①（续）：输出只在瞬间存在，「加个哨兵」也不行");

  // 左：时序问题
  card(s, M, 1.62, 5.9, 4.0);
  s.addText("时序问题：必须当时握着端口", T({ x: M + 0.3, y: 1.9, w: 5.3, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "内核启动日志、U-Boot 自举信息只在 boot 那一刻刷一次——必须在事件发生时已经持有端口才能看到", options: { bullet: bu(), breakLine: true } },
    { text: "事后开端口补读：缓冲里什么都没有", options: { bullet: bu(), breakLine: true } },
    { text: "更麻烦的是：不少板子的 USB 转串口在端口打开 / 关闭时 DTR 电平跳变，会直接复位设备", options: { bullet: bu(), breakLine: true } },
    { text: "——「每次用的时候临时开一下端口」这个策略本身就不安全", options: { bullet: bu() } },
  ], T({ x: M + 0.3, y: 2.44, w: 5.3, h: 3.0, fontSize: 13, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  // 右：哨兵方案逐行打叉
  terminal(s, 6.76, 1.62, 5.95, 4.0);
  s.addText([
    { text: "# 「每条命令尾巴拼个哨兵不就行了？」", options: T({ fontSize: 12, bold: true, color: ACCENT_DK, breakLine: true }) },
    { text: "WriteLine(cmd + \"; echo __DONE__$?\")", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "   ← ① 拼哨兵", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "循环读，直到看见 __DONE__", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "        ← ② 命令回显里也有一份，得滤掉", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "剥掉输出里的 __DONE__ 行", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: "        ← ③ 不能污染结果", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "万一命令自己也打印 __DONE__ 呢？", options: MO({ fontSize: 11.5, color: TERM_FG }) },
    { text: " ← ④ 边界情况还得处理", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "……每轮还要重新猜超时、重新写一遍", options: T({ fontSize: 11.5, bold: true, color: ACCENT_DK }) },
  ], { x: 7.1, y: 2.1, w: 5.3, h: 3.3, margin: 0, valign: "top", paraSpaceAfter: 5 });

  band(s, { txt: "这套逻辑写下来，就已经走在实现这个 MCP「终端模拟器」的路上了——直调能做到，但做着做着就成了重新造它", fontSize: 14.5 }, 5.92, 0.95);
}

/* ============ S12 (PART 03) 困境②：临时进程，状态活不过一轮 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境②：临时进程，状态活不过一轮");
  terminal(s, M, 1.56, 6.15, 2.95);
  s.addText([
    { text: "ssh root@board \"cd /tmp\"", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "    → 这次进了 /tmp", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "ssh root@board \"ls\"", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "    → 又回到 ~，/tmp 白进了", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "ssh root@board \"export FOO=1\"", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "    → 环境变量也丢了", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 2.2, w: 5.5, h: 2.1, margin: 0, paraSpaceAfter: 5 });

  card(s, 7.0, 1.56, 5.71, 2.95);
  s.addText("病根", T({ x: 7.32, y: 1.82, w: 5.0, h: 0.4, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "Host 每轮让 AI 跑的 shell 都是临时进程，用完即弃", options: { bullet: bu(), breakLine: true } },
    { text: "而调试的节奏是「观察 → 决策 → 再观察」——每一次「看」都是新进程、新连接", options: { bullet: bu(), breakLine: true } },
    { text: "cd /work/build && source env-setup.sh 这类环境前缀每轮原样重发，漏一个 source 错得还很隐蔽", options: { bullet: bu() } },
  ], T({ x: 7.32, y: 2.34, w: 5.05, h: 2.0, fontSize: 12.5, valign: "top", paraSpaceAfter: 9, margin: 0 }));

  card(s, M, 4.72, CW, 1.28, ACCENT_LT);
  s.addText("单轮链式够用吗？", T({ x: M + 0.32, y: 4.72, w: 2.7, h: 1.28, fontSize: 15.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
  s.addText("发起前就能确定整个操作序列时，ssh board \"cd /tmp && ls\" 完全够用——但调试不是「一次想清楚」，是看输出、决定下一步、再看、再决定的循环，跨轮状态无处可存", T({ x: M + 3.2, y: 4.72, w: CW - 3.55, h: 1.28, fontSize: 13, valign: "middle", margin: 0, lineSpacingMultiple: 1.2 }));
  band(s, { txt: "每一次「看」都是新进程——而调试需要的是一个「持续在线的读者」", fontSize: 15.5 }, 6.22, 0.75);
}

/* ============ S13 (PART 03) 困境②续：交互式程序是「对话」 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境②（续）：交互式程序是「对话」，不是「命令序列」");

  const hw = CW / 2 - 0.12;
  // 左：命令序列
  card(s, M, 1.62, hw, 2.5);
  s.addText("命令序列：一次性命令的世界", T({ x: M + 0.3, y: 1.9, w: hw - 0.6, h: 0.38, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "ssh host \"cmd1 && cmd2\"", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "发起前就能确定整个序列——直调够用", options: T({ fontSize: 12.5, color: MUTED }) },
  ], { x: M + 0.3, y: 2.42, w: hw - 0.6, h: 1.5, margin: 0, valign: "top", paraSpaceAfter: 10 });

  // 右：对话
  card(s, M + hw + 0.24, 1.62, hw, 2.5, ACCENT_LT);
  s.addText("对话：嵌入式调试的世界", T({ x: M + hw + 0.54, y: 1.9, w: hw - 0.6, h: 0.38, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "U-Boot · menuconfig · gdb · 烧写确认提示", options: T({ fontSize: 12.5, bold: true, color: TEXT, breakLine: true }) },
    { text: "发一句、看响应、再发下一句——下一步取决于上一步的输出", options: T({ fontSize: 12.5, color: MUTED, breakLine: true }) },
    { text: "ssh host \"cmd\" 连 PTY 都没有，无法往返", options: T({ fontSize: 12.5, color: MUTED }) },
  ], { x: M + hw + 0.54, y: 2.42, w: hw - 0.6, h: 1.5, margin: 0, valign: "top", paraSpaceAfter: 10 });

  // 下：长耗时观测
  card(s, M, 4.34, CW, 1.5);
  s.addText("长耗时操作的中间态观测", T({ x: M + 0.3, y: 4.58, w: 3.4, h: 1.0, fontSize: 15.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
  s.addText("reboot 之后盯启动日志、烧写固件时看进度——「发起」与「观测」之间隔着不确定的等待，无法写成一条链式命令，必须有一个持续在线的读者一直握着通道", T({ x: M + 3.9, y: 4.58, w: CW - 4.25, h: 1.0, fontSize: 13, valign: "middle", margin: 0, lineSpacingMultiple: 1.2 }));

  band(s, { txt: "病根与上一页同一个：每轮的命令都跑在临时进程里——交互与观测都要求进程「活着」", fontSize: 15 }, 6.1, 0.85);
}

/* ============ S14 (PART 03) 困境③：常驻命令不知何时结束 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境③：常驻命令不知何时结束");

  terminal(s, M, 1.62, CW, 3.15);
  s.addText([
    { text: "$ ping 192.168.16.1", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "64 bytes from 192.168.16.1: icmp_seq=1 ttl=64 time=0.42 ms", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "64 bytes from 192.168.16.1: icmp_seq=2 ttl=64 time=0.38 ms", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "64 bytes from 192.168.16.1: icmp_seq=3 ttl=64 time=0.45 ms", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "…", options: MO({ fontSize: 12.5, color: TERM_FG, breakLine: true }) },
    { text: "（永不返回提示符——等多久算「采够了」？）", options: T({ fontSize: 12, bold: true, color: ACCENT_DK }) },
  ], { x: M + 0.34, y: 2.16, w: CW - 0.7, h: 2.4, margin: 0, valign: "top", paraSpaceAfter: 5 });

  const qs = [
    ["等多久算采够了？", "猜短了采样不足，结论不可靠"],
    ["读到的是完整快照吗？", "logcat / top 的输出没有「结束」标记"],
    ["猜错了代价是什么？", "猜长了浪费一整轮对话，还污染后续会话"],
  ];
  const cw = 3.87;
  qs.forEach(([t, b], i) => {
    const x = M + i * (cw + 0.24);
    card(s, x, 4.95, cw, 1.1);
    s.addText(t, T({ x: x + 0.24, y: 5.1, w: cw - 0.48, h: 0.34, fontSize: 13.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(b, T({ x: x + 0.24, y: 5.48, w: cw - 0.48, h: 0.5, fontSize: 12, color: MUTED, valign: "top", margin: 0 }));
  });

  band(s, { txt: "「盯一段 logcat」「采样一次 top」恰恰是调试高频需求——而「何时结束」与困境①同源：这个信息不在输出里", fontSize: 14.5 }, 6.25, 0.72);
}

/* ============ S15 (PART 03) 困境④：多设备管理，「写个 skill」够吗 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境④：多设备管理，「写个 skill」够吗？");
  s.addText("真用起来磨人的是设备——四道关摆在 AI 直调面前：", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  const hw = CW / 2 - 0.12;
  // 左：多设备的四道关
  card(s, M, 1.98, hw, 3.62);
  s.addText("多设备的四道关", T({ x: M + 0.3, y: 2.24, w: hw - 0.6, h: 0.38, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  const gatesL = [
    "参数关：哪块板在哪个口、波特率多少、IP 是什么——每次都得用户交代，靠 AI 记忆不靠谱",
    "姿势关：SSH/ADB 拼命令即可；serial 裸字节流要判结束",
    "占用关：串口排他——上轮没关干净本轮打不开，还可能 DTR 复位",
    "并发关：盯 A 板同时操作 B 板——多条会话的开关与清场没人兜底",
  ];
  s.addText(gatesL.map((r, j) => ({ text: r, options: { bullet: bu(), breakLine: j < gatesL.length - 1 } })), T({ x: M + 0.3, y: 2.74, w: hw - 0.6, h: 1.4, fontSize: 12.5, valign: "top", paraSpaceAfter: 8, margin: 0 }));
  terminal(s, M + 0.3, 4.15, hw - 0.6, 1.32);
  s.addText([
    { text: "# skill · devices.md", options: MO({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "- COM3 → A 板 / 115200", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "- board-b → 192.168.16.105", options: MO({ fontSize: 11.5, color: TERM_FG }) },
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

/* ============ S16 (PART 03) 困境⑤：AI 在编译服务器，串口线在工位机 ============ */
{
  const s = newSlide();
  header(s, "PART 03 · 困境", "困境⑤：AI 在编译服务器，串口线在工位机");
  s.addText([
    { text: "Claude Code / OpenCode / ZCode 为了直接摸到代码，通常就跑在 Linux 编译服务器上——", options: T({ fontSize: 13.5 }) },
    { text: "两条路，各难一半：", options: T({ fontSize: 13.5, bold: true, color: ACCENT_DK }) },
  ], { x: M, y: 1.5, w: CW, h: 0.36, margin: 0 });

  const opts = [
    ["方案 A · AI 搬到 Windows", "代码从编译服务器挂载过来", [
      ["✓", "代码经 Z:\\ 网络挂载读写——能用", GREEN],
      ["✓", "串口、USB-ADB 就在手边，AI 够得着", GREEN],
      ["✗", "编译仍在服务器：每次 make 都要远程绕一圈", RED],
      ["✗", "网络挂载 I/O 慢，大仓库尤其难受", RED],
    ], "编辑别扭、编译绕圈，两头不讨好"],
    ["方案 B · AI 跑在编译服务器", "团队的主流形态", [
      ["✓", "代码就在本地：编辑 → 编译 → 测试一气呵成", GREEN],
      ["✓", "工具链、依赖、产物都在手边，最顺畅", GREEN],
      ["✗", "串口线、USB-ADB 只插在 Windows 工位机", RED],
      ["✗", "Linux 侧没有任何路径碰到 COM 口 / USB", RED],
    ], "编译顺畅了，但物理上够不着串口和 USB"],
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

/* ============ S17 (PART 04) 共同病根与解决思路 ============ */
{
  const s = newSlide();
  header(s, "PART 04 · 为什么是 MCP", "解决思路：一个常驻的会话守护进程");
  const boxes = [
    { x: 0.62, w: 2.5, t: "AI 编程助手", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: false },
    { x: 3.97, w: 3.05, t: "MCP Server（常驻）", fill: PRIMARY, line: null, tc: "FFFFFF", mono: false },
    { x: 7.87, w: 2.6, t: "ssh / serial / adb", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: true },
    { x: 11.32, w: 1.39, t: "目标板", fill: "FFFFFF", line: PRIMARY, tc: PRIMARY, mono: false },
  ];
  boxes.forEach(b => {
    box(s, b.x, 1.6, b.w, 0.88, b.t, { fill: b.fill, line: b.line, tc: b.tc, mono: b.mono });
  });
  [3.12, 7.02, 10.47].forEach(x => arrowR(s, x, 2.04, 0.85));
  s.addText([
    { text: "一个长期活着的进程：连接、端口、会话状态都握在它手里", options: T({ fontSize: 13.5 }) },
    { text: "——观察-决策循环直接在既有上下文里跑", options: T({ fontSize: 13.5, color: MUTED }) },
  ], { x: M, y: 2.62, w: CW, h: 0.34, margin: 0 });

  const gains = [
    ["端口常驻持有", "boot 日志、异步打印随时可读；端口不反复开关，避开 DTR 复位风险"],
    ["会话跨轮保持", "登录态、工作目录、环境变量跨几十轮调用保持不变，不再每轮重建环境前缀"],
    ["机制只写一次", "判结束、滤噪声、采样熔断固化在进程里——不再每轮重写脚本、重猜超时"],
  ];
  const cw = 3.87;
  gains.forEach(([t, b], i) => {
    const x = M + i * (cw + 0.24);
    card(s, x, 3.18, cw, 2.35);
    s.addText(t, T({ x: x + 0.26, y: 3.42, w: cw - 0.52, h: 0.34, fontSize: 14.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(b, T({ x: x + 0.26, y: 3.86, w: cw - 0.52, h: 1.55, fontSize: 12.5, valign: "top", margin: 0, lineSpacingMultiple: 1.18 }));
  });

  band(s, { txt: "五个困境指向同一个结构性事实：Host 跑的 shell 是每轮一个的临时进程——它活不过一轮。解法：把「连设备」从临时进程里挪出来，交给常驻守护进程", fontSize: 14.5 }, 5.85, 0.9);
}

/* ============ S18 (PART 04) 拷问①：写进 skill 行不行 ============ */
{
  const s = newSlide();
  header(s, "PART 04 · 为什么是 MCP", "拷问①：把串口脚本写进 skill / CLAUDE.md 行不行？");
  s.addText("skill 是持久知识，每轮自动加载——听起来正好补上「AI 记不住」的洞。拿困境④的四道关逐个检验：", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  const hw = CW / 2 - 0.12;
  // 左：能过的一关
  card(s, M, 1.98, hw, 3.62);
  s.addText([
    { text: "✓ ", options: T({ fontSize: 16, bold: true, color: GREEN }) },
    { text: "参数关：过得去", options: T({ fontSize: 16, bold: true, color: PRIMARY }) },
  ], { x: M + 0.3, y: 2.24, w: hw - 0.6, h: 0.38, margin: 0 });
  s.addText("设备清单写进文档，AI 每次加载就知道连谁、用什么参数——这一关靠「知识」就能解决", T({ x: M + 0.3, y: 2.72, w: hw - 0.6, h: 0.72, fontSize: 12.5, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));
  terminal(s, M + 0.3, 3.55, hw - 0.6, 1.75);
  s.addText([
    { text: "# skill · devices.md", options: MO({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "- COM3 → A 板 / 115200", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "- board-b → 192.168.16.105", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "- 串口命令结尾拼 __DONE__ 判结束", options: MO({ fontSize: 11.5, color: TERM_FG }) },
  ], { x: M + 0.6, y: 3.99, w: hw - 1.2, h: 1.15, margin: 0, paraSpaceAfter: 3 });

  // 右：过不了的三关
  const rx = M + hw + 0.24;
  card(s, rx, 1.98, hw, 3.62);
  s.addText([
    { text: "✗ ", options: T({ fontSize: 16, bold: true, color: RED }) },
    { text: "姿势 / 占用 / 并发三关：全过不去", options: T({ fontSize: 16, bold: true, color: PRIMARY }) },
  ], { x: rx + 0.3, y: 2.24, w: hw - 0.6, h: 0.38, margin: 0 });
  s.addText([
    { text: "姿势关 ✗ ", options: T({ fontSize: 12.5, bold: true, color: RED }) },
    { text: "状态机每轮现写，困境①原样重演——文档教得了「怎么连」，教不会「替你盯着读」", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "占用关 ✗ ", options: T({ fontSize: 12.5, bold: true, color: RED }) },
    { text: "持有端口必须是活着的进程，写在纸上的东西做不到", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "并发关 ✗ ", options: T({ fontSize: 12.5, bold: true, color: RED }) },
    { text: "仲裁冲突、异常清场，都得是常驻者", options: T({ fontSize: 12.5, color: TEXT }) },
  ], { x: rx + 0.3, y: 2.74, w: hw - 0.6, h: 2.6, margin: 0, valign: "top", paraSpaceAfter: 12 });

  band(s, { txt: "知识 ≠ 能力：skill 能把「操作步骤」写清楚，但「持续在线」这件事，任何文本形态的知识都做不到——能力需要一个进程", fontSize: 14.5 }, 5.78, 0.95);
}

/* ============ S19 (PART 04) 拷问②：AI 自己养后台进程行不行 ============ */
{
  const s = newSlide();
  header(s, "PART 04 · 为什么是 MCP", "拷问②：AI 自己 spawn 个后台进程握着串口，行不行？");
  s.addText("理论上可行——让 AI 起一个后台进程持有端口，下一轮再跟它通信。但这一步迈出去，五个新问题立刻出现：", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  terminal(s, M, 1.98, 4.6, 3.62);
  s.addText([
    { text: "# 让 AI 自己养一个常驻进程？", options: T({ fontSize: 12, bold: true, color: ACCENT_DK, breakLine: true }) },
    { text: "Start-Process node hold-serial.js", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "  ← 进程起来了", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "…然后呢？", options: T({ fontSize: 12.5, bold: true, color: ACCENT_DK }) },
  ], { x: M + 0.34, y: 2.5, w: 4.0, h: 2.6, margin: 0, valign: "top", paraSpaceAfter: 6 });

  card(s, 5.46, 1.98, 7.25, 3.62);
  const qs2 = [
    ["①", "跟它怎么通信？", "得自定义一套 stdin/stdout 协议——发命令、判结束、回结果"],
    ["②", "谁保证它活着？", "Host 的 shell 每轮回收，后台进程的生命周期与异常恢复全要自己管"],
    ["③", "它崩了谁清场？", "串口排他，残留句柄 = 下一次打不开，还得有人负责释放"],
    ["④", "两块板同时操作怎么仲裁？", "多设备并发、会话开关与清场，需要统一的调度者"],
    ["⑤", "AI 下一轮还记得它吗？", "会话要有名字、可查询、可管理——又是一套元数据设计"],
  ];
  s.addText(qs2.map(([n, q, a], j) => ([
    { text: n + " " + q + "  ", options: T({ fontSize: 13, bold: true, color: PRIMARY }) },
    { text: a, options: T({ fontSize: 12.5, color: TEXT, breakLine: j < qs2.length - 1 }) },
  ])).flat(), { x: 5.78, y: 2.26, w: 6.7, h: 3.1, margin: 0, valign: "top", paraSpaceAfter: 10 });

  band(s, {
    runs: [
      { text: "把这五个问题做成通用、可配置、跨设备的答案——你已经在重新实现这个 MCP Server。", options: T({ fontSize: 14.5, bold: true, color: PRIMARY, breakLine: true }) },
      { text: "而最后一公里「让任何 AI Host 都能标准地发现并调用它」，恰好就是 MCP 协议本身", options: T({ fontSize: 14.5, bold: true, color: ACCENT_DK }) },
    ]
  }, 5.86, 0.95);
}

/* ============ S20 (PART 04) 拷问③：现成工具行不行 ============ */
{
  const s = newSlide();
  header(s, "PART 04 · 为什么是 MCP", "拷问③：expect / ssh -t / tmux，现成工具行不行？");
  s.addText("还有一批「老牌方案」，逐个检验——注意它们每一个都需要回答同一个问题：谁来常驻？", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  const rows = [
    ["expect / pexpect", "自动化交互的老牌方案。但 expect 脚本自己也要一个宿主进程跑着；在串口上它面对的仍是同一条无结束信号的字节流——提示符匹配、超时、清场一个不少"],
    ["ssh -t / ssh -tt", "给单条命令挂上 PTY。但仍是每轮一个新进程：跨轮状态照旧丢失，U-Boot / menuconfig 的全程对话依然无法往返"],
    ["tmux / nohup 后台会话", "会话确实能活。但 AI 每轮要 attach/detach、解析终端转义序列、判结束、管端口占用——又回到了「重新实现」的起点"],
  ];
  rows.forEach(([tool, verdict], i) => {
    const y = 2.02 + i * 1.32;
    card(s, M, y, CW, 1.14);
    s.addText(tool, MO({ x: M + 0.3, y, w: 2.6, h: 1.14, fontSize: 14.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
    s.addShape(pres.shapes.LINE, { x: M + 3.05, y: y + 0.2, w: 0, h: 0.74, line: { color: HAIR, width: 0.75 } });
    s.addText(verdict, T({ x: M + 3.35, y, w: CW - 3.7, h: 1.14, fontSize: 12.5, valign: "middle", margin: 0, lineSpacingMultiple: 1.15 }));
  });

  band(s, { txt: "三条路殊途同归：都需要一个「常驻的、握着通道的、说标准话的」进程——差别只在自己造，还是用标准", fontSize: 15.5 }, 6.1, 0.85);
}

/* ============ S21 (PART 04) 所以：这个常驻进程就是 MCP Server ============ */
{
  const s = newSlide();
  header(s, "PART 04 · 为什么是 MCP", "所以：这个常驻守护进程，就是 MCP Server");

  // 顶部：三步推演链
  const chainY = 1.56, chainH = 0.92;
  box(s, M, chainY, 3.6, chainH, "困境收敛：\n需要一个常驻的会话守护进程", { fontSize: 12.5 });
  arrowR(s, M + 3.6, chainY + chainH / 2, 0.38);
  box(s, M + 3.98, chainY, 3.9, chainH, "进程要被 AI 调用：\n需要标准化的发现 / 描述 / 调用协议", { fontSize: 12.5 });
  arrowR(s, M + 7.88, chainY + chainH / 2, 0.38);
  box(s, M + 8.26, chainY, 3.83, chainH, "自己定义协议 = 每换 Host 适配一遍\n→ 用现成的开放标准：MCP", { fill: ACCENT_LT, fontSize: 12.5 });

  // 左下：MCP 架构图
  const h = 3.4, w = h * (684 / 409);
  s.addImage({ path: "../docs/项目简介/img/mcp-architecture.svg", x: M, y: 2.86, w, h });
  s.addText("Host 内每个 Server 对应一个 Client（1:1）", T({ x: M, y: 6.32, w, h: 0.3, fontSize: 11.5, color: MUTED, align: "center", margin: 0 }));

  // 右下：MCP 是什么
  card(s, 6.7, 2.86, 6.01, 3.4, ACCENT_LT);
  s.addText("MCP（Model Context Protocol）＝ AI 界的 USB 协议", T({ x: 7.0, y: 3.1, w: 5.4, h: 0.44, fontSize: 16.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "开放标准：规范 AI 应用与外部数据源、工具之间的连接方式", options: { bullet: bu(), breakLine: true } },
    { text: "统一调用：tools/list 发现、tools/call 调用，LLM 以标准方式使用外部能力", options: { bullet: bu(), breakLine: true } },
    { text: "即插即用：只要遵循 MCP，任何支持 MCP 的 Host（Claude Code / ZCode / OpenCode）都能接入，Server 不感知 Host", options: { bullet: bu(), breakLine: true } },
    { text: "一次 tools/call：读 .mcp.json → spawn Server → initialize 握手 → tools/list → LLM 决策 → tools/call → 结果回灌 LLM", options: { bullet: bu() } },
  ], T({ x: 7.0, y: 3.66, w: 5.45, h: 2.4, fontSize: 12.5, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  s.addText("MCP 不是魔法——它只是让「常驻进程」这个唯一解，变成了即插即用的标准件。官网：modelcontextprotocol.io", T({ x: M, y: 6.68, w: CW, h: 0.32, fontSize: 12.5, bold: true, color: ACCENT_DK, margin: 0 }));
}

/* ============ S22 (PART 05) 困境 → 解法对账总表 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "困境 → 解法：一张表对账");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13, valign: "middle" };
  const c = (t, o) => ({ text: t, options: Object.assign({ fontSize: 12.5, valign: "middle", color: TEXT }, o) });
  s.addTable([
    [c("困境", hdr), c("常驻守护进程的解法", hdr)],
    [c("① 串口：无结束信号、输出只在瞬间存在", { bold: true }), { text: [{ text: "终端模拟器：滤回显、剥 ANSI、三级结束判定；端口常驻持有，boot 日志随时可读", options: T({ fontSize: 12.5 }) }] }],
    [c("② 临时进程：状态活不过一轮、交互式无法往返", { bold: true }), { text: [{ text: "会话常驻 + write / read / send_ctrl 原语：跨轮保持上下文，「发一句、看一句」", options: T({ fontSize: 12.5 }) }] }],
    [c("③ 常驻命令：logcat / top 不知何时结束", { bold: true }), { text: [{ text: "常驻命令识别 + 双超时：短超时采样到点自动 Ctrl+C，返回中性采样结果", options: T({ fontSize: 12.5 }) }] }],
    [c("④ 多设备四道关：参数、姿势、占用、并发", { bold: true }), { text: [{ text: "devices/*.yaml 声明设备，AI 按名切换；Server 常驻托管端口与会话、仲裁与清场", options: T({ fontSize: 12.5 }) }] }],
    [c("⑤ AI 在 Linux、设备插在 Windows", { bold: true }), { text: [{ text: "Server 守在设备旁握着物理通道，Linux 侧经 SSH 隧道把 stdio 延长过来", options: T({ fontSize: 12.5 }) }] }],
  ], {
    x: M, y: 1.7, w: CW, colW: [4.1, 7.99], rowH: [0.42, 0.72, 0.72, 0.72, 0.72, 0.72],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "这个「常驻的会话守护进程」以 MCP Server 的形态落地——就是本项目 embedded-mcp-toolkit。下面逐机制对账", fontSize: 15 }, 6.15, 0.75);
}

/* ============ S23 (PART 05) 填平①：终端模拟器 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "填平困境①：终端模拟器，把字节流切成干净输出");

  // 左：原始字节流
  s.addText("串口直调读到的", T({ x: M, y: 1.52, w: 5.9, h: 0.34, fontSize: 14, bold: true, color: MUTED, margin: 0 }));
  terminal(s, M, 1.94, 5.9, 2.7);
  s.addText([
    { text: "free", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "                                ← 命令回显", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "[0mMem:  506864  94152  293068 …[0m", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: " ← ANSI 颜色码", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "root@ATK-IMX6U:~#", options: MO({ fontSize: 12.5, color: TERM_FG }) },
    { text: "                    ← 提示符混在数据里", options: T({ fontSize: 12, color: DIM }) },
  ], { x: M + 0.34, y: 2.5, w: 5.3, h: 1.9, margin: 0, paraSpaceAfter: 5 });

  // 右：exec 返回
  s.addText("serial_exec(\"free\") 返回的", T({ x: 6.85, y: 1.52, w: 5.9, h: 0.34, fontSize: 14, bold: true, color: ACCENT_DK, margin: 0 }));
  card(s, 6.85, 1.94, 5.86, 2.7, ACCENT_LT);
  s.addText([
    { text: "Mem:  506864  94152  293068 …", options: MO({ fontSize: 13, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "Swap:       0       0       0", options: MO({ fontSize: 13, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "[exit code: 0]", options: MO({ fontSize: 12, color: MUTED }) },
  ], { x: 7.17, y: 2.24, w: 5.25, h: 1.1, margin: 0, paraSpaceAfter: 6 });
  s.addText("干净的一次性输出：无回显、无 ANSI、无提示符——直接进 AI 上下文", T({ x: 7.17, y: 3.62, w: 5.25, h: 0.85, fontSize: 12.5, color: TEXT, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));

  s.addText([
    { text: "前置冲刷清缓冲 → 发命令（尾部注入完成 marker，随机后缀防误判）→ 200ms 轮询读", options: { bullet: bu(), breakLine: true } },
    { text: "三级结束判定：marker 命中（确定性，附退出码）→ 提示符末尾锚定（快路径）→ 超时熔断（兜底）", options: { bullet: bu(), breakLine: true } },
    { text: "端口由常驻进程持有：boot 日志随时可读，不反复开关端口，避开 DTR 复位", options: { bullet: bu() } },
  ], T({ x: M + 0.05, y: 4.92, w: CW, h: 1.2, fontSize: 13, valign: "top", paraSpaceAfter: 8, margin: 0 }));

  band(s, { txt: "状态机写一次，一劳永逸——AI 只管调 serial_exec(\"free\")", fontSize: 16 }, 6.3, 0.68);
}

/* ============ S24 (PART 05) 填平③：双超时策略 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "填平困境③：常驻命令识别 + 双超时策略");
  card(s, M, 1.62, 5.75, 2.72);
  s.addText("机制（*_shell_exec 三通道共享）", T({ x: M + 0.3, y: 1.9, w: 5.1, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "常驻识别：按首 token 查白名单——A 类 ping / logcat / top / htop / watch / strace / tcpdump；B 类带 follow 参数（dmesg -w / journalctl -f / tail -f）；可配置扩展", options: { bullet: bu(), breakLine: true } },
    { text: "结束判定：检测到 shell 提示符（$ / # / > / =>，promptPattern 可覆盖）→ 立即返回", options: { bullet: bu() } },
  ], T({ x: M + 0.3, y: 2.42, w: 5.15, h: 1.8, fontSize: 12.5, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  card(s, 6.6, 1.62, 6.11, 2.72);
  s.addText("双超时策略", T({ x: 6.9, y: 1.9, w: 5.4, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "普通命令　", options: T({ fontSize: 13.5, bold: true, color: TEXT }) },
    { text: "5 分钟兜底 · 不发 Ctrl+C · 异常安全阀", options: T({ fontSize: 13.5, color: MUTED, breakLine: true }) },
    { text: "常驻命令　", options: T({ fontSize: 13.5, bold: true, color: TEXT }) },
    { text: "10 秒采样 · 自动发 Ctrl+C · 中性采样结果", options: T({ fontSize: 13.5, color: MUTED, breakLine: true }) },
    { text: "timeoutKind 三态：none 完成 / sampling 采样 / fallback 兜底——AI 不再误判「命令失败了」", options: T({ fontSize: 12.5, color: TEXT }) },
  ], { x: 6.9, y: 2.44, w: 5.55, h: 1.8, margin: 0, valign: "top", paraSpaceAfter: 10 });

  terminal(s, M, 4.72, CW, 0.95);
  s.addText([
    { text: "输出末尾追加 ", options: T({ fontSize: 13.5, color: TERM_FG }) },
    { text: "[采样超时: ...] / [兜底超时: ...]", options: MO({ fontSize: 13, color: TERM_FG }) },
    { text: " 语义标注——采样是预期行为，不是报错", options: T({ fontSize: 13.5, color: TERM_FG }) },
  ], { x: M + 0.34, y: 5.08, w: CW - 0.7, h: 0.52, valign: "middle", margin: 0 });

  s.addText("★ 现场演示：top 采样一次——最能体现「领域流程固化」的价值", T({ x: M, y: 6.0, w: CW, h: 0.4, fontSize: 13.5, bold: true, color: ACCENT_DK, margin: 0 }));
}

/* ============ S25 (PART 05) 填平②：会话常驻 + 交互原语 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "填平困境②：会话常驻 + 交互原语");

  // 左：跨轮时间线
  terminal(s, M, 1.62, 6.15, 3.6);
  s.addText([
    { text: "turn 1   ", options: MO({ fontSize: 12, color: DIM }) },
    { text: "serial_shell_login → 登录成功，serial_1", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "turn 5   ", options: MO({ fontSize: 12, color: DIM }) },
    { text: "serial_exec \"cd /tmp && make\"", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "turn 12  ", options: MO({ fontSize: 12, color: DIM }) },
    { text: "serial_exec \"ls\"", options: MO({ fontSize: 12, color: TERM_FG }) },
    { text: "   → 还在 /tmp，环境变量也在", options: T({ fontSize: 11.5, color: DIM, breakLine: true }) },
    { text: "turn 20  ", options: MO({ fontSize: 12, color: DIM }) },
    { text: "serial_exec \"./run_tests.sh\"", options: MO({ fontSize: 12, color: TERM_FG }) },
    { text: "   → 同一个会话，同一套上下文", options: T({ fontSize: 11.5, color: DIM }) },
  ], { x: M + 0.34, y: 2.24, w: 5.5, h: 2.8, margin: 0, valign: "top", paraSpaceAfter: 6 });
  s.addText("登录态、工作目录、环境变量跨几十轮调用保持不变", T({ x: M, y: 5.36, w: 6.15, h: 0.34, fontSize: 12.5, bold: true, color: PRIMARY, align: "center", margin: 0 }));

  // 右：交互原语
  card(s, 7.0, 1.62, 5.71, 3.6);
  s.addText("write / read / send_ctrl 原语", T({ x: 7.32, y: 1.9, w: 5.1, h: 0.4, fontSize: 16, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "「发一句、看响应、再发下一句」——U-Boot、menuconfig、gdb 都能往返", options: { bullet: bu(), breakLine: true } },
    { text: "reboot / 烧写的安全通道：write 只发不熔断，read 轮询盯启动日志", options: { bullet: bu(), breakLine: true } },
    { text: "send_ctrl 随时可发 Ctrl+C / Ctrl+D，夺回会话控制权", options: { bullet: bu() } },
  ], T({ x: 7.32, y: 2.44, w: 5.05, h: 2.6, fontSize: 13, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  band(s, { txt: "观察 → 决策 → 再观察——调试循环直接在既有上下文里跑，不再每轮从零开始", fontSize: 15.5 }, 6.0, 0.85);
}

/* ============ S26 (PART 05) 填平④：多设备托管与会话管理 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "填平困境④：声明式设备清单 + 常驻托管");

  // 左：设备清单
  card(s, M, 1.62, 5.9, 4.0);
  s.addText("参数关：声明式设备清单", T({ x: M + 0.3, y: 1.88, w: 5.3, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  terminal(s, M + 0.3, 2.36, 5.3, 1.6);
  s.addText([
    { text: "# devices/board-a.yaml（一台一文件）", options: MO({ fontSize: 10.5, color: DIM, breakLine: true }) },
    { text: "serial: { port: COM3, baudRate: 115200 }", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "ssh:    { host: 192.168.16.103 }", options: MO({ fontSize: 11.5, color: TERM_FG }) },
  ], { x: M + 0.6, y: 2.72, w: 4.75, h: 1.1, margin: 0, paraSpaceAfter: 3 });
  s.addText("AI 按设备名调用（device: \"board-a\"），不再记端口、IP、波特率——用户只维护 yaml", T({ x: M + 0.3, y: 4.14, w: 5.3, h: 0.72, fontSize: 12.5, valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));
  s.addText([
    { text: "双向查询：", options: T({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: "session_info 按设备 / 按会话 / 全列", options: T({ fontSize: 12.5, color: TEXT }) },
  ], { x: M + 0.3, y: 4.98, w: 5.3, h: 0.4, margin: 0 });

  // 右：托管四件事
  card(s, 6.76, 1.62, 5.95, 4.0);
  s.addText("姿势 / 占用 / 并发关：常驻托管", T({ x: 7.06, y: 1.88, w: 5.4, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "姿势关：状态机固化在进程里，AI 只发高层工具调用", options: { bullet: bu(), breakLine: true } },
    { text: "占用关：端口由 Server 持有，portToSession 防重复打开", options: { bullet: bu(), breakLine: true } },
    { text: "并发关：per-session 互斥锁——同会话串行防输出交错，跨会话互不阻塞", options: { bullet: bu(), breakLine: true } },
    { text: "清场兜底：进程退出时 disposeAll 释放全部串口 / SSH / ADB 连接", options: { bullet: bu() } },
  ], T({ x: 7.06, y: 2.4, w: 5.4, h: 2.9, fontSize: 13, valign: "top", paraSpaceAfter: 12, margin: 0 }));

  band(s, { txt: "四道关的账：参数关靠声明式配置填平，姿势 / 占用 / 并发三关靠「常驻托管」填平——没有一样靠 AI 的记忆力", fontSize: 15 }, 5.92, 0.9);
}

/* ============ S27 (PART 05) 填平⑤：跨机桥接与注册策略 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "填平困境⑤：stdio 经 SSH 隧道延长到跨机");

  // 左：链路
  card(s, M, 1.62, 5.9, 4.0);
  s.addText("桥接的实质", T({ x: M + 0.3, y: 1.88, w: 5.3, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  terminal(s, M + 0.3, 2.34, 5.3, 2.55);
  s.addText([
    { text: "Linux AI Client", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "  └─ tools/call(JSON-RPC) 写进 ssh stdin", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "      └─> TCP :22 ─> Windows sshd", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "          └─> remote-start-mcp.bat ─> node", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "              └─> 响应沿原路写回", options: MO({ fontSize: 11.5, color: TERM_FG, breakLine: true }) },
    { text: "Host 视角：仍是一个普通 stdio Server", options: T({ fontSize: 11, bold: true, color: ACCENT_DK }) },
  ], { x: M + 0.6, y: 2.72, w: 4.75, h: 2.0, margin: 0, valign: "top", paraSpaceAfter: 4 });
  s.addText("物理通道（COM / USB）在哪台机，Server 就守在哪台机——AI 从远程过来用", T({ x: M + 0.3, y: 5.02, w: 5.3, h: 0.55, fontSize: 12, color: MUTED, valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));

  // 右：跨机信息缺口
  card(s, 6.76, 1.62, 5.95, 4.0);
  s.addText("跨机衍生的信息缺口，两个机制", T({ x: 7.06, y: 1.88, w: 5.4, h: 0.4, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "宿主端点告知（scp 要知道往哪搬）：", options: T({ fontSize: 13, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "instructions 握手注入 + host_info 兜底查询——告知 username@ip、scp 骨架、编译路由", options: T({ fontSize: 12.5, color: TEXT, breakLine: true }) },
    { text: "注册策略防绕行（从源头杜绝）：", options: T({ fontSize: 13, bold: true, color: PRIMARY, breakLine: true }) },
    { text: "power_shell_exec 仅远程注册（Linux 侧没有本机 shell）；ssh_build 仅本地注册——防止流量 Linux → Windows → Linux 绕圈", options: T({ fontSize: 12.5, color: TEXT }) },
  ], { x: 7.06, y: 2.4, w: 5.4, h: 3.0, margin: 0, valign: "top", paraSpaceAfter: 10 });

  band(s, { txt: "困境⑤的解一半在机制（桥接协议 + 端点告知），一半在部署形态——下一部分展开", fontSize: 15 }, 5.92, 0.8);
}

/* ============ S28 (PART 05) 附加价值：领域流程固化 ============ */
{
  const s = newSlide();
  header(s, "PART 05 · 机制对账", "附加价值：把领域流程固化进单个工具");
  s.addText("在会话常驻之上，把「每轮都要 AI 重新推导」的特定设备 / 厂商流程固化成一次确定性调用：", T({ x: M, y: 1.5, w: CW, h: 0.36, fontSize: 13.5, margin: 0 }));

  const caps = [
    ["serial/ssh_shell_login", "PSH 双状态机（用户登录 + 解锁）一次调用完成 challenge → 动态口令 → 解锁，配 KeyProvider 密钥管理"],
    ["serial_enter_uboot", "autoboot 提示检测并中断 + printenv 环境变量键双层验证——适配各厂商提示符（可配正则）"],
    ["serial_upload / download", "ZMODEM 传输：字节旁路「双写」（文本态 + 二进制旁路），复用串口会话、不释放端口传固件"],
    ["ssh_build", "Server 端轮询完成标记，error / warning / info 结构化分类——一次调用替代 N 次轮询，LLM 零判断"],
  ];
  caps.forEach(([n, d], i) => {
    const y = 2.06 + i * 0.94;
    card(s, M, y, CW, 0.8);
    s.addText(n, MO({ x: M + 0.28, y, w: 3.35, h: 0.8, fontSize: 13.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
    s.addText(d, T({ x: M + 3.85, y, w: CW - 4.2, h: 0.8, fontSize: 12.5, valign: "middle", margin: 0, lineSpacingMultiple: 1.12 }));
  });

  band(s, { txt: "这类能力不普适，但对命中的场景是真省事——每轮让 AI 重新推导领域流程，既慢又易错；固化后变成一次确定性调用", fontSize: 14.5 }, 5.95, 0.9);
}

/* ============ S29 (PART 06) 部署形态总览 ============ */
{
  const s = newSlide();
  header(s, "PART 06 · 部署", "部署形态总览：选择依据只有一个");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const dim = (t, mono) => ({ text: t, options: { fontSize: 12.5, bold: true, color: PRIMARY, fontFace: mono ? MONO : SANS, valign: "middle" } });
  const v = (t, mono) => ({ text: t, options: { fontSize: 12.5, color: TEXT, fontFace: mono ? MONO : SANS, valign: "middle" } });
  s.addTable([
    [{ text: "维度", options: Object.assign({}, hdr) }, { text: "形态一：本地同机", options: Object.assign({}, hdr) }, { text: "形态二：跨机远程", options: Object.assign({}, hdr) }],
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
  band(s, {
    runs: [
      { text: "选择依据：物理串口 / USB 插在哪台机器上。", options: T({ fontSize: 15.5, bold: true, color: PRIMARY, breakLine: true }) },
      { text: "无论怎么部署：工具、配置、运行时行为完全一致——只是连接介质的差别", options: T({ fontSize: 13.5, bold: true, color: PRIMARY }) },
    ]
  }, 5.95, 1.0);
}

/* ============ S30 (PART 06) 形态一：本地同机 ============ */
{
  const s = newSlide();
  header(s, "PART 06 · 部署", "形态一：本地同机（stdio 直连）");
  // 直接引用 docs/项目简介/img/usage1-local.excalidraw.svg（矢量，1320x980pt）
  const iw = 7.63, ih = iw * (980 / 1320);
  s.addImage({ path: "../docs/项目简介/img/usage1-local.excalidraw.svg", x: M, y: 1.62 + (5.15 - ih) / 2, w: iw, h: ih });
  const cx = M + iw + 0.28, cwd = W - M - cx;
  card(s, cx, 1.62, cwd, 5.15);
  s.addText("要点", T({ x: cx + 0.28, y: 1.86, w: cwd - 0.56, h: 0.36, fontSize: 15, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: ".mcp.json 写 command: node，子进程拉起，零网络", options: { bullet: bu(), breakLine: true } },
    { text: "两条并行通路：源码编辑绕过 MCP（Z: 挂载），设备操作经 MCP", options: { bullet: bu() } },
  ], T({ x: cx + 0.28, y: 2.28, w: cwd - 0.56, h: 1.5, fontSize: 12, valign: "top", paraSpaceAfter: 8, margin: 0 }));
  s.addText("✓ 优点", T({ x: cx + 0.28, y: 3.82, w: cwd - 0.56, h: 0.32, fontSize: 13.5, bold: true, color: GREEN, margin: 0 }));
  s.addText("零网络配置、延迟最低、不依赖 SSH、开箱即用", T({ x: cx + 0.28, y: 4.18, w: cwd - 0.56, h: 0.62, fontSize: 12, color: TEXT, valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));
  s.addText("✗ 缺点", T({ x: cx + 0.28, y: 4.86, w: cwd - 0.56, h: 0.32, fontSize: 13.5, bold: true, color: RED, margin: 0 }));
  s.addText("AI 必须跑在插着设备的那台 Windows 上；编译要经 Z: 挂载或 ssh_build 绕到 Linux", T({ x: cx + 0.28, y: 5.22, w: cwd - 0.56, h: 0.85, fontSize: 12, color: TEXT, valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));
  s.addText("→ 适用：开发者单人单机调试", T({ x: cx + 0.28, y: 6.28, w: cwd - 0.56, h: 0.34, fontSize: 12.5, bold: true, color: ACCENT_DK, margin: 0 }));
}

/* ============ S31 (PART 06) 形态二：跨机远程 ============ */
{
  const s = newSlide();
  header(s, "PART 06 · 部署", "形态二：跨机远程（SSH 隧道）");
  // 图片：上下结构，占满宽度
  const ih = 3.4, iw = ih * (1618 / 684);
  const ix = (W - iw) / 2;
  s.addImage({ path: "../docs/项目简介/img/usage2-remote.excalidraw.svg", x: ix, y: 1.5, w: iw, h: ih });
  s.addText([
    { text: "Linux 端配置 command: ssh -i ~/.ssh/id_mcp_server user@win-ip remote-start-mcp.bat", options: MO({ fontSize: 12, color: MUTED, breakLine: true }) },
    { text: "JSON-RPC 走 ssh stdin → TCP :22 → Windows 拉起 node，响应原路写回——Host 视角下它仍是普通 stdio Server", options: T({ fontSize: 12, color: MUTED }) },
  ], { x: M, y: 5.0, w: CW, h: 0.52, align: "center", margin: 0, lineSpacingMultiple: 1.1 });

  // 优点 / 缺点 双卡
  const hw = CW / 2 - 0.12;
  card(s, M, 5.64, hw, 1.34);
  s.addText("✓ 优点", T({ x: M + 0.28, y: 5.74, w: 1.4, h: 0.3, fontSize: 13, bold: true, color: GREEN, margin: 0 }));
  s.addText([
    { text: "AI 留在编译服务器：编辑 → 编译 → 调试一气呵成", options: { bullet: bu(), breakLine: true } },
    { text: "串口 / USB-ADB 照样可用——团队主流形态", options: { bullet: bu() } },
  ], T({ x: M + 0.28, y: 6.08, w: hw - 0.56, h: 0.84, fontSize: 11.5, valign: "top", paraSpaceAfter: 5, margin: 0 }));

  const rx = M + hw + 0.24;
  card(s, rx, 5.64, hw, 1.34);
  s.addText("✗ 缺点", T({ x: rx + 0.28, y: 5.74, w: 1.4, h: 0.3, fontSize: 13, bold: true, color: RED, margin: 0 }));
  s.addText([
    { text: "依赖 Windows 侧 OpenSSH Server 与免密配置，多一跳网络", options: { bullet: bu(), breakLine: true } },
    { text: "跨机传文件靠 scp（host_info / instructions 告知宿主端点）", options: { bullet: bu() } },
  ], T({ x: rx + 0.28, y: 6.08, w: hw - 0.56, h: 0.84, fontSize: 11.5, valign: "top", paraSpaceAfter: 5, margin: 0 }));
}

/* ============ S32 (PART 06) 落地：一键打通 ============ */
{
  const s = newSlide();
  header(s, "PART 06 · 部署", "部署落地：一键打通免密的两条对偶命令");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13, valign: "middle" };
  const cmd = (t) => ({ text: t, options: { fontFace: MONO, fontSize: 12.5, bold: true, color: PRIMARY, valign: "middle" } });
  const c = (t, o) => ({ text: t, options: Object.assign({ fontSize: 12.5, valign: "middle", color: TEXT }, o) });
  s.addTable([
    [c("命令", hdr), c("跑在哪", hdr), c("角色", hdr), c("职责", hdr)],
    [cmd("sshd-config"), c("Windows"), c("Windows 当 SSH server"), c("装 OpenSSH Server、生成密钥对、配 authorized_keys、生成 Linux 端 .mcp.json 模板")],
    [cmd("remote-mcp-config"), c("Windows"), c("Windows 当 SSH 客户端"), c("从 Windows 登录 Linux，把桥接 server 写入 Claude / ZCode / opencode 配置文件")],
  ], {
    x: M, y: 1.7, w: CW, colW: [2.5, 1.7, 3.0, 4.89],
    rowH: [0.48, 0.92, 0.92],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  card(s, M, 4.32, CW, 0.98);
  s.addText("产物", T({ x: M + 0.3, y: 4.32, w: 1.1, h: 0.98, fontSize: 14, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));
  s.addText([
    { text: "Linux 端出现桥接 server 定义——", options: T({ fontSize: 13 }) },
    { text: "command: ssh", options: MO({ fontSize: 12.5, bold: true, color: PRIMARY }) },
    { text: " + 一条连到 Windows 并启动 remote-start-mcp.bat 的完整命令", options: T({ fontSize: 13 }) },
  ], { x: M + 1.5, y: 4.32, w: CW - 1.9, h: 0.98, valign: "middle", margin: 0 });

  card(s, M, 5.5, CW, 0.92, ACCENT_LT);
  s.addText("本地 / 远程共用同一个 remote-start-mcp.bat launcher：锚定 cwd + 设 5 个 env + stdio 启动——双击或被 ssh 拉起，跑的是同一进程、同一份配置", T({ x: M + 0.32, y: 5.5, w: CW - 0.64, h: 0.92, fontSize: 13.5, bold: true, color: PRIMARY, valign: "middle", margin: 0 }));

  s.addText("推荐顺序：init → sshd-config 搭桥 → remote-mcp-config 写配置 → Linux 端重启客户端生效", T({ x: M, y: 6.62, w: CW, h: 0.32, fontSize: 12.5, color: MUTED, margin: 0 }));
}

/* ============ S33 (PART 06) 怎么选：推荐结论 ============ */
{
  const s = newSlide();
  header(s, "PART 06 · 部署", "怎么选：一个硬约束 + 一个明确推荐");

  // 顶部：判定链（一分为二）
  box(s, M, 1.56, 3.7, 1.0, "硬约束判定：\n物理串口 / USB 插在哪台机器？", { fontSize: 13 });
  arrowR(s, M + 3.7, 1.82, 0.4);
  arrowR(s, M + 3.7, 2.32, 0.4);
  box(s, M + 4.1, 1.56, 3.75, 1.0, "与 AI 同一台 Windows\n→ 形态一 · 本地同机", { fontSize: 13 });
  box(s, M + 8.0, 1.56, 4.09, 1.0, "在另一台 Windows（AI 在 Linux）\n→ 形态二 · 跨机远程", { fontSize: 13 });

  // 中部：两形态定性对比
  const hw = CW / 2 - 0.12;
  card(s, M, 2.86, hw, 2.72);
  s.addText("形态一 · 本地同机", T({ x: M + 0.3, y: 3.08, w: hw - 0.6, h: 0.36, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "上手最快：npm 装 + init，5 分钟跑通，零网络配置", options: { bullet: bu(), breakLine: true } },
    { text: "延迟最低，行为最简单，出问题最好排查", options: { bullet: bu(), breakLine: true } },
    { text: "局限：AI 必须与设备同机；编译要经 Z: 挂载或 ssh_build 绕行", options: { bullet: bu() } },
  ], T({ x: M + 0.3, y: 3.56, w: hw - 0.6, h: 1.9, fontSize: 12.5, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  card(s, M + hw + 0.24, 2.86, hw, 2.72);
  s.addText("形态二 · 跨机远程", T({ x: M + hw + 0.54, y: 3.08, w: hw - 0.6, h: 0.36, fontSize: 15.5, bold: true, color: PRIMARY, margin: 0 }));
  s.addText([
    { text: "AI 留在编译服务器——编辑 / 编译 / 调试一气呵成，团队主流形态", options: { bullet: bu(), breakLine: true } },
    { text: "串口、USB-ADB 照常可用：物理通道缺口被 MCP 补齐", options: { bullet: bu(), breakLine: true } },
    { text: "代价：一次性免密配置 + 多一跳网络 + 文件搬运靠 scp", options: { bullet: bu() } },
  ], T({ x: M + hw + 0.54, y: 3.56, w: hw - 0.6, h: 1.9, fontSize: 12.5, valign: "top", paraSpaceAfter: 10, margin: 0 }));

  band(s, {
    runs: [
      { text: "推荐：单人临时调试 → 形态一；正式开发 / 团队 → 形态二——它同时保住「编译顺畅」与「物理通道」，正是困境⑤两个选项之外的最优解。", options: T({ fontSize: 14, bold: true, color: PRIMARY, breakLine: true }) },
      { text: "两形态共用同一 launcher 与配置，切换成本≈0：先形态一上手，随需求平滑升级到形态二", options: T({ fontSize: 13.5, bold: true, color: ACCENT_DK }) },
    ]
  }, 5.8, 1.1);
}

/* ============ S34 (PART 07) 能力分界 ============ */
{
  const s = newSlide();
  header(s, "PART 07 · 边界与选型", "能力分界：PowerShell 直调 vs 本 MCP");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const cap = (t) => ({ text: t, options: { fontSize: 13, color: TEXT, valign: "middle" } });
  const no = () => ({ text: "✕", options: { fontSize: 17, bold: true, color: RED, align: "center", valign: "middle" } });
  const yes = () => ({ text: "✓", options: { fontSize: 17, bold: true, color: GREEN, align: "center", valign: "middle" } });
  s.addTable([
    [{ text: "能力", options: Object.assign({}, hdr) }, { text: "PowerShell 直调", options: Object.assign({}, hdr, { align: "center" }) }, { text: "本 MCP", options: Object.assign({}, hdr, { align: "center" }) }],
    [cap("串口流切片（提示符检测 + 超时熔断）"), no(), yes()],
    [cap("端口持续持有（boot 日志捕获）"), no(), yes()],
    [cap("持久会话（多串口 / SSH 并发）"), no(), yes()],
    [cap("交互式往返（U-Boot / gdb / menuconfig）"), no(), yes()],
    [cap("常驻命令取采样（logcat / top）"), no(), yes()],
    [cap("PSH 一键解锁登录"), no(), yes()],
  ], {
    x: M, y: 1.7, w: CW, colW: [5.2, 3.4, 3.49],
    rowH: [0.46, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "直调做不到的不是「命令」，而是「活不过一轮」的一切——这些能力都架构在常驻进程之上", fontSize: 15.5 }, 6.02, 0.8);
}

/* ============ S35 (PART 07) 场景选型 ============ */
{
  const s = newSlide();
  header(s, "PART 07 · 边界与选型", "场景选型：什么场景用 MCP，什么场景不用");
  const hdr = { fill: { color: PRIMARY }, color: "FFFFFF", bold: true, fontSize: 13.5, valign: "middle" };
  const sc = (t, mono) => ({ text: t, options: { fontSize: 12.5, color: TEXT, fontFace: mono ? MONO : SANS, valign: "middle" } });
  const rec = (t, good) => ({ text: t, options: { fontSize: 12.5, bold: true, color: good ? GREEN : RED, valign: "middle" } });
  const why = (t) => ({ text: t, options: { fontSize: 12.5, color: TEXT, valign: "middle" } });
  s.addTable([
    [{ text: "场景", options: Object.assign({}, hdr) }, { text: "推荐", options: Object.assign({}, hdr) }, { text: "理由", options: Object.assign({}, hdr) }],
    [sc("adb install / adb push / ssh host \"一次性命令\"", true), rec("PowerShell 直调", false), why("无状态，MCP 多此一举")],
    [sc("扫端口、看网卡、跑本地脚本"), rec("PowerShell 直调", false), why("Host 本身就有 shell 能力")],
    [sc("AI 在 Linux 编译服务器，设备插在 Windows 工位机"), rec("MCP 工具", true), why("物理够不着：Linux 没有路径碰 COM / USB，经 SSH 隧道桥接（形态二）")],
    [sc("串口交互、U-Boot、boot 日志捕获"), rec("MCP 工具", true), why("有状态长连接 + 流切片")],
    [sc("SSH 多轮调试（观察-决策循环）、多板卡并发"), rec("MCP 工具", true), why("长连接保持上下文 + 多会话管理")],
    [sc("logcat / top 取采样"), rec("MCP 的 exec", true), why("解决「不知道命令何时结束」")],
  ], {
    x: M, y: 1.7, w: CW, colW: [5.1, 2.6, 4.39],
    rowH: [0.5, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62],
    border: { pt: 0.5, color: HAIR }, fontFace: SANS, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], autoPage: false,
  });
  band(s, { txt: "如果你用 PowerShell 自己维护长会话、处理 PTY、识别提示符、走 PSH 登录——本质上就是在重新实现这个 MCP。这正是它存在的理由。", fontSize: 14, bold: true }, 6.06, 0.85);
}

/* ============ S36 (PART 07) 诚实的边界 ============ */
{
  const s = newSlide();
  header(s, "PART 07 · 边界与选型", "诚实的边界：已知限制与对策");
  const edges = [
    ["一次性命令：直调更直接", "adb install、ssh host \"uname -a\"、扫端口——PowerShell 直调即可，MCP 在这里几乎不增加价值，不必为用而用"],
    ["MCP 协议超时按 Host 配置", "opencode 默认 60s：按 server 配 timeout: 600000；Claude Code 默认约 28 小时，一般无需配置"],
    ["reboot / 烧写类长启动命令", "用 write + read 安全通道轮询观测，或显式传大 timeoutMs；普通命令兜底超时不自动 Ctrl+C（旧版误中断问题已修复）"],
    ["ZMODEM × 持续打印的设备", "ZMODEM 是带内协议，内核日志洪水会污染传输：优先用上传；确需下载先停输出源（dmesg -D / kill 打印任务）"],
  ];
  const hw = CW / 2 - 0.12;
  edges.forEach(([t, b], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = col === 0 ? M : M + hw + 0.24, y = 1.66 + row * 2.18;
    card(s, x, y, hw, 1.96);
    s.addText(t, T({ x: x + 0.28, y: y + 0.2, w: hw - 0.56, h: 0.38, fontSize: 14.5, bold: true, color: PRIMARY, margin: 0 }));
    s.addText(b, T({ x: x + 0.28, y: y + 0.66, w: hw - 0.56, h: 1.16, fontSize: 12.5, valign: "top", margin: 0, lineSpacingMultiple: 1.18 }));
  });
  band(s, { txt: "把边界讲清楚，是为了让工具在边界内可靠——每一条在文档与工具描述里都写了对策", fontSize: 15 }, 6.12, 0.8);
}

/* ============ S37 (PART 08) 快速上手 ============ */
{
  const s = newSlide();
  header(s, "PART 08 · 上手与总结", "快速上手：五分钟跑通最小闭环");
  terminal(s, M, 1.62, 6.55, 5.3);
  s.addText([
    { text: "# 1. 安装（npm）", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "mkdir mcp-toolkit && cd mcp-toolkit", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "npm i @smai-kit/embedded-mcp-toolkit", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "./node_modules/.bin/embedded-mcp-toolkit init", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 2. 配置设备：复制 devices/board-example.yaml 填好参数", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 3. 启动 AI 客户端并连接", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "claude", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "/mcp list", options: MO({ fontSize: 12, color: TERM_FG }) },
    { text: "   # 看到 embedded-board ✓ connected", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: " ", options: { breakLine: true } },
    { text: "# 4. 自然语言对话", options: T({ fontSize: 12, color: DIM, breakLine: true }) },
    { text: "\"串口一键登录 board-test\"", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "\"在串口执行 uname -a\"", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "\"重启进入 uboot\"", options: MO({ fontSize: 12, color: TERM_FG, breakLine: true }) },
    { text: "\"用 top 采样一下\"", options: MO({ fontSize: 12, color: TERM_FG }) },
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

/* ============ S38 (PART 08) 总结：三问三答 ============ */
{
  const s = newSlide();
  header(s, "PART 08 · 上手与总结", "总结：回到三个问题");
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: 1.58, w: CW, h: 1.0, fill: { color: PRIMARY }, line: { type: "none" }, rectRadius: 0.07 });
  s.addText("embedded-mcp-toolkit 用一个常驻的 MCP Server，把嵌入式调试里「有状态、跨轮、易出错」的部分全部固化——让 AI 真正「直接对话板子」", T({ x: M + 0.32, y: 1.58, w: CW - 0.64, h: 1.0, fontSize: 15, bold: true, color: "FFFFFF", valign: "middle", margin: 0 }));

  const qa = [
    ["Q1 是什么、有什么用？", "一个常驻的 MCP Server：串口 / SSH / ADB / PowerShell 四通道、40+ 工具，覆盖交互会话、文件传输、结构化编译；不绑定 Host，npm 一条 init 即用"],
    ["Q2 解决了什么困境？", "五个困境五个机制：字节流切片 · 跨轮会话 · 常驻命令采样 · 多设备托管 · 跨机桥接。AI 自己解决不了，是因为信息不在输出里、进程活不过一轮、物理没有线缆——任何替代路线最终都在重新实现它"],
    ["Q3 怎么部署、推荐哪种？", "本地 stdio 直连 / 跨机 SSH 隧道两种形态，同一进程同一配置；单人调试用形态一，正式开发推荐形态二（AI 留编译服务器 + MCP 守设备旁）"],
  ];
  const cw = 3.87;
  qa.forEach(([q, a], i) => {
    const x = M + i * (cw + 0.24);
    card(s, x, 2.86, cw, 3.0);
    s.addText(q, MO({ x: x + 0.26, y: 3.12, w: cw - 0.52, h: 0.4, fontSize: 15.5, bold: true, color: ACCENT_DK, margin: 0 }));
    s.addText(a, T({ x: x + 0.26, y: 3.62, w: cw - 0.52, h: 2.1, fontSize: 12.5, color: TEXT, valign: "top", margin: 0, lineSpacingMultiple: 1.18 }));
  });
  band(s, { txt: "展望：Streamable HTTP 远程 Server 形态探索 · 更多通道 / 协议支持 · 更多领域流程固化", fontSize: 14.5 }, 6.15, 0.75);
}

/* ============ S39 封底 ============ */
{
  const s = newSlide();
  s.background = { color: "FFFFFF" };
  s.addText("嵌入式开发 · MCP 协议 · AI 工具链", MO({ x: 0.95, y: 1.35, w: 8, h: 0.35, fontSize: 14, bold: true, color: ACCENT_DK, charSpacing: 2, margin: 0 }));
  s.addText("谢谢聆听", T({ x: 0.95, y: 2.05, w: 10, h: 1.0, fontSize: 46, bold: true, color: PRIMARY, margin: 0 }));
  s.addText("embedded-mcp-toolkit · 让 AI 直接对话嵌入式板卡", T({ x: 0.95, y: 3.3, w: 10, h: 0.5, fontSize: 18, color: MUTED, margin: 0 }));
  s.addText("技术分享 · 2026", T({ x: 0.95, y: 6.72, w: 5, h: 0.32, fontSize: 12.5, color: MUTED, margin: 0 }));
}

if (PAGE !== TOTAL) {
  console.error("[X] 页数断言失败：实际 " + PAGE + " 页，TOTAL 常量为 " + TOTAL + "，请同步修正");
  process.exit(1);
}

pres.writeFile({ fileName: ".tmp/out_new.pptx" }).then(() => console.log("OK out_new.pptx · " + PAGE + " pages"));
