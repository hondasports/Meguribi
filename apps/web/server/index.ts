import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { buildCliArgs, commandIds, redactOutput, type CommandRequest } from "./command-specs.js";

interface RunRecord {
  id: string;
  status: "running" | "completed";
  exitCode: number | null;
  output: Array<{ stream: "stdout" | "stderr"; text: string }>;
  clients: Set<http.ServerResponse>;
  child?: ChildProcessWithoutNullStreams;
}

const runs = new Map<string, RunRecord>();
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = process.env.MEGURIBI_ROOT
  ? path.resolve(process.env.MEGURIBI_ROOT)
  : path.resolve(appDirectory, "../..");
const port = Number(process.env.MEGURIBI_WEB_PORT ?? 4173);
const pnpmExecutable = process.platform === "win32" ? process.execPath : "pnpm";

function pnpmArguments(args: readonly string[]): string[] {
  if (process.platform !== "win32") return [...args];
  return [
    path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
    ...args,
  ];
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function event(res: http.ServerResponse, name: string, value: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

function broadcast(run: RunRecord, name: string, value: unknown): void {
  for (const client of run.clients) event(client, name, value);
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isCommandRequest(value: unknown): value is CommandRequest {
  if (typeof value !== "object" || value === null) return false;
  const input = value as { command?: unknown; target?: unknown; options?: unknown };
  return (
    typeof input.command === "string" &&
    commandIds.includes(input.command as never) &&
    (input.target === undefined || typeof input.target === "string") &&
    (input.options === undefined ||
      (typeof input.options === "object" &&
        input.options !== null &&
        !Array.isArray(input.options)))
  );
}

function startRun(request: CommandRequest): RunRecord {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const run: RunRecord = { id, status: "running", exitCode: null, output: [], clients: new Set() };
  runs.set(id, run);
  const args = buildCliArgs(request);
  const child = spawn(pnpmExecutable, pnpmArguments(args), {
    cwd: repositoryRoot,
    windowsHide: true,
  });
  run.child = child;
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = redactOutput(chunk.toString("utf8"));
    run.output.push({ stream, text });
    broadcast(run, "output", { stream, text });
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.on("error", (cause) => append("stderr", Buffer.from(cause.message)));
  child.on("close", (exitCode) => {
    run.status = "completed";
    run.exitCode = exitCode ?? 1;
    broadcast(run, "complete", { exitCode: run.exitCode });
    for (const client of run.clients) client.end();
    run.clients.clear();
    run.child = undefined;
  });
  return run;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requested = new URL(req.url ?? "/", "http://localhost").pathname;
  const relative = requested === "/" ? "index.html" : requested.replace(/^\//, "");
  const filePath = path.resolve(appDirectory, "dist", relative);
  if (!filePath.startsWith(path.resolve(appDirectory, "dist") + path.sep))
    return json(res, 403, { error: "Forbidden" });
  try {
    await access(filePath);
    const extension = path.extname(filePath);
    const contentType =
      extension === ".js" ? "text/javascript" : extension === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = await readFile(path.join(appDirectory, "dist", "index.html"), "utf8").catch(
      () => "Not found",
    );
    res.writeHead(fallback === "Not found" ? 404 : 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(fallback);
  }
}

async function createAppServer(): Promise<http.Server> {
  const production = process.argv.includes("--production");
  let vite: ViteDevServer | undefined;
  if (!production)
    vite = await createViteServer({
      root: appDirectory,
      server: { middlewareMode: true },
      appType: "spa",
    });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health" && req.method === "GET") return json(res, 200, { ok: true });
    if (url.pathname === "/api/commands" && req.method === "POST") {
      try {
        const body = await parseBody(req);
        if (!isCommandRequest(body)) return json(res, 400, { error: "Invalid command request" });
        const run = startRun(body);
        return json(res, 202, { runId: run.id });
      } catch (cause) {
        return json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const run = runs.get(decodeURIComponent(eventsMatch[1]));
      if (!run) return json(res, 404, { error: "Run not found" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const line of run.output) event(res, "output", line);
      if (run.status === "completed") {
        event(res, "complete", { exitCode: run.exitCode });
        return res.end();
      }
      run.clients.add(res);
      req.on("close", () => run.clients.delete(res));
      return;
    }
    if (vite) return vite.middlewares(req, res, () => json(res, 404, { error: "Not found" }));
    return serveStatic(req, res);
  });
}

const server = await createAppServer();
server.listen(port, "127.0.0.1", () =>
  console.log(`Meguribi Command Desk listening on http://127.0.0.1:${port}`),
);
