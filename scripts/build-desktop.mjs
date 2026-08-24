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
  entryPoints: {
    preload: path.join(root, "desktop", "preload.ts"),
    "agent-display-preload": path.join(root, "desktop", "agent-display-preload.ts"),
  },
  outdir: output,
  outExtension: { ".js": ".cjs" },
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

await build({
  ...shared,
  entryPoints: {
    "agent-displays": path.join(root, "desktop", "agent-displays.ts"),
    "agent-surface": path.join(root, "desktop", "agent-surface.ts"),
  },
  outdir: path.join(output, "agent-ui"),
  platform: "browser",
  format: "iife",
  target: "chrome140",
});

await Promise.all([
  cp(path.join(root, "desktop", "index.html"), path.join(output, "ui", "index.html")),
  cp(path.join(root, "desktop", "styles.css"), path.join(output, "ui", "styles.css")),
  mkdir(path.join(output, "agent-ui"), { recursive: true }),
  cp(
    path.join(root, "desktop", "agent-displays.html"),
    path.join(output, "agent-ui", "displays.html"),
  ),
  cp(
    path.join(root, "desktop", "agent-displays.css"),
    path.join(output, "agent-ui", "agent-displays.css"),
  ),
  cp(
    path.join(root, "desktop", "agent-surface.html"),
    path.join(output, "agent-ui", "surface.html"),
  ),
  cp(
    path.join(root, "desktop", "agent-surface.css"),
    path.join(output, "agent-ui", "agent-surface.css"),
  ),
  cp(path.join(root, "assets", "pen-icon.png"), path.join(output, "assets", "pen-icon.png")),
  cp(path.join(root, "assets", "trayTemplate.png"), path.join(output, "assets", "trayTemplate.png")),
  cp(path.join(root, "assets", "trayTemplate@2x.png"), path.join(output, "assets", "trayTemplate@2x.png")),
]);

process.stdout.write(`Built cross-platform desktop runtime at ${output}\n`);
