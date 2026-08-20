import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Dock and menu-bar icon assets keep real transparency", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-icon-assets.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout) as { ok: boolean; icons: Array<{ minimumAlpha: number }> };
  assert.equal(receipt.ok, true);
  assert.equal(receipt.icons.length, 3);
  assert.ok(receipt.icons.every((icon) => icon.minimumAlpha === 0));
});

test("macOS tray creation explicitly uses template-image semantics", async () => {
  const source = await readFile(path.join(root, "desktop", "main.ts"), "utf8");
  assert.match(source, /icon\.setTemplateImage\(true\)/);
});
