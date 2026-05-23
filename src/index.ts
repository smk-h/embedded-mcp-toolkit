#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { SSHManager } from "./ssh.js";
import { SerialManager } from "./serial.js";
import { ShellStateManager } from "./shell-state.js";
import { readFileSync } from "node:fs";

// ── helpers ────────────────────────────────────────────────

function text(content: string): TextContent {
  return { type: "text", text: content };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

// ── config ─────────────────────────────────────────────────

interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string | null;
  hostKeyAlgorithms: string[] | undefined;
}

interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 8 | 5 | 6 | 7;
  stopBits: 1 | 1.5 | 2;
  parity: "none" | "even" | "odd";
}

const useSSH = process.env.BOARD_HOST !== undefined;
const useSerial = process.env.SERIAL_PORT !== undefined;

let ssh: SSHManager | null = null;
let serial: SerialManager | null = null;
let sshConfig: SSHConfig | null = null;
let serialConfig: SerialConfig | null = null;
let shellState: ShellStateManager | null = null;

if (useSSH) {
  const hostKeyAlgorithmsStr = process.env.BOARD_HOST_KEY_ALGORITHMS || "";
  const hostKeyAlgorithms = hostKeyAlgorithmsStr
    ? hostKeyAlgorithmsStr.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  // 旧版内核(4.x)的 SSH 服务仅支持 ssh-rsa 主机密钥算法，
  // 而新版 ssh2 客户端默认已禁用此算法，
  // 通过 BOARD_HOST_KEY_ALGORITHMS 环境变量可显式指定算法列表，
  // 避免 "no matching host key type found" 错误。

  sshConfig = {
    host: process.env.BOARD_HOST!,
    port: parseInt(process.env.BOARD_PORT || "22", 10),
    username: process.env.BOARD_USERNAME || "root",
    password: process.env.BOARD_PASSWORD || "root",
    privateKey: process.env.BOARD_PRIVATE_KEY || null,
    hostKeyAlgorithms,
  };
  ssh = new SSHManager(sshConfig);
}

if (useSerial) {
  serialConfig = {
    port: process.env.SERIAL_PORT!,
    baudRate: parseInt(process.env.SERIAL_BAUDRATE || "115200", 10),
    dataBits: (parseInt(process.env.SERIAL_DATABITS || "8", 10) as 8 | 5 | 6 | 7),
    stopBits: (parseInt(process.env.SERIAL_STOPBITS || "1", 10) as 1 | 1.5 | 2),
    parity: (process.env.SERIAL_PARITY || "none") as "none" | "even" | "odd",
  };
  serial = new SerialManager(serialConfig);
}

// ── Shell State Manager ─────────────────────────────────────

shellState = ShellStateManager.fromEnv();
if (ssh) {
  ssh.setShellStateManager(shellState);
}
if (serial) {
  serial.setShellStateManager(shellState);
}

if (shellState.profile.name !== "heuristic") {
  console.error(`ShellStateManager: using profile '${shellState.profile.name}' (${shellState.profile.description})`);
  if (shellState.hasUnlockSequence) {
    console.error(`ShellStateManager: auto-unlock enabled (${shellState.unlockSequence.length} steps)`);
  }
} else {
  console.error("ShellStateManager: heuristic mode (no profile configured)");
}

// ── MCP server ─────────────────────────────────────────────

