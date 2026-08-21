import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "desktop");

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "ui"), { recursive: true });
await mkdir(path.join(output, "assets"), { recursive: true });

const shared = {
  bundle: true,
  logLevel: "info",
  sourcemap: true,
  target: "node20",
};

await build({
  ...shared,
  entryPoints: [path.join(root, "desktop", "launcher.ts")],
  outfile: path.join(output, "main.cjs"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

await build({
  ...shared,
  entryPoints: [path.join(root, "desktop", "preload.ts")],
  outfile: path.join(output, "preload.cjs"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

await build({
  ...shared,
  entryPoints: [path.join(root, "desktop", "renderer.ts")],
  outfile: path.join(output, "ui", "renderer.js"),
  platform: "browser",
  format: "iife",
  target: "chrome140",
});

await Promise.all([
  cp(path.join(root, "desktop", "index.html"), path.join(output, "ui", "index.html")),
  cp(path.join(root, "desktop", "styles.css"), path.join(output, "ui", "styles.css")),
  cp(path.join(root, "assets", "pen-icon.png"), path.join(output, "assets", "pen-icon.png")),
  cp(path.join(root, "assets", "trayTemplate.png"), path.join(output, "assets", "trayTemplate.png")),
  cp(path.join(root, "assets", "trayTemplate@2x.png"), path.join(output, "assets", "trayTemplate@2x.png")),
]);

process.stdout.write(`Built cross-platform desktop runtime at ${output}\n`);
