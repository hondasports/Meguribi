import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDeskCommand, type DeskStartInput } from "./desk.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const expectedPnpmCommand = process.platform === "win32" ? process.execPath : "pnpm";
const expectedPnpmArgs =
  process.platform === "win32"
    ? [
        path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
        "--filter",
        "@meguribi/web",
        "dev",
      ]
    : ["--filter", "@meguribi/web", "dev"];

describe("runDeskCommand", () => {
  it("starts the web dev server with argument array, repository root, and port env", async () => {
    let received: DeskStartInput | undefined;
    const output: string[] = [];
    const result = await runDeskCommand(
      { port: 4199 },
      {
        env: { TEST_MARKER: "present" },
        start: async (input) => {
          received = input;
          return 0;
        },
        stdout: (text) => output.push(text),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(received?.command).toBe(expectedPnpmCommand);
    expect(received?.args).toEqual(expectedPnpmArgs);
    expect(received?.cwd).toBe(repositoryRoot);
    expect(received?.env.MEGURIBI_WEB_PORT).toBe("4199");
    expect(received?.env.TEST_MARKER).toBe("present");
    expect(output.join("")).toContain("http://127.0.0.1:4199");
  });

  it("uses the web default port and propagates the child exit code", async () => {
    let received: DeskStartInput | undefined;
    const result = await runDeskCommand(
      {},
      {
        start: async (input) => {
          received = input;
          return 7;
        },
        stdout: () => {},
      },
    );

    expect(result.exitCode).toBe(7);
    expect(received?.env.MEGURIBI_WEB_PORT).toBe("4173");
  });

  it("rejects invalid ports before starting a child process", async () => {
    let started = false;
    await expect(
      runDeskCommand(
        { port: 70000 },
        {
          start: async () => {
            started = true;
            return 0;
          },
          stdout: () => {},
        },
      ),
    ).rejects.toThrow("Invalid --port");
    expect(started).toBe(false);
  });
});
