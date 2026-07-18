import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   version_tool MCP test                  ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  try {
    const conn = await connect({ name: "test-version" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  console.log("\n── 测试: 获取版本信息 ──");

  try {
    const result = await client.callTool({
      name: "version_tool",
      arguments: {},
    });

    printResult(result);

    const text = result.content.map((c) => c.text).join("");
    assert(text.includes("Name:"), "返回包含 Name 字段");
    assert(text.includes("Version:"), "返回包含 Version 字段");
    assert(text.includes("Node:"), "返回包含 Node 字段");
    assert(text.includes("Platform:"), "返回包含 Platform 字段");
  } catch (err) {
    fail("version_tool 调用", err.message);
  }

  await client.close();
  console.log("\n── 测试完成 ──");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
