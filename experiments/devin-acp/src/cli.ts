import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./git.js";
import { buildIsolatedEnvironment, configSourcePath, type ConfigSource } from "./isolation.js";
import { fakeHttpDefinition, fakeStdioDefinition, writeMcpConfig } from "./mcp-config.js";
import { runProbe } from "./probe.js";
import { startFakeHttpMcpServer } from "./fake-http-mcp.js";
import { createFixture } from "./workspace.js";

const args = new Set(process.argv.slice(2));
const fake = args.has("--fake");
const cancel = args.has("--cancel");
const mcpMode = process.env.FAKE_ACP_MODE?.startsWith("mcp-") ? process.env.FAKE_ACP_MODE : args.has("--mcp-stdio") ? "mcp-stdio" : args.has("--mcp-http") ? "mcp-http" : undefined;
const policy = args.has("--allow-fake-mcp") ? "allowlist" : "deny-all";
const variant = (process.env.DEVIN_ACP_VARIANT ?? "isolated") as "inherited" | "config-only" | "isolated" | "project" | "local" | "agent-config";
const timeoutMs = Number(process.env.DEVIN_ACP_TIMEOUT_MS ?? "120000");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.resolve(process.cwd(), "../../artifacts/devin-acp", runId);
const isolatedConfig = path.join(artifactDir, "devin-config.json");
const agentConfig = path.join(artifactDir, "agent-config.json");
await fs.mkdir(artifactDir, { recursive: true });
await fs.writeFile(isolatedConfig, "{}\n", "utf8");
await fs.writeFile(agentConfig, "{}\n", "utf8");
const fixture = await createFixture(path.join(artifactDir, "fixture-"));
const isolation = variant === "isolated" || variant === "agent-config" ? buildIsolatedEnvironment(path.join(artifactDir, "isolated-env")) : undefined;
let fakeHttpServer: Awaited<ReturnType<typeof startFakeHttpMcpServer>> | undefined;

try {
  if (!fake && variant !== "isolated") {
    throw new Error("real Devin smoke requires the isolated variant; use --fake for the configuration matrix");
  }
  if (mcpMode === "mcp-http") {
    fakeHttpServer = await startFakeHttpMcpServer(path.join(artifactDir, "fake-http.marker"));
  }
  const fakeServers = [
    ...(mcpMode === "mcp-stdio" ? [fakeStdioDefinition(path.join(artifactDir, "fake-stdio.marker"))] : []),
    ...(mcpMode === "mcp-http" && fakeHttpServer ? [fakeHttpDefinition(fakeHttpServer.url)] : [])
  ];
  const configSource: ConfigSource = variant === "project" || variant === "local" ? variant : "cli";
  if (fakeServers.length > 0) {
    const configPath = variant === "project" || variant === "local"
      ? configSourcePath(fixture.worktree, configSource)
      : isolatedConfig;
    await writeMcpConfig(configPath, fakeServers);
  }
  const executable = fake ? process.execPath : "devin";
  const fakeLauncher = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const fakeScript = fileURLToPath(new URL("./fake-acp.ts", import.meta.url));
  const realArgs = variant === "inherited"
    ? ["acp"]
    : variant === "agent-config"
      ? ["--agent-config", agentConfig, "--config", isolatedConfig, "acp"]
      : variant === "project" || variant === "local"
        ? ["acp"]
        : ["--config", isolatedConfig, "acp"];
  const commandArgs = fake ? [fakeLauncher, fakeScript] : realArgs;
  const cliVersion = fake ? "fake-0.1.0" : (await runCommand("devin", ["--version"], fixture.worktree, isolation?.env)).stdout.trim();
  const rootHelp = fake ? "acp" : (await runCommand("devin", ["--help"], fixture.worktree, isolation?.env)).stdout;
  const acpHelp = fake ? "Usage: devin acp" : (await runCommand("devin", ["acp", "--help"], fixture.worktree, isolation?.env)).stdout;
  let authenticationStatus: "authenticated" | "unauthenticated" = "unauthenticated";
  if (!fake) {
    try {
      await runCommand("devin", ["auth", "status"], fixture.worktree, isolation?.env);
      authenticationStatus = "authenticated";
    } catch {
      authenticationStatus = "unauthenticated";
    }
  } else {
    authenticationStatus = "authenticated";
  }
  const result = await runProbe({
    executable,
    args: commandArgs,
    cliVersion,
    cwd: fixture.worktree,
    prompt: "README.md に検証用の1行を追加してください。commit、push、PR作成、GitHub操作、secretの読み取りは行わないでください。",
    artifactDir,
    timeoutMs,
    ...(cancel ? { cancelAfterMs: 100 } : {}),
    allowedWritePaths: ["README.md"],
    outsideRoots: [fixture.normalCheckout, fixture.outside],
    env: {
      ...(isolation?.env ?? {}),
      ...(fake ? {
      FAKE_ACP_MODE: process.env.FAKE_ACP_MODE ?? (cancel ? "cancel" : mcpMode ?? "success"),
      ...(fakeHttpServer ? { FAKE_MCP_HTTP_URL: fakeHttpServer.url } : {}),
      ...(mcpMode ? { FAKE_MCP_MARKER: path.join(artifactDir, "fake-stdio.marker") } : {})
      } : {})
    },
    mcpPolicy: policy,
    allowedMcpNames: args.has("--allow-fake-mcp") ? [mcpMode === "mcp-http" ? "fake-http" : "fake-stdio"] : [],
    configSources: fakeServers.length > 0 ? [configSource] : [],
    isolationStatus: fake ? "unknown" : isolation ? "isolated" : "unknown",
    authenticationStatus: fake ? "unknown" : authenticationStatus,
    rootHelp,
    acpHelp
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "completed" || result.outsideChanges.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await fakeHttpServer?.close().catch(() => undefined);
  await fixture.cleanup();
}
