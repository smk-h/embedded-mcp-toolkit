import { connect } from "./client.mjs";
import { pass, fail, assert, printResult } from "./common.mjs";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   notify_demo MCP notification test      ║");
  console.log("╚══════════════════════════════════════════╝");

  let client;
  let notificationsReceived = [];

  try {
    const conn = await connect({ name: "test-notifications" });
    client = conn.client;
    pass("MCP 服务器连接成功");
  } catch (err) {
    fail("MCP 服务器连接", err.message);
    process.exit(1);
  }

  console.log("\n── 订阅日志并注册通知处理器 ──");

  // 0. 必须先调用 logging/setLevel 让服务端启用日志通知
  try {
    await client.setLoggingLevel("debug");
    pass("logging level 已设为 debug");
  } catch (err) {
    fail("设置 logging level", err.message);
  }

  // 1. 注册 logging/message 通知处理器 (通用消息推送)
  try {
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        const { level, data, logger } = notification.params;
        const msg = typeof data === "string" ? data : JSON.stringify(data);
        notificationsReceived.push({ type: "logging", level, data: msg, logger });
        console.log(`  ⬅ 收到通知: [${level}] ${logger ? `(${logger}) ` : ""}${msg}`);
      }
    );
    pass("logging/message 通知处理器已注册");
  } catch (err) {
    fail("注册 logging 通知处理器", err.message);
  }

  // 2. 使用 fallback 处理器捕获所有未匹配的通知
  try {
    client.fallbackNotificationHandler = async (notification) => {
      console.log(`  ⬅ 收到未匹配通知: method=${notification.method}`);
      notificationsReceived.push({ type: "fallback", method: notification.method });
    };
    pass("fallback 通知处理器已注册");
  } catch (err) {
    fail("注册 fallback 通知处理器", err.message);
  }

  // ═══════════════════════════════════════════
  // 测试 1: logging 通知
  // ═══════════════════════════════════════════
  console.log("\n── 测试 1: 触发 logging 通知 ──");

  try {
    const result = await client.callTool({
      name: "notify_demo_tool",
      arguments: {
        type: "logging",
        message: "Hello from notify_demo!",
        level: "notice",
      },
    });
    printResult(result);

    // 等待异步通知到达
    await new Promise((r) => setTimeout(r, 500));

    const logNotif = notificationsReceived.find((n) => n.type === "logging");
    assert(
      logNotif !== undefined,
      "收到 logging 通知",
      logNotif ? `content: ${logNotif.data}` : ""
    );
    if (logNotif) {
      assert(
        logNotif.data.includes("Hello from notify_demo!"),
        "通知内容正确",
        logNotif.data
      );
    }
  } catch (err) {
    fail("notify_demo_tool (logging)", err.message);
  }

  // ═══════════════════════════════════════════
  // 测试 2: tool_list_changed 通知
  // ═══════════════════════════════════════════
  console.log("\n── 测试 2: 触发 tool_list_changed 通知 ──");

  try {
    notificationsReceived = [];

    const result = await client.callTool({
      name: "notify_demo_tool",
      arguments: { type: "tool_list_changed" },
    });
    printResult(result);

    await new Promise((r) => setTimeout(r, 500));

    const tlNotif = notificationsReceived.find(
      (n) => n.method === "notifications/tools/list_changed"
    );
    assert(
      tlNotif !== undefined,
      "收到 tool_list_changed 通知",
      tlNotif ? `method: ${tlNotif.method}` : ""
    );
  } catch (err) {
    fail("notify_demo_tool (tool_list_changed)", err.message);
  }

  // ═══════════════════════════════════════════
  // 测试 3: both (logging + tool_list_changed)
  // ═══════════════════════════════════════════
  console.log("\n── 测试 3: 同时触发两种通知 ──");

  try {
    notificationsReceived = [];

    const result = await client.callTool({
      name: "notify_demo_tool",
      arguments: {
        type: "both",
        message: "Combined notification test",
        level: "info",
      },
    });
    printResult(result);

    await new Promise((r) => setTimeout(r, 500));

    const hasLogging = notificationsReceived.some((n) => n.type === "logging");
    const hasTLChange = notificationsReceived.some(
      (n) => n.method === "notifications/tools/list_changed"
    );

    assert(hasLogging, "同时收到 logging 通知");
    assert(hasTLChange, "同时收到 tool_list_changed 通知");
  } catch (err) {
    fail("notify_demo_tool (both)", err.message);
  }

  await client.close();
  console.log("\n── 通知测试完成 ──");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
