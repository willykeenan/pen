import path from "node:path";

// Pure pieces of "hold the middle button to capture": settings bounds, the
// helper's stdio protocol, restart policy, the arm gate, helper location and
// the freeze-then-select ordering. Nothing here touches Electron or the OS, so
// every rule is unit-tested directly.

export const HOLD_PROTOCOL_VERSION = 1;
export const HOLD_HELPER_NAME = "ke-pen-hold-helper";
export const HOLD_LINE_MAX = 1024;
export const HOLD_MIN_DELAY_MS = 200;
export const HOLD_MAX_DELAY_MS = 1500;
export const HOLD_DEFAULT_DELAY_MS = 500;
export const HOLD_DELAY_CHOICES: readonly number[] = [200, 350, 500, 750, 1000, 1500];

export const HOLD_RESTART_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const HOLD_RESTART_WINDOW_MS = 120_000;
export const HOLD_RESTART_LIMIT = 6;
export const HOLD_HEALTHY_RESET_MS = 300_000;
export const HOLD_READY_TIMEOUT_MS = 5_000;
export const HOLD_STOP_GRACE_MS = 1_000;

// Wayland forbids global input interception and X11 already gives the middle
// click to primary-selection paste, so Linux never runs the helper.
export function holdCaptureSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function clampHoldDelay(value: unknown, fallback = HOLD_DEFAULT_DELAY_MS): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(HOLD_MAX_DELAY_MS, Math.max(HOLD_MIN_DELAY_MS, Math.round(value)));
}

export function holdDelayChoices(current: number): number[] {
  const choices = [...HOLD_DELAY_CHOICES];
  if (!choices.includes(current)) choices.push(current);
  return choices.sort((a, b) => a - b);
}

// ---- Protocol -----------------------------------------------------------------

// The helper accepts these four commands and nothing else. None of them can
// carry a position, a button or an event description, so writing to the
// helper's stdin can never make it post input of anyone's choosing.
export type HoldCommand =
  | { cmd: "config"; thresholdMs: number }
  | { cmd: "arm" }
  | { cmd: "disarm" }
  | { cmd: "quit" };

export function encodeHoldCommand(command: HoldCommand): string {
  switch (command.cmd) {
    case "config":
      return `{"cmd":"config","thresholdMs":${clampHoldDelay(command.thresholdMs)}}\n`;
    case "arm":
      return `{"cmd":"arm"}\n`;
    case "disarm":
      return `{"cmd":"disarm"}\n`;
    case "quit":
      return `{"cmd":"quit"}\n`;
  }
}

export type HoldMessage =
  | { type: "ready"; name: string; version: string; protocol: number; platform: string }
  | { type: "active" }
  | { type: "needs-permission"; permission: string }
  | { type: "hold"; seq: number }
  | { type: "tap-restored"; reason: string }
  | { type: "error"; code: string };

const WORD = /^[A-Za-z0-9._+-]{1,32}$/;
const MESSAGE_KEYS: Record<HoldMessage["type"], readonly string[]> = {
  ready: ["v", "type", "name", "version", "protocol", "platform"],
  active: ["v", "type"],
  "needs-permission": ["v", "type", "permission"],
  hold: ["v", "type", "seq"],
  "tap-restored": ["v", "type", "reason"],
  error: ["v", "type", "code"],
};

// Strict whitelist: an unknown type, an extra key (a coordinate, say), a
// wrong version or an oversized line is dropped rather than interpreted.
export function parseHoldMessage(line: string): HoldMessage | null {
  if (line.length === 0 || line.length > HOLD_LINE_MAX) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== HOLD_PROTOCOL_VERSION || typeof record.type !== "string") return null;
  const type = record.type as HoldMessage["type"];
  if (!Object.hasOwn(MESSAGE_KEYS, type)) return null;
  const allowed = MESSAGE_KEYS[type];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
  const word = (key: string): string | null => {
    const candidate = record[key];
    return typeof candidate === "string" && WORD.test(candidate) ? candidate : null;
  };
  switch (type) {
    case "ready": {
      const name = word("name");
      const version = word("version");
      const platform = word("platform");
      if (name !== HOLD_HELPER_NAME || !version || !platform) return null;
      if (typeof record.protocol !== "number" || !Number.isInteger(record.protocol)) return null;
      return { type, name, version, protocol: record.protocol, platform };
    }
    case "active":
      return { type };
    case "needs-permission": {
      const permission = word("permission");
      return permission ? { type, permission } : null;
    }
    case "hold": {
      const seq = record.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return null;
      return { type, seq };
    }
    case "tap-restored": {
      const reason = word("reason");
      return reason ? { type, reason } : null;
    }
    case "error": {
      const code = word("code");
      return code ? { type, code } : null;
    }
    default:
      return null;
  }
}

