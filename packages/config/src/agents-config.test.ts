import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentsConfig, loadImplementerConfig } from "./config-loader.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "meguribi-agents-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createConfigFixture(options: { user?: string; repository?: string } = {}) {
  const root = await createTemporaryDirectory();
  const repositoryPath = path.join(root, "repository");
  const userConfigPath = path.join(root, "user.yml");
  await mkdir(repositoryPath);
  if (options.user !== undefined) {
    await writeFile(userConfigPath, options.user);
  }
  if (options.repository !== undefined) {
    await writeFile(path.join(repositoryPath, ".meguribi.yml"), options.repository);
  }
  return { repositoryPath, userConfigPath };
}

describe("loadAgentsConfig", () => {
  it("uses builtin profiles and default roles when no configuration exists", async () => {
    const fixture = await createConfigFixture();

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });

    expect(result.roles).toEqual({
      discussants: [],
      planner: "codex",
      reviewer: "codex",
      allowSameImplementerReviewer: false,
    });
    expect(result.profiles.map((profile) => profile.id)).toEqual([
      "claude-code",
      "codex",
      "codex-acp",
      "devin",
      "cursor",
    ]);
  });

  it("maps a legacy implementer setting to roles.implementer", async () => {
    const fixture = await createConfigFixture({ repository: "implementer: devin\n" });

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });

    expect(result.roles.implementer).toBe("devin");
  });

  it("rejects conflicting legacy and roles implementers in the same file", async () => {
    const fixture = await createConfigFixture({
      repository: "implementer: devin\nroles:\n  implementer: claude-code\n",
    });

    const error = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "conflicting_implementer" });
  });

  it("lets a user-defined profile replace a builtin profile", async () => {
    const fixture = await createConfigFixture({
      repository: [
        "agents:",
        "  claude-code:",
        "    kind: claude-code",
        "    executable: my-claude-acp",
        "",
      ].join("\n"),
    });

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });
    const claudeCode = result.profiles.find((profile) => profile.id === "claude-code");

    expect(claudeCode).toMatchObject({
      kind: "claude-code",
      transport: "acp",
      executable: "my-claude-acp",
    });
  });

  it("rejects invalid agent profile ids", async () => {
    const fixture = await createConfigFixture({
      repository: "agents:\n  Bad_ID:\n    kind: devin\n",
    });

    await expect(
      loadAgentsConfig({
        repositoryPath: fixture.repositoryPath,
        userConfigPath: fixture.userConfigPath,
        environment: {},
      }),
    ).rejects.toThrow(/Invalid agents configuration: agents\.Bad_ID/);
  });

  it("adds new profiles and normalizes one-element executable paths", async () => {
    const fixture = await createConfigFixture({
      repository: [
        "agents:",
        "  local-claude:",
        "    kind: claude-code",
        "    executable:",
        "      - /my dir/bin/claude-agent-acp",
        "    startupTimeoutMs: 2000",
        "    turnTimeoutMinutes: 5",
        "    inheritedMcpPolicy: deny",
        "",
      ].join("\n"),
    });

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });

    expect(result.profiles.find((profile) => profile.id === "local-claude")).toMatchObject({
      kind: "claude-code",
      transport: "acp",
      executable: "/my dir/bin/claude-agent-acp",
      startupTimeoutMs: 2000,
      turnTimeoutMinutes: 5,
      inheritedMcpPolicy: "deny",
    });
  });

  it("merges roles key-by-key with repository settings winning over user settings", async () => {
    const fixture = await createConfigFixture({
      user: [
        "roles:",
        "  discussants: [devin]",
        "  planner: claude-code",
        "  reviewer: codex-acp",
        "",
      ].join("\n"),
      repository: "roles:\n  planner: codex-acp\n",
    });

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });

    expect(result.roles).toMatchObject({
      discussants: ["devin"],
      planner: "codex-acp",
      reviewer: "codex-acp",
    });
  });

  it("keeps the existing user-before-repository legacy implementer precedence", async () => {
    const fixture = await createConfigFixture({
      user: "implementer: cursor\n",
      repository: "implementer: devin\n",
    });

    const result = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    });

    expect(result.roles.implementer).toBe("cursor");
  });

  it("lets CLI and environment implementer overrides win in the existing precedence order", async () => {
    const fixture = await createConfigFixture({ user: "implementer: cursor\n" });

    const environmentOnly = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: { MEGURIBI_IMPLEMENTER: "devin" },
    });
    const cliOverride = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: { MEGURIBI_IMPLEMENTER: "devin" },
      cli: { implementer: "claude-code" },
    });

    expect(environmentOnly.roles.implementer).toBe("devin");
    expect(cliOverride.roles.implementer).toBe("claude-code");
  });

  it("validates the final role assignments", async () => {
    const fixture = await createConfigFixture({
      repository: "roles:\n  implementer: devin\n  reviewer: devin\n",
    });

    const error = await loadAgentsConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "same_implementer_reviewer" });
  });
});

describe("loadImplementerConfig with agent profiles", () => {
  it("returns an acp-server result for a claude-code implementer", async () => {
    const fixture = await createConfigFixture();

    const result = await loadImplementerConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
      cli: { implementer: "claude-code" },
    });

    expect(result).toMatchObject({
      kind: "acp-server",
      profile: { id: "claude-code", kind: "claude-code", transport: "acp" },
    });
  });

  it("rejects an sdk-transport implementer", async () => {
    const fixture = await createConfigFixture();

    const error = await loadImplementerConfig({
      repositoryPath: fixture.repositoryPath,
      userConfigPath: fixture.userConfigPath,
      environment: {},
      cli: { implementer: "codex" },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "transport_unsupported" });
  });
});
