import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function fakeCommand(): { executable: string; args: string[] } {
  return {
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../src/fake-acp.ts", import.meta.url))
    ]
  };
}

export function artifactDirectory(): string {
  return path.join(os.tmpdir(), "meguribi-devin-acp-test", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
