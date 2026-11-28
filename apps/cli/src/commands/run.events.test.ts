import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeDeliveryDeps,
  FileSystemRunStore,
  FileSystemWorkflowEventLog,
} from "@meguribi/adapters";
import type {
  DeliveryDependencies,
  DeliveryResult,
  RunDeliveryInput,
  RunState,
  RunStore,
  LiveLogEvent,
  WorkflowEvent,
} from "@meguribi/core";
import {
  runResumeCommand,
  runRunCommand,
  type DeliveryCommandDependencies,
} from "./run.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-run-events-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function testIdentity(repository: string, issueNumber: number) {
  return {
    repository,
    issueNumber,
    branch: `meguribi/issue-${String(issueNumber)}`,
    worktreePath: "/tmp/worktree",
    baseRef: "origin/main",
    baseSha: "base-sha",
    headSha: "head-sha",
    remoteIdentity: `github.com/${repository}`,
  };
}

async function createState(runStore: RunStore, input: RunDeliveryInput): Promise<RunState> {
  return runStore.create({
    repository: input.repository,
    issueNumber: input.issueNumber,
    command: "run",
    identity: testIdentity(input.repository, input.issueNumber),
    maxFixAttempts: input.maxFixAttempts,
  });
}

function workflowStarted(runId: string): WorkflowEvent {
  return {
    type: "workflow.started",
    runId,
    workflow: "delivery",
    at: "2026-11-28T12:00:00.000Z",
  };
}

function workflowStepStarted(runId: string, stepId: "plan" | "implement"): WorkflowEvent {
  return {
    type: "workflow.step.started",
    runId,
    stepId,
    kind: stepId,
    visit: 1,
    at: "2026-11-28T12:00:01.000Z",
  };
}

function workflowStepCompleted(runId: string, stepId: "plan" | "implement"): WorkflowEvent {
  return {
    type: "workflow.step.completed",
    runId,
    stepId,
    kind: stepId,
    outcome: "continue",
    at: "2026-11-28T12:00:02.000Z",
  };
}

function workflowFinished(runId: string): WorkflowEvent {
  return {
    type: "workflow.finished",
    runId,
    workflow: "delivery",
    outcome: "stopped",
    at: "2026-11-28T12:00:09.000Z",
  };
}

function implementerStepStarted(): LiveLogEvent {
  return {
    type: "step.started",
    stepId: "implement",
    label: "implement",
    role: "implementer",
    profileId: "devin",
    agentLabel: "Devin",
  };
}

function implementerAgentEvent(): LiveLogEvent {
  return {
    type: "agent.event",
    stepId: "implement",
    profileId: "devin",
    agentLabel: "Devin",
    role: "implementer",
    event: {
      type: "message.delta",
      sessionId: "devin-session",
      text: "実装を進めます。",
      at: "2026-11-28T12:00:03.000Z",
    },
  };
}

function successfulResult(runId: string): DeliveryResult {
  return {
    runId,
    status: "awaiting_human",
    published: true,
    reasons: [],
  };
}

async function createHarness(): Promise<{
  runStore: FileSystemRunStore;
  delivery: DeliveryDependencies;
  eventLog: FileSystemWorkflowEventLog;
}> {
  const root = await tempRoot();
  const runStore = new FileSystemRunStore({
    rootDir: root,
    now: () => new Date("2026-11-28T12:00:00.000Z"),
    randomId: () => "abc123",
  });
  const fake = createFakeDeliveryDeps();
  return {
    runStore,
    delivery: { ...fake.deps, runStore },
    eventLog: new FileSystemWorkflowEventLog({ runStore }),
  };
}

function silentSignalHandlers(): () => void {
  return () => undefined;
}

