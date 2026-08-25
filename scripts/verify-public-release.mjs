import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  ...(await sourceTree(path.join(root, "src"))),
  ...(await sourceTree(path.join(root, "desktop"))),
];
const runtimeFiles = [
  path.join(root, "dist", "mcp-app", "index.js"),
  path.join(root, "dist", "desktop", "main.cjs"),
];
const files = [...sourceFiles, ...runtimeFiles];

const forbidden = [
  ["founder home path", /\/Users\/williamkeenan(?:\/|\\)/i],
  ["Codex private state path", /(?:^|[\\/])\.codex(?:[\\/]|$)/i],
  ["KE agent room path", /ke-agent-rooms/i],
  ["KE room control client", /(?:roomctl|boardctl)\.py/i],
  ["private KE API default", /https:\/\/kestudios\.dev\/api\//i],
  ["private KE app origin", /https:\/\/(?:app|dayledger)\.kestudios\.dev/i],
  ["provider API credential name", /\b(?:OPENAI|ANTHROPIC|VERCEL|HUGGINGFACE)_API_KEY\b/],
  ["provider bearer credential name", /\b(?:VERCEL|HF|GITHUB|GH)_TOKEN\b/],
  ["embedded private key", /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
];

for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const [label, pattern] of forbidden) {
    assert.doesNotMatch(text, pattern, `${path.relative(root, file)} contains ${label}`);
  }
}

const settings = await readFile(path.join(root, "desktop", "settings.ts"), "utf8");
assert.match(settings, /shotEndpoint:\s*""/);
assert.match(settings, /shotToken:\s*""/);

const referenceRuntime = await readFile(
  path.join(root, "src", "agent-visual-reference-tools.ts"),
  "utf8",
);
assert.match(referenceRuntime, /sent:\s*false/);
assert.doesNotMatch(
  referenceRuntime,
  /(?:node:http|node:https|fetch\s*\(|WebSocket|send_message|followup_task|roomctl|boardctl)/i,
);

const packageDocument = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const publicFiles = packageDocument.files ?? [];
for (const entry of publicFiles) {
  assert.doesNotMatch(String(entry), /(?:\.env|credentials?|secrets?|evidence|agent-rooms)/i);
}

process.stdout.write(`PEN_PUBLIC_RELEASE_BOUNDARY_OK files=${files.length}\n`);

async function sourceTree(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceTree(candidate)));
    else if (entry.isFile() && /\.(?:c?ts|m?js)$/.test(entry.name)) files.push(candidate);
  }
  return files;
}
