import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServerDefinition {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function fakeStdioDefinition(marker: string): McpServerDefinition {
  return {
    name: "fake-stdio",
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL("./fake-mcp.ts", import.meta.url))],
    env: { FAKE_MCP_MARKER: marker, FAKE_MCP_NAME: "fake-stdio" }
  };
}

export function fakeHttpDefinition(serverUrl: string): McpServerDefinition {
  return { name: "fake-http", transport: "http", url: serverUrl };
}

export async function writeMcpConfig(filePath: string, servers: McpServerDefinition[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, {
    transport: server.transport,
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server.url === undefined ? {} : { url: server.url })
  }]));
  await fs.writeFile(filePath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf8");
}
