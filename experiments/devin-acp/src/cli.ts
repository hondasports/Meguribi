import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./git.js";
import { runProbe } from "./probe.js";
import { createFixture } from "./workspace.js";

const args = new Set(process.argv.slice(2));
const fake = args.has("--fake");
const cancel = args.has("--cancel");
const timeoutMs = Number(process.env.DEVIN_ACP_TIMEOUT_MS ?? "120000");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.resolve(process.cwd(), "../../artifacts/devin-acp", runId);
const isolatedConfig = path.join(artifactDir, "devin-config.json");
await fs.mkdir(artifactDir, { recursive: true });
await fs.writeFile(isolatedConfig, "{}\n", "utf8");
const fixture = await createFixture(path.join(artifactDir, "fixture-"));

try {
  const executable = fake ? process.execPath : "devin";
  const fakeLauncher = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const fakeScript = fileURLToPath(new URL("./fake-acp.ts", import.meta.url));
  const commandArgs = fake ? [fakeLauncher, fakeScript] : ["--config", isolatedConfig, "acp"];
  const cliVersion = fake ? "fake-0.1.0" : (await runCommand("devin", ["--config", isolatedConfig, "--version"], fixture.worktree)).stdout.trim();
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
    ...(fake ? { env: { FAKE_ACP_MODE: process.env.FAKE_ACP_MODE ?? (cancel ? "cancel" : "success") } } : {})
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "completed" || result.outsideChanges.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await fixture.cleanup();
}
import fs from "node:fs/promises";
