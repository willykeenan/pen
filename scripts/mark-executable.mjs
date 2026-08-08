import { chmod } from "node:fs/promises";

if (process.platform !== "win32") {
  for (const file of process.argv.slice(2)) {
    await chmod(file, 0o755);
  }
}
