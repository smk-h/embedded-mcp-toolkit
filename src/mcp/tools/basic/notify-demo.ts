import { fromJsonSchema } from "@modelcontextprotocol/server";
import { text } from "../../tool-registry.js";
import { logger } from "../../../shared/logger.js";
import { server } from "../../server.js";

export const notifyDemoConfig = {
  description:
    "Demonstrate server-to-client notifications: send logging messages or trigger list_changed events",
  inputSchema: fromJsonSchema<{
    type: string;
    message?: string;
    level?: string;
  }>({
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["logging", "tool_list_changed", "both"],
        description:
          "Notification type: logging=sends a log message, tool_list_changed=triggers re-fetch of tools, both=sends both",
      },
      message: {
        type: "string",
        description: "Custom message data for the logging notification",
      },
      level: {
        type: "string",
        enum: [
          "debug",
          "info",
          "notice",
          "warning",
          "error",
          "critical",
          "alert",
          "emergency",
        ],
        description: "Log level for the logging notification (default: notice)",
      },
    },
    required: ["type"],
  }),
};

export async function notifyDemoHandler(args: {
  type: string;
  message?: string;
  level?: string;
}) {
  const results: string[] = [];

  if (args.type === "logging" || args.type === "both") {
    const level = (args.level ?? "notice") as
      | "debug"
      | "info"
      | "notice"
      | "warning"
      | "error"
      | "critical"
      | "alert"
      | "emergency";
    const data =
      args.message ??
      `MCP server proactive notification at ${new Date().toISOString()}`;

    logger.info(
      `[notify_demo] sending logging message, level=${level}, data=${data}`
    );

    await server.sendLoggingMessage({
      level,
      logger: "notify-demo",
      data,
    });

    results.push(`logging message sent (level=${level})`);
  }

  if (args.type === "tool_list_changed" || args.type === "both") {
    logger.info(`[notify_demo] sending tool_list_changed notification`);

    server.sendToolListChanged();

    results.push("tool_list_changed notification sent");
  }

  return { content: [text(results.join("\n"))] };
}
