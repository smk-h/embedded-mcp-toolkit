import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

async function testNetworkScan(client) {
  console.log("\n── 测试 1: 扫描网络适配器 ──");

  const result = await client.callTool({
    name: "network_scan_tool",
    arguments: {},
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(!result.isError, "调用未返回错误");

  const hasAdapters =
    text.includes("Network Adapters") || text.includes("No network adapters");
  assert(hasAdapters, "返回包含适配器信息或无适配器提示");
}

async function testNetworkScanDetail(client) {
  console.log("\n── 测试 2: 验证返回字段 ──");

  const result = await client.callTool({
    name: "network_scan_tool",
    arguments: {},
  });

  const text = result.content.map((c) => c.text).join("");
  if (text.includes("No network adapters")) {
    pass("无适配器，跳过字段验证");
    return;
  }

  assert(text.includes("DeviceID:"), "包含 DeviceID 字段");
  assert(text.includes("Status:"), "包含 Status 字段");
  assert(text.includes("Speed:"), "包含 Speed 字段");
  assert(text.includes("MAC Address:"), "包含 MAC Address 字段");
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   network_scan_tool MCP test             ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  try {
    const conn = await connect({ name: "test-network-scan" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  const tests = [testNetworkScan, testNetworkScanDetail];

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
