import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connect(options = {}) {
  const transport = new StdioClientTransport({
    command: options.command ?? "node",
    args: options.args ?? ["bin/embedded-mcp-toolkit-cli.js"],
  });

  const client = new Client(
    { name: options.name ?? "embedded-mcp-client", version: options.version ?? "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return { client, transport };
}
