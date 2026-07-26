import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DevinDiagnosis } from "@meguribi/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCompatibilitySmoke } from "../src/compatibility-smoke.js";

const artifactDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(artifactDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Devin compatibility smoke", () => {
  it("fails closed without real Devin opt-in", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-opt-in-"));
    artifactDirectories.push(artifactDirectory);
    const result = await runCompatibilitySmoke({ artifactDirectory, optIn: false });

    expect(result.status).toBe("blocked");
    expect(result.acpCompatible).toBe(false);
    expect(result.cliVersion).toBe("not-started");
    await expect(fs.readFile(path.join(artifactDirectory, "compatibility-result.json"), "utf8")).resolves.toContain("no external agent was started");
  });

  it("runs the fake ACP through the production adapter facade", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-fake-"));
    artifactDirectories.push(artifactDirectory);
    const result = await runCompatibilitySmoke({
      artifactDirectory,
      fake: true,
      optIn: true,
      fakeMode: "write-in-scope",
    });

    expect(result.status).toBe("completed");
    expect(result.acpCompatible).toBe(true);
    expect(result.sessionStarted).toBe(true);
    expect(result.promptCompleted).toBe(true);
    expect(result.worktreeBoundaryOk).toBe(true);
    expect(result.shutdownCompleted).toBe(true);
    expect(result.changedFiles).toEqual(["README.md"]);
    expect(result.outsideChanges).toEqual([]);
    expect(result.residualProcesses).toBe(false);
    expect(result.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.minimumSupportedVersion).toMatch(/^\d+\.\d+\.\d+/);
    await expect(fs.readFile(path.join(artifactDirectory, "raw-events.jsonl"), "utf8")).resolves.toContain("session_update");
    await expect(fs.readFile(path.join(artifactDirectory, "events.jsonl"), "utf8")).resolves.toContain("turn.completed");
  });

  it("blocks when Devin diagnosis is not runnable", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-diagnosis-"));
    artifactDirectories.push(artifactDirectory);
    const diagnosis: DevinDiagnosis = {
      executable: { status: "ok", path: "devin" },
      version: { status: "supported", raw: "3000.0.0" },
      authentication: { status: "unauthenticated" },
      acp: { status: "supported" },
      inheritedMcpPolicy: "deny",
      runnable: false,
      warnings: [],
      errors: [
        { code: "unauthenticated", message: "Devin CLI is not authenticated", nextAction: "Run: devin auth login" },
      ],
    };
    const result = await runCompatibilitySmoke({ artifactDirectory, optIn: true, diagnosis });

    expect(result.status).toBe("blocked");
    expect(result.implementation).toBeNull();
    expect(result.error).toContain("not authenticated");
  });

  it("records worktree boundary violation and outside changes", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-outside-"));
    artifactDirectories.push(artifactDirectory);
    const result = await runCompatibilitySmoke({
      artifactDirectory,
      fake: true,
      optIn: true,
      fakeMode: "write-outside",
    });

    expect(result.status).toBe("blocked");
    expect(result.worktreeBoundaryOk).toBe(false);
    expect(result.outsideChanges.length).toBeGreaterThan(0);
    expect(result.implementation).not.toBeNull();
  });

  it("blocks unexpected inherited MCP under deny policy", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-mcp-deny-"));
    artifactDirectories.push(artifactDirectory);
    const result = await runCompatibilitySmoke({
      artifactDirectory,
      fake: true,
      optIn: true,
      fakeMode: "mcp-stderr",
      inheritedMcpPolicy: "deny",
    });

    expect(result.status).toBe("blocked");
    expect(result.implementation).not.toBeNull();
    expect(result.error ?? "").toMatch(/unexpected.*stdio.*MCP|detected unexpected stdio MCP/);
  });

  it("force-terminates a SIGTERM-ignoring fake ACP without residual processes", async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-compatibility-sigterm-"));
    artifactDirectories.push(artifactDirectory);
    const result = await runCompatibilitySmoke({
      artifactDirectory,
      fake: true,
      optIn: true,
      fakeMode: "ignore-sigterm",
    });

    expect(result.status).toBe("completed");
    expect(result.residualProcesses).toBe(false);
    expect(result.shutdownCompleted).toBe(true);
  });
});
