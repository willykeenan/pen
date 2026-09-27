import {
  access,
  chmod,
  constants,
  copyFile,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXPECTED_TOOL_NAMES } from "./expected-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2] ?? process.platform;
const releaseRoot = path.join(root, "dist", "release");

const executable = await findExecutable(platform);
await access(executable);
const result = spawnSync(executable, ["--smoke-test"], {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Packaged KE Pen smoke test failed (${result.status}).\n${result.stdout}\n${result.stderr}`,
  );
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (platform !== "win32" && !output.includes('"product":"KE Pen"')) {
  throw new Error(`Packaged KE Pen did not emit its smoke receipt.\n${output}`);
}
process.stdout.write(`Verified packaged KE Pen executable: ${executable}\n${output}`);

const serverPath = packagedMcpServer(executable, platform);
await access(serverPath);
await verifyBridge(executable, serverPath, { ELECTRON_RUN_AS_NODE: "1" }, "installed app");

if (platform === "darwin" || platform === "win32") await verifyHoldHelper(executable, platform);
await verifyFuses(executable, platform);
if (platform === "darwin") verifyMacSignature(executable);

if (platform === "linux") {
  const appImage = await findAppImage();
  const appImageResult = spawnSync(appImage, ["--smoke-test"], {
    encoding: "utf8",
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    timeout: 30_000,
  });
  if (appImageResult.error) throw appImageResult.error;
  const appImageOutput = `${appImageResult.stdout ?? ""}${appImageResult.stderr ?? ""}`;
  if (appImageResult.status !== 0 || !appImageOutput.includes('"product":"KE Pen"')) {
    throw new Error(
      `Packaged KE Pen AppImage smoke test failed (${appImageResult.status}).\n${appImageOutput}`,
    );
  }
  process.stdout.write(`Verified packaged KE Pen AppImage GUI launch.\n${appImageOutput}`);

  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "ke-pen-appimage-mcp-"));
  const stagedServer = path.join(stagingDirectory, "index.js");
  const stagedRuntimeDirectory = path.join(stagingDirectory, "runtime");
  const stagedRuntime = path.join(stagedRuntimeDirectory, path.basename(executable));
  try {
    await copyFile(serverPath, stagedServer);
    await cp(path.dirname(executable), stagedRuntimeDirectory, {
      recursive: true,
      force: true,
    });
    await chmod(stagedRuntimeDirectory, 0o700);
    await chmod(stagedRuntime, 0o700);
    await chmod(path.join(stagedRuntimeDirectory, "chrome-sandbox"), 0o700);
    await verifyBridge(
      stagedRuntime,
      stagedServer,
      { ELECTRON_RUN_AS_NODE: "1" },
      "AppImage-staged private runtime",
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function verifyBridge(command, serverPath, env, label) {
  const transport = new StdioClientTransport({
    command,
    args: [serverPath],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "pen-packaged-bridge-check", version: "1.0.0" });
  let bridgeStderr = "";
  transport.stderr?.on("data", (chunk) => {
    bridgeStderr += chunk.toString();
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      EXPECTED_TOOL_NAMES,
    );
    const status = await client.callTool({ name: "pen_status", arguments: {} });
    assert.equal(status.isError, undefined);
    process.stdout.write(
      `Verified packaged KE Pen MCP bridge (${label}): tools=${EXPECTED_TOOL_NAMES.length}\n`,
    );
  } catch (error) {
    throw new Error(
      `Packaged KE Pen MCP bridge failed (${label}).\n${bridgeStderr}\n${error instanceof Error ? error.stack : String(error)}`,
    );
  } finally {
    await client.close();
  }
}

// Hold to capture ships a small native helper next to the app. It must be
// present, executable, built for every architecture the app runs on, signed,
// report this exact version and protocol 1, and start disarmed and quit cleanly.
async function verifyHoldHelper(packagedExecutable, targetPlatform) {
  const helper =
    targetPlatform === "darwin"
      ? path.join(path.dirname(packagedExecutable), "ke-pen-hold-helper")
      : path.join(path.dirname(packagedExecutable), "resources", "hold", "ke-pen-hold-helper.exe");
  await access(helper, targetPlatform === "win32" ? constants.F_OK : constants.X_OK);
  const expectedVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

  if (targetPlatform === "darwin") {
    const archs = spawnSync("lipo", ["-archs", helper], { encoding: "utf8" }).stdout.trim().split(/\s+/).sort();
    assert.deepEqual(archs, ["arm64", "x86_64"], `hold helper architectures: ${archs.join(" ")}`);
    const signature = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", helper], {
      encoding: "utf8",
    });
    assert.equal(signature.status, 0, `hold helper signature: ${signature.stderr}`);
  }

  const versionRun = spawnSync(helper, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(versionRun.status, 0, `hold helper --version failed: ${versionRun.stderr}`);
  const reported = JSON.parse(versionRun.stdout.trim());
  assert.deepEqual(reported, { name: "ke-pen-hold-helper", version: expectedVersion, protocol: 1 });

  const handshake = await new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The hold helper did not start and quit cleanly.\n${output}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n") && !child.quitSent) {
        child.quitSent = true;
        child.stdin.end('{"cmd":"quit"}\n');
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, lines: output.split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
    });
  });
  assert.equal(handshake.code, 0, "the hold helper did not exit cleanly on quit");
  assert.equal(handshake.lines[0]?.type, "ready");
  assert.equal(handshake.lines[0]?.version, expectedVersion);
  assert.equal(handshake.lines[0]?.protocol, 1);
  process.stdout.write(
    `Verified packaged hold helper: ${path.relative(root, helper)} (${handshake.lines
      .map((line) => line.type)
      .join(" → ")})\n`,
  );
}

// Electron fuses baked into the packaged binary (every slice of a universal
// build). runAsNode stays on for the embedded MCP server; every other way to
// run code as KE Pen is off.
async function verifyFuses(packagedExecutable, targetPlatform) {
  const binary =
    targetPlatform === "darwin"
      ? path.resolve(packagedExecutable, "..", "..", "Frameworks", "Electron Framework.framework", "Electron Framework")
      : packagedExecutable;
  const bytes = await readFile(binary);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const wires = [];
  for (let at = bytes.indexOf(sentinel); at >= 0; at = bytes.indexOf(sentinel, at + 1)) {
    const start = at + sentinel.length;
    const length = bytes[start + 1];
    wires.push([...bytes.subarray(start + 2, start + 2 + length)].map((value) => String.fromCharCode(value)));
  }
  assert.ok(wires.length >= 1, "no Electron fuse wire was found in the packaged binary");
  if (targetPlatform === "darwin") assert.equal(wires.length, 2, "both slices of the universal binary carry fuses");
  const expected = { 0: "1", 2: "0", 3: "0", 5: "1" };
  const names = { 0: "RunAsNode", 2: "EnableNodeOptionsEnvironmentVariable", 3: "EnableNodeCliInspectArguments", 5: "OnlyLoadAppFromAsar" };
  for (const wire of wires) {
    for (const [index, value] of Object.entries(expected)) {
      assert.equal(wire[Number(index)], value, `fuse ${names[index]} is ${wire[Number(index)]}, expected ${value}`);
    }
  }
  process.stdout.write(
    `Verified Electron fuses (${wires.length} wire${wires.length === 1 ? "" : "s"}): RunAsNode on for the MCP bridge; NODE_OPTIONS, --inspect off; app only from asar\n`,
  );
}

// The whole bundle is signed (not just the linker-signed executable), and the
// hold helper carries its own identifier, hardened runtime and the same
// signing authority as the app.
function verifyMacSignature(packagedExecutable) {
  const app = path.resolve(packagedExecutable, "..", "..", "..");
  const helper = path.join(path.dirname(packagedExecutable), "ke-pen-hold-helper");
  const deep = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { encoding: "utf8" });
  assert.equal(deep.status, 0, `app bundle signature: ${deep.stderr}`);
  const describe = (target) => {
    const result = spawnSync("codesign", ["-dvv", target], { encoding: "utf8" });
    assert.equal(result.status, 0, `codesign -dvv ${target}: ${result.stderr}`);
    const text = result.stderr;
    const field = (name) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? null;
    return {
      identifier: field("Identifier"),
      authority: field("Authority"),
      adhoc: /^Signature=adhoc$/m.test(text),
      runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(text),
      sealed: /^Sealed Resources/m.test(text),
    };
  };
  const appInfo = describe(app);
  const helperInfo = describe(helper);
  assert.equal(appInfo.identifier, "dev.kestudios.pen", "app identifier");
  assert.equal(appInfo.sealed, true, "the app bundle's resources are sealed");
  assert.equal(helperInfo.identifier, "dev.kestudios.pen.hold-helper", "hold helper identifier");
  assert.equal(helperInfo.runtime, true, "the hold helper uses the hardened runtime");
  assert.equal(helperInfo.adhoc, appInfo.adhoc, "the helper and the app are signed the same way");
  assert.equal(helperInfo.authority, appInfo.authority, "the helper and the app share a signing authority");
  process.stdout.write(
    `Verified macOS signatures: bundle sealed, helper ${helperInfo.identifier} (${appInfo.adhoc ? "ad hoc" : appInfo.authority})\n`,
  );
}

function packagedMcpServer(packagedExecutable, targetPlatform) {
  if (targetPlatform === "darwin") {
    return path.resolve(packagedExecutable, "..", "..", "Resources", "mcp", "index.js");
  }
  return path.join(path.dirname(packagedExecutable), "resources", "mcp", "index.js");
}

async function findExecutable(targetPlatform) {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (targetPlatform === "darwin") {
    const container = directories.find((name) => name.startsWith("mac"));
    if (!container) throw new Error("No unpacked macOS application was found.");
    return path.join(releaseRoot, container, "KE Pen.app", "Contents", "MacOS", "KE Pen");
  }
  if (targetPlatform === "win32") {
    const container = directories.find((name) => name.startsWith("win"));
    if (!container) throw new Error("No unpacked Windows application was found.");
    return path.join(releaseRoot, container, "KE Pen.exe");
  }
  const container = directories.find((name) => name.startsWith("linux"));
  if (!container) throw new Error("No unpacked Linux application was found.");
  return path.join(releaseRoot, container, "ke-pen");
}

async function findAppImage() {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const appImage = entries.find((entry) => entry.isFile() && entry.name.endsWith(".AppImage"));
  if (!appImage) throw new Error("No packaged KE Pen AppImage was found.");
  return path.join(releaseRoot, appImage.name);
}