// Splits a stdout stream into protocol lines; a runaway line is discarded up
// to its newline instead of growing a buffer without bound.
export class HoldLineSplitter {
  private buffer = "";
  private discarding = false;

  push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline < 0) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        this.buffer = "";
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = "";
      if (line.length <= HOLD_LINE_MAX) lines.push(line.replace(/\r$/, ""));
    }
    if (!this.discarding) {
      this.buffer += rest;
      if (this.buffer.length > HOLD_LINE_MAX) {
        this.buffer = "";
        this.discarding = true;
      }
    }
    return lines;
  }
}

// ---- Restart policy -----------------------------------------------------------

export interface HoldRestartPlan {
  giveUp: boolean;
  delayMs: number;
  recentFailures: number[];
}

// Backs off 0.5 → 30 s and stops after six failures inside two minutes; the
// tray then offers a manual restart.
export function planHoldRestart(failures: readonly number[], now: number): HoldRestartPlan {
  const recentFailures = failures.filter((at) => now - at <= HOLD_RESTART_WINDOW_MS && at <= now);
  if (recentFailures.length >= HOLD_RESTART_LIMIT) {
    return { giveUp: true, delayMs: 0, recentFailures };
  }
  const index = Math.min(Math.max(recentFailures.length - 1, 0), HOLD_RESTART_DELAYS_MS.length - 1);
  return { giveUp: false, delayMs: HOLD_RESTART_DELAYS_MS[index]!, recentFailures };
}

// ---- Arm gate -----------------------------------------------------------------

export interface HoldArmInput {
  enabled: boolean;
  helperActive: boolean;
  phase: string;
  activating: boolean;
  shotBusy: boolean;
  holdInFlight: boolean;
}

// The helper only holds middle clicks back while KE Pen could actually open
// the selector. Whenever an overlay, a macOS screencapture run, an upload or
// a hold capture is in progress, middle clicks pass through untouched.
export function shouldArmHold(input: HoldArmInput): boolean {
  return (
    input.enabled &&
    input.helperActive &&
    input.phase === "idle" &&
    !input.activating &&
    !input.shotBusy &&
    !input.holdInFlight
  );
}

// ---- Helper location ------------------------------------------------------------

export interface HoldHelperLocationInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  resourcesPath: string;
  appPath: string;
}

export function holdHelperPath(input: HoldHelperLocationInput): string | null {
  if (!holdCaptureSupported(input.platform)) return null;
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (input.platform === "darwin") {
    // Contents/MacOS beside the app executable: outside the asar, in a code
    // location macOS signs and attributes to KE Pen.
    return input.isPackaged
      ? paths.join(paths.dirname(input.executablePath), HOLD_HELPER_NAME)
      : paths.join(input.appPath, "dist", "native", "darwin", HOLD_HELPER_NAME);
  }
  return input.isPackaged
    ? paths.join(input.resourcesPath, "hold", `${HOLD_HELPER_NAME}.exe`)
    : paths.join(input.appPath, "dist", "native", "win32-x64", `${HOLD_HELPER_NAME}.exe`);
}

// ---- Overlay bootstrap ------------------------------------------------------------

// What the overlay renderer is sent as its background. Pen mode needs the
// lossless capture to crop ink from; the KE Shot hotkey selector shows the
// live screen and gets nothing; the hold selector shows the frozen screen,
// where a JPEG is plenty because the crop still comes from the main process.
export type OverlayBaseline = "png" | "none" | "frozen-jpeg";

export function overlayBaseline(mode: "pen" | "shot", frozen: boolean): OverlayBaseline {
  if (mode === "pen") return "png";
  return frozen ? "frozen-jpeg" : "none";
}

// ---- Freeze, then select ----------------------------------------------------------

export interface HoldFlowSteps<Frame> {
  // Returns false when the screen may not be captured (and has said so).
  ensureAccess(): Promise<boolean>;
  // Takes the frozen image of every display. Must run before any window is
  // shown, any focus change or any activation of KE Pen.
  freeze(): Promise<Frame[]>;
  // Opens the selector over the frozen frames and resolves with the crop.
  select(frames: Frame[]): Promise<Buffer | null>;
  // Runs the normal KE Shot delivery (clipboard first) around a capture.
  deliver(capture: () => Promise<Buffer | null>): Promise<void>;
  trace?(event: string): void;
}

export type HoldFlowOutcome = "delivered" | "no-access";

export async function runHoldFlow<Frame>(steps: HoldFlowSteps<Frame>): Promise<HoldFlowOutcome> {
  if (!(await steps.ensureAccess())) return "no-access";
  steps.trace?.("capture-start");
  const frames = await steps.freeze();
  steps.trace?.("capture-complete");
  if (frames.length === 0) {
    throw new Error("KE Shot could not capture a display. Grant screen-capture permission and try again.");
  }
  await steps.deliver(() => steps.select(frames));
  return "delivered";
}
