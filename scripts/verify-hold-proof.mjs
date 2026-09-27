// Runtime proof for hold to capture. Launches the real desktop build in an
// isolated --hold-proof mode: temporary user data, a fake hold helper (never
// the real input tap), an in-memory clipboard shim and no upload endpoint.
// The proof drives three holds through the real supervisor and main process:
//   1. freeze → frozen overlays on every display → select a region → the crop
//      reaches the clipboard shim and a local copy, with the exact pixel size;
//   2. freeze → Escape → nothing reaches the clipboard;
//   3. freeze → right click → nothing reaches the clipboard.
// It records the order of capture, overlay creation, showing and focus.
//
// Overlays stay hidden unless KE_PEN_HOLD_PROOF_SHOW=1, so nothing takes over
// the screen or keyboard focus. Evidence: dist/verification/middle-hold/.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" && process.platform !== "win32") {
  process.stdout.write(`PEN_HOLD_PROOF_SKIPPED hold to capture is not supported on ${process.platform}\n`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electron = require("electron");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const evidenceDirectory = path.join(root, "dist", "verification", "middle-hold");
const proofDirectory = path.join(evidenceDirectory, "hold-proof-run");
await rm(proofDirectory, { recursive: true, force: true });
await mkdir(proofDirectory, { recursive: true, mode: 0o700 });

const env = {
  ...process.env,
  KE_PEN_HOLD_HELPER_OVERRIDE: path.join(root, "test", "fixtures", "fake-hold-helper.mjs"),
  FAKE_HOLD_MODE: "hold-on-arm",
  FAKE_HOLD_COUNT: "3",
  FAKE_HOLD_VERSION: version,
};
delete env.ELECTRON_RUN_AS_NODE;

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(electron, [root, `--hold-proof=${proofDirectory}`], {
    cwd: root,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code ?? 1);
  });
});

const receiptPath = path.join(proofDirectory, "hold-proof.json");
const receipt = JSON.parse(await readFile(receiptPath, "utf8").catch(() => "null"));
if (exitCode !== 0 || !receipt || receipt.passed !== true) {
  process.stderr.write(`Hold runtime proof failed (exit ${exitCode}).\n`);
  if (receipt) process.stderr.write(`${JSON.stringify(receipt.failures ?? receipt, null, 2)}\n`);
  process.exit(1);
}
const summary = path.join(evidenceDirectory, `hold-runtime-proof-${process.platform}.json`);
await import("node:fs/promises").then(({ writeFile }) =>
  writeFile(summary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }),
);
await chmod(summary, 0o600).catch(() => undefined);
await rm(proofDirectory, { recursive: true, force: true });
process.stdout.write(
  `Hold runtime proof: ${receipt.overlays} display(s), capture ${receipt.captureSource}, ` +
    `hold→capture ${receipt.timingsMs.holdToCaptureComplete} ms, ` +
    `hold→overlays ready ${receipt.timingsMs.holdToOverlaysReady} ms. Evidence: ${path.relative(root, summary)}\n`,
);
