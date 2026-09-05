/**
 * @brief dev create 交互问答「validate 内联校验原地重绘」冒烟测试（Windows/Git Bash）
 *
 * 复现方式：在真实 PTY（winpty）下运行 dev create，串口问答故意先提交
 * "COM3"（缺波特率）触发校验错误，再补输 "@115200" 提交。
 *
 * 验证点（对应 prompts.ts 的 validate 原地重绘行为）：
 *   1. 提交 COM3 后出现内联黄色错误「格式应为 端口@波特率」
 *   2. 错误后发生 clack 原地上移重绘（出现光标上移序列）
 *   3. 最终画面上串口提示只出现一次（不往下堆重复提示，核心回归点）
 *   4. 最终画面不残留错误信息（错误帧被成功帧原地替换）
 *   5. 错误后已输入内容保留（COM3 + 补输 @115200 → COM3@115200）
 *   6. 全流程走通且落盘 yaml 含 port: "COM3" / baudRate: 115200
 *
 * 运行：node test/cli/test-dev-create-redraw.mjs [--verbose|-v] [--sleeptime <ms>]
 *   - 默认打印分步进度（等待/出现/发送），零停留，用于自动化测试
 *   - --verbose 或 TEST_VERBOSE=1 时实时回显 PTY 原始输出，可在终端直接
 *     观看 clack 界面逐步重绘；配合 --sleeptime <ms> 让每步画面停留指定
 *     毫秒再发下一个输入（不传默认 1000ms），便于肉眼查看
 *   - Git Bash 与 PowerShell/cmd 均可运行（winpty 从 PATH 或 Git 安装目录推导）
 *   - 未找到 winpty（无 Git for Windows）时跳过（exit 0）
 *   - 测试生成的设备 yaml 会在结束时清理；若同名文件已存在则换名/跳过，绝不覆盖
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = "bin/embedded-mcp-toolkit-cli.js";
const CREATE_TIMEOUT_MS = 60_000;

// --verbose / -v / TEST_VERBOSE=1：实时回显 PTY 原始输出
const VERBOSE =
  process.argv.includes("--verbose") ||
  process.argv.includes("-v") ||
  process.env.TEST_VERBOSE === "1";

/**
 * @brief 解析 --sleeptime <ms>（支持空格与 = 两种写法）
 * @details 仅在 verbose 观看模式下生效：每步画面出现后停留指定毫秒再发送
 *          下一个输入；自动化模式（无 -v）恒为 0，不拖慢测试。
 */
function parseSleeptimeMs() {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith("--sleeptime="));
  const raw = eq ? eq.split("=")[1] : argv[argv.indexOf("--sleeptime") + 1];
  const ms = parseInt(raw, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 1000;
}
const PAUSE_MS = VERBOSE ? parseSleeptimeMs() : 0;
const pause = () => (PAUSE_MS > 0 ? new Promise((r) => setTimeout(r, PAUSE_MS)) : null);

// ── 检查辅助 ──
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

/** @brief 去掉 SGR 等 ANSI 序列，仅保留可见文本（含换行） */
function stripAnsi(raw) {
  return raw.replace(
    /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b[c]/g,
    ""
  );
}

/**
 * @brief 迷你 ANSI 屏幕模拟器：把终端输出流重放到虚拟屏幕，重建最终画面
 * @details 处理光标移动（A/B/C/D/G/H/f）、行/屏擦除（K/J）、\r \b，忽略样式类
 *          序列（SGR、光标显隐等）。ConPTY 的软换行已在输出流中物化为真实换行。
 * @param raw 原始输出
 * @param cols 虚拟屏宽度（需不小于 PTY 宽度，避免截断）
 * @returns 逐行文本数组
 */
function replayScreen(raw, cols = 200) {
  const rows = 500;
  const screen = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  const put = (ch) => {
    if (ch === "\n") {
      row = Math.min(row + 1, rows - 1);
      col = 0;
      return;
    }
    if (ch === "\r") {
      col = 0;
      return;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      return;
    }
    if (row < rows && col < cols) {
      screen[row][col] = ch;
    }
    col++;
  };

  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === "\x1b" && raw[i + 1] === "[") {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) {
        const params = m[1];
        const n = params === "" ? 1 : parseInt(params, 10) || 0;
        const nums = params.split(";").map((p) => parseInt(p, 10) || 0);
        switch (m[2]) {
          case "A":
            row = Math.max(0, row - n);
            break;
          case "B":
            row = Math.min(rows - 1, row + n);
            break;
          case "C":
            col += n;
            break;
          case "D":
            col = Math.max(0, col - n);
            break;
          case "G":
            col = Math.max(0, n - 1);
            break;
          case "H":
          case "f":
            row = Math.min(rows - 1, Math.max(0, (nums[0] || 1) - 1));
            col = Math.max(0, (nums[1] || 1) - 1);
            break;
          case "K": {
            const mode = params === "" ? 0 : nums[0];
            if (mode === 0) {
              for (let c = col; c < cols; c++) screen[row][c] = " ";
            } else if (mode === 1) {
              for (let c = 0; c <= col && c < cols; c++) screen[row][c] = " ";
            } else if (mode === 2) {
              for (let c = 0; c < cols; c++) screen[row][c] = " ";
            }
            break;
          }
          case "J": {
            const mode = params === "" ? 0 : nums[0];
            if (mode === 0) {
              for (let r = row; r < rows; r++)
                for (let c = r === row ? col : 0; c < cols; c++)
                  screen[r][c] = " ";
            } else if (mode === 2) {
              for (let r = 0; r < rows; r++)
                for (let c = 0; c < cols; c++) screen[r][c] = " ";
            }
            break;
          }
          // 其余（m 样式、私有模式等）不影响画面文本
        }
        i += m[0].length;
        continue;
      }
    }
    put(ch);
    i++;
  }
  return screen.map((line) => line.join("").trimEnd());
}

