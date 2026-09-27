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
