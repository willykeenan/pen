// Synthetic macOS integration gate for hold-to-capture. Builds the real
// helper, compiles the test-only harness in native/hold/tests/hold_it_mac.m
// (never packaged), and runs it: CGEvents posted at the HID level into a small
// sink panel, counted after the helper's tap. No real menus or clicks needed.
//
// Locally this is a hard gate. Exit 77 from the harness means this process
// has no Accessibility access; that is only accepted as a SKIP on CI (or with
// --allow-skip). Exit 75 means the machine was in use; the run waits for 10 s
// of idle time and retries, up to KE_PEN_HOLD_IT_WAIT_S seconds (default 600).
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.stdout.write("PEN_MIDDLE_HOLD_MAC_IT_SKIPPED not macOS\n");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowSkip = process.argv.includes("--allow-skip") || Boolean(process.env.CI);
const waitSeconds = Number(process.env.KE_PEN_HOLD_IT_WAIT_S ?? 600);
const evidenceDirectory = path.join(root, "dist", "verification", "middle-hold");
const evidence = path.join(evidenceDirectory, "mac-integration.json");
const helper = path.join(root, "dist", "native", "darwin", "ke-pen-hold-helper");

const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-native.mjs"), "--require"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const work = await mkdtemp(path.join(os.tmpdir(), "ke-pen-hold-it-"));
const harness = path.join(work, "hold_it_mac");
try {
  const compile = spawnSync(
    "clang",
    [
      "-fobjc-arc",
      "-O1",
      "-Wall",
      "-Werror",
      "-mmacosx-version-min=12.0",
      "-o",
      harness,
      path.join(root, "native", "hold", "tests", "hold_it_mac.m"),
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
    ],
    { encoding: "utf8" },
  );
  if (compile.status !== 0) {
    process.stderr.write(`${compile.stdout}${compile.stderr}`);
    throw new Error("The macOS hold integration harness did not compile.");
  }

  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const run = spawnSync(harness, [helper, evidence], { encoding: "utf8", timeout: 60_000 });
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status === 0) break;
    if (run.status === 77) {
      if (allowSkip) {
        process.stdout.write(
          "PEN_MIDDLE_HOLD_MAC_IT_SKIPPED this runner has no Accessibility access for event taps\n",
        );
        process.exit(0);
      }
      throw new Error("The integration test needs Accessibility access for this terminal or agent host.");
    }
    if (run.status === 75 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    throw new Error(`The macOS hold integration test failed (status ${run.status ?? run.signal}).`);
  }
  await chmod(evidence, 0o600).catch(() => undefined);
  const result = JSON.parse(await readFile(evidence, "utf8"));
  if (result.passed !== true) throw new Error("The integration evidence does not record a pass.");
  process.stdout.write(
    `Evidence: ${path.relative(root, evidence)} (${result.scenarios.length} scenarios, ${Math.round(result.durationMs)} ms)\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
