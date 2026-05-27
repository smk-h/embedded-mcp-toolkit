import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

async function testPortScan(client) {
  console.log("\n── 测试 1: 扫描端口 ──");

  const result = await client.callTool({
    name: "port_scan_tool",
    arguments: {},
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(!result.isError, "调用未返回错误");

  // 应该包含 COM 或 LPT 或 "No" 关键字（无端口时）
  const hasPorts =
    text.includes("COM") ||
    text.includes("LPT") ||
    text.includes("No COM/LPT ports");
  assert(hasPorts, "返回包含端口信息或无端口提示");
}

async function testPortScanNoArgs(client) {
  console.log("\n── 测试 2: 无参数调用 ──");

  const result = await client.callTool({
    name: "port_scan_tool",
    arguments: {},
  });

  const text = result.content.map((c) => c.text).join("");
  assert(text.length > 0, "返回非空内容");
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   port_scan_tool MCP test                ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  try {
    const conn = await connect({ name: "test-port-scan" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  const tests = [testPortScan, testPortScanNoArgs];

  for (const test of tests) {
    try {
      await test(client);
    } catch (err) {
      fail(test.name, err.message);
    }
  }

  await client.close();
  console.log("\n── 测试完成 ──");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
