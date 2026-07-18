import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   greet_tool MCP test                    ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  try {
    const conn = await connect({ name: "test-greet" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  console.log("\n── 测试: greet 工具基本调用 ──");

  try {
    const result = await client.callTool({
      name: "greet_tool",
      arguments: { name: "MCP" },
    });

    printResult(result);

    const text = result.content.map((c) => c.text).join("");
    assert(text === "Hello, MCP!", "返回正确的问候语");
  } catch (err) {
    fail("greet_tool 调用", err.message);
  }

  await client.close();
  console.log("\n── 测试完成 ──");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
