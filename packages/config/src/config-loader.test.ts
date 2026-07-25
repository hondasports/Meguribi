import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDevinConfig } from "./config-loader.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "meguribi-config-"));
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

describe("loadDevinConfig", () => {
  it("uses defaults for an empty configuration document", async () => {
    const root = await createTemporaryDirectory();
    const userConfigPath = path.join(root, "user.yml");
    await writeFile(userConfigPath, "");

    await expect(loadDevinConfig({ userConfigPath })).resolves.toMatchObject({
      config: { executable: "devin", transport: "acp" },
    });
  });

  it("merges user, repository, environment, and CLI settings in precedence order", async () => {
    const root = await createTemporaryDirectory();
    const userConfigPath = path.join(root, "user.yml");
    const repositoryPath = path.join(root, "repository");
    await mkdir(repositoryPath);
    await writeFile(userConfigPath, "devin:\n  executable: user-devin\n  turnTimeoutMinutes: 10\n");
    await writeFile(
      path.join(repositoryPath, ".meguribi.yml"),
      "devin:\n  turnTimeoutMinutes: 20\n",
    );

    await expect(
      loadDevinConfig({
        userConfigPath,
        repositoryPath,
        environment: { MEGURIBI_DEVIN_TURN_TIMEOUT_MINUTES: "30" },
        cli: { turnTimeoutMinutes: 40 },
      }),
    ).resolves.toMatchObject({
      config: { executable: "user-devin", turnTimeoutMinutes: 40 },
    });
  });

  it("rejects deprecated command templates from a repository configuration", async () => {
    const repositoryPath = await createTemporaryDirectory();
    await writeFile(
      path.join(repositoryPath, ".meguribi.yml"),
      "devin:\n  commandTemplate: devin acp\n",
    );

    await expect(loadDevinConfig({ repositoryPath })).rejects.toThrow(/commandTemplate/);
  });

  it("resolves the default user configuration path with XDG_CONFIG_HOME", async () => {
    const root = await createTemporaryDirectory();
    const configDir = path.join(root, "config");
    await mkdir(path.join(configDir, "meguribi"), { recursive: true });
    await writeFile(path.join(configDir, "meguribi", "config.yml"), "devin:\n  executable: xdg-devin\n");

    const result = await loadDevinConfig({
      environment: { XDG_CONFIG_HOME: configDir },
    });
    expect(result.config.executable).toBe("xdg-devin");
  });

  it("falls back to HOME/.config when XDG and Windows variables are not set", async () => {
    const root = await createTemporaryDirectory();
    const configDir = path.join(root, ".config", "meguribi");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.yml"), "devin:\n  executable: home-devin\n");

    const result = await loadDevinConfig({
      environment: { HOME: root },
    });
    expect(result.config.executable).toBe("home-devin");
  });

  it("lets userConfigPath override the default path", async () => {
    const root = await createTemporaryDirectory();
    const explicitPath = path.join(root, "explicit.yml");
    await writeFile(explicitPath, "devin:\n  executable: explicit-devin\n");

    const result = await loadDevinConfig({
      userConfigPath: explicitPath,
      environment: { XDG_CONFIG_HOME: path.join(root, "does-not-exist") },
    });
    expect(result.config.executable).toBe("explicit-devin");
  });

  it("returns a redacted snapshot of all configuration sources", async () => {
    const root = await createTemporaryDirectory();
    const userConfigPath = path.join(root, "user.yml");
    const repositoryPath = path.join(root, "repository");
    await mkdir(repositoryPath);
    await writeFile(userConfigPath, "devin:\n  executable: user-devin\n  turnTimeoutMinutes: 10\n");
    await writeFile(
      path.join(repositoryPath, ".meguribi.yml"),
      "devin:\n  turnTimeoutMinutes: 20\n",
    );

    const result = await loadDevinConfig({
      userConfigPath,
      repositoryPath,
      environment: {
        MEGURIBI_DEVIN_TURN_TIMEOUT_MINUTES: "30",
        MEGURIBI_DEVIN_SECRET_TOKEN: "must-not-appear",
      },
      cli: { turnTimeoutMinutes: 40 },
    });

    expect(result.snapshot).toEqual({
      user: { executable: "user-devin", turnTimeoutMinutes: 10 },
      repository: { turnTimeoutMinutes: 20 },
      environment: { turnTimeoutMinutes: 30 },
      cli: { turnTimeoutMinutes: 40 },
    });
    expect(result.snapshot).not.toHaveProperty(["environment", "token"]);
  });
});
