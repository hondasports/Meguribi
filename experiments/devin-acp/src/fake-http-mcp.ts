import http from "node:http";
import fs from "node:fs/promises";

export interface FakeHttpMcpServer {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

export async function startFakeHttpMcpServer(marker?: string): Promise<FakeHttpMcpServer> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    if (marker) void fs.appendFile(marker, "fake-http:connected\n", "utf8");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-http", version: "0.1.0" } } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake HTTP MCP did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    get requests() { return requests; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
