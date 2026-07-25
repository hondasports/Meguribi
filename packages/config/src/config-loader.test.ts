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
      executable: "devin",
      transport: "acp",
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
    ).resolves.toMatchObject({ executable: "user-devin", turnTimeoutMinutes: 40 });
  });

  it("rejects deprecated command templates from a repository configuration", async () => {
    const repositoryPath = await createTemporaryDirectory();
    await writeFile(
      path.join(repositoryPath, ".meguribi.yml"),
      "devin:\n  commandTemplate: devin acp\n",
    );

    await expect(loadDevinConfig({ repositoryPath })).rejects.toThrow(/commandTemplate/);
  });
});