describe("run/resume workflow event recording", () => {
  it("writes workflow events and implementer agent events to events.jsonl in order", async () => {
    const { delivery, eventLog } = await createHarness();
    const fakeRunDelivery: NonNullable<DeliveryCommandDependencies["runDelivery"]> = async (
      input,
      deps,
    ) => {
      const state = await createState(deps.runStore, input);
      await deps.onStateChange?.(state);
      deps.onWorkflowEvent?.(workflowStarted(state.runId));
      deps.onWorkflowEvent?.(workflowStepStarted(state.runId, "plan"));
      deps.onWorkflowEvent?.(workflowStepCompleted(state.runId, "plan"));
      deps.onWorkflowEvent?.(workflowStepStarted(state.runId, "implement"));
      deps.onAgentEvent?.(implementerStepStarted());
      deps.onAgentEvent?.(implementerAgentEvent());
      deps.onWorkflowEvent?.(workflowStepCompleted(state.runId, "implement"));
      deps.onWorkflowEvent?.(workflowFinished(state.runId));
      return successfulResult(state.runId);
    };
    const stderr: string[] = [];

    const result = await runRunCommand(
      "owner/repo#76",
      { json: true, log: "none" },
      {
        delivery,
        runDelivery: fakeRunDelivery,
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
        installSignalHandlers: silentSignalHandlers,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.result?.published).toBe(true);
    const read = await eventLog.read(result.result!.runId);
    expect(read.records.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "workflow.step.started",
      "workflow.step.completed",
      "workflow.step.started",
      "step.started",
      "agent.event",
      "workflow.step.completed",
      "workflow.finished",
    ]);
    expect(read.skippedLines).toBe(0);
    expect(stderr.join("")).not.toContain("warning: failed to append workflow event");
  });

  it("records planner events emitted through the delivery wiring observer even when live logs are disabled", async () => {
    const { delivery, eventLog } = await createHarness();
    let wiringObserver: ((event: LiveLogEvent) => void) | undefined;
    const plannerStepStarted: LiveLogEvent = {
      type: "step.started",
      stepId: "plan",
      label: "plan",
      role: "planner",
      profileId: "codex",
      agentLabel: "Codex",
    };
    const fakeRunDelivery: NonNullable<DeliveryCommandDependencies["runDelivery"]> = async (
      input,
      deps,
    ) => {
      const state = await createState(deps.runStore, input);
      await deps.onStateChange?.(state);
      wiringObserver?.(plannerStepStarted);
      deps.onAgentEvent?.(implementerAgentEvent());
      return successfulResult(state.runId);
    };

    const result = await runRunCommand(
      "owner/repo#76",
      { json: true, log: "none" },
      {
        createDeliveryDeps: async (options) => {
          wiringObserver = options.onAgentEvent;
          return {
            deps: {
              ...delivery,
              ...(options.onAgentEvent ? { onAgentEvent: options.onAgentEvent } : {}),
            },
            inheritedMcpPolicy: "allow",
          };
        },
        runDelivery: fakeRunDelivery,
        stdout: () => undefined,
        stderr: () => undefined,
        installSignalHandlers: silentSignalHandlers,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(wiringObserver).toBeDefined();
    const read = await eventLog.read(result.result!.runId);
    expect(read.records.map((record) => record.event.type)).toEqual([
      "step.started",
      "agent.event",
    ]);
  });

  it("keeps initial resume workflow events until the first observed state supplies the runId", async () => {
    const { runStore, delivery, eventLog } = await createHarness();
    const seed = await runStore.create({
      repository: "owner/repo",
      issueNumber: 76,
      command: "run",
      identity: testIdentity("owner/repo", 76),
      maxFixAttempts: 2,
    });
    const fakeResumeDelivery: NonNullable<DeliveryCommandDependencies["resumeDelivery"]> = async (
      _input,
      deps,
    ) => {
      deps.onWorkflowEvent?.(workflowStarted(seed.runId));
      deps.onWorkflowEvent?.(workflowStepStarted(seed.runId, "implement"));
      await deps.onStateChange?.({
        ...seed,
        status: "verifying",
        currentStep: "verifying",
      });
      deps.onAgentEvent?.(implementerAgentEvent());
      deps.onWorkflowEvent?.(workflowFinished(seed.runId));
      return successfulResult(seed.runId);
    };

    const result = await runResumeCommand(
      "owner/repo#76",
      { json: true, log: "none", runId: seed.runId },
      {
        delivery,
        resumeDelivery: fakeResumeDelivery,
        stdout: () => undefined,
        stderr: () => undefined,
        installSignalHandlers: silentSignalHandlers,
      },
    );

    expect(result.exitCode).toBe(0);
    const read = await eventLog.read(seed.runId);
    expect(read.records.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "workflow.step.started",
      "agent.event",
      "workflow.finished",
    ]);
  });

  it("warns once without changing the result when appending events fails", async () => {
    const { runStore, delivery } = await createHarness();
    const fakeRunDelivery: NonNullable<DeliveryCommandDependencies["runDelivery"]> = async (
      input,
      deps,
    ) => {
      const state = await createState(deps.runStore, input);
      const runDirectory = await runStore.runDirectory(state.runId);
      await fs.mkdir(path.join(runDirectory!, "events.jsonl"));
      await deps.onStateChange?.(state);
      deps.onWorkflowEvent?.(workflowStarted(state.runId));
      deps.onWorkflowEvent?.(workflowStepStarted(state.runId, "plan"));
      deps.onWorkflowEvent?.(workflowFinished(state.runId));
      return successfulResult(state.runId);
    };
    const stderr: string[] = [];

    const result = await runRunCommand(
      "owner/repo#76",
      { json: true, log: "none" },
      {
        delivery,
        runDelivery: fakeRunDelivery,
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
        installSignalHandlers: silentSignalHandlers,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({ published: true, status: "awaiting_human" });
    const warnings = stderr.join("").match(/warning: failed to append workflow event/g) ?? [];
    expect(warnings).toHaveLength(1);
  });
});
