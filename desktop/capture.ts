import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export interface RegionCaptureHooks {
  ensureAccess(): Promise<boolean>;
  captureWithOverlay(): Promise<Buffer | null>;
}

interface ScreencaptureOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

const SCREENCAPTURE = "/usr/sbin/screencapture";
const MAX_STDERR_CHARS = 400;

// The running selection owns the whole screen, so quitting has to take it down
// with the app instead of leaving an orphaned crosshair behind.
let activeCapture: ChildProcess | null = null;

// Resolves to PNG bytes, or null when the person cancelled the selection.
export async function captureRegion(hooks: RegionCaptureHooks): Promise<Buffer | null> {
  if (!(await hooks.ensureAccess())) return null;
  if (process.platform === "darwin") return captureRegionWithScreencapture();
  return hooks.captureWithOverlay();
}

export function cancelActiveRegionCapture(): void {
  const child = activeCapture;
  activeCapture = null;
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}

// macOS already ships the selection UI everyone knows — magnifier, pixel
// readout, spacebar window mode — so KE Shot drives it instead of redrawing it.
async function captureRegionWithScreencapture(): Promise<Buffer | null> {
  const target = path.join(app.getPath("temp"), `ke-shot-${randomUUID()}.png`);
  const outcome = await runScreencapture(target);
  const bytes = await readFile(target).catch(() => null);
  // The unlink is housekeeping; it must not sit between the bytes and the
  // clipboard write that is the whole product promise.
  void rm(target, { force: true }).catch(() => undefined);

  // Escape cancels the selection and writes no file at all. So does being
  // killed on quit. Neither is an error worth interrupting anyone over.
  if (outcome.signal !== null) return null;
  if (!bytes || bytes.byteLength === 0) {
    if (outcome.stderr.length > 0) throw new Error(screencaptureError(outcome));
    return null;
  }
  // A non-zero exit with a file on disk means a truncated or unwritable image;
  // sending those bytes to the clipboard and the wire is worse than failing.
  if (outcome.code !== 0) throw new Error(screencaptureError(outcome));
  return bytes;
}

function screencaptureError(outcome: ScreencaptureOutcome): string {
  const detail = outcome.stderr.length > 0 ? ` ${outcome.stderr}` : "";
  return `The macOS screen capture tool failed (exit ${outcome.code ?? "unknown"}).${detail}`;
}

function runScreencapture(target: string): Promise<ScreencaptureOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(SCREENCAPTURE, ["-i", "-o", "-J", "selection", "-t", "png", target], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    activeCapture = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.once("error", () => {
      activeCapture = null;
      reject(new Error("KE Shot could not start the macOS screen capture tool."));
    });
    child.once("close", (code, signal) => {
      activeCapture = null;
      resolve({ code, signal, stderr: stderr.trim().slice(0, MAX_STDERR_CHARS) });
    });
  });
}
