import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

/**
 * 测试 1: 使用有效的目标 IP 调用 subnet_check_tool
 * 验证返回结果包含必要的结构字段
 */
async function testValidTargetIP(client) {
  console.log("\n── 测试 1: 有效目标 IP 调用 ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "8.8.8.8" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(!result.isError, "调用未返回 MCP 错误");

  // 验证输出包含关键结构字段
  assert(text.includes("Subnet Check for Target IP"), "包含标题行");
  assert(text.includes("Adapter:"), "包含 Adapter 信息");
  assert(text.includes("IP Address:"), "包含 IP Address 字段");
  assert(text.includes("Subnet Mask:"), "包含 Subnet Mask 字段");
  assert(text.includes("Default Gateway:"), "包含 Default Gateway 字段");
  assert(text.includes("Subnet Analysis"), "包含 Subnet Analysis 段");
  assert(text.includes("Network Address:"), "包含 Network Address 字段");
  assert(text.includes("Broadcast Address:"), "包含 Broadcast Address 字段");
  assert(text.includes("Usable Host Range:"), "包含 Usable Host Range 字段");

  // 8.8.8.8 通常不在任何本地子网内，应显示 NOT reachable
  const hasReachable =
    text.includes("REACHABLE") || text.includes("NOT in this subnet");
  assert(hasReachable, "包含可达性判断结果（REACHABLE 或 NOT in this subnet）");
}

/**
 * 测试 2: 无效 IP 格式应返回错误提示
 */
async function testInvalidIP(client) {
  console.log("\n── 测试 2: 无效 IP 格式 ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "not-an-ip" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(
    text.includes("Invalid target IP") || text.includes("Invalid"),
    "无效 IP 应返回错误提示"
  );
}

/**
 * 测试 3: 非标准但合法的 IP（如 0.0.0.0）应能被正常解析
 */
async function testSpecialValidIP(client) {
  console.log("\n── 测试 3: 特殊合法 IP ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "0.0.0.0" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  // 0.0.0.0 是合法 IPv4 地址，不应出现 "Invalid" 错误
  const isInvalid = text.includes("Invalid target IP");
  // 这里只要能正常解析出结果即可（不论是否可达）
  const hasAdapterOrReachable =
    text.includes("Adapter:") || text.includes("Subnet Analysis");
  assert(
    !isInvalid && hasAdapterOrReachable,
    "0.0.0.0 应被正常解析并返回子网分析结果（不报 Invalid 错误）"
  );
}

/**
 * 测试 4: 格式异常的 IP（超出范围的数字）
 */
async function testOutOfRangeIP(client) {
  console.log("\n── 测试 4: 超出范围的 IP ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "999.999.999.999" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(
    text.includes("Invalid"),
    "超出范围的 IP 应返回 Invalid 错误"
  );
}

/**
 * 测试 5: 127.0.0.1 回环地址
 */
async function testLoopbackIP(client) {
  console.log("\n── 测试 5: 回环地址 127.0.0.1 ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "127.0.0.1" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  // 127.0.0.1 是合法 IP，应能正常执行（不在任何物理适配器子网内是正常的）
  assert(text.includes("Subnet Analysis"), "回环地址应能正常执行子网分析");
  assert(text.includes("Adapter:"), "包含 Adapter 信息");
}

/**
 * 测试 6: 局域网内网 IP 192.168.16.105
 */
async function testLanIP(client) {
  console.log("\n── 测试 6: 局域网 IP 192.168.16.105 ──");

  const result = await client.callTool({
    name: "subnet_check_tool",
    arguments: { target_ip: "192.168.16.105" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(!result.isError, "调用未返回 MCP 错误");
  assert(text.includes("Subnet Check for Target IP: 192.168.16.105"), "包含正确的目标 IP 标题");
  assert(text.includes("Subnet Analysis"), "包含 Subnet Analysis 段");
  assert(text.includes("Network Address:"), "包含 Network Address 字段");
  assert(text.includes("Broadcast Address:"), "包含 Broadcast Address 字段");

  // 验证可达性判断结果存在（不论 REACHABLE 还是 NOT in this subnet）
  const hasReachableJudgment =
    text.includes("REACHABLE") || text.includes("NOT in this subnet");
  assert(hasReachableJudgment, "包含对 192.168.16.105 的可达性判断");
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   subnet_check_tool MCP test             ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  try {
    const conn = await connect({ name: "test-subnet-check" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  // 检查当前平台
  const platformResult = await client.callTool({
    name: "version_tool",
    arguments: {},
  });
  const platformText = platformResult.content.map((c) => c.text).join("");
  const isWindows = platformText.includes("Platform: win32");

  if (!isWindows) {
    console.log("\n  ℹ 当前非 Windows 平台，只验证跨平台错误信息");

    const result = await client.callTool({
      name: "subnet_check_tool",
      arguments: { target_ip: "8.8.8.8" },
    });
    const text = result.content.map((c) => c.text).join("");
    assert(
      text.includes("only works on Windows"),
      "非 Windows 平台应返回平台限制提示"
    );

    await client.close();
    console.log("\n── 测试完成 ──");
    return;
  }

  const tests = [
    testValidTargetIP,
    testInvalidIP,
    testSpecialValidIP,
    testOutOfRangeIP,
    testLoopbackIP,
    testLanIP,
  ];

  let passed = 0;
  let total = 0;

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
