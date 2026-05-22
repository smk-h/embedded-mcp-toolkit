#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { SSHManager } from "./ssh.js";
import { readFileSync } from "node:fs";

// ── helpers ────────────────────────────────────────────────

function text(content: string): TextContent {
  return { type: "text", text: content };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── config ─────────────────────────────────────────────────

interface Config {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string | null;
}

const config: Config = {
  host: process.env.BOARD_HOST || "192.168.16.103",
  port: parseInt(process.env.BOARD_PORT || "22", 10),
  username: process.env.BOARD_USERNAME || "root",
  password: process.env.BOARD_PASSWORD || "root",
  privateKey: process.env.BOARD_PRIVATE_KEY || null,
};

// ── MCP server ─────────────────────────────────────────────

const ssh = new SSHManager(config);

const server = new Server(
  {
    name: "embedded-mcp-toolkit",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "exec",
      description: "Execute a shell command on the remote board",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: "Command timeout in seconds (default: 30)" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read the content of a file on the remote board",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file on the remote board",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_dir",
      description: "List contents of a directory on the remote board",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "dmesg",
      description: "Get kernel ring buffer messages from the remote board",
      inputSchema: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Number of recent lines to show (default: all)" },
        },
      },
    },
    {
      name: "system_info",
      description: "Get system information from the remote board (hostname, kernel, uptime, memory, CPU)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "upload_file",
      description: "Upload a local file to the remote board",
      inputSchema: {
        type: "object",
        properties: {
          local_path: { type: "string", description: "Absolute path to local file" },
          remote_path: { type: "string", description: "Absolute destination path on board" },
        },
        required: ["local_path", "remote_path"],
      },
    },
  ],
}));

// ── tool handlers ──────────────────────────────────────────

interface ToolArgs {
  command?: string;
  timeout?: number;
  path?: string;
  content?: string;
  lines?: number;
  local_path?: string;
  remote_path?: string;
}

async function handleToolCall(name: string, args: ToolArgs): Promise<CallToolResult> {
  switch (name) {
    case "exec": {
      const result = await ssh.exec(args.command!);
      const contents: CallToolResult["content"] = [
        text(result.stdout || "(no output)"),
      ];
      if (result.stderr) {
        contents.push(text(`STDERR:\n${result.stderr}`));
      }
      contents.push(text(`\nExit code: ${result.exitCode}`));
      return { content: contents };
    }

    case "read_file": {
      const content = await ssh.readFile(args.path!);
      return { content: [text(content)] };
    }

    case "write_file": {
      await ssh.writeFile(args.path!, args.content!);
      return { content: [text(`File written: ${args.path}`)] };
    }

    case "list_dir": {
      const entries = await ssh.listDir(args.path!);
      const output = entries.map((e) => e.longname).join("\n") || "(empty directory)";
      return { content: [text(output)] };
    }

    case "dmesg": {
      const cmd = args.lines ? `dmesg | tail -${args.lines}` : "dmesg";
      const result = await ssh.exec(cmd);
      return { content: [text(result.stdout || "(no output)")] };
    }

    case "system_info": {
      const cmds = [
        "echo '=== Hostname ===' && hostname",
        "echo '=== Kernel ===' && uname -a",
        "echo '=== Uptime ===' && uptime",
        "echo '=== Memory ===' && free -h",
        "echo '=== CPU ===' && cat /proc/cpuinfo | grep 'model name' | head -1",
        "echo '=== Disk ===' && df -h /",
      ];
      const result = await ssh.exec(cmds.join(" && "));
      return { content: [text(result.stdout)] };
    }

    case "upload_file": {
      const content = readFileSync(args.local_path!, "utf8");
      await ssh.writeFile(args.remote_path!, content);
      return { content: [text(`Uploaded ${args.local_path} -> ${args.remote_path}`)] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    return await handleToolCall(name, (args as ToolArgs) || {});
  } catch (err: unknown) {
    return {
      content: [text(`Error: ${getErrorMessage(err)}`)],
      isError: true,
    };
  }
});

// ── entrypoint ─────────────────────────────────────────────

async function main() {
  try {
    console.error(`Connecting to ${config.host}:${config.port} as ${config.username}...`);
    await ssh.connect();
    console.error("SSH connection established.");
  } catch (err: unknown) {
    console.error(`Warning: Initial SSH connection failed: ${getErrorMessage(err)}`);
    console.error("Tools will attempt to connect on each call.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server started on stdio.");
}

main().catch((err: unknown) => {
  console.error("Fatal error:", getErrorMessage(err));
  process.exit(1);
});