const server = new Server(
  {
    name: "embedded-mcp-toolkit",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[] = [];

  if (useSSH) {
    tools.push(
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
      {
        name: "shell_open",
        description: "Open an interactive shell session on the remote board (with PTY allocation, supports interactive programs like top, vi)",
        inputSchema: {
          type: "object",
          properties: {
            term: { type: "string", description: "Terminal type (default: xterm)" },
            cols: { type: "number", description: "Terminal columns (default: 80)" },
            rows: { type: "number", description: "Terminal rows (default: 24)" },
          },
        },
      },
      {
        name: "shell_send",
        description: "Send a command to the interactive shell session and wait for output",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to send" },
            timeout: { type: "number", description: "Timeout in milliseconds (default: 10000)" },
          },
          required: ["command"],
        },
      },
      {
        name: "shell_close",
        description: "Close the interactive shell session",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    );
  }

  if (useSerial) {
    tools.push(
      {
        name: "serial_connect",
        description: "Configure and open a serial connection to the board",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "Serial port name (e.g., COM3, /dev/ttyUSB0)" },
            baudRate: { type: "number", description: "Baud rate (e.g., 115200)" },
            dataBits: { type: "number", description: "Data bits (default: 8)" },
            stopBits: { type: "number", description: "Stop bits (default: 1)" },
            parity: { type: "string", description: "Parity: none, even, odd (default: none)" },
          },
        },
      },
      {
        name: "serial_disconnect",
        description: "Close the serial connection to the board",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "serial_exec",
        description: "Execute a shell command on the board over serial",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            timeout: { type: "number", description: "Command timeout in milliseconds (default: 15000)" },
          },
          required: ["command"],
        },
      },
      {
        name: "serial_send",
        description: "Send raw data over the serial connection (useful for control characters like Ctrl+C)",
        inputSchema: {
          type: "object",
          properties: {
            data: { type: "string", description: "Data to send (supports escape sequences like \\x03 for Ctrl+C)" },
          },
          required: ["data"],
        },
      },
    );
  }

  if (useSSH || useSerial) {
    tools.push(
      {
        name: "shell_detect_state",
        description: "Detect the current state of the remote shell (ready, locked, unlocking, error, unknown)",
        inputSchema: {
          type: "object",
          properties: {
            timeout: { type: "number", description: "Detection timeout in milliseconds (default: 5000)" },
          },
        },
      },
      {
        name: "shell_unlock",
        description: "Execute the unlock sequence if the remote shell is protected (e.g., psh). If the shell requires a key/password, provide it via the 'key' parameter. Without a key, only automatic steps are performed.",
        inputSchema: {
          type: "object",
          properties: {
            timeout: { type: "number", description: "Unlock timeout in milliseconds (default: 30000)" },
            key: { type: "string", description: "Unlock key/password (required if the shell prompts for it)" },
          },
        },
      },
    );
  }

  return { tools };
});

// ── tool handlers ──────────────────────────────────────────

interface ToolArgs {
  command?: string;
  timeout?: number;
  path?: string;
  content?: string;
  lines?: number;
  local_path?: string;
  remote_path?: string;
  term?: string;
  cols?: number;
  rows?: number;
  // serial
  port?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  data?: string;
  key?: string;
}

