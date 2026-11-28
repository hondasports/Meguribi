import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@meguribi/core";
import {
  createDiscussionStartApi,
  probeAvailabilityCommand,
  type CliProcess,
} from "./discussion-start.js";

function profile(id: string, kind: AgentProfile["kind"], transport: "acp" | "sdk"): AgentProfile {
  return {
    id,
    kind,
    transport,
    executable: id,
    startupTimeoutMs: 1_000,
    turnTimeoutMinutes: 5,
    inheritedMcpPolicy: "warn",
  };
}

function profilesFixture() {
  return {
    profiles: [
      profile("claude-code", "claude-code", "acp"),
      profile("codex", "codex", "sdk"),
      profile("codex-acp", "codex", "acp"),
      profile("devin", "devin", "acp"),
    ],
    roles: { discussants: ["claude-code", "codex", "devin"] },
  };
}

class FakeChild extends EventEmitter implements CliProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  override once(event: "error" | "exit", listener: (value: unknown) => void): this {
    return super.once(event, listener);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

async function withServer(
  input: {
    children?: FakeChild[];
    loadProfiles?: () => Promise<ReturnType<typeof profilesFixture>>;
  },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const children = input.children ?? [new FakeChild()];
  const api = createDiscussionStartApi({
    repositoryPath: "/repo",
    loadProfiles: input.loadProfiles ?? (async () => profilesFixture()),
    diagnoseProfile: async () => ({ available: true }),
    startCli: () => children.shift() ?? new FakeChild(),
    runIdTimeoutMs: 200,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing test port");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function request(port: number, pathName: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${pathName}`, {
    ...init,
    headers: { host: `127.0.0.1:${String(port)}`, ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

describe("discussion start API", () => {
  it("returns configured ACP profile candidates with standard labels and ACP defaults", async () => {
    await withServer({}, async (port) => {
      const response = await request(port, "/api/discussion/profiles");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        profiles: [
          { id: "claude-code", label: "Claude Code", available: true },
          { id: "codex-acp", label: "Codex CLI", available: true },
          { id: "devin", label: "Devin CLI", available: true },
        ],
        defaultProfileIds: ["claude-code", "devin"],
      });
    });
  });

  it("marks unavailable candidates and selects only available defaults", async () => {
    const diagnosed: string[] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async ({ profile }) => {
        diagnosed.push(profile.id);
        if (profile.id === "codex-acp") {
          return { available: false, unavailableReason: "codex-acp executable not found" };
        }
        return { available: true };
      },
      startCli: () => new FakeChild(),
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussion/profiles");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        profiles: [
          { id: "claude-code", label: "Claude Code", available: true },
          {
            id: "codex-acp",
            label: "Codex CLI",
            available: false,
            unavailableReason: "codex-acp executable not found",
          },
          { id: "devin", label: "Devin CLI", available: true },
        ],
        defaultProfileIds: ["claude-code", "devin"],
      });
      expect(diagnosed).toEqual(["claude-code", "codex-acp", "devin"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses deny as the GET baseline and accepts an explicit discussionMcpPolicy query", async () => {
    const policies: Array<string | undefined> = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async ({ discussionMcpPolicy }) => {
        policies.push(discussionMcpPolicy);
        return { available: true };
      },
      startCli: () => new FakeChild(),
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const initial = await request(address.port, "/api/discussion/profiles");
      expect(initial.status).toBe(200);
      expect(policies).toEqual(["deny", "deny", "deny"]);
      policies.length = 0;
      const allowed = await request(address.port, "/api/discussion/profiles?discussionMcpPolicy=allow");
      expect(allowed.status).toBe(200);
      expect(policies).toEqual(["allow", "allow", "allow"]);
      const invalid = await request(address.port, "/api/discussion/profiles?discussionMcpPolicy=warn");
      expect(invalid.status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects before CLI startup when the effective custom summarizer is unavailable", async () => {
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => ({
        ...profilesFixture(),
        roles: { ...profilesFixture().roles, summarizer: "codex-acp" },
      }),
      diagnoseProfile: async ({ profile }) =>
        profile.id === "codex-acp"
          ? { available: false, unavailableReason: "codex-acp executable not found" }
          : { available: true },
      startCli: (args) => {
        calls.push([...args]);
        return new FakeChild();
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "相談",
          profileIds: ["claude-code", "devin"],
          discussionMcpPolicy: "deny",
        }),
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("summarizer");
      expect(response.body.error).toContain("codex-acp");
      expect(calls).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("treats an sdk-only effective summarizer as unavailable before CLI startup", async () => {
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => ({
        ...profilesFixture(),
        roles: { ...profilesFixture().roles, summarizer: "codex" },
      }),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        return new FakeChild();
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "相談",
          profileIds: ["claude-code", "devin"],
          discussionMcpPolicy: "deny",
        }),
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("summarizer");
      expect(response.body.error).toContain("does not use acp transport");
      expect(calls).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses a lightweight version probe instead of an ACP session for standalone bridges", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meguribi-acp-light-probe-"));
    const executableFile = process.platform === "win32" ? "fake-acp-light-probe.cmd" : "fake-acp-light-probe";
    const executable = path.join(dir, executableFile);
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho fake-acp 1.0\r\n"
        : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 1.0"; exit 0; fi\necho "unexpected full startup" >&2; exit 42\n',
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    const acpProfile = {
      ...profile("claude-code", "claude-code", "acp"),
      executable: "fake-acp-light-probe",
    };
    try {
      const api = createDiscussionStartApi({
        repositoryPath: dir,
        loadProfiles: async () => ({
          profiles: [acpProfile],
          roles: { discussants: ["claude-code"] },
        }),
        startCli: () => new FakeChild(),
        probeCommand: async () => {
          throw new Error("custom executable must not require a version probe");
        },
      });
      const server = http.createServer((req, res) => void api.handle(req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("missing test port");
      try {
        const response = await request(address.port, "/api/discussion/profiles");
        expect(response.status).toBe(200);
        expect(response.body.profiles).toEqual([
          { id: "claude-code", label: "Claude Code", available: true },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      process.env.PATH = originalPath;
      if (originalPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = originalPathExt;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the bundled official bridge for the built-in Claude profile on GET", async () => {
    const probes: Array<{ executable: string; executableArgs: readonly string[]; args: readonly string[]; timeoutMs: number }> = [];
    const api = createDiscussionStartApi({
      repositoryPath: process.cwd(),
      loadProfiles: async () => ({
        profiles: [
          {
            ...profile("claude-code", "claude-code", "acp"),
            executable: "claude-agent-acp",
          },
        ],
        roles: { discussants: ["claude-code"] },
      }),
      startCli: () => new FakeChild(),
      probeCommand: async ({ executable, executableArgs, args, timeoutMs }) => {
        probes.push({ executable, executableArgs, args, timeoutMs });
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "", timedOut: false };
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussion/profiles");
      expect(response.status).toBe(200);
      expect(response.body.profiles).toEqual([
        { id: "claude-code", label: "Claude Code", available: true },
      ]);
      expect(probes).toHaveLength(2);
      expect(probes[0]?.args).toEqual(["--version"]);
      expect(probes[1]?.args).toEqual(["auth", "status"]);
      expect(probes[0]?.executableArgs).toEqual([]);
      expect(probes[0]?.timeoutMs).toBe(5_000);
      expect(probes[1]?.timeoutMs).toBe(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not expose Claude auth output in the unavailable reason", async () => {
    const api = createDiscussionStartApi({
      repositoryPath: process.cwd(),
      loadProfiles: async () => ({
        profiles: [{ ...profile("claude-code", "claude-code", "acp"), executable: "claude-agent-acp" }],
        roles: { discussants: ["claude-code"] },
      }),
      startCli: () => new FakeChild(),
      probeCommand: async ({ args }) => {
        if (args[0] === "--version") {
          return { ok: true, exitCode: 0, stdout: "claude 1.0", stderr: "", timedOut: false };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({ loggedIn: false, organization: "secret-org", account: "person@example.com" }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussion/profiles");
      expect(response.status).toBe(200);
      expect(response.body.profiles[0]).toEqual({
        id: "claude-code",
        label: "Claude Code",
        available: false,
        unavailableReason: "Claude Code にログインしてください",
      });
      expect(JSON.stringify(response.body)).not.toContain("secret-org");
      expect(JSON.stringify(response.body)).not.toContain("person@example.com");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not expose Codex probe output in the unavailable reason", async () => {
    const sensitive = "token=sk-secret organization=secret-org";
    const api = createDiscussionStartApi({
      repositoryPath: process.cwd(),
      loadProfiles: async () => ({
        profiles: [{ ...profile("codex-acp", "codex", "acp"), executable: "codex-acp" }],
        roles: { discussants: ["codex-acp"] },
      }),
      startCli: () => new FakeChild(),
      probeCommand: async () => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: sensitive,
        timedOut: false,
      }),
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussion/profiles");
      expect(response.status).toBe(200);
      expect(response.body.profiles[0]).toEqual({
        id: "codex-acp",
        label: "Codex CLI",
        available: false,
        unavailableReason: "Codex CLI の実行ファイルを確認してください",
      });
      expect(JSON.stringify(response.body)).not.toContain("sk-secret");
      expect(JSON.stringify(response.body)).not.toContain("secret-org");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds a probe even when the child ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meguribi-probe-sigterm-"));
    const script = path.join(dir, "ignore-term.cjs");
    writeFileSync(script, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1_000);\n", "utf8");
    const startedAt = Date.now();
    try {
      const result = await probeAvailabilityCommand({
        executable: process.execPath,
        executableArgs: [script],
        args: [],
        cwd: dir,
        timeoutMs: 50,
      });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable selected profile before starting the CLI", async () => {
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async ({ profile }) =>
        profile.id === "devin"
          ? { available: false, unavailableReason: "Devin executable not found" }
          : { available: true },
      startCli: (args) => {
        calls.push([...args]);
        return new FakeChild();
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "相談",
          profileIds: ["claude-code", "devin"],
          discussionMcpPolicy: "deny",
        }),
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("devin");
      expect(response.body.error).toContain("Devin executable not found");
      expect(calls).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("revalidates POST selections with the submitted discussion MCP policy", async () => {
    const policies: Array<string | undefined> = [];
    const child = new FakeChild();
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async ({ discussionMcpPolicy }) => {
        policies.push(discussionMcpPolicy);
        return { available: true };
      },
      startCli: () => {
        setTimeout(() => child.stdout.emit("data", Buffer.from("Run ID: run-policy\n")), 0);
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      const response = await request(address.port, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "相談",
          profileIds: ["claude-code", "devin"],
          discussionMcpPolicy: "allow",
        }),
      });
      expect(response.status).toBe(202);
      expect(policies).toEqual(["allow", "allow"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts a normal issue discussion without entering discuss-to-pr and returns the early persistent run id", async () => {
    const child = new FakeChild();
    const calls: string[][] = [];
    await withServer({ children: [child] }, async (port) => {
      const api = createDiscussionStartApi({
        repositoryPath: "/repo",
        loadProfiles: async () => profilesFixture(),
        diagnoseProfile: async () => ({ available: true }),
        startCli: (args) => {
          calls.push([...args]);
          setTimeout(() => child.stdout.emit("data", Buffer.from("Run ID: run-persistent-1\n")), 0);
          return child;
        },
      });
      const server = http.createServer((req, res) => void api.handle(req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const directPort = typeof address === "object" && address !== null ? address.port : port;
      const pending = request(directPort, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "multi\nline; $(not shell)",
          profileIds: ["claude-code", "devin"],
          target: "owner/repo#22",
        }),
      });
      const response = await pending;
      server.closeAllConnections();
      server.close();
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ runId: "run-persistent-1" });
    });
    expect(calls[0]).toEqual([
      "discuss",
      "owner/repo#22",
      "--request",
      "multi\nline; $(not shell)",
      "--repo-path",
      "/repo",
      "--discussants",
      "claude-code,devin",
      "--non-interactive",
    ]);
    expect(calls[0]).not.toContain("workflow");
    expect(calls[0]).not.toContain("discuss-to-pr");
  });

  it("uses the prompt-only discuss contract when target is omitted", async () => {
    const child = new FakeChild();
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        setTimeout(() => child.stdout.emit("data", Buffer.from("Run ID: prompt-only-run\n")), 0);
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const pending = request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "相談", profileIds: ["claude-code", "codex-acp"] }),
    });
    const response = await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(202);
    expect(calls[0]?.slice(0, 3)).toEqual(["discuss", "--prompt", "相談"]);
    expect(calls[0]).toContain("--prompt");
    expect(calls[0]).toContain("--discussants");
    expect(calls[0]).not.toContain("workflow");
    expect(calls[0]).not.toContain("discuss-to-pr");
  });

  it("uses discuss-to-pr only when explicitly selected with an issue target", async () => {
    const child = new FakeChild();
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        setTimeout(() => child.stdout.emit("data", Buffer.from("Run ID: explicit-dtp\n")), 0);
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const pending = request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "実装まで進める",
        profileIds: ["claude-code", "devin"],
        target: "owner/repo#22",
        workflow: "discuss-to-pr",
      }),
    });
    const response = await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(202);
    expect(calls[0]?.slice(0, 4)).toEqual(["workflow", "run", "discuss-to-pr", "owner/repo#22"]);
  });

  it("accepts and rejects prompt length at the shared 4000-character boundaries", async () => {
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        const child = new FakeChild();
        setTimeout(
          () =>
            child.stdout.emit("data", Buffer.from(`Run ID: boundary-${String(calls.length)}\n`)),
          0,
        );
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    try {
      for (const length of [3999, 4000]) {
        const response = await request(address.port, "/api/discussions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "あ".repeat(length),
            profileIds: ["claude-code", "codex-acp"],
          }),
        });
        expect(response.status).toBe(202);
      }
      for (const length of [4001, 4096]) {
        const response = await request(address.port, "/api/discussions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "あ".repeat(length),
            profileIds: ["claude-code", "codex-acp"],
          }),
        });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe("prompt must be at most 4000 characters");
      }
      expect(calls).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects explicit discuss-to-pr without an issue target", async () => {
    await withServer({}, async (port) => {
      const response = await request(port, "/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "相談",
          profileIds: ["claude-code", "devin"],
          workflow: "discuss-to-pr",
        }),
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("requires target");
    });
  });

  it("passes an explicit discussionMcpPolicy through to the discuss CLI args", async () => {
    const child = new FakeChild();
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const pending = request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "MCP 検証",
        profileIds: ["claude-code", "devin"],
        discussionMcpPolicy: "allow",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdout.emit("data", Buffer.from("Run ID: run-mcp\n"));
    await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(calls[0]).toContain("--discussion-mcp-policy");
    const flagIndex = calls[0]!.indexOf("--discussion-mcp-policy");
    expect(calls[0]![flagIndex + 1]).toBe("allow");
  });

  it("does not pass any discussion-mcp-policy flag when the input omits it", async () => {
    const child = new FakeChild();
    const calls: string[][] = [];
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: (args) => {
        calls.push([...args]);
        return child;
      },
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const pending = request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "既定の相談", profileIds: ["claude-code", "devin"] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdout.emit("data", Buffer.from("Run ID: run-default\n"));
    await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // サーバー既定は許可しない: 省略時はフラグ自体を渡さず CLI の fail-closed に委ねる。
    expect(calls[0]).not.toContain("--discussion-mcp-policy");
  });

  it("rejects invalid discussionMcpPolicy values, non-string types, and the discuss-to-pr combination", async () => {
    await withServer({}, async (port) => {
      for (const body of [
        { prompt: "x", profileIds: ["claude-code", "devin"], discussionMcpPolicy: "sometimes" },
        { prompt: "x", profileIds: ["claude-code", "devin"], discussionMcpPolicy: true },
        { prompt: "x", profileIds: ["claude-code", "devin"], discussionMcpPolicy: "" },
        {
          prompt: "x",
          profileIds: ["claude-code", "devin"],
          target: "owner/repo#22",
          workflow: "discuss-to-pr",
          discussionMcpPolicy: "allow",
        },
      ]) {
        const response = await request(port, "/api/discussions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
    });
  });

  it("rejects invalid agent sets, blank prompt, sdk profiles, and foreign origins", async () => {
    await withServer({}, async (port) => {
      for (const body of [
        { prompt: " ", profileIds: ["claude-code", "devin"] },
        { prompt: "x", profileIds: ["claude-code"] },
        { prompt: "x", profileIds: ["claude-code", "claude-code"] },
        { prompt: "x", profileIds: ["claude-code", "devin", "claude-code"] },
        { prompt: "x", profileIds: ["claude-code", "codex"] },
      ]) {
        const response = await request(port, "/api/discussions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      const forbidden = await request(port, "/api/discussions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ prompt: "x", profileIds: ["claude-code", "devin"] }),
      });
      expect(forbidden.status).toBe(403);
    });
  });

  it("terminates a silent CLI when no persistent run id arrives within the time limit", async () => {
    const child = new FakeChild();
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: () => child,
      runIdTimeoutMs: 20,
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const response = await request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", profileIds: ["claude-code", "devin"] }),
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(502);
    expect(response.body.error).toContain("within the time limit");
    expect(child.killed).toBe(true);
  });

  it("returns a clear startup error when the CLI exits before reporting a run id", async () => {
    const child = new FakeChild();
    const api = createDiscussionStartApi({
      repositoryPath: "/repo",
      loadProfiles: async () => profilesFixture(),
      diagnoseProfile: async () => ({ available: true }),
      startCli: () => {
        setTimeout(() => {
          child.stderr.emit("data", Buffer.from("configuration failed"));
          child.emit("exit", 1);
        }, 0);
        return child;
      },
      runIdTimeoutMs: 200,
    });
    const server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing test port");
    const pending = request(address.port, "/api/discussions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", profileIds: ["claude-code", "devin"] }),
    });
    const response = await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(502);
    expect(response.body.error).toContain("persistent Run ID");
    expect(response.body.error).toContain("configuration failed");
  });
});
