import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemRunStore, FileSystemWorkflowEventLog } from "@meguribi/adapters";
import { createProgram } from "../program.js";

/**
 * 実 CLI エントリ（createProgram + 本番配線）を通し、MEGURIBI_DELIVERY_FAKES=1 の
 * fake エージェントで discuss → say → approve/reject が往復できることを確認する。
 * エージェントの診断・GitHub・git はすべて adapters の fake に流れる。
 */

interface EnvSnapshot {
  xdg: string | undefined;
  fakes: string | undefined;
  exitCode: typeof process.exitCode;
}

function saveEnv(): EnvSnapshot {
  return {
    xdg: process.env.XDG_DATA_HOME,
    fakes: process.env.MEGURIBI_DELIVERY_FAKES,
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
  process.exitCode = snapshot.exitCode;
}

function createFixtureRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "meguribi-discuss-repo-"));
  writeFileSync(
    path.join(repo, ".meguribi.yml"),
    [
      "roles:",
      "  discussants: [claude-code, codex-acp]",
      "",
    ].join("\n"),
    "utf8",
  );
  return repo;
}

const SYNTHETIC_APPROVER = "Integration Test Approver";

function createTestProgram(
  output: { stdout: string[]; stderr: string[] },
  extra: { cwd?: string } = {},
) {
  return createProgram({
    stdout: (text) => output.stdout.push(text),
    stderr: (text) => output.stderr.push(text),
    // 実名を出さないため、git user.name の解決は合成名で差し替える。
    resolveApprover: async () => SYNTHETIC_APPROVER,
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
  });
}

async function runCli(
  args: string[],
  output: { stdout: string[]; stderr: string[] },
  extra: { cwd?: string } = {},
): Promise<void> {
  process.exitCode = 0;
  const program = createTestProgram(output, extra);
  await program.parseAsync(["node", "meguribi", ...args]);
}

function runStoreFor(dataRoot: string): FileSystemRunStore {
  return new FileSystemRunStore({ rootDir: path.join(dataRoot, "meguribi") });
}

function extractRunId(stdout: string[]): string {
  const match = /Next: meguribi approve (\S+)/.exec(stdout.join(""));
  expect(match, `runId should appear in output: ${stdout.join("")}`).not.toBeNull();
  return match![1]!;
}

