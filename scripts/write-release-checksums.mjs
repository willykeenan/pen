import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "dist", "release");
const entries = await readdir(releaseRoot, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => /\.(dmg|zip|exe|AppImage|deb|tar\.gz)$/i.test(name))
  .sort();
if (files.length === 0) throw new Error("No KE Pen release artifacts were found.");

const lines = [];
for (const file of files) {
  const digest = createHash("sha256").update(await readFile(path.join(releaseRoot, file))).digest("hex");
  lines.push(`${digest}  ${file}`);
}
await writeFile(
  path.join(releaseRoot, `SHA256SUMS-${process.platform}.txt`),
  `${lines.join("\n")}\n`,
);
process.stdout.write(`${lines.join("\n")}\n`);
