import { describe, expect, it } from "vitest";
import { createConsultationApi, validateConsultationInput } from "./consultation-api.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("consultation api", () => {
  it("loads configured discussion profiles", async () => {
    const calls: string[] = [];
    const api = createConsultationApi(async (input) => {
      calls.push(String(input));
      return response(200, {
        profiles: [
          { id: "claude-code", label: "Claude Code" },
          { id: "codex-acp", label: "Codex CLI (ACP)" },
        ],
        defaultProfileIds: ["claude-code", "codex-acp"],
      });
    });

    await expect(api.loadProfiles()).resolves.toEqual({
      profiles: [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex-acp", label: "Codex CLI (ACP)" },
      ],
      defaultProfileIds: ["claude-code", "codex-acp"],
    });
    expect(calls).toEqual(["/api/discussion/profiles"]);
  });

  it("loads selectable discussion issues lazily", async () => {
    const calls: string[] = [];
    const api = createConsultationApi(async (input) => {
      calls.push(String(input));
      return response(200, {
        issues: [
          { target: "owner/repo#96", title: "複数エージェント相談" },
          { target: "owner/repo#97", title: "通知整理" },
        ],
      });
    });

    await expect(api.loadIssues()).resolves.toEqual({
      issues: [
        { target: "owner/repo#96", title: "複数エージェント相談" },
        { target: "owner/repo#97", title: "通知整理" },
      ],
    });
    expect(calls).toEqual(["/api/discussion/issues"]);
  });

  it("starts a discussion with prompt, selected profiles, and optional target", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const api = createConsultationApi(async (input, init) => {
      calls.push({ input: String(input), init });
      return response(202, { runId: "run-1" });
    });

    await expect(
      api.startDiscussion({
        prompt: "夜間通知をどうするか相談したい",
        profileIds: ["claude-code", "codex-acp"],
        target: "owner/repo#96",
      }),
    ).resolves.toEqual({ runId: "run-1" });
    expect(calls[0]?.input).toBe("/api/discussions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        prompt: "夜間通知をどうするか相談したい",
        profileIds: ["claude-code", "codex-acp"],
        target: "owner/repo#96",
      }),
    );
  });

  it("omits an empty target and surfaces server errors", async () => {
    const bodies: unknown[] = [];
    const api = createConsultationApi(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response(400, { error: "profiles are unavailable" });
    });
    await expect(
      api.startDiscussion({ prompt: "相談", profileIds: ["a", "b"], target: "  " }),
    ).rejects.toThrow("profiles are unavailable");
    expect(bodies[0]).toEqual({ prompt: "相談", profileIds: ["a", "b"] });
  });
});

describe("validateConsultationInput", () => {
  it("requires a prompt and two to four distinct participants", () => {
    expect(validateConsultationInput({ prompt: " ", profileIds: ["a", "b"] })).toBe(
      "相談内容を入力してください",
    );
    expect(validateConsultationInput({ prompt: "相談", profileIds: ["a"] })).toBe(
      "参加エージェントを2〜4件選んでください",
    );
    expect(validateConsultationInput({ prompt: "相談", profileIds: ["a", "a"] })).toBe(
      "参加エージェントを2〜4件選んでください",
    );
    expect(validateConsultationInput({ prompt: "相談", profileIds: ["a", "b"] })).toBeNull();
  });

  it("accepts and rejects the shared prompt length contract at exact boundaries", () => {
    for (const length of [3999, 4000]) {
      expect(
        validateConsultationInput({ prompt: "あ".repeat(length), profileIds: ["a", "b"] }),
      ).toBeNull();
    }
    for (const length of [4001, 4096]) {
      expect(
        validateConsultationInput({ prompt: "あ".repeat(length), profileIds: ["a", "b"] }),
      ).toBe("相談内容は4000文字以内で入力してください");
    }
  });
});