describe("discussion commands through the real CLI entry", () => {
  let snapshot: EnvSnapshot;
  let dataRoot: string;
  let repoDir: string;

  beforeEach(() => {
    snapshot = saveEnv();
    dataRoot = mkdtempSync(path.join(tmpdir(), "meguribi-discuss-data-"));
    repoDir = createFixtureRepo();
    process.env.XDG_DATA_HOME = dataRoot;
    process.env.MEGURIBI_DELIVERY_FAKES = "1";
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("runs fake discuss -> say -> approve end to end", async () => {
    const discussOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "owner/repo#22",
        "--repo-path",
        repoDir,
        "--log",
        "none",
        "--non-interactive",
      ],
      discussOut,
    );

    expect(process.exitCode, discussOut.stderr.join("")).toBe(0);
    const runId = extractRunId(discussOut.stdout);

    // say/approve が参照するのと同じ正準ルートで Run を読めること。
    const runStore = runStoreFor(dataRoot);
    const afterDiscuss = await runStore.load(runId);
    expect(afterDiscuss?.command).toBe("discuss");
    expect(afterDiscuss?.status).toBe("awaiting_human");
    const conclusion = await runStore.readArtifact<{ conclusion: string }>(
      runId,
      "discussion/conclusion.json",
    );
    expect(conclusion?.conclusion).toContain("fake");

    // workflow 内部で発行された runId で events.jsonl に永続化されていること。
    const eventLog = new FileSystemWorkflowEventLog({ runStore });
    const events = await eventLog.read(runId);
    const types = events.records.map((entry) => entry.event.type);
    expect(types).toContain("discussion.turn");
    expect(types).toContain("discussion.ended");

    // 結論後（awaiting_human）は inbox を消費するセッションがないため say は拒否される。
    const lateSayOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["say", runId, "結論後の発言"], lateSayOut);
    expect(process.exitCode).toBe(1);
    expect(lateSayOut.stderr.join("")).toContain("議論中ではありません");

    // 議論中（created）の Run には say が書ける。進行中の議論を直接再現する。
    const active = await runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "discuss",
      maxFixAttempts: 0,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/tmp/fake-worktree",
        baseRef: "origin/main",
        baseSha: "base",
        headSha: "head",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const sayOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["say", active.runId, "人間の声"], sayOut);
    expect(process.exitCode, sayOut.stderr.join("")).toBe(0);

    const approveOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId, "--comment", "よい"], approveOut);
    expect(process.exitCode, approveOut.stderr.join("")).toBe(0);
    expect(approveOut.stdout.join("")).toContain("承認しました");

    const approval = await runStore.readArtifact<{ decision: string; approver: string }>(
      runId,
      "approval.json",
    );
    expect(approval?.decision).toBe("approved");
    // 承認者はローカルの git user（テストでは注入した合成名）。
    expect(approval?.approver).toBe(SYNTHETIC_APPROVER);
    const afterApprove = await runStore.load(runId);
    expect(afterApprove?.status).toBe("completed");
  });

  it("runs fake discuss -> reject without redo end to end", async () => {
    const discussOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "owner/repo#22",
        "--repo-path",
        repoDir,
        "--log",
        "none",
        "--non-interactive",
      ],
      discussOut,
    );
    expect(process.exitCode, discussOut.stderr.join("")).toBe(0);
    const runId = extractRunId(discussOut.stdout);

    // reject(redo なし) はエージェントや repo 設定を解決せず、Run の記録だけで完了する。
    // 設定のないディレクトリを cwd にしても成功することで証明する。
    const rejectOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["reject", runId, "--reason", "方向性が違う"], rejectOut);
    expect(process.exitCode, rejectOut.stderr.join("")).toBe(0);
    expect(rejectOut.stdout.join("")).toContain("却下しました");

    const approval = await runStoreFor(dataRoot).readArtifact<{
      decision: string;
      comment?: string;
      approver?: string;
    }>(runId, "approval.json");
    expect(approval?.decision).toBe("rejected");
    expect(approval?.comment).toBe("方向性が違う");
    expect(approval?.approver).toBe(SYNTHETIC_APPROVER);
  });

  it("redoes the discussion with the original repository settings even from a different cwd", async () => {
    const discussOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "owner/repo#22",
        "--repo-path",
        repoDir,
        "--log",
        "none",
        "--non-interactive",
      ],
      discussOut,
    );
    expect(process.exitCode, discussOut.stderr.join("")).toBe(0);
    const runId = extractRunId(discussOut.stdout);

    // .meguribi.yml のない別 cwd から redo する。保存済み discussion-input.json が
    // 配線に使われなければ、設定を解決できず invalid_discussants で失敗するはず。
    const emptyCwd = mkdtempSync(path.join(tmpdir(), "meguribi-discuss-empty-"));
    const rejectOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      ["reject", runId, "--reason", "やり直し", "--redo"],
      rejectOut,
      { cwd: emptyCwd },
    );

    expect(process.exitCode, rejectOut.stderr.join("")).toBe(0);
    expect(rejectOut.stdout.join("")).toContain("やり直します");
    const state = await runStoreFor(dataRoot).load(runId);
    expect(state?.status).toBe("awaiting_human");
  });

  it("rejects say for a completed discussion run", async () => {
    const discussOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "owner/repo#22",
        "--repo-path",
        repoDir,
        "--log",
        "none",
        "--non-interactive",
      ],
      discussOut,
    );
    expect(process.exitCode, discussOut.stderr.join("")).toBe(0);
    const runId = extractRunId(discussOut.stdout);

    const approveOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["approve", runId], approveOut);
    expect(process.exitCode, approveOut.stderr.join("")).toBe(0);

    const sayOut = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["say", runId, "遅すぎる発言"], sayOut);
    expect(process.exitCode).toBe(1);
    expect(sayOut.stderr.join("")).toContain("議論中ではありません");
  });
});
