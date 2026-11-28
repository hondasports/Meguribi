import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemRunStore } from "@meguribi/adapters";
import { createProgram } from "../program.js";

/**
 * PR #100 指摘の回帰試験。
 * reject --redo すると approval.json には decision "rejected" のレコードが残る。
 * 従来は approve がその存在だけを見て承認記録をスキップし、新しい結論へ進めなかった。
 * awaiting_human にある新しい結論は人間の明示承認を正しく記録し、
 * 有効な承認（approved かつ現在の結論ハッシュ一致）だけを継続再試行に再利用する。
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
  const repo = mkdtempSync(path.join(tmpdir(), "meguribi-redo-repo-"));
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

async function runCli(
  args: string[],
  output: { stdout: string[]; stderr: string[] },
): Promise<void> {
  process.exitCode = 0;
  const program = createProgram({
    stdout: (text) => output.stdout.push(text),
    stderr: (text) => output.stderr.push(text),
    resolveApprover: async () => "Integration Test Approver",
  });
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

describe("discuss-to-pr reject redo approve regression (program E2E)", () => {
  let snapshot: EnvSnapshot;
  let dataRoot: string;
  let repoDir: string;

  beforeEach(() => {
    snapshot = saveEnv();
    dataRoot = mkdtempSync(path.join(tmpdir(), "meguribi-redo-data-"));
    repoDir = createFixtureRepo();
    process.env.XDG_DATA_HOME = dataRoot;
    process.env.MEGURIBI_DELIVERY_FAKES = "1";
    process.env.MEGURIBI_IMPLEMENTER = "devin";
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("records a fresh approval after reject --redo and continues to the Draft PR", async () => {
    // 1. 議論開始 → awaiting_human
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
    const runId = extractRunId(runOut.stdout);

    // 2. reject --redo → approval.json には rejected が残り、議論は awaiting_human に戻る
    const rejectOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["reject", runId, "--reason", "方向性が違う", "--redo"], rejectOut);
    expect(process.exitCode, rejectOut.stderr.join("")).toBe(0);
    const rejectedRecord = await runStoreFor(dataRoot).readArtifact<{ decision?: string }>(
      runId,
      "approval.json",
    );
    expect(rejectedRecord?.decision).toBe("rejected");
    expect((await runStoreFor(dataRoot).load(runId))?.status).toBe("awaiting_human");

    // 3. approve: 既存の rejected レコードでスキップせず、新しい結論への承認を記録して継続する
    const approveOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], approveOut);
    expect(process.exitCode, approveOut.stderr.join("")).toBe(0);
    expect(approveOut.stdout.join("")).toContain("承認しました");

    // 4. approval.json は明示承認で approved に更新され、specify 以降が走り PR まで届く。
    //    継続内部のハッシュ照合が通ること自体が、現在の結論への有効な承認の証明になる。
    const approval = await runStoreFor(dataRoot).readArtifact<{ decision?: string; conclusionHash?: string }>(
      runId,
      "approval.json",
    );
    expect(approval?.decision).toBe("approved");
    // 履歴には rejected → approved の2件が順に残る（明示承認が実際に記録された証拠）。
    const history = await runStoreFor(dataRoot).readArtifact<{ decision?: string }[]>(
      runId,
      "approval-history.json",
    );
    expect(history?.map((record) => record.decision)).toEqual(["rejected", "approved"]);
    const state = await runStoreFor(dataRoot).load(runId);
    expect(state?.pullRequestNumber).toBeDefined();
    const specification = await runStoreFor(dataRoot).readArtifact(runId, "specification.json");
    expect(specification).not.toBeNull();
  });

  it("reuses a valid existing approval for continuation retry without re-recording", async () => {
    // 継続再試行: 有効な承認（approved かつ現在の結論ハッシュ一致）が既にある場合は
    // 承認を二重記録せず継続だけ行う。
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
    const runId = extractRunId(runOut.stdout);
    const first = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], first);
    expect(process.exitCode, first.stderr.join("")).toBe(0);
    const approvalAfterFirst = await runStoreFor(dataRoot).readArtifact<{ at?: string }>(runId, "approval.json");

    // 完了済みへの再 approve は既存承認を再利用し、レコードを書き換えない。
    const second = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], second);
    expect(process.exitCode, second.stderr.join("")).toBe(0);
    const approvalAfterSecond = await runStoreFor(dataRoot).readArtifact<{ at?: string }>(runId, "approval.json");
    expect(approvalAfterSecond?.at).toBe(approvalAfterFirst?.at);
    // 再利用では承認を二重記録しない: 履歴は最初の1件のまま。
    const history = await runStoreFor(dataRoot).readArtifact<unknown[]>(runId, "approval-history.json");
    expect(history).toHaveLength(1);
  });
});
