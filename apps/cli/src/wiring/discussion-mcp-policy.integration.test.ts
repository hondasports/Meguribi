import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcpRoleAgent,
  diagnoseAcpServer,
} from "@meguribi/adapters";
import type { AgentDiagnosis, AgentProfile, InheritedMcpPolicy } from "@meguribi/core";
import { createDiscussionDependencies } from "./create-delivery-deps.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function node(): string {
  return process.execPath;
}

function fakeAcpServer(): string {
  return fileURLToPath(
    new URL("../../../../packages/adapters/src/devin/fixtures/fake-acp-server.js", import.meta.url),
  );
}

function profile(id: string, inheritedMcpPolicy: InheritedMcpPolicy): AgentProfile {
  return {
    id,
    kind: "claude-code",
    transport: "acp",
    executable: "fake-discussion-acp",
    startupTimeoutMs: 5_000,
    turnTimeoutMinutes: 1,
    inheritedMcpPolicy,
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, windowsHide: true });
}

async function tempGit(): Promise<{ cwd: string; artifactRoot: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discussion-mcp-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discussion-mcp-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await git(cwd, ["config", "user.name", "Meguribi Test"]);
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "fixture"]);
  return { cwd, artifactRoot };
}

interface CapturedDiagnosis {
  profileId: string;
  diagnosis: AgentDiagnosis;
}

interface CapturedFactoryInput {
  profileId: string;
}

async function wiredDiscussion(input: {
  cwd: string;
  mode: "success" | "mcp-stderr";
  discussionMcpPolicy?: "deny" | "allow";
  profilePolicy?: InheritedMcpPolicy;
}) {
  const diagnoses: CapturedDiagnosis[] = [];
  const factoryInputs: CapturedFactoryInput[] = [];
  const profilePolicy = input.profilePolicy ?? "warn";
  const profiles = ["alpha", "beta", "gamma"].map((id) => profile(id, profilePolicy));
  const env = { ...process.env, FAKE_ACP_MODE: input.mode };
  const deps = await createDiscussionDependencies({
    cwd: input.cwd,
    repositoryPath: input.cwd,
    localOnly: true,
    nonInteractive: true,
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
    diagnoseAcpServer: async (diagnoseInput) => {
      const diagnosis = await diagnoseAcpServer({
        ...diagnoseInput,
        executable: node(),
        executableArgs: [fakeAcpServer()],
        env,
      });
      diagnoses.push({
        profileId: diagnoseInput.profile.id,
        diagnosis,
      });
      return diagnosis;
    },
    createAcpRoleAgent: (factoryInput) => {
      factoryInputs.push({
        profileId: factoryInput.profile.id,
      });
      return createAcpRoleAgent({
        ...factoryInput,
        executable: node(),
        executableArgs: [fakeAcpServer()],
        env,
      });
    },
  });
  return { deps, diagnoses, factoryInputs };
}

describe("discussion MCP policy wiring integration", () => {
  it("fails default warn in non-interactive mode with the policy reason before a session", async () => {
    const { cwd } = await tempGit();
    const error = await wiredDiscussion({ cwd, mode: "success" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeDefined();
    const diagnosis = (error as { diagnosis?: AgentDiagnosis }).diagnosis;
    expect(diagnosis?.runnable).toBe(false);
    expect(diagnosis?.errors.map((item) => item.code)).toContain("policy_blocked");
    expect(diagnosis?.errors[0]?.message).toContain("inheritedMcpPolicy is warn");
  });

  it("applies run-scoped deny to discussants and the summarizer after session start", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const { deps, diagnoses, factoryInputs } = await wiredDiscussion({
      cwd,
      mode: "mcp-stderr",
      discussionMcpPolicy: "deny",
      profilePolicy: "allow",
    });

    expect(diagnoses.map((item) => item.profileId)).toEqual(["alpha", "beta", "gamma"]);
    expect(diagnoses.every((item) => item.diagnosis.runnable)).toBe(true);
    expect(factoryInputs.map((item) => item.profileId)).toEqual(["alpha", "beta", "gamma"]);

    const discussant = await deps.discussants[0]!.openSession({
      cwd,
      mode: "read-only",
      role: "discussant",
      artifactRoot: path.join(artifactRoot, "alpha"),
    });
    await expect(discussant.send({ content: "hello" })).rejects.toMatchObject({
      code: "policy_blocked",
    });
    await discussant.close().catch(() => undefined);

    const summarizer = await deps.summarizer.openSession({
      cwd,
      mode: "read-only",
      role: "summarizer",
      artifactRoot: path.join(artifactRoot, "gamma"),
    });
    await expect(summarizer.send({ content: "summarize" })).rejects.toMatchObject({
      code: "policy_blocked",
    });
    await summarizer.close().catch(() => undefined);
  });

  it("treats run-scoped allow as explicit acceptance for warn and reaches session start", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const { deps, diagnoses, factoryInputs } = await wiredDiscussion({
      cwd,
      mode: "mcp-stderr",
      discussionMcpPolicy: "allow",
    });

    expect(diagnoses.map((item) => item.profileId)).toEqual(["alpha", "beta", "gamma"]);
    expect(diagnoses.every((item) => item.diagnosis.runnable)).toBe(true);
    expect(factoryInputs.map((item) => item.profileId)).toEqual(["alpha", "beta", "gamma"]);

    const session = await deps.summarizer.openSession({
      cwd,
      mode: "read-only",
      role: "summarizer",
      artifactRoot: path.join(artifactRoot, "gamma"),
    });
    const turn = await session.send({ content: "hello" });
    await session.close();
    expect(turn.stopReason).toBe("end_turn");
  });

  it("does not loosen a fixed deny profile when the run-scoped UI choice is allow", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const { deps, diagnoses, factoryInputs } = await wiredDiscussion({
      cwd,
      mode: "mcp-stderr",
      discussionMcpPolicy: "allow",
      profilePolicy: "deny",
    });

    expect(diagnoses.every((item) => item.diagnosis.runnable)).toBe(true);
    expect(factoryInputs.map((item) => item.profileId)).toEqual(["alpha", "beta", "gamma"]);
    const session = await deps.discussants[0]!.openSession({
      cwd,
      mode: "read-only",
      role: "discussant",
      artifactRoot: path.join(artifactRoot, "alpha"),
    });
    await expect(session.send({ content: "hello" })).rejects.toMatchObject({
      code: "policy_blocked",
    });
    await session.close().catch(() => undefined);
  });
});
