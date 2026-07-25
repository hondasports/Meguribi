import fs from "node:fs/promises";

const marker = process.env.FAKE_MCP_MARKER;
const name = process.env.FAKE_MCP_NAME ?? "fake-stdio";

async function record(event: string): Promise<void> {
  if (marker) {
    await fs.appendFile(marker, `${name}:${event}\n`, "utf8");
  }
}

await record("started");

const stop = async (): Promise<void> => {
  await record("stopped");
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
    try {
      const request = JSON.parse(line) as { id?: string | number; method?: string };
      if (request.id === undefined) continue;
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name, version: "0.1.0" } }
        : request.method === "tools/list"
          ? { tools: [] }
          : {};
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch {
      process.stderr.write("fake MCP received malformed JSON\n");
    }
  }
});
