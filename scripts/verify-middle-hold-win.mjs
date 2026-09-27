// Synthetic Windows integration gate for hold-to-capture. Builds the real
// helper, compiles the test-only harness in native/hold/tests/hold_it_win.c
// (never packaged), and runs it: SendInput middle-button events aimed at a
// small sink window, counted by that window. No real menus or clicks needed.
//
// Exit 77 from the harness means this session cannot deliver injected input
// to a window at all; that is only accepted as a SKIP with --allow-skip.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write("PEN_MIDDLE_HOLD_WIN_IT_SKIPPED not Windows\n");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowSkip = process.argv.includes("--allow-skip");
const evidenceDirectory = path.join(root, "dist", "verification", "middle-hold");
const evidence = path.join(evidenceDirectory, "win-integration.json");
const helper = path.join(root, "dist", "native", "win32-x64", "ke-pen-hold-helper.exe");

const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-native.mjs"), "--require"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(evidenceDirectory, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), "ke-pen-hold-it-"));
const harness = path.join(work, "hold_it_win.exe");
const source = path.join(root, "native", "hold", "tests", "hold_it_win.c");
try {
  const compile = compileHarness();
  if (compile.status !== 0) {
    process.stderr.write(`${compile.stdout ?? ""}${compile.stderr ?? ""}`);
    throw new Error("The Windows hold integration harness did not compile.");
  }
  const run = spawnSync(harness, [helper, evidence], { encoding: "utf8", timeout: 90_000, windowsHide: true });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.status === 77) {
    if (allowSkip) {
      process.stdout.write("PEN_MIDDLE_HOLD_WIN_IT_SKIPPED this session cannot inject input\n");
      process.exit(0);
    }
    throw new Error("This Windows session could not deliver injected input to a window.");
  }
  if (run.status !== 0) {
    throw new Error(`The Windows hold integration test failed (status ${run.status ?? run.signal}).`);
  }
  const result = JSON.parse(await readFile(evidence, "utf8"));
  if (result.passed !== true) throw new Error("The integration evidence does not record a pass.");
  process.stdout.write(`Evidence: ${path.relative(root, evidence)} (${result.scenarios.length} scenarios)\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}

function compileHarness() {
  const clang = spawnSync("clang", ["--version"], { encoding: "utf8" });
  if (!clang.error && clang.status === 0) {
    return spawnSync(
      "clang",
      [
        "-target",
        "x86_64-pc-windows-msvc",
        "-O1",
        "-Wall",
        "-D_CRT_SECURE_NO_WARNINGS",
        "-o",
        harness,
        source,
        "-luser32",
        "-lkernel32",
        "-lgdi32",
      ],
      { encoding: "utf8" },
    );
  }
  return spawnSync(
    "cl",
    ["/nologo", "/O1", "/D_CRT_SECURE_NO_WARNINGS", source, `/Fe:${harness}`, `/Fo:${work}${path.sep}`,
      "user32.lib", "kernel32.lib", "gdi32.lib"],
    { encoding: "utf8" },
  );
}
