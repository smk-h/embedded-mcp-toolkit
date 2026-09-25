#!/usr/bin/env node
/**
 * =====================================================
 * remote-mcp-config 客户端落点快照测试
 *
 * 锁住「每类客户端 × 每个配置范围」在远端写哪几个文件、server 对象长什么样，
 * 作为 targets.ts 落点数据表的安全网。覆盖：
 *   1. 数据表完备性与客户端菜单顺序（新增客户端须在此补期望）
 *   2. 八类落点的路径、label、server 容器路径与 render 形态（逐字段）
 *   3. 取消语义：项目路径为空时 resolveTargets 返回 null
 *   4. 全局落点经 getHome 展开 ~（不得硬编码家目录）
 *   5. Claude 与 CodeBuddy 项目级共用 .mcp.json：形态须逐字节一致
 *   6. json-mutate 纯函数的写入/删除往返（锁住"怎么写"的一半）
 *
 * 全部断言通过输出 ALL PASS 并退出码 0，否则列出失败项。
 * 运行：node test/cli/remote-mcp-config-clients.mjs（需先 npm run build）
 * ======================================================
 */
import {
  CLIENTS,
  resolveTargets,
  supportedScopes,
} from "../../out/cli/commands/remote-mcp-config/targets.js";
import { buildBridgeServer } from "../../out/cli/commands/remote-mcp-config/bridge.js";
import {
  ensureInArray,
  getContainerAtPath,
  getValueAtPath,
  removeFromArray,
  removeServerAtPath,
  setServerAtPath,
} from "../../out/cli/commands/remote-mcp-config/json-mutate.js";

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  if (!cond) failed++;
};

/** @brief 断言落点为期望类型（判别联合收窄）；不符时记失败并返回 false */
const assertKind = (file, kind, tag) => {
  if (file.kind !== kind) {
    assert(false, `${tag} 落点应为 ${kind} 型，实际 ${file.kind}`);
    return false;
  }
  return true;
};

// ── 固定输入 ──────────────────────────────────────────────
const HOME = "/home/u";
const ALT_HOME = "/alt/home";
const PROJ = "/proj";
const KEY = "embedded-board";
const BRIDGE = buildBridgeServer("sumu", "1.2.3.4", "/p/remote-start-mcp.bat");
const A = BRIDGE.args;

/** 桩上下文：家目录与项目路径固定，使落点可复现 */
const ctx = {
  getHome: async () => HOME,
  askProjectPath: async () => PROJ,
};
/** 取消桩：用户在项目路径问答中取消 */
const cancelCtx = {
  getHome: async () => HOME,
  askProjectPath: async () => null,
};
/** 换一个家目录，用于验证 ~ 确实经 getHome 展开 */
const altCtx = {
  getHome: async () => ALT_HOME,
  askProjectPath: async () => PROJ,
};

/**
 * 重构前的期望快照：{ key: [ { path, label, jsonPath?, render?, enable?,
 * enableValue?, rootSchema? } ] }。字段顺序即写入顺序，故用 JSON 串全等比对。
 */
