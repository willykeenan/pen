import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

if (process.platform !== "darwin") {
  throw new Error("The KE Shot top-right popup runtime check requires macOS.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(root, "dist", "verification", "shot-link-toast");
const entry = path.join(evidenceDirectory, "shot-toast-smoke.cjs");
const electron = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

await rm(evidenceDirectory, { recursive: true, force: true });
await mkdir(evidenceDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts", "shot-toast-smoke-entry.ts")],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "silent",
});

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(electron, [entry], {
    cwd: root,
    env: { ...process.env, KE_PEN_TOAST_EVIDENCE_DIR: evidenceDirectory },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

if (exitCode !== 0) process.exit(exitCode);
