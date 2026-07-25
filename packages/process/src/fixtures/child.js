import { writeFileSync } from "node:fs";

const pidFile = process.env.MEGURIBI_TEST_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

setInterval(() => {}, 1000);