// ── 主流程 ──

/**
 * @brief 定位 winpty 可执行文件
 * @details 依次尝试：PATH 直接解析（Git Bash 环境）→ 由 git --exec-path 推导
 *          Git 安装目录 → 由 where git 推导 → 常见静态安装位置。
 *          PowerShell/cmd 不含 Git\usr\bin，必须靠路径推导兜底。
 * @returns 可直接传给 spawn 的 winpty 路径；找不到返回 null
 */
function findWinpty() {
  const probe = spawnSync("winpty", ["--version"], { timeout: 5000 });
  if (!probe.error) {
    return "winpty";
  }

  const candidates = [];
  // git --exec-path 形如 <Git>\mingw64\libexec\git-core，上溯 3 级即 <Git>
  const execPath = spawnSync("git", ["--exec-path"], {
    timeout: 5000,
    encoding: "utf8",
  });
  if (execPath.status === 0) {
    const gitCore = execPath.stdout.trim().split(/\r?\n/)[0];
    if (gitCore) {
      candidates.push(resolve(gitCore, "../../../usr/bin/winpty.exe"));
    }
  }
  // where git 形如 <Git>\cmd\git.exe 或 scoop shim，上溯 2 级尝试
  const whereGit = spawnSync("where", ["git"], {
    timeout: 5000,
    encoding: "utf8",
  });
  if (whereGit.status === 0) {
    for (const line of whereGit.stdout.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (gitExe) {
        candidates.push(resolve(gitExe, "../../usr/bin/winpty.exe"));
      }
    }
  }
  // 常见静态安装位置
  for (const base of [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LOCALAPPDATA"],
  ]) {
    if (base) {
      candidates.push(resolve(base, "Git/usr/bin/winpty.exe"));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// winpty 不可用（非 Windows 且无 Git 安装）时跳过
const winptyPath = findWinpty();
if (!winptyPath) {
  console.log("SKIP  未找到 winpty，本测试需要 Windows + Git for Windows 环境");
  process.exit(0);
}

// 选一个不存在的设备名，绝不覆盖用户已有配置
let deviceName;
let targetPath;
for (let i = 0; i < 5; i++) {
  const candidate = i === 0 ? "zz-clack-redraw" : `zz-clack-redraw-${i}`;
  const p = resolve(REPO_ROOT, `.embedded/configs/devices/${candidate}.yaml`);
  if (!existsSync(p)) {
    deviceName = candidate;
    targetPath = p;
    break;
  }
}
if (!deviceName) {
  console.log("SKIP  zz-clack-redraw* 设备名均已被占用，为避免覆盖跳过测试");
  process.exit(0);
}

/**
 * @brief 在 winpty PTY 中运行 dev create 并分步驱动交互
 * @details 不用盲等 sleep：每步先 waitFor 等到预期画面出现再送按键，
 *          输入用 \r 表示回车。返回累积的原始输出 Buffer。
 */
function runCreateInteractive() {
  return new Promise((outResolve) => {
    const child = spawn(
      winptyPath,
      ["-Xallow-non-tty", process.execPath, CLI_ENTRY, "dev", "create"],
      { cwd: REPO_ROOT, windowsHide: true }
    );
    let rawBuf = Buffer.alloc(0);
    let settled = false;

    const text = () => rawBuf.toString("utf8");
    const collect = (chunk) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      // 实时回显模式：把 PTY 原始输出直接打到终端，可观看界面逐步重绘
      if (VERBOSE) {
        process.stdout.write(chunk);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    /** 等到 raw 流中出现 substr 或超时 */
    async function waitFor(substr, timeoutMs) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (text().includes(substr)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }

    /** 送一行输入（\r = 回车） */
    function send(line) {
      child.stdin.write(line);
    }

    const overall = setTimeout(() => {
      if (!settled) {
        child.kill();
      }
    }, CREATE_TIMEOUT_MS);

    (async () => {
      const steps = [
        { wait: "设备名（用作配置文件名）", input: `${deviceName}\r` },
        { wait: "串口连接 端口@波特率", input: "COM3\r" },
        // 错误帧出现后，clack 已把 "COM3" 写回输入行，这里只补波特率
        {
          wait: "格式应为 端口@波特率",
          input: "@115200\r",
          note: "错误帧已出现，COM3 保留在输入行",
        },
        { wait: "串口登录 用户名@密码", input: "\r" },
        { wait: "SSH 连接 IP@端口", input: "\r" },
        { wait: "ADB 序列号", input: "\r" },
        { wait: "设备配置已生成", input: null },
      ];
      let stepNo = 0;
      for (const step of steps) {
        stepNo++;
        if (!VERBOSE) {
          console.log(`[${stepNo}/${steps.length}] 等待「${step.wait}」`);
        }
        const ok = await waitFor(step.wait, 15_000);
        if (!ok) {
          if (!VERBOSE) {
            console.error(`      ✗ 超时未出现`);
          }
          child.kill();
          return {
            ok: false,
            reason: `等待超时：「${step.wait}」未出现`,
            raw: rawBuf,
          };
        }
        if (!VERBOSE) {
          const sent = step.input === null ? null : step.input.replace(/\r$/, "");
          console.log(
            sent === null
              ? `      ✓ 出现${step.note ? `（${step.note}）` : ""}`
              : `      ✓ 出现${step.note ? `（${step.note}）` : ""}，发送「${sent}」`
          );
        }
        if (step.input !== null) {
          await pause(); // 观看模式：停留 PAUSE_MS 再发下一个输入
          send(step.input);
        }
      }
      await pause(); // 摘要画面同样停留，便于查看
      // 等子进程自然退出（摘要打印完）
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, raw: rawBuf };
    })()
      .then((result) => {
        settled = true;
        clearTimeout(overall);
        child.kill();
        outResolve({ ...result, raw: rawBuf });
      })
      .catch((err) => {
        settled = true;
        clearTimeout(overall);
        child.kill();
        outResolve({ ok: false, reason: err.message, raw: rawBuf });
      });
  });
}

console.log(`── 运行 dev create（PTY 设备名: ${deviceName}）──`);
if (VERBOSE) {
  console.log(`── 实时回显 PTY 输出（--verbose，每步停留 ${PAUSE_MS}ms）──\n`);
}
const { ok, reason, raw } = await runCreateInteractive();
if (!ok) {
  console.error(`\nFAIL  交互流程未走通: ${reason ?? "未知原因"}`);
  console.error(stripAnsi(raw?.toString("utf8") ?? "").slice(-800));
  rmSync(targetPath, { force: true });
  process.exit(1);
}
if (VERBOSE) {
  console.log("\n── PTY 会话结束，开始断言 ──");
}

// ── 断言 ──
const rawText = raw.toString("utf8");
const stripped = stripAnsi(rawText);
const screenLines = replayScreen(rawText);
const screenText = screenLines.join("\n");

// 1. 内联校验错误出现过
check(
  "提交 COM3 后出现内联校验错误「格式应为 端口@波特率」",
  stripped.includes("格式应为 端口@波特率")
);

// 2. 错误后发生 clack 原地上移重绘（光标上移序列是原地重绘的标志）
const anchor = rawText.lastIndexOf("格式应为");
const rawAtError = anchor >= 0 ? rawText.slice(anchor, anchor + 4000) : "";
check(
  "错误后发生光标上移重绘（原地重绘标志）",
  /\x1b\[\d+A/.test(rawAtError),
  "错误信息之后未检测到光标上移序列"
);

// 3. 最终画面上串口提示只出现一次（核心回归点：不往下堆重复提示）
const promptCount = screenText.split("串口连接 端口@波特率").length - 1;
check(
  "最终画面串口提示只出现一次",
  promptCount === 1,
  `出现 ${promptCount} 次（旧实现会堆出第 2 个提示）`
);

// 4. 最终画面不残留错误信息
check(
  "最终画面不残留校验错误信息",
  !screenText.includes("格式应为 端口@波特率")
);

// 5. 错误后输入保留：COM3 与 @115200 合并为 COM3@115200
check(
  "错误后输入保留并合并为 COM3@115200",
  screenText.includes("COM3@115200")
);

// 6. 全流程走通：摘要与落盘内容正确
check("摘要显示设备配置已生成", screenText.includes("设备配置已生成"));
if (existsSync(targetPath)) {
  const yamlText = readFileSync(targetPath, "utf8");
  check("落盘 yaml 含 port: \"COM3\"", yamlText.includes('port: "COM3"'));
  check("落盘 yaml 含 baudRate: 115200", yamlText.includes("baudRate: 115200"));
} else {
  check("落盘 yaml 已生成", false, `${targetPath} 不存在`);
}

// ── 清理 ──
rmSync(targetPath, { force: true });
console.log(`\n已清理测试产物: ${targetPath}`);

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
