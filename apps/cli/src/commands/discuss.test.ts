import { describe, expect, it } from "vitest";
import { createMemoryRunStore } from "@meguribi/adapters";
import type {
  DiscussionConclusion,
  DiscussionDependencies,
  RunDiscussionWorkflowInput,
  RunState,
} from "@meguribi/core";
import {
  runApproveCommand,
  runDiscussCommand,
  runRejectCommand,
  runSayCommand,
  type DiscussionCommandDeps,
  type DiscussionInboxStore,
} from "./discuss.js";
import type { DiscussionWiringDependencies } from "../wiring/create-delivery-deps.js";

function conclusionFixture(): DiscussionConclusion {
  return {
    topic: "topic",
    conclusion: "A 案で進める",
    issues: [
      {
        issue: "どの方式にするか",
        positions: [
          { participant: "Claude", stance: "A 案", turnIds: ["t1"] },
          { participant: "Codex", stance: "B 案", turnIds: ["t2"] },
        ],
        resolution: "A 案に収束",
      },
    ],
    rejectedOptions: [{ option: "B 案", reason: "コストが高い", turnIds: ["t2"] }],
    openQuestions: [],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "hash",
  };
}

function wiringFixture(): DiscussionWiringDependencies {
  return {
    github: {} as DiscussionWiringDependencies["github"],
    git: {} as DiscussionWiringDependencies["git"],
    policy: {} as DiscussionWiringDependencies["policy"],
    runStore: {} as DiscussionWiringDependencies["runStore"],
    discussants: [],
    summarizer: {} as DiscussionWiringDependencies["summarizer"],
    parseEnvelope: () => ({ ok: false, reason: "not used" }),
    summarize: async () => conclusionFixture(),
    hashConclusion: () => "hash",
    createStore: () => {
      throw new Error("not used");
    },
    now: () => new Date("2026-11-28T00:00:00.000Z"),
  };
}

function discussDeps(overrides: Partial<DiscussionCommandDeps> = {}): {
  deps: DiscussionCommandDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: DiscussionCommandDeps = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    createDependencies: async () => wiringFixture(),
    ...overrides,
  };
  return { deps, stdout, stderr };
}

describe("runDiscussCommand", () => {
  it("prints the conclusion and next actions with exit 0 when awaiting human approval", async () => {
    let receivedInput: RunDiscussionWorkflowInput | undefined;
    let receivedDeps: DiscussionDependencies | undefined;
    const { deps, stdout } = discussDeps({
      runWorkflow: async (input, workflowDeps) => {
        receivedInput = input;
        receivedDeps = workflowDeps as DiscussionDependencies;
        return {
          runId: "run-1",
          status: "awaiting_human",
          conclusion: conclusionFixture(),
          reasons: [],
        };
      },
    });

    const result = await runDiscussCommand("owner/repo#83", {}, deps);

    expect(result.exitCode).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("結論: A 案で進める");
    expect(text).toContain("Claude: A 案");
    expect(text).toContain("B 案: コストが高い");
    expect(text).toContain(
      'Next: meguribi approve run-1  /  meguribi reject run-1 --reason "..." [--redo]',
    );
    expect(receivedInput?.issueNumber).toBe(83);
    expect(receivedInput?.branch).toBe("meguribi/issue-83");
    expect(receivedInput?.baseRef).toBe("origin/main");
    expect(receivedInput?.requiredLabels).toEqual(["agent:ready"]);
    expect(typeof receivedDeps?.createStore).toBe("function");
    expect(typeof receivedDeps?.onWorkflowEvent).toBe("function");
  });

  it("applies --max-turns and --local to the workflow input", async () => {
    let receivedInput: RunDiscussionWorkflowInput | undefined;
    const { deps } = discussDeps({
      runWorkflow: async (input) => {
        receivedInput = input;
        return { runId: "run-1", status: "awaiting_human", reasons: [] };
      },
    });

    await runDiscussCommand("owner/repo#83", { maxTurns: "7", local: true }, deps);

    expect(receivedInput?.limits.maxTurns).toBe(7);
    expect(receivedInput?.baseRef).toBe("HEAD");
  });

  it("rejects an invalid --max-turns", async () => {
    const { deps } = discussDeps();
    await expect(runDiscussCommand("owner/repo#83", { maxTurns: "zero" }, deps)).rejects.toThrow(
      /--max-turns/,
    );
    await expect(runDiscussCommand("owner/repo#83", { maxTurns: "-1" }, deps)).rejects.toThrow(
      /--max-turns/,
    );
  });

  it("rejects an invalid --log mode", async () => {
    const { deps } = discussDeps();
    await expect(runDiscussCommand("owner/repo#83", { log: "verbose" }, deps)).rejects.toThrow(/--log/);
  });

  it("exits 1 with reasons when the discussion fails", async () => {
    const { deps, stderr } = discussDeps({
      runWorkflow: async () => ({
        runId: "run-1",
        status: "failed",
        reasons: ["agent exploded"],
      }),
    });

    const result = await runDiscussCommand("owner/repo#83", {}, deps);

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("agent exploded");
  });

  it("emits JSON when --json is set", async () => {
    const { deps, stdout } = discussDeps({
      runWorkflow: async () => ({
        runId: "run-1",
        status: "awaiting_human",
        conclusion: conclusionFixture(),
        reasons: [],
      }),
    });

    const result = await runDiscussCommand("owner/repo#83", { json: true }, deps);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join("")) as { runId: string; status: string };
    expect(parsed.runId).toBe("run-1");
    expect(parsed.status).toBe("awaiting_human");
  });
});