async function handleToolCall(name: string, args: ToolArgs): Promise<CallToolResult> {
  switch (name) {
    // ── SSH handlers ──
    case "exec": {
      const result = await ssh!.exec(args.command!);
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
      const content = await ssh!.readFile(args.path!);
      return { content: [text(content)] };
    }

    case "write_file": {
      await ssh!.writeFile(args.path!, args.content!);
      return { content: [text(`File written: ${args.path}`)] };
    }

    case "list_dir": {
      const entries = await ssh!.listDir(args.path!);
      const output = entries.map((e) => e.longname).join("\n") || "(empty directory)";
      return { content: [text(output)] };
    }

    case "dmesg": {
      const cmd = args.lines ? `dmesg | tail -${args.lines}` : "dmesg";
      const result = await ssh!.exec(cmd);
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
      const result = await ssh!.exec(cmds.join(" && "));
      return { content: [text(result.stdout)] };
    }

    case "upload_file": {
      const content = readFileSync(args.local_path!, "utf8");
      await ssh!.writeFile(args.remote_path!, content);
      return { content: [text(`Uploaded ${args.local_path} -> ${args.remote_path}`)] };
    }

    case "shell_open": {
      const output = await ssh!.openShell({
        term: args.term,
        cols: args.cols,
        rows: args.rows,
      });
      return { content: [text(output || "(shell opened, no initial output)")] };
    }

    case "shell_send": {
      const output = await ssh!.shellSend(args.command!, args.timeout);
      return { content: [text(output || "(no output)")] };
    }

    case "shell_close": {
      await ssh!.closeShell();
      return { content: [text("Shell session closed")] };
    }

    // ── Serial handlers ──
    case "serial_connect": {
      const connectConfig: Partial<SerialConfig> = {};
      if (args.port) connectConfig.port = args.port;
      if (args.baudRate) connectConfig.baudRate = args.baudRate;
      if (args.dataBits) connectConfig.dataBits = args.dataBits as 8 | 5 | 6 | 7;
      if (args.stopBits) connectConfig.stopBits = args.stopBits as 1 | 1.5 | 2;
      if (args.parity) connectConfig.parity = args.parity as "none" | "even" | "odd";
      const hasNewConfig = Object.keys(connectConfig).length > 0;

      const wasConnected = serial!.isConnected;
      const configChanged = hasNewConfig && !serial!.configsEqual(connectConfig);

      const statusParts: string[] = [
        `isConnected=${wasConnected}`,
        `hasNewConfig=${hasNewConfig}`,
      ];

      if (wasConnected && configChanged) {
        statusParts.push("config differs, reconnecting");
      } else if (wasConnected) {
        statusParts.push("config same, reusing");
      } else {
        statusParts.push("connecting fresh");
      }

      await serial!.connect(hasNewConfig ? connectConfig : undefined);

      const finalConfig = serial!.config;
      return { content: [text(`Serial connected (${statusParts.join(", ")}): ${finalConfig.port} @ ${finalConfig.baudRate} baud`)] };
    }

    case "serial_disconnect": {
      await serial!.disconnect();
      return { content: [text("Serial disconnected")] };
    }

    case "serial_exec": {
      const timeout = args.timeout || 15000;
      const result = await serial!.exec(args.command!, timeout);
      return { content: [text(result || "(no output)")] };
    }

    case "serial_send": {
      // Support \xHH hex escape sequences
      const raw = args.data!.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      serial!.write(raw);
      return { content: [text(`Sent ${raw.length} bytes`)] };
    }

    // ── Shell state tools ──
    case "shell_detect_state": {
      const timeout = args.timeout || 5000;

      if (serial && serial.isConnected) {
        const result = await serial.detectState(timeout);
        return { content: [text(result)] };
      }

      if (ssh) {
        const result = await ssh.detectState();
        return { content: [text(result)] };
      }

      throw new Error("No active connection for state detection.");
    }

    case "shell_unlock": {
      const timeout = args.timeout || 30000;
      const key = args.key;

      if (serial && serial.isConnected) {
        const result = await serial.unlockShell(timeout, key);
        return { content: [text(result)] };
      }

      if (ssh) {
        const result = await ssh.unlockShell(timeout, key);
        return { content: [text(result)] };
      }

      throw new Error("No active connection for shell unlock.");
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
  if (useSSH) {
    try {
      console.error(`Connecting SSH to ${sshConfig!.host}:${sshConfig!.port} as ${sshConfig!.username}...`);
      await ssh!.connect();
      console.error("SSH connection established.");
    } catch (err: unknown) {
      console.error(`Warning: Initial SSH connection failed: ${getErrorMessage(err)}`);
      console.error("SSH tools will attempt to connect on each call.");
    }
  }

  if (useSerial) {
    try {
      console.error(`Connecting serial to ${serialConfig!.port} @ ${serialConfig!.baudRate}...`);
      await serial!.connect();
      console.error("Serial connection established.");
    } catch (err: unknown) {
      console.error(`Warning: Initial serial connection failed: ${getErrorMessage(err)}`);
      console.error("Use serial_connect tool to connect manually.");
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server started on stdio.");
}

// ── graceful shutdown ──────────────────────────────────────

let cleaned = false;
const CLEANUP_TIMEOUT = 5000; // 5 seconds timeout for cleanup

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  console.error("Shutting down...");

  // Cleanup serial with timeout
  if (serial) {
    try {
      await withTimeout(
        serial.disconnect(),
        CLEANUP_TIMEOUT,
        "serial disconnect"
      );
      console.error("Serial disconnected.");
    } catch (e) {
      console.error("Serial disconnect error:", getErrorMessage(e));
    }
  }

  // Cleanup SSH with timeout
  if (ssh) {
    try {
      await withTimeout(
        ssh.close(),
        CLEANUP_TIMEOUT,
        "SSH close"
      );
      console.error("SSH disconnected.");
    } catch (e) {
      console.error("SSH close error:", getErrorMessage(e));
    }
  }

  // Close MCP server with timeout
  try {
    await withTimeout(
      server.close(),
      CLEANUP_TIMEOUT,
      "MCP server close"
    );
    console.error("MCP server closed.");
  } catch (e) {
    console.error("Server close error:", getErrorMessage(e));
  }
}

process.on("SIGINT", () => {
  cleanup().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  cleanup().then(() => process.exit(0));
});
process.on("SIGBREAK", () => {
  cleanup().then(() => process.exit(0));
});
process.stdin.on("end", () => {
  cleanup().then(() => process.exit(0));
});

// ── entry ──────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error("Fatal error:", getErrorMessage(err));
  cleanup().then(() => process.exit(1));
});
