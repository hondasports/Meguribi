import { runCommand } from "./git.js";
import { diagnoseDevinCapabilities } from "./diagnose.js";

async function capture(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await runCommand("devin", args, process.cwd());
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

const version = await capture(["--version"]);
const rootHelp = await capture(["--help"]);
const acpHelp = await capture(["acp", "--help"]);
const auth = await capture(["auth", "status"]);
const result = diagnoseDevinCapabilities({
  cliVersion: version.stdout.trim(),
  rootHelp: rootHelp.stdout,
  acpHelp: acpHelp.stdout,
  isolation: "unknown",
  authentication: auth.ok ? "authenticated" : "unknown"
});

process.stdout.write(`${JSON.stringify({
  ...result,
  cliVersion: version.stdout.trim() || "unknown",
  next: "run the isolated smoke to mechanically verify MCP isolation"
}, null, 2)}\n`);
