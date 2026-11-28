import { buildSpecificationPrompt } from "@meguribi/core";
import type {
  AgentPrompt,
  DiscussionConclusion,
  RoleAgent,
  RoleSession,
  SpecificationContent,
} from "@meguribi/core";
import { describe, expect, it, vi } from "vitest";
import { RoleSessionWriteViolationError } from "../acp-server/role-agent.js";
import { RolePlanningError } from "../role-planning/index.js";
import { specifyApprovedConclusion } from "./specifier.js";

function jsonFenced(value: unknown): string {
  return ["prefix", "```json", JSON.stringify(value), "```"].join("\n");
}

function content(seed = "夜間は通知しない"): SpecificationContent {
  return {
    problem: "夜間通知が煩い",
    targetUsers: ["個人"],
    requirements: [{ id: "REQ-1", statement: "通知をまとめられる", priority: "must" }],
    acceptanceCriteria: [
      {
        id: "AC-1",
        seed,
        given: "夜間",
        when: "通知が届く",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
        then: "即時通知しない",
        requirementIds: ["REQ-1"],
      },
    ],
    inScope: ["通知"], outOfScope: [], testPlan: ["unit"], successMetrics: [], guardrails: [], openQuestions: [],
  };
}

function conclusion(): DiscussionConclusion {
  return {
    topic: "通知", conclusion: "朝にまとめる", issues: [], rejectedOptions: [], openQuestions: [],
    acceptanceCriteriaSeeds: ["夜間は通知しない"], endedBy: "consensus", transcriptHash: "hash",
  };
}

function fakeAgent(script: readonly string[]) {
  const sessions: (RoleSession & { prompts: string[]; closed: boolean })[] = [];
  const openInputs: unknown[] = [];
  const agent: RoleAgent = {
    profileId: "specifier",
    kind: "codex",
    async openSession(input) {
      openInputs.push(input);
      let index = 0;
      const session: RoleSession & { prompts: string[]; closed: boolean } = {
        sessionId: "specifier-session",
        prompts: [],
        closed: false,
        async send(prompt: AgentPrompt) {
          session.prompts.push(prompt.content);
          const text = script[Math.min(index, script.length - 1)] ?? "";
          index += 1;
          return { sessionId: session.sessionId, text, events: [] };
        },
        async close() { session.closed = true; },
      };
      sessions.push(session);
      return session;
    },
  };
  return { agent, sessions, openInputs };
}

function inputFor(agent: RoleAgent) {
  return { specifier: agent, cwd: "/worktree", artifactRoot: "/artifacts", conclusion: conclusion() };
}

describe("specifyApprovedConclusion", () => {
  it("opens a read-only specifier session and returns validated specification content", async () => {
    const expected = content();
    const fake = fakeAgent([jsonFenced(expected)]);
    const result = await specifyApprovedConclusion(inputFor(fake.agent), buildSpecificationPrompt);
    expect(result).toEqual(expected);
    expect(fake.openInputs[0]).toMatchObject({ mode: "read-only", role: "specifier", cwd: "/worktree" });
    expect(fake.sessions[0]?.prompts).toHaveLength(1);
    expect(fake.sessions[0]?.prompts[0]).toContain("<untrusted-conclusion>");
    expect(fake.sessions[0]?.prompts[0]).toContain("[OUTPUT FORMAT]");
    expect(fake.sessions[0]?.closed).toBe(true);
  });

  it("accepts an unknown seed reference as schema-valid content for core traceability handling", async () => {
    const fake = fakeAgent([jsonFenced(content("unknown seed"))]);
    const result = await specifyApprovedConclusion(inputFor(fake.agent), () => "initial");
    expect(result.acceptanceCriteria[0]?.seed).toBe("unknown seed");
    expect(fake.sessions[0]?.prompts).toHaveLength(1);
  });

  it("throws malformed_output after three invalid responses and closes the session", async () => {
    const fake = fakeAgent(["not json", "not json", "not json"]);
    const error = await specifyApprovedConclusion(inputFor(fake.agent), () => "initial").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RolePlanningError);
    expect((error as RolePlanningError).code).toBe("malformed_output");
    expect(fake.sessions[0]?.prompts).toHaveLength(3);
    expect(fake.sessions[0]?.closed).toBe(true);
  });

  it("converts read-only write violations to policy_blocked and closes the session", async () => {
    const close = vi.fn(async () => undefined);
    const session: RoleSession = {
      sessionId: "specifier-write-violation",
      async send() {
        throw new RoleSessionWriteViolationError(["src/changed.ts"]);
      },
      close,
    };
    const agent: RoleAgent = {
      profileId: "specifier",
      kind: "codex",
      async openSession() {
        return session;
      },
    };
    const error = await specifyApprovedConclusion(inputFor(agent), () => "initial").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RolePlanningError);
    expect((error as RolePlanningError).code).toBe("policy_blocked");
    expect((error as Error).message).toContain("src/changed.ts");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight send, closes the session, and propagates cancelled", async () => {
    const controller = new AbortController();
    let resolveSend: ((result: { sessionId: string; text: string; events: [] }) => void) | undefined;
    const close = vi.fn(async () => undefined);
    const session: RoleSession = {
      sessionId: "specifier-cancelled",
      async send() {
        return await new Promise((resolve) => { resolveSend = resolve; });
      },
      close,
    };
    const agent: RoleAgent = {
      profileId: "specifier", kind: "codex",
      async openSession() { return session; },
    };
    const running = specifyApprovedConclusion(
      { ...inputFor(agent), abortSignal: controller.signal },
      () => "initial",
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    resolveSend?.({ sessionId: session.sessionId, text: jsonFenced(content()), events: [] });
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
