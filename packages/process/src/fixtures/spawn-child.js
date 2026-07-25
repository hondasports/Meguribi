import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("./child.js", import.meta.url));
spawn(process.execPath, [childPath], { stdio: "inherit", detached: true });

process.on("SIGTERM", () => {
  // ignored
});
process.on("SIGINT", () => {
  // ignored
});

setInterval(() => {}, 1000);
