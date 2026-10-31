#!/usr/bin/env node
/**
 * =====================================================
 * local-mcp-config 离线测试（边界断言 + 全 agent 沙箱生成实测）
 *
 * 三段式结构：
 *   一、bridge 形态与 bat 探测边界（临时目录, 自清理）
 *      - cmd /c <bat 绝对路径> 形态
 *      - detectBatCandidates 三候选（bin 上溯 / exe 同目录 / cwd）的存在性
 *        过滤、去重与无命中空数组
 *   二、本地 file-ops 语义（临时目录, 自清理）
 *      - 五态判定（absent/consistent）
 *      - server 型写入总是重写（幂等内容）；enable 型去重
 *      - .bak 规则：原文件不存在不产生；已存在时首次写入产生
 *      - 落点父目录自动创建；同容器其它 server key 保留
 *      - 删除与重复删除幂等
 *   三、全 agent 沙箱生成实测（沙箱保留, 供人工核对）
 *      - 运行前删除一次沙箱, 运行后保留：.embedded/tmp/lv-agent-test/
 *      - resolveTargets(本机 ResolveCtx) → commitTargetFile → 读回校验
 *      - 覆盖 5 客户端 × 8 落点：Claude 全局/项目(双文件+预置保留)、
 *        CodeBuddy 全局/项目(共用 .mcp.json 的 consistent 语义)、
 *        ZCode(嵌套容器)、DSH(type/cwd)、opencode(数组形态/$schema 补齐)
 *
 * 全部断言通过输出 ALL PASS 并退出码 0，否则列出失败项。
 * 运行：node test/cli/local-mcp-config.mjs（需先 npm run build）
 * 或：npm run test:local-mcp-config
 * ======================================================
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildLocalBridge, detectBatCandidates } from "../../out/cli/commands/local-mcp-config/bridge.js";
import {
  commitTargetFile,
  readTargetStatus,
} from "../../out/cli/commands/local-mcp-config/file-ops.js";
import {
  CLIENTS,
  resolveTargets,
} from "../../out/cli/commands/remote-mcp-config/targets.js";

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  if (!cond) failed++;
};

const BAT = "E:/AI/embedded-mcp-toolkit/remote-start-mcp.bat";
const KEY = "embedded-board";
const bridge = buildLocalBridge(BAT);

// ============================================================
// 一、bridge 形态与 bat 探测边界
// ============================================================
{
  assert(
    JSON.stringify(bridge) ===
      JSON.stringify({ command: "cmd", args: ["/c", BAT] }),
    `bridge 形态 = cmd /c <bat 绝对路径>: ${JSON.stringify(bridge)}`
  );

  // 临时布局: <root>/remote-start-mcp.bat + <root>/bin/entry.js（bin wrapper 形态）
  const root = join(tmpdir(), `lmc-test-${Date.now()}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "remote-start-mcp.bat"), "placeholder");
  writeFileSync(join(root, "bin", "entry.js"), "// entry");
  const entry = join(root, "bin", "entry.js");

  // bin 上溯与 cwd 指向同一 bat → 去重为一条; exe 同目录候选不存在被过滤
  const found = detectBatCandidates(entry, root);
  assert(
    JSON.stringify(found) === JSON.stringify([join(root, "remote-start-mcp.bat")]),
    `bin wrapper 布局: 包根 bat 命中且去重 ${JSON.stringify(found)}`
  );

  // 无任何命中: 返回空数组（第二个空布局, 无 bat）
  const root2 = join(tmpdir(), `lmc-empty-${Date.now()}`);
  mkdirSync(join(root2, "bin"), { recursive: true });
  writeFileSync(join(root2, "bin", "entry.js"), "// entry");
  assert(
    detectBatCandidates(join(root2, "bin", "entry.js"), tmpdir()).length === 0,
    "无命中时返回空数组"
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(root2, { recursive: true, force: true });
}

// ============================================================
// 二、本地 file-ops 语义
// ============================================================
{
  const proj = join(tmpdir(), `lmc-proj-${Date.now()}`);
  mkdirSync(proj, { recursive: true });

  // claude 项目落点: .mcp.json(server) + .claude/settings.local.json(enable)
  const files = CLIENTS.claude.project.map((f) => ({
    ...f,
    remotePath: join(proj, f.remotePath.replace("{proj}/", "")),
  }));
  const [serverFile, enableFile] = files;

  // 未配置状态
  let st = await readTargetStatus(serverFile, bridge);
  assert(st.status === "absent", `写入前状态 absent: ${st.detail}`);

  // 写入（父目录 .claude 不存在, 应自动创建）
  assert(
    (await commitTargetFile(serverFile, { present: true, bridge })) === true,
    "server 落点写入返回 true"
  );
  assert(
    (await commitTargetFile(enableFile, { present: true, bridge })) === true,
    "enable 落点写入返回 true"
  );
  assert(
    existsSync(join(proj, ".claude", "settings.local.json")),
    "落点父目录 .claude 自动创建"
  );
  assert(
    !existsSync(join(proj, ".mcp.json.bak")),
    "首次写入（原文件不存在）不产生 .bak"
  );

  // 内容校验: server 形态 + 使能数组
  const mcpJson = JSON.parse(readFileSync(serverFile.remotePath, "utf-8"));
  assert(
    JSON.stringify(mcpJson.mcpServers[KEY]) ===
      JSON.stringify({ command: "cmd", args: ["/c", BAT] }),
    ".mcp.json server 形态正确"
  );
  const settings = JSON.parse(readFileSync(enableFile.remotePath, "utf-8"));
  assert(
    JSON.stringify(settings.enabledMcpjsonServers) === JSON.stringify([KEY]),
    "settings.local.json 使能数组正确"
  );

  // 状态 consistent + 重复写入（server 型总是重写, 与远端语义一致）
  st = await readTargetStatus(serverFile, bridge);
  assert(st.status === "consistent", `写入后状态 consistent: ${st.detail}`);
  assert(
    (await commitTargetFile(serverFile, { present: true, bridge })) === true,
    "重复写入返回 true（server 型总是重写, 顺带归一漂移字段）"
  );
  assert(
    existsSync(join(proj, ".mcp.json.bak")),
    "二次写入（文件已存在）产生首次 .bak 备份"
  );

  // 其它 key 保留: 预置含其它 server 的 .mcp.json → 写入后仍在
  const proj2 = join(tmpdir(), `lmc-proj2-${Date.now()}`);
  mkdirSync(proj2, { recursive: true });
  const serverFile2 = { ...serverFile, remotePath: join(proj2, ".mcp.json") };
  writeFileSync(
    serverFile2.remotePath,
    JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2) + "\n"
  );
  await commitTargetFile(serverFile2, { present: true, bridge });
  const kept = JSON.parse(readFileSync(serverFile2.remotePath, "utf-8"));
  assert(
    kept.mcpServers.other &&
      kept.mcpServers.other.command === "foo" &&
      kept.mcpServers[KEY],
    "同容器其它 server key 保留"
  );
  assert(
    existsSync(serverFile2.remotePath + ".bak"),
    "原文件已存在时产生 .bak 备份"
  );

  // 删除: server 与使能项移除, 重复删除返回 false
  assert(
    (await commitTargetFile(serverFile, { present: false })) === true,
    "删除 server 返回 true"
  );
  assert(
    (await commitTargetFile(enableFile, { present: false })) === true,
    "删除使能项返回 true"
  );
  assert(
    (await commitTargetFile(serverFile, { present: false })) === false,
    "重复删除返回 false"
  );
  const afterRemove = JSON.parse(readFileSync(serverFile.remotePath, "utf-8"));
  assert(
    !(KEY in (afterRemove.mcpServers ?? {})),
    "删除后 .mcp.json 无 embedded-board"
  );

  rmSync(proj, { recursive: true, force: true });
  rmSync(proj2, { recursive: true, force: true });
}

// ============================================================
// 三、全 agent 沙箱生成实测（沙箱保留, 供人工核对）
// ============================================================
{
  // 沙箱锚定脚本位置（不依赖 cwd）; 运行前删除一次, 运行后保留
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SANDBOX = resolve(HERE, "..", "..", ".embedded", "tmp", "lv-agent-test");
  rmSync(SANDBOX, { recursive: true, force: true });

  const HOME = resolve(SANDBOX, "home");
  const PROJ = resolve(SANDBOX, "proj");
  mkdirSync(HOME, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  const ctx = {
    getHome: async () => HOME,
    askProjectPath: async () => PROJ,
  };

  // 预置既有 .claude.json（验证保留与 .bak）
  const claudeGlobalAbs = resolve(HOME, ".claude.json");
  writeFileSync(
    claudeGlobalAbs,
    JSON.stringify(
      {
        mcpServers: { "other-server": { command: "node", args: ["other.js"] } },
        numStartups: 42,
      },
      null,
      2
    ) + "\n"
  );

  /** 一个落点的完整生成+校验 */
  async function generate(clientId, scope, expects, preStatus = "absent") {
    const tag = `${clientId}/${scope}`;
    const files = await resolveTargets(ctx, clientId, scope);
    if (!Array.isArray(files) || files.length === 0) {
      assert(false, `${tag} 落点解析失败（resolveTargets 返回空）`);
      return;
    }
    for (const file of files) {
      const status = await readTargetStatus(file, bridge);
      assert(
        status.status === preStatus,
        `${tag} 写入前状态=${preStatus} [${file.label}]`,
        status.detail
      );
      await commitTargetFile(file, { present: true, bridge });
    }
    for (const exp of expects) {
      const abs = resolve(exp.file.replace("{HOME}", HOME).replace("{PROJ}", PROJ));
      if (!existsSync(abs)) {
        assert(false, `${tag} 生成 ${exp.file}: 文件不存在`);
        continue;
      }
      const json = JSON.parse(readFileSync(abs, "utf-8"));
      for (const [jsonPath, expected] of exp.asserts) {
        let cur = json;
        for (const k of jsonPath) cur = cur?.[k];
        assert(
          JSON.stringify(cur) === JSON.stringify(expected),
          `${tag} ${exp.file} :: ${jsonPath.join(".")}`,
          `got ${JSON.stringify(cur)}`
        );
      }
      for (const [jsonPath, expected] of exp.preserve ?? []) {
        let cur = json;
        for (const k of jsonPath) cur = cur?.[k];
        assert(
          JSON.stringify(cur) === JSON.stringify(expected),
          `${tag} ${exp.file} 保留 :: ${jsonPath.join(".")}`,
          `got ${JSON.stringify(cur)}`
        );
      }
    }
  }

  // Claude 全局
  await generate("claude", "global", [
    {
      file: "{HOME}/.claude.json",
      asserts: [
        [["mcpServers", "embedded-board"], { command: "cmd", args: ["/c", BAT] }],
      ],
      preserve: [
        [["mcpServers", "other-server"], { command: "node", args: ["other.js"] }],
        [["numStartups"], 42],
      ],
    },
  ]);
  assert(existsSync(claudeGlobalAbs + ".bak"), ".claude.json 产生 .bak 备份");

  // Claude 项目（双文件）
  await generate("claude", "project", [
    {
      file: "{PROJ}/.mcp.json",
      asserts: [
        [["mcpServers", "embedded-board"], { command: "cmd", args: ["/c", BAT] }],
      ],
    },
    {
      file: "{PROJ}/.claude/settings.local.json",
      asserts: [[["enabledMcpjsonServers"], ["embedded-board"]]],
    },
  ]);

  // CodeBuddy 全局
  await generate("codebuddy", "global", [
    {
      file: "{HOME}/.codebuddy/mcp.json",
      asserts: [
        [
          ["mcpServers", "embedded-board"],
          { command: "cmd", args: ["/c", BAT], type: "stdio" },
        ],
      ],
    },
  ]);

  // CodeBuddy 项目（与 Claude 项目同文件: 先写入者已落 key → consistent）
  await generate(
    "codebuddy",
    "project",
    [
      {
        file: "{PROJ}/.mcp.json",
        asserts: [
          [["mcpServers", "embedded-board"], { command: "cmd", args: ["/c", BAT] }],
        ],
      },
    ],
    "consistent"
  );

  // ZCode 项目
  await generate("zcode", "project", [
    {
      file: "{PROJ}/.zcode/config.json",
      asserts: [
        [
          ["mcp", "servers", "embedded-board"],
          { command: "cmd", args: ["/c", BAT], type: "stdio", enabled: true },
        ],
      ],
    },
  ]);

  // DSH 项目
  await generate("dsh", "project", [
    {
      file: "{PROJ}/.dsh/dshmm/mcp.json",
      asserts: [
        [
          ["mcpServers", "embedded-board"],
          { command: "cmd", args: ["/c", BAT], type: "stdio", cwd: "" },
        ],
      ],
    },
  ]);

  // opencode 全局（数组形态 + $schema 补齐）
  await generate("opencode", "global", [
    {
      file: "{HOME}/.config/opencode/opencode.json",
      asserts: [
        [["$schema"], "https://opencode.ai/config.json"],
        [
          ["mcp", "embedded-board"],
          {
            type: "local",
            command: ["cmd", "/c", BAT],
            enabled: true,
            timeout: 600000,
          },
        ],
      ],
    },
  ]);

  // opencode 项目
  await generate("opencode", "project", [
    {
      file: "{PROJ}/.opencode/opencode.json",
      asserts: [
        [
          ["mcp", "embedded-board"],
          {
            type: "local",
            command: ["cmd", "/c", BAT],
            enabled: true,
            timeout: 600000,
          },
        ],
      ],
    },
  ]);

  console.log(
    `沙箱已保留, 供人工核对: ${SANDBOX}`
  );
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} assertion(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
