import { access, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

if (platform === "linux") {
  const appImage = await findAppImage();
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "ke-pen-appimage-mcp-"));
  const stagedServer = path.join(stagingDirectory, "index.js");
  try {
    await copyFile(serverPath, stagedServer);
    await verifyBridge(
      appImage,
      stagedServer,
      { APPIMAGE_EXTRACT_AND_RUN: "1", ELECTRON_RUN_AS_NODE: "1" },
      "AppImage",
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
      ["pen_complete", "pen_read", "pen_status"],
    );
    const status = await client.callTool({ name: "pen_status", arguments: {} });
    assert.equal(status.isError, undefined);
    process.stdout.write(`Verified packaged KE Pen MCP bridge (${label}): tools=3\n`);
  } catch (error) {
    throw new Error(
      `Packaged KE Pen MCP bridge failed (${label}).\n${bridgeStderr}\n${error instanceof Error ? error.stack : String(error)}`,
    );
  } finally {
    await client.close();
  }
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
