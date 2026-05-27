import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";

async function testDefaultDevice(client) {
  console.log("\n── 测试 1: 获取默认设备信息 ──");

  const result = await client.callTool({
    name: "device_info_tool",
    arguments: {},
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(text.includes("Device:"), "返回包含 Device 字段");
  assert(text.includes("[SSH]"), "返回包含 [SSH] 段");
  assert(text.includes("[Serial]"), "返回包含 [Serial] 段");
  assert(text.includes("Available:"), "返回包含 Available 设备列表");
}

async function testSpecificDevice(client) {
  console.log("\n── 测试 2: 获取指定设备信息 ──");

  const result = await client.callTool({
    name: "device_info_tool",
    arguments: { device: "board-a" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  assert(text.includes("Device: board-a"), "返回正确的设备名");
  assert(text.includes("192.168.16.103"), "返回 board-a 的 SSH 地址");
}

async function testNonexistentDevice(client) {
  console.log("\n── 测试 3: 查询不存在的设备 ──");

  const result = await client.callTool({
    name: "device_info_tool",
    arguments: { device: "nonexistent-board" },
  });

  printResult(result);

  const text = result.content.map((c) => c.text).join("");
  const isError =
    result.isError ||
    text.includes("not found") ||
    text.includes("nonexistent-board");

  assert(isError, "不存在的设备应返回错误信息", text);
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   device_info_tool MCP test              ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  const serverEnv = {
    DEVICE: "board-b",
    BOARD_CONFIG_PATH: "./configs/config.yaml",
    LOG_SAVE: "1",
    LOG_DIR: "./log",
  };

  try {
    const conn = await connect({ name: "test-device-info", env: serverEnv });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  const tests = [testDefaultDevice, testSpecificDevice, testNonexistentDevice];

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
