import { describe, expect, it } from "vitest";
import { createDiscussionApi } from "./discussion-api.js";

function jsonResponse(status: number, value: unknown): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("discussion api client", () => {
  it("loads discussion detail for the encoded run id", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const api = createDiscussionApi(async (input, init) => {
      calls.push({ input: String(input), ...(init !== undefined ? { init } : {}) });
      return jsonResponse(200, {
        turns: [],
        conclusion: null,
        approval: null,
        canInterject: true,
        canDecide: false,
      });
    });

    const detail = await api.load("run/1");

    expect(calls).toEqual([{ input: "/api/run-store/runs/run%2F1/discussion" }]);
    expect(detail.canInterject).toBe(true);
  });

  it("posts say/approve/reject as JSON to the CLI-backed endpoints", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const api = createDiscussionApi(async (input, init) => {
      calls.push({ input: String(input), ...(init !== undefined ? { init } : {}) });
      return jsonResponse(200, { ok: true, stdout: "done" });
    });

    await api.say("run-1", "改行\n; echo dangerous");
    await api.approve("run-1", "承認コメント");
    await api.reject("run-1", "やり直し", true);

    expect(calls.map((call) => [call.input, call.init?.method, call.init?.body])).toEqual([
      [
        "/api/run-store/runs/run-1/say",
        "POST",
        JSON.stringify({ message: "改行\n; echo dangerous" }),
      ],
      ["/api/run-store/runs/run-1/approve", "POST", JSON.stringify({ comment: "承認コメント" })],
      [
        "/api/run-store/runs/run-1/reject",
        "POST",
        JSON.stringify({ reason: "やり直し", redo: true }),
      ],
    ]);
    expect(
      calls.every(
        (call) => new Headers(call.init?.headers).get("Content-Type") === "application/json",
      ),
    ).toBe(true);
  });

  it("returns 422 action payloads so the UI can show CLI stderr", async () => {
    const api = createDiscussionApi(async () =>
      jsonResponse(422, { ok: false, stderr: "not_awaiting_approval" }),
    );

    await expect(api.approve("run-1")).resolves.toEqual({
      ok: false,
      stderr: "not_awaiting_approval",
    });
  });

  it("throws a readable error when the detail endpoint fails", async () => {
    const api = createDiscussionApi(async () => jsonResponse(404, { error: "Run not found" }));

    await expect(api.load("missing")).rejects.toThrow("Run not found");
  });
});
