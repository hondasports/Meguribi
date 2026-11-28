import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile, InheritedMcpPolicy } from "@meguribi/core";
import { createDiscussionDependencies } from "./create-delivery-deps.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function devinProfile(id: string, inheritedMcpPolicy: InheritedMcpPolicy): AgentProfile {
  return {
    id,
    kind: "devin",
    transport: "acp",
    executable: "devin",
    startupTimeoutMs: 5_000,
    turnTimeoutMinutes: 1,
    inheritedMcpPolicy,
  };
}

interface CapturedFactory {
  profileId: string;
  env?: NodeJS.ProcessEnv;
  acpArgs?: string[];
  sessionEnvHook?: () => Promise<{
    env?: NodeJS.ProcessEnv;
    acpArgs?: readonly string[];
    cleanup?: () => Promise<void>;
  }>;
}

async function captureWiring(input: {
  discussionMcpPolicy?: "deny" | "allow";
  profilePolicy: InheritedMcpPolicy;
  interactive?: boolean;
}): Promise<CapturedFactory[]> {
  const cwd = await mkdtemp(join(tmpdir(), "meguribi-iso-wire-"));
  const runsRoot = await mkdtemp(join(tmpdir(), "meguribi-iso-runs-"));
  tempDirs.push(cwd, runsRoot);
  const captured: CapturedFactory[] = [];
  const profiles = [
    devinProfile("alpha", input.profilePolicy),
    devinProfile("beta", input.profilePolicy),
    devinProfile("gamma", input.profilePolicy),
  ];
  await createDiscussionDependencies({
    cwd,
    repositoryPath: cwd,
    runsRoot,
    localOnly: true,
    nonInteractive: input.interactive !== true,
    ...(input.discussionMcpPolicy !== undefined
      ? { discussionMcpPolicy: input.discussionMcpPolicy }
      : {}),
    loadAgentsConfig: async () => ({
      profiles,
      roles: {
        discussants: ["alpha", "beta"],
        summarizer: "gamma",
        planner: "alpha",
        reviewer: "beta",
        allowSameImplementerReviewer: false,
      },
      snapshot: {},
    }),
    diagnoseDevin: async () => ({
      executable: { path: "/fake/devin", version: "3000.14.0", source: "test" },
      auth: { ok: true },
      capabilities: { acp: true },
      runnable: true,
      inheritedMcpPolicy: input.profilePolicy,
      problems: [],
    }) as never,
    createAcpRoleAgent: ((factoryInput: {
      profile: AgentProfile;
      env?: NodeJS.ProcessEnv;
      acpArgs?: string[];
      sessionEnvHook?: CapturedFactory["sessionEnvHook"];
    }) => {
      captured.push({
        profileId: factoryInput.profile.id,
        env: factoryInput.env,
        acpArgs: factoryInput.acpArgs,
        sessionEnvHook: factoryInput.sessionEnvHook,
      });
      return { profileId: factoryInput.profile.id, kind: "devin" } as never;
    }) as never,
  });
  return captured;
}

describe("devin MCP isolation wiring", () => {
  it("deny 解決時は XDG_CONFIG_HOME 隔離と in-process を devin セッションへ適用する", async () => {
    const captured = await captureWiring({ discussionMcpPolicy: "deny", profilePolicy: "deny" });
    expect(captured.length).toBeGreaterThan(0);
    for (const input of captured) {
      // 隔離は wiring 時点でなく openSession 時に hook 経由で適用される。
      expect(input.sessionEnvHook).toBeDefined();
      const hookResult = await input.sessionEnvHook!();
      expect(hookResult.env?.XDG_CONFIG_HOME).toContain("meguribi-devin-iso-");
      expect(hookResult.env?.PATH).toBe(process.env.PATH);
      expect(hookResult.acpArgs).toContain("--process-model");
      expect(hookResult.acpArgs).toContain("in-process");
      await hookResult.cleanup?.();
    }
  });

  it("allow 解決時は隔離せず従来どおり継承する", async () => {
    const captured = await captureWiring({ discussionMcpPolicy: "allow", profilePolicy: "warn" });
    expect(captured.length).toBeGreaterThan(0);
    for (const input of captured) {
      expect(input.sessionEnvHook).toBeUndefined();
      expect(input.env?.XDG_CONFIG_HOME).toBeUndefined();
      expect(input.acpArgs ?? []).not.toContain("--process-model");
    }
  });

  it("warn のままでは隔離しない（検知と確認の従来経路を維持）", async () => {
    const captured = await captureWiring({ profilePolicy: "warn", interactive: true });
    expect(captured.length).toBeGreaterThan(0);
    for (const input of captured) {
      expect(input.sessionEnvHook).toBeUndefined();
      expect(input.env?.XDG_CONFIG_HOME).toBeUndefined();
    }
  });
});
