import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe } from "../src/probe.js";
import { startFakeHttpMcpServer } from "../src/fake-http-mcp.js";
import { createFixture } from "../src/workspace.js";
import { artifactDirectory, fakeCommand } from "./helpers.js";
import type { Fixture } from "../src/workspace.js";

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.cleanup();
  }
});

async function runFake(mode: string, options: { timeoutMs?: number; cancelAfterMs?: number; env?: NodeJS.ProcessEnv; mcpPolicy?: "deny-all" | "allowlist"; allowedMcpNames?: string[] } = {}) {
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
    env: { FAKE_ACP_MODE: mode, ...options.env },
    ...(options.mcpPolicy === undefined ? {} : { mcpPolicy: options.mcpPolicy }),
    ...(options.allowedMcpNames === undefined ? {} : { allowedMcpNames: options.allowedMcpNames })
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
    expect(result.mcp.sourceOrder).toEqual(["user", "project", "local", "cli"]);
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

  it("blocks fake stdio MCP before it starts under deny-all", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-mcp-"));
    try {
      const marker = path.join(root, "stdio.marker");
      const result = await runFake("mcp-stdio", { env: { FAKE_MCP_MARKER: marker } });
      expect(result.status).toBe("failed");
      expect(result.mcp.action).toBe("blocked-and-terminated");
      expect(result.mcp.unexpected[0]?.name).toBe("fake-stdio");
      await expect(fs.readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("detects an unexpected MCP connection before prompt", async () => {
    const result = await runFake("mcp-preprompt");
    expect(result.status).toBe("failed");
    expect(result.mcp.action).toBe("blocked-and-terminated");
    expect(result.mcp.unexpected[0]?.name).toBe("fake-preprompt");
    expect(result.changedFiles).toEqual([]);
  });

  it("allows only an exact fake stdio MCP allowlist entry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-mcp-"));
    const marker = path.join(root, "stdio.marker");
    const result = await runFake("mcp-stdio", {
      env: { FAKE_MCP_MARKER: marker },
      mcpPolicy: "allowlist",
      allowedMcpNames: ["fake-stdio"],
      timeoutMs: 5_000
    });
    expect(result.status).toBe("completed");
    expect(result.mcp.unexpected).toEqual([]);
    expect(await fs.readFile(marker, "utf8")).toContain("fake-stdio:started");
    expect(result.residualProcesses).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("blocks fake HTTP MCP before the localhost request under deny-all", async () => {
    const server = await startFakeHttpMcpServer();
    try {
      const result = await runFake("mcp-http", { env: { FAKE_MCP_HTTP_URL: server.url } });
      expect(result.status).toBe("failed");
      expect(result.mcp.action).toBe("blocked-and-terminated");
      expect(server.requests).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("allows a localhost fake HTTP MCP only when allowlisted", async () => {
    const server = await startFakeHttpMcpServer();
    try {
      const result = await runFake("mcp-http", {
        env: { FAKE_MCP_HTTP_URL: server.url },
        mcpPolicy: "allowlist",
        allowedMcpNames: ["fake-http"]
      });
      expect(result.status).toBe("completed");
      expect(result.mcp.unexpected).toEqual([]);
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });
});
