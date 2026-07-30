import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiscoverCommand } from "./discover.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runDiscoverCommand", () => {
  it("reads supplied observations and emits JSON without creating Issues", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discover-command-"));
    roots.push(root);
    const input = path.join(root, "observations.json");
    await fs.writeFile(input, JSON.stringify({ observations: [{ statement: "reported fact", source: "notes", confidence: "reported" }] }), "utf8");
    const output: string[] = [];
    let received: unknown;
    const result = await runDiscoverCommand("owner/repo", { json: true, input, since: "2026-07-01", limit: 3 }, {
      discover: {} as never,
      discoverProblems: async (value) => {
        received = value;
        return {
          artifact: {
            schemaVersion: 1,
            artifactType: "discovery",
            repository: "owner/repo",
            generatedAt: "2026-07-03T00:00:00.000Z",
            filters: { updatedSince: "2026-07-01", limit: 3 },
            observations: [...(value.fileObservations ?? [])],
            problemCandidates: [],
          },
          artifactPath: "C:/data/discovery.json",
        };
      },
      stdout: (text) => output.push(text),
    });

    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({ repository: "owner/repo", since: "2026-07-01", limit: 3, fileObservations: [{ statement: "reported fact" }] });
    expect(JSON.parse(output[0] ?? "{}").artifactPath).toBe("C:/data/discovery.json");
  });
});
