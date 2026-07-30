import { describe, expect, it } from "vitest";
import { runPromoteCommand } from "./promote.js";

describe("runPromoteCommand", () => {
  it("creates a local Problem draft only from a validated hypothesis", async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const result = await runPromoteCommand(
      "owner/repo#12",
      { json: true },
      {
        stdout: (text) => output.push(text),
        promote: {
          github: {
            getIssue: async () => ({
              number: 12,
              title: "Registration drop-off",
              body: ["## 観測", "- 離脱が報告された", "## 課題候補", "- 登録を完了できない利用者がいる"].join("\n"),
              labels: ["product:validated"],
              comments: [],
              updatedAt: "2026-07-30T00:00:00.000Z",
            }),
            upsertMarkerComment: async (input) => {
              calls.push(input.marker);
              return { commentId: 5 };
            },
            createIssue: async () => {
              throw new Error("must not create without --create-issue");
            },
          },
          artifactStore: { save: async () => "C:/data/problem.json" },
          now: () => new Date("2026-07-30T01:00:00.000Z"),
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.result?.artifact.problem).toContain("登録を完了");
    expect(JSON.parse(output.join("")).artifact.humanApprovalRequired).toBe(true);
    expect(calls).toEqual(["<!-- meguribi:promote -->"]);
  });

  it("requires explicit confirmation before creating an Issue", async () => {
    let created = false;
    await runPromoteCommand("owner/repo#12", { createIssue: true }, {
      confirmCreateIssue: async () => false,
      promote: {
        github: {
          getIssue: async () => ({ number: 12, title: "Problem", body: "## 観測\n- fact\n## 課題候補\n- problem", labels: ["product:validated"], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }),
          upsertMarkerComment: async () => ({ commentId: 1 }),
          createIssue: async () => { created = true; return { number: 13, url: "local://issues/13" }; },
        },
        artifactStore: { save: async () => "problem.json" },
      },
    }).catch((error: unknown) => expect(error).toEqual(new Error("Problem Issue creation was not confirmed; draft remains saved")));
    expect(created).toBe(false);
  });
});
