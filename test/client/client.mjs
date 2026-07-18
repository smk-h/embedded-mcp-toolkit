import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 连接到 MCP 服务器
 *
 * @param {object} options
 * @param {string} [options.command] - 启动命令
 * @param {string[]} [options.args] - 命令参数
 * @param {string} [options.name] - 客户端名称
 * @param {string} [options.version] - 客户端版本
 * @param {Record<string,string>} [options.env] - 传递给服务端进程的环境变量
 * @returns {Promise<{client: Client, transport: StdioClientTransport}>}
 */
export async function connect(options = {}) {
  const transport = new StdioClientTransport({
    command: options.command ?? "node",
    args: options.args ?? ["bin/embedded-mcp-toolkit-cli.js"],
    env: options.env ?? undefined,
    stderr: options.stderr ?? "pipe",
  });

  const client = new Client(
    {
      name: options.name ?? "embedded-mcp-client",
      version: options.version ?? "1.0.0",
    },
    { capabilities: {} }
  );

  await client.connect(transport);
  return { client, transport };
}
