import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe } from "../src/probe.js";
import { createFixture } from "../src/workspace.js";
import { artifactDirectory, fakeCommand } from "./helpers.js";
import type { Fixture } from "../src/workspace.js";

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.cleanup();
  }
});

async function runFake(mode: string, options: { timeoutMs?: number; cancelAfterMs?: number } = {}) {
  const fixture = await createFixture();
  fixtures.push(fixture);
  const command = fakeCommand();
  return runProbe({
    ...command,
    cliVersion: "fake-0.1.0",
    cwd: fixture.worktree,
    prompt: "fixture prompt",
    artifactDir: artifactDirectory(),
    timeoutMs: options.timeoutMs ?? 1_000,
    ...(options.cancelAfterMs === undefined ? {} : { cancelAfterMs: options.cancelAfterMs }),
    allowedWritePaths: ["README.md"],
    outsideRoots: [fixture.normalCheckout, fixture.outside],
    env: { FAKE_ACP_MODE: mode }
  });
}

describe("Devin ACP probe", () => {
  it("runs the ACP lifecycle and changes only the fixture worktree", async () => {
    const result = await runFake("success");
    expect(result.status).toBe("completed");
    expect(result.protocolVersion).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.changedFiles).toEqual(["README.md"]);
    expect(result.outsideChanges).toEqual([]);
    expect(result.permissionRequests).toEqual([{ requestId: "fake-edit", summary: "Edit README.md", decision: "allow" }]);
    expect(await fs.readFile(path.join(result.cwd, "README.md"), "utf8")).toContain("ACP fixture change");
  });

  it("denies forbidden Git operations and records the decision", async () => {
    const result = await runFake("forbidden");
    expect(result.status).toBe("completed");
    expect(result.permissionRequests).toEqual([{ requestId: "forbidden-git", summary: "git push", decision: "deny" }]);
    expect(result.changedFiles).toEqual([]);
  });

  it("records timeout and terminates the child process", async () => {
    const result = await runFake("timeout", { timeoutMs: 100 });
    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBeNull();
  });

  it("records cancellation and terminates the child process", async () => {
    const result = await runFake("cancel", { timeoutMs: 1_000, cancelAfterMs: 100 });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBeNull();
  });

  it("turns malformed protocol output and abnormal exits into failures", async () => {
    const malformed = await runFake("malformed");
    expect(malformed.status).toBe("failed");
    const crashed = await runFake("crash");
    expect(crashed.status).toBe("failed");
  });
});
