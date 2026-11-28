import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemRunStore } from "@meguribi/adapters";
import { createProgram } from "../program.js";

/**
 * 実 CLI エントリ（createProgram + 本番配線）を通し、MEGURIBI_DELIVERY_FAKES=1 の
 * fake エージェントで `workflow run discuss-to-pr` → `approve` の継続実行が
 * Issue から Draft PR 相当まで往復できることを確認する。
 */

interface EnvSnapshot {
  xdg: string | undefined;
  fakes: string | undefined;
  implementer: string | undefined;
  exitCode: typeof process.exitCode;
}

function saveEnv(): EnvSnapshot {
  return {
    xdg: process.env.XDG_DATA_HOME,
    fakes: process.env.MEGURIBI_DELIVERY_FAKES,
    implementer: process.env.MEGURIBI_IMPLEMENTER,
    exitCode: process.exitCode,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  if (snapshot.xdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = snapshot.xdg;
  }
  if (snapshot.fakes === undefined) {
    delete process.env.MEGURIBI_DELIVERY_FAKES;
  } else {
    process.env.MEGURIBI_DELIVERY_FAKES = snapshot.fakes;
  }
  if (snapshot.implementer === undefined) {
    delete process.env.MEGURIBI_IMPLEMENTER;
  } else {
    process.env.MEGURIBI_IMPLEMENTER = snapshot.implementer;
  }
  process.exitCode = snapshot.exitCode;
}

function createFixtureRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "meguribi-dtp-repo-"));
  writeFileSync(
    path.join(repo, ".meguribi.yml"),
    [
      "roles:",
      "  discussants: [claude-code, codex-acp]",
      "  specifier: claude-code",
      "implementer: devin",
      "",
    ].join("\n"),
    "utf8",
  );
  return repo;
}

function createTestProgram(output: { stdout: string[]; stderr: string[] }) {
  return createProgram({
    stdout: (text) => output.stdout.push(text),
    stderr: (text) => output.stderr.push(text),
    resolveApprover: async () => "Integration Test Approver",
  });
}

async function runCli(
  args: string[],
  output: { stdout: string[]; stderr: string[] },
): Promise<void> {
  process.exitCode = 0;
  const program = createTestProgram(output);
  await program.parseAsync(["node", "meguribi", ...args]);
}

function extractRunId(stdout: string[]): string {
  const match = stdout.join("").match(/Run ID: (\S+)/);
  if (match === null) {
    throw new Error(`run id not found in output: ${stdout.join("")}`);
  }
  return match[1] as string;
}

function runStoreFor(dataRoot: string): FileSystemRunStore {
  return new FileSystemRunStore({ rootDir: path.join(dataRoot, "meguribi") });
}

describe("workflow run discuss-to-pr (program E2E)", () => {
  let snapshot: EnvSnapshot;
  let dataRoot: string;
  let repoDir: string;

  beforeEach(() => {
    snapshot = saveEnv();
    dataRoot = mkdtempSync(path.join(tmpdir(), "meguribi-dtp-data-"));
    repoDir = createFixtureRepo();
    process.env.XDG_DATA_HOME = dataRoot;
    process.env.MEGURIBI_DELIVERY_FAKES = "1";
    // implementer の選択は設定ファイルではなく環境変数で明示する
    // （approve の継続配線は cwd ではなく永続入力から復元されるため、
    //   cli オプションが届かない。本番では .meguribi.yml / env で選択する運用）。
    process.env.MEGURIBI_IMPLEMENTER = "devin";
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("lists discuss-to-pr in workflow list", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["workflow", "list", "--repo-path", repoDir], output);
    expect(process.exitCode).toBe(0);
    expect(output.stdout.join("")).toContain("discuss-to-pr");
  });

  it("runs discussion to awaiting_human and continues to Draft PR after approve", async () => {
    const runOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "workflow", "run", "discuss-to-pr", "owner/repo#22",
        "--repo-path", repoDir,
        "--implementer", "devin",
        "--allow-inherited-mcp",
        "--non-interactive",
      ],
      runOut,
    );
    expect(process.exitCode, runOut.stderr.join("")).toBe(0);
    expect(runOut.stdout.join("")).toContain("承認");
    const runId = extractRunId(runOut.stdout);
    const state = await runStoreFor(dataRoot).load(runId);
    expect(state?.status).toBe("awaiting_human");

    // 承認すると同じプロセスで specify 以降へ継続する
    const approveOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], approveOut);
    expect(process.exitCode, approveOut.stderr.join("")).toBe(0);

    const continued = await runStoreFor(dataRoot).load(runId);
    expect(continued?.status).toBe("awaiting_human");
    expect(continued?.pullRequestNumber).toBeDefined();

    // 仕様は RunStore に保存される
    const specification = await runStoreFor(dataRoot).readArtifact(runId, "specification.json");
    expect(specification).not.toBeNull();
  });

  it("re-invoking approve after completion does not duplicate implementation or PR", async () => {
    const runOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      ["workflow", "run", "discuss-to-pr", "owner/repo#22", "--repo-path", repoDir, "--implementer", "devin", "--allow-inherited-mcp", "--non-interactive"],
      runOut,
    );
    const runId = extractRunId(runOut.stdout);

    const first = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], first);
    expect(process.exitCode, first.stderr.join("")).toBe(0);
    const prNumber = (await runStoreFor(dataRoot).load(runId))?.pullRequestNumber;

    // 途中失敗後の継続入口としての再 approve: 完了済みなら二重実行しない
    const second = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], second);
    expect(process.exitCode, second.stderr.join("")).toBe(0);
    const state = await runStoreFor(dataRoot).load(runId);
    expect(state?.pullRequestNumber).toBe(prNumber);
    // steps/publish.json は1度だけ完了している（再実行されない）
    const publish = await runStoreFor(dataRoot).readArtifact<{ visit: number }>(runId, "steps/publish.json");
    expect(publish?.visit).toBe(1);
  });

  it("rejects unknown workflow names", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      ["workflow", "run", "no-such-workflow", "owner/repo#22", "--repo-path", repoDir],
      output,
    );
    expect(process.exitCode).toBe(1);
    expect(output.stderr.join("")).toContain("no-such-workflow");
  });
});