async function createRunState(input: {
  command?: "discuss" | "run";
  status?: RunState["status"];
} = {}) {
  const runStore = createMemoryRunStore({
    now: () => new Date("2026-11-28T00:00:00.000Z"),
  });
  const created = await runStore.create({
    repository: "owner/repo",
    issueNumber: 83,
    command: input.command ?? "discuss",
    maxFixAttempts: 0,
    identity: {
      repository: "owner/repo",
      issueNumber: 83,
      branch: "meguribi/issue-83",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
  const state = await runStore.update(created.runId, {
    status: input.status ?? "created",
  });
  return { runStore, state };
}

function inboxStoreFake(): {
  createStore: (runId: string) => DiscussionInboxStore;
  written: { runId: string; message: string }[];
} {
  const written: { runId: string; message: string }[] = [];
  return {
    written,
    createStore: (runId) => ({
      appendTurn: async () => undefined,
      readTurns: async () => [],
      readHumanMessages: async () => [],
      saveConclusion: async () => undefined,
      readConclusion: async () => null,
      writeHumanMessage: async (message) => {
        written.push({ runId, message });
        return "inbox/1.json";
      },
    }),
  };
}

describe("runSayCommand", () => {
  it("writes a human message into an in-progress discussion run", async () => {
    const { runStore, state } = await createRunState({ status: "created" });
    const inbox = inboxStoreFake();
    const { deps, stdout } = discussDeps({
      runStore,
      createStore: inbox.createStore,
    });

    const result = await runSayCommand(state.runId, "A 案がよいと思う", deps);

    expect(result.exitCode).toBe(0);
    expect(inbox.written).toEqual([{ runId: state.runId, message: "A 案がよいと思う" }]);
    expect(stdout.join("")).toContain(state.runId);
  });

  it("rejects messages while awaiting human approval (no session consumes the inbox)", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    const inbox = inboxStoreFake();
    const { deps, stderr } = discussDeps({ runStore, createStore: inbox.createStore });

    const result = await runSayCommand(state.runId, "結論後の発言", deps);

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("議論中ではありません");
    expect(inbox.written).toHaveLength(0);
  });

  it("exits 1 when the run is not a discussion", async () => {
    const { runStore, state } = await createRunState({ command: "run" });
    const inbox = inboxStoreFake();
    const { deps, stderr } = discussDeps({ runStore, createStore: inbox.createStore });

    const result = await runSayCommand(state.runId, "hello", deps);

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("議論の Run ではありません");
    expect(inbox.written).toHaveLength(0);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "exits 1 when the discussion is already %s",
    async (status) => {
      const { runStore, state } = await createRunState({ status });
      const inbox = inboxStoreFake();
      const { deps, stderr } = discussDeps({ runStore, createStore: inbox.createStore });

      const result = await runSayCommand(state.runId, "hello", deps);

      expect(result.exitCode).toBe(1);
      expect(stderr.join("")).toContain("議論中ではありません");
      expect(inbox.written).toHaveLength(0);
    },
  );

  it("exits 1 for an unknown run or empty message", async () => {
    const { runStore, state } = await createRunState();
    const inbox = inboxStoreFake();
    const { deps } = discussDeps({ runStore, createStore: inbox.createStore });

    expect((await runSayCommand("missing-run", "hello", deps)).exitCode).toBe(1);
    expect((await runSayCommand(state.runId, "   ", deps)).exitCode).toBe(1);
    expect(inbox.written).toHaveLength(0);
  });
});

describe("runApproveCommand", () => {
  it("passes runStore/createStore/hashConclusion to the workflow and exits 0 on completion", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    const inbox = inboxStoreFake();
    let receivedInput: { runId: string; approver: string; comment?: string } | undefined;
    let receivedDeps:
      | Pick<DiscussionDependencies, "runStore" | "createStore" | "hashConclusion" | "now">
      | undefined;
    const { deps, stdout } = discussDeps({
      runStore,
      createStore: inbox.createStore,
      createDependencies: async () => {
        throw new Error("approve must not resolve agents or repository config");
      },
      resolveApprover: async () => "Test Approver",
      approveWorkflow: async (input, approveDeps) => {
        receivedInput = input;
        receivedDeps = approveDeps;
        return { runId: input.runId, status: "completed", reasons: [] };
      },
    });

    const result = await runApproveCommand(state.runId, { comment: "よさそう" }, deps);

    expect(result.exitCode).toBe(0);
    expect(receivedInput).toEqual({
      runId: state.runId,
      approver: "Test Approver",
      comment: "よさそう",
    });
    expect(receivedDeps?.runStore).toBe(runStore);
    expect(typeof receivedDeps?.createStore).toBe("function");
    expect(typeof receivedDeps?.hashConclusion).toBe("function");
    expect(stdout.join("")).toContain("承認しました");
  });

  it("exits 1 when the workflow does not complete the run", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    const { deps, stderr } = discussDeps({
      runStore,
      createStore: inboxStoreFake().createStore,
      resolveApprover: async () => "Test Approver",
      approveWorkflow: async (input) => ({
        runId: input.runId,
        status: "failed",
        reasons: ["not awaiting approval"],
      }),
    });

    const result = await runApproveCommand(state.runId, {}, deps);

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("not awaiting approval");
  });
});

describe("approver resolution", () => {
  it("exits 1 with guidance when the git user name cannot be resolved", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    let workflowCalled = false;
    const { deps, stderr } = discussDeps({
      runStore,
      createStore: inboxStoreFake().createStore,
      resolveApprover: async () => undefined,
      approveWorkflow: async (input) => {
        workflowCalled = true;
        return { runId: input.runId, status: "completed", reasons: [] };
      },
    });

    const result = await runApproveCommand(state.runId, {}, deps);

    expect(result.exitCode).toBe(1);
    expect(workflowCalled).toBe(false);
    expect(stderr.join("")).toContain("git config user.name");
  });

  it("reject also exits 1 with guidance when the git user name cannot be resolved", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    let workflowCalled = false;
    const { deps, stderr } = discussDeps({
      runStore,
      createStore: inboxStoreFake().createStore,
      resolveApprover: async () => undefined,
      rejectWorkflow: async (input) => {
        workflowCalled = true;
        return { runId: input.runId, status: "completed", reasons: [] };
      },
    });

    const result = await runRejectCommand(state.runId, { reason: "だめ" }, deps);

    expect(result.exitCode).toBe(1);
    expect(workflowCalled).toBe(false);
    expect(stderr.join("")).toContain("git config user.name");
  });
});

