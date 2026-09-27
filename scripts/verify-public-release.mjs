import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  ...(await sourceTree(path.join(root, "src"))),
  ...(await sourceTree(path.join(root, "desktop"))),
  ...(await sourceTree(path.join(root, "native"), /\.(?:c|h|m)$/)),
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
  ["absolute external-volume path", /\/Volumes\/[A-Za-z0-9._ -]+\//],
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

// Built hold helpers must not carry a build machine's paths (no debug info, no
// assert(), -ffile-prefix-map); scan them as bytes when they exist.
const helperBinaries = [
  path.join(root, "dist", "native", "darwin", "ke-pen-hold-helper"),
  path.join(root, "dist", "native", "win32-x64", "ke-pen-hold-helper.exe"),
];
let scannedBinaries = 0;
for (const binary of helperBinaries) {
  const exists = await stat(binary).then(() => true, () => false);
  if (!exists) continue;
  const text = (await readFile(binary)).toString("latin1");
  for (const [label, pattern] of [
    ...forbidden,
    ["absolute home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
    ["Windows profile path", /[A-Za-z]:\\Users\\/],
    ["GitHub runner work path", /\/Users\/runner\/work|D:\\a\\/],
  ]) {
    assert.doesNotMatch(text, pattern, `${path.relative(root, binary)} contains ${label}`);
  }
  scannedBinaries += 1;
}

// The helper's stdin contract is five fixed commands. Nothing that reaches it
// may describe a position, a button or an event: that would let any process
// with access to its stdin borrow the helper's Accessibility approval to click.
const protocolSource = await readFile(path.join(root, "native", "hold", "protocol.c"), "utf8");
const acceptedKeys = [...protocolSource.matchAll(/strcmp\(member->key, "([^"]+)"\)/g)].map((match) => match[1]);
assert.deepEqual([...new Set(acceptedKeys)].sort(), ["cmd", "thresholdMs", "v"]);
const acceptedCommands = [...protocolSource.matchAll(/strcmp\(command, "([^"]+)"\)/g)].map((match) => match[1]);
assert.deepEqual([...new Set(acceptedCommands)].sort(), ["arm", "config", "disarm", "prompt", "quit"]);
const holdCore = await readFile(path.join(root, "desktop", "hold-core.ts"), "utf8");
const encoded = [...holdCore.matchAll(/return `(\{[^`]*\})\\n`;/g)].map((match) => match[1]);
assert.equal(encoded.length, 5, "hold-core must encode exactly five commands");
for (const line of encoded) {
  assert.doesNotMatch(line, /"(?:x|y|button|point|location|event|key)"/i, `hold command ${line}`);
}

process.stdout.write(
  `PEN_PUBLIC_RELEASE_BOUNDARY_OK files=${files.length} helperBinaries=${scannedBinaries}\n`,
);

async function sourceTree(directory, pattern = /\.(?:c?ts|m?js)$/) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceTree(candidate, pattern)));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(candidate);
  }
  return files;
}