const EXPECTED = {
  "claude/global": [
    {
      path: `${HOME}/.claude.json`,
      label: "Claude 全局",
      jsonPath: ["mcpServers"],
      render: { command: "ssh", args: A },
    },
  ],
  "claude/project": [
    {
      path: `${PROJ}/.mcp.json`,
      label: "Claude 项目（.mcp.json server 定义）",
      jsonPath: ["mcpServers"],
      render: { command: "ssh", args: A },
    },
    {
      path: `${PROJ}/.claude/settings.local.json`,
      label: "Claude 项目（settings.local.json 使能）",
      enable: ["enabledMcpjsonServers"],
      enableValue: KEY,
    },
  ],
  "codebuddy/global": [
    {
      path: `${HOME}/.codebuddy/mcp.json`,
      label: "CodeBuddy 全局（~/.codebuddy/mcp.json）",
      jsonPath: ["mcpServers"],
      render: { command: "ssh", args: A, type: "stdio" },
    },
  ],
  "codebuddy/project": [
    {
      path: `${PROJ}/.mcp.json`,
      label: "CodeBuddy 项目（.mcp.json，与 Claude 共用）",
      jsonPath: ["mcpServers"],
      render: { command: "ssh", args: A },
    },
  ],
  "zcode/project": [
    {
      path: `${PROJ}/.zcode/config.json`,
      label: "ZCode 项目",
      jsonPath: ["mcp", "servers"],
      render: { command: "ssh", args: A, type: "stdio", enabled: true },
    },
  ],
  "dsh/project": [
    {
      path: `${PROJ}/.dsh/dshmm/mcp.json`,
      label: "DSH 项目（.dsh/dshmm/mcp.json）",
      jsonPath: ["mcpServers"],
      render: { command: "ssh", args: A, type: "stdio", cwd: "" },
    },
  ],
  "opencode/global": [
    {
      path: `${HOME}/.config/opencode/opencode.json`,
      label: "opencode 全局（~/.config/opencode/opencode.json）",
      jsonPath: ["mcp"],
      render: {
        type: "local",
        command: ["ssh", ...A],
        enabled: true,
        timeout: 600000,
      },
      rootSchema: "https://opencode.ai/config.json",
    },
  ],
  "opencode/project": [
    {
      path: `${PROJ}/.opencode/opencode.json`,
      label: "opencode 项目（.opencode/opencode.json）",
      jsonPath: ["mcp"],
      render: {
        type: "local",
        command: ["ssh", ...A],
        enabled: true,
        timeout: 600000,
      },
      rootSchema: "https://opencode.ai/config.json",
    },
  ],
};

// ── 1. 数据表完备性与菜单顺序 ─────────────────────────────
const ENTRIES = Object.entries(CLIENTS);
assert(
  Object.keys(CLIENTS).join(",") === "claude,zcode,opencode,dsh,codebuddy",
  "客户端菜单顺序为 claude > zcode > opencode > dsh > codebuddy"
);
assert(
  Object.values(CLIENTS)
    .map((spec) => spec.label)
    .join("|") === "Claude Code|ZCode|opencode|DSH (DeepSeek Harness)|CodeBuddy",
  "客户端菜单文案与数据表一致"
);
assert(Object.keys(CLIENTS).length === 5, "数据表恰有 5 个客户端");
for (const [id, spec] of ENTRIES) {
  assert(CLIENTS[id] === spec, `数据表按 id 可反查落点数据：${id}`);
}

// ── 2. 八类落点的路径、label 与写入形态 ───────────────────
for (const [id, spec] of ENTRIES) {
  for (const scope of supportedScopes(spec)) {
    const key = `${id}/${scope}`;
    const expected = EXPECTED[key];
    if (!expected) {
      assert(false, `期望快照缺少用例 ${key}`);
      continue;
    }
    const files = await resolveTargets(ctx, id, scope);
    assert(
      Array.isArray(files) && files.length === expected.length,
      `${key} 落点文件数 = ${expected.length}`
    );
    if (!Array.isArray(files)) continue;
    files.forEach((file, i) => {
      const exp = expected[i];
      if (!exp) return;
      assert(file.remotePath === exp.path, `${key}[${i}] 路径 ${exp.path}`);
      assert(file.label === exp.label, `${key}[${i}] label 未变`);
      if (exp.jsonPath) {
        if (!assertKind(file, "server", `${key}[${i}]`)) return;
        assert(
          JSON.stringify(file.slot.path) === JSON.stringify(exp.jsonPath),
          `${key}[${i}] server 容器路径 ${exp.jsonPath.join(".")}`
        );
        assert(
          JSON.stringify(file.slot.render(BRIDGE)) ===
            JSON.stringify(exp.render),
          `${key}[${i}] render 形态 ${JSON.stringify(exp.render)}`
        );
      }
      if (exp.enable) {
        if (!assertKind(file, "enable", `${key}[${i}]`)) return;
        assert(
          JSON.stringify(file.enable.path) === JSON.stringify(exp.enable),
          `${key}[${i}] 使能数组路径 ${exp.enable.join(".")}`
        );
        assert(
          file.enable.value === exp.enableValue,
          `${key}[${i}] 使能值 ${exp.enableValue}`
        );
      }
      if (exp.rootSchema) {
        if (!assertKind(file, "server", `${key}[${i}]`)) return;
        assert(
          file.rootSchema === exp.rootSchema,
          `${key}[${i}] rootSchema 补齐`
        );
      }
    });
  }
}

