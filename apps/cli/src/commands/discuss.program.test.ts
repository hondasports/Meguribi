import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("discuss participant override (program E2E)", () => {
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

  it("runs the discussion with overridden participants without changing persistent config", async () => {
    const configBefore = readFileSync(path.join(repoDir, ".meguribi.yml"), "utf8");
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss", "owner/repo#22",
        "--repo-path", repoDir,
        "--discussants", "devin,cursor",
        "--summarizer", "devin",
        "--log", "none",
        "--non-interactive",
      ],
      output,
    );
    expect(process.exitCode, output.stderr.join("")).toBe(0);
    const runId = extractRunId(output.stdout);

    // 実際に選んだメンバーが参加したこと: speaker が override の profile id になっている
    const runStore = runStoreFor(dataRoot);
    const eventLog = new FileSystemWorkflowEventLog({ runStore });
    const events = await eventLog.read(runId);
    const speakers = new Set(
      events.records
        .filter((entry) => entry.event.type === "discussion.turn")
        .map((entry) => (entry.event as { turn: { speaker: string } }).turn.speaker),
    );
    expect(speakers).toEqual(new Set(["devin", "cursor"]));

    // override は Run に保存される（redo の復元用）
    const saved = await runStore.readArtifact<{ discussants?: string[]; summarizer?: string }>(
      runId,
      "discussion-participants.json",
    );
    expect(saved?.discussants).toEqual(["devin", "cursor"]);
    expect(saved?.summarizer).toBe("devin");

    // 永続設定は変更しない
    expect(readFileSync(path.join(repoDir, ".meguribi.yml"), "utf8")).toBe(configBefore);
  });

  it("uses config discussants when no override is given", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      ["discuss", "owner/repo#22", "--repo-path", repoDir, "--log", "none", "--non-interactive"],
      output,
    );
    expect(process.exitCode, output.stderr.join("")).toBe(0);
    const runId = extractRunId(output.stdout);
    const runStore = runStoreFor(dataRoot);
    const eventLog = new FileSystemWorkflowEventLog({ runStore });
    const events = await eventLog.read(runId);
    const speakers = new Set(
      events.records
        .filter((entry) => entry.event.type === "discussion.turn")
        .map((entry) => (entry.event as { turn: { speaker: string } }).turn.speaker),
    );
    expect(speakers).toEqual(new Set(["claude-code", "codex-acp"]));
    // override なしでは artifact を残さない
    expect(await runStore.readArtifact(runId, "discussion-participants.json")).toBeNull();
  });

  it("rejects unknown override profiles with a validation error", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss", "owner/repo#22",
        "--repo-path", repoDir,
        "--discussants", "no-such-profile,cursor",
        "--log", "none",
        "--non-interactive",
      ],
      output,
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("prompt-only consultation (program E2E)", () => {
  let snapshot: EnvSnapshot;
  let dataRoot: string;
  let repoDir: string;

  beforeEach(() => {
    snapshot = saveEnv();
    dataRoot = mkdtempSync(path.join(tmpdir(), "meguribi-consult-data-"));
    repoDir = createFixtureRepo();
    process.env.XDG_DATA_HOME = dataRoot;
    process.env.MEGURIBI_DELIVERY_FAKES = "1";
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("runs an issue-free read-only consultation and reports the run id early", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "--repo-path", repoDir,
        "--prompt", "認証基盤の設計について相談したい",
        "--discussants", "devin,cursor",
        "--log", "none",
        "--non-interactive",
      ],
      output,
    );
    expect(process.exitCode, output.stderr.join("")).toBe(0);

    // サーバー契約: Run ID を stdout に報告する
    const match = /Run ID:\s*(\S+)/.exec(output.stdout.join(""));
    expect(match, `Run ID should appear in stdout: ${output.stdout.join("")}`).not.toBeNull();
    const runId = match![1]!;

    // 実際に選んだメンバーが参加したこと
    const runStore = runStoreFor(dataRoot);
    const eventLog = new FileSystemWorkflowEventLog({ runStore });
    const events = await eventLog.read(runId);
    const speakers = new Set(
      events.records
        .filter((entry) => entry.event.type === "discussion.turn")
        .map((entry) => (entry.event as { turn: { speaker: string } }).turn.speaker),
    );
    expect(speakers).toEqual(new Set(["devin", "cursor"]));

    // 結論は保存されるが、承認フロー（Next: approve）や実装・PR へは進まない
    const conclusion = await runStore.readArtifact(runId, "discussion/conclusion.json");
    expect(conclusion).not.toBeNull();
    expect(output.stdout.join("")).not.toContain("Next: meguribi approve");
    const state = await runStore.load(runId);
    expect(state?.status).toBe("completed");
  });

  it("rejects prompt-only launch without --prompt", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      ["discuss", "--repo-path", repoDir, "--log", "none", "--non-interactive"],
      output,
    );
    expect(process.exitCode).toBe(1);
  });

  it("keeps stdout as pure JSON in --json mode without the early Run ID line", async () => {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(
      [
        "discuss",
        "--repo-path", repoDir,
        "--prompt", "JSON 出力の相談",
        "--log", "none",
        "--json",
        "--non-interactive",
      ],
      output,
    );
    expect(process.exitCode, output.stderr.join("")).toBe(0);
    const stdout = output.stdout.join("");
    // 早期 Run ID 通知はサーバー開始プロトコル専用。--json の stdout は純 JSON を維持する。
    expect(stdout).not.toContain("Run ID:");
    const parsed = JSON.parse(stdout) as { runId?: string; status?: string };
    expect(parsed.status).toBe("completed");
    expect(typeof parsed.runId).toBe("string");
  });

  it("accepts say for an in-progress consultation run", async () => {
    // 相談中（created）の consult Run には人間が追加入力できる。
    const runStore = runStoreFor(dataRoot);
    const state = await runStore.create({
      repository: "local/testbed",
      command: "consult",
      consultation: { worktreePath: repoDir, remoteIdentity: `local:${repoDir}` },
      maxFixAttempts: 0,
    });
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["say", state.runId, "別案も検討して"], output);
    expect(process.exitCode, output.stderr.join("")).toBe(0);
  });

  it("rejects say for a completed consultation run", async () => {
    const runStore = runStoreFor(dataRoot);
    const state = await runStore.create({
      repository: "local/testbed",
      command: "consult",
      consultation: { worktreePath: repoDir, remoteIdentity: `local:${repoDir}` },
      maxFixAttempts: 0,
    });
    await runStore.update(state.runId, { status: "completed" });
    const output = { stdout: [] as string[], stderr: [] as string[] };
    await runCli(["say", state.runId, "遅すぎる発言"], output);
    expect(process.exitCode).toBe(1);
  });
});
