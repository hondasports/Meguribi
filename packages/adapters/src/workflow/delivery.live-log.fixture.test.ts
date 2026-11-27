import { describe, expect, it } from "vitest";
import {
  runDelivery,
  type AgentAdapter,
  type LiveLogEvent,
  type RunDeliveryInput,
} from "@meguribi/core";
import { createFakeDeliveryDeps } from "../fakes/delivery-fakes.js";

function baseInput(overrides: Partial<RunDeliveryInput> = {}): RunDeliveryInput {
  return {
    repository: "owner/repo",
    issueNumber: 22,
    repositoryPath: "/repo",
    worktreePath: "/worktree",
    branch: "meguribi/issue-22",
    baseRef: "origin/main",
    repositoryRules: "Follow AGENTS.md",
    completionCriteria: ["tests pass"],
    outOfScope: [],
    requiredLabels: ["agent:ready"],
    protectedPaths: [".env"],
    verifyCommands: [{ name: "test", run: "pnpm test" }],
    inheritedMcpPolicy: "allow",
    allowInheritedMcp: false,
    nonInteractive: false,
    maxFixAttempts: 2,
    artifactRootForDevin: "/artifacts",
    ...overrides,
  };
}

describe("delivery workflow live log", () => {
  it("emits step.started then forwarded agent events for the implementer", async () => {
    const bundle = createFakeDeliveryDeps();
    const implementer: AgentAdapter = {
      implement: async (input) => {
        input.onEvent?.({
          type: "message.delta",
          sessionId: "implement-session",
          text: "implementing now",
          at: "2026-07-26T12:00:00.000Z",
        });
        return bundle.devin.implement(input);
      },
      fix: (input) => bundle.devin.fix(input),
    };
    const events: LiveLogEvent[] = [];
    const result = await runDelivery(baseInput(), {
      ...bundle.deps,
      implementer,
      onAgentEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.published).toBe(true);
    const stepIndex = events.findIndex(
      (event) => event.type === "step.started" && event.stepId === "implement",
    );
    const messageIndex = events.findIndex(
      (event) =>
        event.type === "agent.event" &&
        event.stepId === "implement" &&
        event.role === "implementer" &&
        event.event.type === "message.delta",
    );
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(stepIndex);

    const stepStarted = events[stepIndex];
    expect(stepStarted).toMatchObject({
      type: "step.started",
      stepId: "implement",
      role: "implementer",
      profileId: "devin",
      agentLabel: "Devin",
    });
    const agentEvent = events[messageIndex];
    expect(agentEvent).toMatchObject({
      type: "agent.event",
      stepId: "implement",
      role: "implementer",
      profileId: "devin",
      agentLabel: "Devin",
    });
  });
});