describe("runRejectCommand", () => {
  it("requires --reason", async () => {
    const { deps, stderr } = discussDeps();

    const result = await runRejectCommand("run-1", {}, deps);

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("--reason");
  });

  it("rejects without redo using only the approval deps", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    let receivedInput: { runId: string; reason: string; redo: boolean; approver?: string } | undefined;
    const { deps, stdout } = discussDeps({
      runStore,
      createStore: inboxStoreFake().createStore,
      createDependencies: async () => {
        throw new Error("reject without redo must not resolve agents or repository config");
      },
      resolveApprover: async () => "Test Rejecter",
      rejectWorkflow: async (input) => {
        receivedInput = input;
        return { runId: input.runId, status: "completed", reasons: [] };
      },
    });

    const result = await runRejectCommand(state.runId, { reason: "方向性が違う" }, deps);

    expect(result.exitCode).toBe(0);
    expect(receivedInput?.redo).toBe(false);
    expect(receivedInput?.reason).toBe("方向性が違う");
    expect(receivedInput?.approver).toBe("Test Rejecter");
    expect(stdout.join("")).toContain("却下しました");
  });

  it("builds full wiring and redo input when --redo is set", async () => {
    const { runStore, state } = await createRunState({ status: "awaiting_human" });
    let receivedInput: Partial<RunDiscussionWorkflowInput> | undefined;
    let wiringRequested = false;
    const { deps, stdout } = discussDeps({
      runStore,
      createStore: inboxStoreFake().createStore,
      createDependencies: async () => {
        wiringRequested = true;
        return wiringFixture();
      },
      resolveApprover: async () => "Test Rejecter",
      rejectWorkflow: async (input) => {
        receivedInput = input;
        return { runId: input.runId, status: "awaiting_human", reasons: [] };
      },
    });

    const result = await runRejectCommand(state.runId, { reason: "やり直し", redo: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(wiringRequested).toBe(true);
    expect(receivedInput?.repositoryPath).toBeDefined();
    expect(receivedInput?.repositoryRules).toBe("Follow AGENTS.md");
    expect(receivedInput?.limits).toBeDefined();
    expect(receivedInput?.artifactRoot).toBeDefined();
    expect(stdout.join("")).toContain("やり直します");
  });
});