// ── 3. 取消语义：项目路径为空 → resolveTargets 返回 null ──
for (const [id, spec] of ENTRIES) {
  if (!supportedScopes(spec).includes("project")) continue;
  const files = await resolveTargets(cancelCtx, id, "project");
  assert(files === null, `${id} 项目路径取消时返回 null`);
}

// ── 4. 全局落点经 getHome 展开 ~ ──────────────────────────
for (const [id, spec] of ENTRIES) {
  if (!supportedScopes(spec).includes("global")) continue;
  const files = await resolveTargets(altCtx, id, "global");
  assert(
    !!files && files.every((f) => f.remotePath.startsWith(ALT_HOME + "/")),
    `${id} 全局落点随 getHome 变化（未硬编码家目录）`
  );
}

// ── 5. Claude 与 CodeBuddy 项目级共用 .mcp.json，形态须一致 ─
{
  const claudeProj = (await resolveTargets(ctx, "claude", "project"))[0];
  const cbProj = (await resolveTargets(ctx, "codebuddy", "project"))[0];
  if (
    assertKind(claudeProj, "server", "claude/project[0]") &&
    assertKind(cbProj, "server", "codebuddy/project[0]")
  ) {
    assert(
      claudeProj.remotePath === cbProj.remotePath,
      "Claude 与 CodeBuddy 项目级落在同一文件 <proj>/.mcp.json"
    );
    assert(
      JSON.stringify(claudeProj.slot.render(BRIDGE)) ===
        JSON.stringify(cbProj.slot.render(BRIDGE)),
      "两者 server 形态逐字节一致（同一文件内容唯一确定）"
    );
    assert(
      !("type" in cbProj.slot.render(BRIDGE)),
      "项目级不写 type（含 command 时由客户端自动推断为 stdio）"
    );
  }
}

// ── 6. json-mutate 往返：写入 → 读回 → 删除 ───────────────
{
  // 嵌套容器：沿 path 建对象
  const json = {};
  const zcode = (await resolveTargets(ctx, "zcode", "project"))[0];
  if (assertKind(zcode, "server", "zcode/project[0]")) {
    setServerAtPath(json, zcode.slot.path, KEY, zcode.slot.render(BRIDGE));
    const container = getContainerAtPath(json, ["mcp", "servers"]);
    assert(
      !!container &&
        JSON.stringify(container[KEY]) ===
          JSON.stringify(zcode.slot.render(BRIDGE)),
      "setServerAtPath 沿嵌套 path 建容器并写入 server"
    );
    assert(
      removeServerAtPath(json, ["mcp", "servers"], KEY) === true,
      "removeServerAtPath 删除已存在的 server 返回 true"
    );
    assert(
      removeServerAtPath(json, ["mcp", "servers"], KEY) === false,
      "removeServerAtPath 重复删除返回 false"
    );
  }

  // 使能数组：去重追加 / 移除
  const arr = [];
  assert(ensureInArray(arr, KEY) === true, "ensureInArray 首次追加返回 true");
  assert(
    ensureInArray(arr, KEY) === false,
    "ensureInArray 重复追加返回 false（不产生重复项）"
  );
  assert(
    JSON.stringify(getValueAtPath({ enabledMcpjsonServers: arr }, [
      "enabledMcpjsonServers",
    ])) === JSON.stringify([KEY]),
    "getValueAtPath 可取到数组叶子值"
  );
  assert(
    removeFromArray(arr, KEY) === true && arr.length === 0,
    "removeFromArray 移除后数组为空"
  );
}

console.log(
  failed === 0 ? "\nALL PASS" : `\n${failed} assertion(s) FAILED`
);
process.exit(failed === 0 ? 0 : 1);
