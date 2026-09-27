import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  Tray,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentDisplayRuntimePaths } from "../src/agent-display-protocol.js";
import { AnnotationStore } from "../src/store.js";
import type { AnnotationRecord } from "../src/types.js";
import { AgentDisplayBroker } from "./agent-display-broker.js";
import { AgentDisplayManager } from "./agent-display-manager.js";
import { cancelActiveRegionCapture, captureRegion } from "./capture.js";
import {
  captureThumbnailSize,
  displayForPoint,
  matchCapturesToDisplays,
  nativeCaptureSize,
  needsNativeResize,
} from "./display-capture-core.js";
import {
  formatHoldDelay,
  HOLD_SETUP_IDLE_SECONDS,
  HOLD_SETUP_WAIT_MS,
  holdCaptureSupported,
  holdDelayChoices,
  holdDelayLabel,
  holdHelperPath,
  holdSetupStep,
  overlayBaseline,
  runHoldFlow,
  shouldArmHold,
  shouldOfferHoldSetup,
} from "./hold-core.js";
import { HoldHelperSupervisor, type HoldHelperStatus } from "./hold-helper.js";
import { holdSetupBounds, holdSetupDocument, holdSetupRoute } from "./hold-setup-core.js";
import {
  SettingsStore,
  ShotHistoryStore,
  writePrivateFile,
  type ShotSettings,
} from "./settings.js";
import { createShotRuntime, type ShotClipboard, type ShotNotice, type ShotRuntime } from "./shot.js";
import { dismissShotLinkToast, presentShotNotice } from "./shot-toast.js";
import {
  computeRegionCropPixels,
  formatAccelerator,
  type CopyMode,
  type ShotHistoryEntry,
} from "./shot-core.js";
import {
  createMcpHostConfig,
  packagedExecutablePath,
  packagedMcpServerPath,
} from "./mcp-setup.js";

type PenPhase = "idle" | "drawing" | "queued" | "reading" | "completing" | "clearing";

type OverlayMode = "pen" | "shot";

interface OverlayContext {
  capture: NativeImage;
  display: Display;
  window: BrowserWindow;
}

interface AnnotationPayload {
  displayId: number;
  screenWidth: number;
  screenHeight: number;
  strokeBoundsPoints: unknown;
  cropRectPixels: unknown;
  normalizedStrokes: unknown;
  image: {
    dataUrl: string;
    width: number;
    height: number;
  };
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IS_SMOKE_TEST = process.argv.includes("--smoke-test");
const AGENT_DISPLAY_PROOF = process.argv
  .find((argument) => argument.startsWith("--agent-display-proof="))
  ?.slice("--agent-display-proof=".length);
const IS_AGENT_DISPLAY_PROOF = Boolean(AGENT_DISPLAY_PROOF);
// Runtime proof for hold to capture: an isolated user-data directory, a fake
// helper, an in-memory clipboard and no network. See scripts/verify-hold-proof.mjs.
// Development builds only: a packaged KE Pen never honours it, so nothing can
// point an installed app at a different helper or user-data directory.
const HOLD_PROOF = app.isPackaged
  ? undefined
  : process.argv.find((argument) => argument.startsWith("--hold-proof="))?.slice("--hold-proof=".length);
const IS_HOLD_PROOF = Boolean(HOLD_PROOF) && !app.isPackaged;
const HOLD_STATUS_FILE = "hold-status.json";
const ACTIVATE_ON_START = process.argv.includes("--activate-on-start");
const SHORTCUT = process.platform === "darwin" ? "Control+Alt+Command+P" : "Control+Alt+P";
const SHORTCUT_LABEL = process.platform === "darwin" ? "⌃⌥⌘P" : "Ctrl+Alt+P";
const COPY_MODE_LABELS: Record<CopyMode, string> = {
  image: "Image",
  link: "Link",
  both: "Both",
};

app.setName("KE Pen");
if (IS_HOLD_PROOF) {
  app.setPath("userData", path.join(path.resolve(HOLD_PROOF!), "user-data"));
}
if ((IS_AGENT_DISPLAY_PROOF || IS_HOLD_PROOF) && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
}
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
  if (
    process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" &&
    process.env.KE_PEN_NATIVE_WAYLAND !== "1"
  ) {
    app.commandLine.appendSwitch("ozone-platform", "x11");
  }
}
app.enableSandbox();

if (!IS_SMOKE_TEST && !IS_AGENT_DISPLAY_PROOF && !IS_HOLD_PROOF && !app.requestSingleInstanceLock()) {
  app.quit();
}

const store = new AnnotationStore();
const overlays = new Map<number, OverlayContext>();
let tray: Tray | null = null;
let phase: PenPhase = "idle";
let activating = false;
let activeDisplayId: number | null = null;
let currentAnnotationId: string | null = null;
let statusTimer: NodeJS.Timeout | null = null;
let permissionWatchTimer: NodeJS.Timeout | null = null;
let isPolling = false;
let isQuitting = false;
let overlayMode: OverlayMode = "pen";
let pendingShotRegion: ((region: Buffer | null) => void) | null = null;
let shot: ShotRuntime | null = null;
let shotShortcutLabel = "";
let dockCaptureArmed = false;
let agentDisplays: AgentDisplayManager | null = null;
let agentDisplayBroker: AgentDisplayBroker | null = null;
let agentDisplayStartupError: string | null = null;
let overlayFrozen = false;
let holdHelper: HoldHelperSupervisor | null = null;
let holdStatus: HoldHelperStatus | null = null;
let holdInFlight = false;
let holdSetupCard: BrowserWindow | null = null;
let holdSetupTimer: NodeJS.Timeout | null = null;
let holdAwaitingPermission = false;
let holdProof: HoldProofState | null = null;
const paintedOverlays = new Set<number>();
const shownOverlays = new Set<number>();
let revealOverlaysOnPaint = false;
let overlayPointerDisplayId: number | null = null;
let overlayPaintWaiter: (() => void) | null = null;

interface HoldProofState {
  show: boolean;
  trace: Array<{ event: string; atMs: number }>;
  startedAt: number;
  clipboardImages: Array<{ width: number; height: number }>;
  notices: string[];
  captureSource: "desktopCapturer" | "synthetic";
  overlayLevel: string | null;
  holdsReceived: number;
  runsCompleted: number;
}
if (IS_SMOKE_TEST) {
  void app.whenReady().then(() => {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        product: "KE Pen",
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        sandbox: true,
      })}\n`,
    );
    app.exit(0);
  });
} else {
  registerIpc();
  app.on("second-instance", () => void togglePen());
  app.on("window-all-closed", () => undefined);
  // On macOS the Dock icon is the KE Shot button. macOS also fires this while
  // the app is still coming up, so the arming delay keeps launch from shooting.
  app.on("activate", () => {
    if (!dockCaptureArmed) return;
    void runShot();
  });
  app.on("before-quit", () => {
    isQuitting = true;
    stopPolling();
    stopPermissionWatch();
    // An orphaned crosshair would own the screen after the app is gone.
    cancelActiveRegionCapture();
    finishShotOverlay(null);
    closeOverlays();
    stopHoldSetupWait();
    closeHoldSetupCard();
    void holdHelper?.stop();
    void agentDisplayBroker?.stop();
    void agentDisplays?.shutdown();
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app
    .whenReady()
    .then(async () => {
      if ((IS_AGENT_DISPLAY_PROOF || IS_HOLD_PROOF) && process.platform === "darwin") app.dock?.hide();
      if (IS_HOLD_PROOF) {
        await runHoldProof();
        return;
      }
      await createAgentDisplayRuntime();
      if (IS_AGENT_DISPLAY_PROOF) {
        await runAgentDisplayProof();
        return;
      }
      // Hidden until the real preference is known: reading settings takes two
      // file reads, and the icon must not flash for anyone who turned it off.
      if (process.platform === "darwin") app.dock?.hide();
      await store.cancelOrphanedCurrent();
      // KE Shot is additive: if its local state cannot be prepared, KE Pen still
      // has to come up exactly as it did before.
      await createShot().catch(() => undefined);
      startHoldCapture();
      applyDockVisibility();
      applyDockMenu();
      createTray();
      const penRegistered = globalShortcut.register(SHORTCUT, () => void togglePen());
      const shotRegistered = registerShotShortcut();
      applyTrayTooltip(penRegistered, shotRegistered);
      setTimeout(() => {
        dockCaptureArmed = true;
      }, 1_500);
      if (ACTIVATE_ON_START) await activatePen();
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : "KE Pen failed during startup."}\n`,
      );
      app.exit(1);
    });
}

async function createAgentDisplayRuntime(): Promise<void> {
  let manager: AgentDisplayManager | null = null;
  let broker: AgentDisplayBroker | null = null;
  try {
    const paths = agentDisplayRuntimePaths(store.root);
    manager = new AgentDisplayManager(paths.stateFile);
    await manager.initialize();
    broker = new AgentDisplayBroker(paths, (request) => manager!.handleBrokerRequest(request));
    await broker.start();
    agentDisplays = manager;
    agentDisplayBroker = broker;
    agentDisplayStartupError = null;
  } catch (error) {
    await broker?.stop().catch(() => undefined);
    await manager?.shutdown().catch(() => undefined);
    agentDisplayStartupError =
      error instanceof Error ? error.message : "The local Agent Displays broker could not start.";
    if (IS_AGENT_DISPLAY_PROOF) throw error;
  }
}

async function runAgentDisplayProof(): Promise<void> {
  const manager = agentDisplays;
  if (!manager || !AGENT_DISPLAY_PROOF) {
    throw new Error("Agent Displays proof mode could not initialize its isolated runtime.");
  }
  const output = path.resolve(AGENT_DISPLAY_PROOF);
  if (!output.endsWith(".png")) throw new Error("Agent Displays proof output must be a PNG path.");
  const multiAgentIsolation = await manager.seedProofFixtures();
  const proof = await manager.captureSwitcher();
  validateAgentDisplayProof(proof);
  const imageSize = proof.image.getSize();
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, proof.image.toPNG(), { mode: 0o600 });
  const receipt = output.replace(/\.png$/i, ".json");
  await writeFile(
    receipt,
    `${JSON.stringify(
      {
        schema: "dev.kestudios.pen.agent-display.render-proof.v1",
        createdAt: new Date().toISOString(),
        viewport: imageSize,
        appHostedOffscreenDisplay: true,
        nativeMacOSVirtualMonitor: false,
        nativeSystemCursor: false,
        realDesktopInput: false,
        headlessRender: true,
        foregroundWindowShown: false,
        assertions: {
          exact960x680: true,
          threeIndependentSessionsVisible: true,
          humanControllerVisible: true,
          keyboardFocusInsideSelectedSurface: true,
          selectedSurfaceFrameLoaded: true,
          noHorizontalOverflow: true,
          noRendererError: true,
        },
        multiAgentIsolation,
        accessibility: proof.accessibility,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ ok: true, screenshot: output, receipt })}\n`);
  await agentDisplayBroker?.stop();
  await manager.shutdown();
  app.exit(0);
}

function validateAgentDisplayProof(proof: { image: NativeImage; accessibility: unknown }): void {
  const size = proof.image.getSize();
  if (size.width !== 960 || size.height !== 680) {
    throw new Error(`Agent Displays proof rendered ${size.width}x${size.height}, not 960x680.`);
  }
  if (!proof.accessibility || typeof proof.accessibility !== "object") {
    throw new Error("Agent Displays proof returned no accessibility facts.");
  }
  const facts = proof.accessibility as Record<string, unknown>;
  const overflow = facts.overflow as Record<string, unknown> | undefined;
  const viewport = facts.viewport as Record<string, unknown> | undefined;
  const selectedFrame = facts.selectedFrame as Record<string, unknown> | undefined;
  const liveRegions = Array.isArray(facts.liveRegions) ? facts.liveRegions : [];
  if (facts.sessionOptions !== 3) throw new Error("Agent Displays proof did not show all three sessions.");
  if (facts.controller !== "YOU HAVE CONTROL") {
    throw new Error("Agent Displays proof did not expose the exclusive human handoff state.");
  }
  if (facts.keyboardFocusTarget !== "viewport" || viewport?.tabIndex !== 0) {
    throw new Error("Agent Displays proof did not expose a keyboard-focusable selected surface.");
  }
  if (
    selectedFrame?.complete !== true ||
    selectedFrame.loadState !== "ready" ||
    typeof selectedFrame.naturalWidth !== "number" ||
    selectedFrame.naturalWidth <= 0 ||
    typeof selectedFrame.naturalHeight !== "number" ||
    selectedFrame.naturalHeight <= 0
  ) {
    throw new Error("Agent Displays proof exposed a missing or broken selected surface frame.");
  }
  if (
    typeof overflow?.width !== "number" ||
    typeof overflow.viewport !== "number" ||
    overflow.width > overflow.viewport
  ) {
    throw new Error("Agent Displays proof has horizontal overflow.");
  }
  if (liveRegions.some((value) => typeof value === "string" && /error/i.test(value))) {
    throw new Error("Agent Displays proof exposed a renderer error.");
  }
}

interface ShotOverrides {
  picturesDirectory?: string;
  clipboard?: ShotClipboard;
  notify?: ShotNotice;
}

async function createShot(overrides: ShotOverrides = {}): Promise<void> {
  const options = {
    directory: app.getPath("userData"),
    picturesDirectory: overrides.picturesDirectory ?? picturesDirectory(),
  };
  const settings = new SettingsStore(options);
  const history = new ShotHistoryStore(options);
  await settings.load();
  await history.load();
  shotShortcutLabel = formatAccelerator(settings.current.shotShortcut);
  shot = createShotRuntime({
    settings,
    history,
    captureRegion: () =>
      captureRegion({
        ensureAccess: ensureScreenAccess,
        captureWithOverlay: () => captureShotRegionWithOverlay(),
      }),
    onChange: () => {
      updateTrayMenu();
      refreshHoldArm();
    },
    ...(overrides.clipboard ? { clipboard: overrides.clipboard } : {}),
    ...(overrides.notify ? { notify: overrides.notify } : {}),
  });
}

function picturesDirectory(): string {
  try {
    return app.getPath("pictures");
  } catch {
    return path.join(app.getPath("home"), "Pictures");
  }
}

function registerShotShortcut(): boolean {
  const accelerator = shot?.settings.current.shotShortcut ?? "";
  if (accelerator.length === 0) return false;
  try {
    return globalShortcut.register(accelerator, () => void runShot());
  } catch {
    return false;
  }
}

async function runShot(): Promise<void> {
  if (!shot || phase !== "idle" || activating) return;
  await shot.run();
}

// ---- Hold the middle button to capture ------------------------------------

interface HoldHelperLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function holdHelperLaunch(): HoldHelperLaunch | null {
  // Only the runtime proof may point KE Pen at a different helper.
  const override = IS_HOLD_PROOF ? process.env.KE_PEN_HOLD_HELPER_OVERRIDE : undefined;
  if (override) {
    return {
      command: process.execPath,
      args: [override],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const helper = holdHelperPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!helper) return null;
  // The helper needs no environment of its own; it gets only what the OS
  // needs to start a process.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { command: helper, args: [], env };
}

function startHoldCapture(): void {
  if (!shot || holdHelper || !holdCaptureSupported(process.platform)) return;
  const launch = holdHelperLaunch();
  if (!launch) return;
  holdHelper = new HoldHelperSupervisor({
    ...launch,
    expectedVersion: app.getVersion(),
    onHold: () => {
      if (holdProof) holdProof.holdsReceived += 1;
      holdProofTrace("hold-received");
      void runHoldShot();
    },
    onStatus: (status) => {
      const previous = holdStatus?.state;
      holdStatus = status;
      queueHoldStatusWrite();
      refreshHoldArm();
      if (previous !== status.state) updateTrayMenu();
      if (status.state === "needs-permission") {
        holdAwaitingPermission = true;
        offerHoldSetupWhenIdle();
      }
      if (status.state === "active") {
        stopHoldSetupWait();
        closeHoldSetupCard();
        if (holdAwaitingPermission && previous !== "active") announceHoldReady();
        holdAwaitingPermission = false;
        void maybeAnnounceHoldCapture();
      }
    },
  });
  holdHelper.configure(shot.settings.current.middleHoldDelayMs);
  if (shot.settings.current.middleHoldCapture) holdHelper.start();
}

// Middle clicks are only held back while KE Pen could really open the frozen
// selector; any overlay, macOS region capture, upload or hold in progress lets
// them straight through.
function refreshHoldArm(): void {
  if (!holdHelper) return;
  holdHelper.setArmed(
    shouldArmHold({
      enabled: shot?.settings.current.middleHoldCapture ?? false,
      helperActive: holdStatus?.state === "active",
      phase,
      activating,
      shotBusy: shot?.busy() ?? false,
      holdInFlight,
    }),
  );
}

async function runHoldShot(): Promise<void> {
  const runtime = shot;
  // A hold that lands while something else owns the screen is dropped; the
  // helper was already disarmed for most of that window.
  if (!runtime || phase !== "idle" || activating || runtime.busy() || holdInFlight) return;
  holdInFlight = true;
  refreshHoldArm();
  try {
    await runHoldFlow<CapturedDisplay>({
      // Already-granted access answers without any UI.
      ensureAccess: () => (IS_HOLD_PROOF ? Promise.resolve(true) : ensureScreenAccess()),
      // The freeze is the first real work: no window is shown, no tray menu is
      // rebuilt and no focus moves until every display has been captured.
      freeze: async () => {
        dismissShotLinkToast();
        return IS_HOLD_PROOF ? captureDisplaysForProof() : captureDisplays();
      },
      select: (frozen) => captureShotRegionWithOverlay({ frozen, showFrozen: true }),
      deliver: (capture) => runtime.run(capture),
      trace: holdProofTrace,
    });
  } catch (error) {
    (holdProof ? proofNotice : presentShotNotice)(
      "KE Shot failed",
      error instanceof Error ? error.message : "KE Shot could not freeze the screen.",
    );
  } finally {
    holdInFlight = false;
    if (holdProof) holdProof.runsCompleted += 1;
    refreshHoldArm();
  }
}

// Status changes arrive in quick bursts (starting, then needs-permission or
// active). Writes are chained and each one records the status current when it
// runs, so the file never ends up holding an older state than the app.
let holdStatusWrites: Promise<void> = Promise.resolve();

function queueHoldStatusWrite(): void {
  holdStatusWrites = holdStatusWrites
    .then(() => (holdStatus ? writeHoldStatus(holdStatus) : undefined))
    .catch(() => undefined);
}

async function writeHoldStatus(status: HoldHelperStatus): Promise<void> {
  const settings = shot?.settings.current;
  const document = {
    schema: "dev.kestudios.pen.hold-status.v1",
    state: status.state,
    enabled: settings?.middleHoldCapture ?? false,
    delayMs: settings?.middleHoldDelayMs ?? null,
    helperVersion: status.helperVersion,
    restarts: status.restarts,
    lastError: status.lastError,
    updatedAt: new Date().toISOString(),
  };
  await writePrivateFile(
    path.join(app.getPath("userData"), HOLD_STATUS_FILE),
    `${JSON.stringify(document, null, 2)}\n`,
  ).catch(() => undefined);
}

// macOS: the helper needs its own Accessibility approval. Nothing pops up the
// moment KE Pen starts: the tray shows "allow in System Settings…", and the
// one-time explanation waits until the person has been idle for a few
// seconds, so it can never catch a keystroke meant for another app.
function offerHoldSetupWhenIdle(): void {
  if (IS_HOLD_PROOF || !shot || holdSetupTimer) return;
  if (
    !shouldOfferHoldSetup({
      platform: process.platform,
      state: holdStatus?.state ?? "stopped",
      introducedVersion: shot.settings.current.middleHoldIntroduced,
      appVersion: app.getVersion(),
    })
  ) {
    return;
  }
  const giveUpAt = Date.now() + HOLD_SETUP_WAIT_MS;
  holdSetupTimer = setInterval(() => {
    if (holdStatus?.state !== "needs-permission" || Date.now() > giveUpAt) {
      stopHoldSetupWait();
      return;
    }
    const busy = phase !== "idle" || activating || holdInFlight || (shot?.busy() ?? false);
    if (busy || powerMonitor.getSystemIdleTime() < HOLD_SETUP_IDLE_SECONDS) return;
    stopHoldSetupWait();
    explainHoldPermission({ focus: false });
  }, 1_000);
}

function stopHoldSetupWait(): void {
  if (holdSetupTimer) clearInterval(holdSetupTimer);
  holdSetupTimer = null;
}

// Windows needs no permission, so the feature (on by default) introduces
// itself once instead, with where to turn it off.
async function maybeAnnounceHoldCapture(): Promise<void> {
  if (process.platform !== "win32" || IS_HOLD_PROOF || !shot) return;
  if (shot.settings.current.middleHoldIntroduced !== "") return;
  await shot.settings.update({ middleHoldIntroduced: app.getVersion() }).catch(() => undefined);
  presentShotNotice(
    "Hold the middle button to capture",
    `Hold the middle mouse button for ${formatHoldDelay(shot.settings.current.middleHoldDelayMs)} to ` +
      "freeze the screen and capture a region. A quick middle click still works; it lands when " +
      "you let go. Turn it off or change how long to hold from the KE Pen tray menu.",
  );
}

// macOS: once the approval arrives, say so, once.
function announceHoldReady(): void {
  if (process.platform !== "darwin" || IS_HOLD_PROOF || !shot) return;
  presentShotNotice(
    "Hold to capture is ready",
    `Hold the middle mouse button for ${formatHoldDelay(shot.settings.current.middleHoldDelayMs)} ` +
      "to freeze the screen and capture a region.",
  );
}

// One plain explanation, then one system surface: macOS's own Accessibility
// alert the first time for this version, the settings pane after that. The
// helper notices the approval on its own; nothing needs a relaunch.
//
// The explanation is a small KE Pen card, not a modal dialog: a modal message
// box would stop KE Pen's main loop (hotkeys, the helper, quitting, logging
// out) for as long as it stayed open, and this card can appear while the
// person is away. Shown automatically it never takes focus; from the tray it
// does.
function explainHoldPermission(options: { focus: boolean } = { focus: true }): void {
  if (!shot || process.platform !== "darwin") return;
  const runtime = shot;
  const version = app.getVersion();
  if (holdSetupCard && !holdSetupCard.isDestroyed()) {
    if (options.focus) {
      app.focus({ steal: true });
      holdSetupCard.show();
      holdSetupCard.focus();
    }
    return;
  }
  void runtime.settings.update({ middleHoldIntroduced: version }).catch(() => undefined);
  const step = holdSetupStep(runtime.settings.current.middleHoldPrompted, version);
  let bounds;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    bounds = holdSetupBounds(display.workArea);
  } catch {
    return;
  }
  const card = new BrowserWindow({
    ...bounds,
    title: "Hold to capture",
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: false,
    },
  });
  holdSetupCard = card;
  card.setMenu(null);
  card.setAlwaysOnTop(true, "floating");
  const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    holdSetupDocument({
      delay: formatHoldDelay(runtime.settings.current.middleHoldDelayMs),
      staleEntryHint: step === "open-settings",
    }),
  )}`;
  const route = (destination: string): void => {
    const action = holdSetupRoute(destination);
    if (!action) return;
    closeHoldSetupCard();
    if (action === "continue") void continueHoldSetup();
    else if (action === "off") applyShotSetting({ middleHoldCapture: false });
  };
  card.webContents.on("will-navigate", (event, destination) => {
    if (destination === documentUrl) return;
    event.preventDefault();
    route(destination);
  });
  card.webContents.setWindowOpenHandler(({ url: destination }) => {
    route(destination);
    return { action: "deny" };
  });
  card.webContents.on("will-attach-webview", (event) => event.preventDefault());
  card.once("closed", () => {
    if (holdSetupCard === card) holdSetupCard = null;
    updateTrayMenu();
  });
  void card
    .loadURL(documentUrl)
    .then(() => {
      if (card.isDestroyed()) return;
      if (options.focus) {
        app.focus({ steal: true });
        card.show();
        card.focus();
      } else {
        card.showInactive();
      }
    })
    .catch(() => closeHoldSetupCard());
}

async function continueHoldSetup(): Promise<void> {
  const runtime = shot;
  if (!runtime) return;
  const version = app.getVersion();
  if (holdSetupStep(runtime.settings.current.middleHoldPrompted, version) === "prompt" &&
      holdHelper?.requestPermissionPrompt()) {
    await runtime.settings.update({ middleHoldPrompted: version }).catch(() => undefined);
    return;
  }
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
}

function closeHoldSetupCard(): void {
  const card = holdSetupCard;
  holdSetupCard = null;
  if (card && !card.isDestroyed()) card.destroy();
}

// ---- Hold runtime proof (--hold-proof=<dir>) ----------------------------------

function holdProofTrace(event: string): void {
  if (!holdProof) return;
  const atMs = Math.round((performance.now() - holdProof.startedAt) * 10) / 10;
  holdProof.trace.push({ event, atMs });
  if (process.env.KE_PEN_HOLD_PROOF_DEBUG === "1") process.stderr.write(`hold-proof ${atMs} ${event}\n`);
}

// A hidden window's renderer can be slow to answer; no single probe may hang
// the proof past its own deadline.
function evaluateIn<T>(window: BrowserWindow, source: string, fallback: T, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    window.webContents.executeJavaScript(source, true) as Promise<T>,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]).catch(() => fallback);
}

function proofNotice(title: string, body: string): void {
  holdProof?.notices.push(`${title}: ${body.split("\n")[0]}`);
}

// Real frames when this process may capture the screen; otherwise synthetic
// frames of each display's exact pixel size, so CI runners without screen
// capture still prove the ordering, geometry and crop.
async function captureDisplaysForProof(): Promise<CapturedDisplay[]> {
  const displays = screen.getAllDisplays();
  const real = await captureDisplays().catch(() => [] as CapturedDisplay[]);
  if (real.length === displays.length && process.env.KE_PEN_HOLD_PROOF_SYNTHETIC !== "1") {
    if (holdProof) holdProof.captureSource = "desktopCapturer";
    return real;
  }
  if (holdProof) holdProof.captureSource = "synthetic";
  return displays.map((display) => {
    const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    const pixels = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 0x2a; // blue
      pixels[offset + 1] = 0x3a; // green
      pixels[offset + 2] = 0xff; // red
      pixels[offset + 3] = 0xff;
    }
    return { display, image: nativeImage.createFromBuffer(pixels, { width, height }) };
  });
}

async function runHoldProof(): Promise<void> {
  const directory = path.resolve(HOLD_PROOF!);
  const picturesRoot = path.join(directory, "pictures");
  const startedAt = performance.now();
  holdProof = {
    show: process.env.KE_PEN_HOLD_PROOF_SHOW === "1",
    trace: [],
    startedAt,
    clipboardImages: [],
    notices: [],
    captureSource: "desktopCapturer",
    overlayLevel: null,
    holdsReceived: 0,
    runsCompleted: 0,
  };
  const proof = holdProof;
  const failures: string[] = [];
  const expect = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };
  const clipboardShim: ShotClipboard = {
    writeImage: (image) => {
      proof.clipboardImages.push(image.getSize());
    },
    readImage: () => nativeImage.createEmpty(),
    writeText: () => undefined,
    write: () => undefined,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await createShot({ picturesDirectory: picturesRoot, clipboard: clipboardShim, notify: proofNotice });
  if (!shot) throw new Error("Hold proof could not create the KE Shot runtime.");
  const runtime = shot;
  const displays = screen.getAllDisplays();
  const result: Record<string, unknown> = {
    schema: "dev.kestudios.pen.middle-hold.runtime-proof.v1",
    createdAt: new Date().toISOString(),
    platform: process.platform,
    displays: displays.length,
    overlaysShownOnScreen: proof.show,
    clipboard: "in-memory shim",
    network: "none (no endpoint configured)",
  };

  startHoldCapture();
  const helper = holdHelper as HoldHelperSupervisor | null;
  if (!helper) throw new Error("Hold proof could not start the hold helper supervisor.");

  // Hold #1: the fake helper sends a hold after KE Pen arms it.
  await waitFor(() => proof.holdsReceived >= 1, 8_000, "the first hold");
  const expectedOverlays = displays.length;
  await waitFor(() => overlays.size === expectedOverlays && pendingShotRegion !== null, 10_000, "the frozen overlays");
  const contexts = [...overlays.values()];
  await waitForAsync(async () => {
    const ready = await Promise.all(
      contexts.map((context) => evaluateIn(context.window, "document.body.dataset.ready === 'true'", false)),
    );
    return ready.every(Boolean);
  }, 10_000, "the frozen overlay renderers");
  holdProofTrace("overlays-ready");

  const geometry = contexts.map((context) => {
    const bounds = context.window.getBounds();
    const pixels = context.capture.getSize();
    return {
      boundsMatchDisplay: JSON.stringify(bounds) === JSON.stringify(context.display.bounds),
      alwaysOnTop: context.window.isAlwaysOnTop(),
      scaleFactor: context.display.scaleFactor,
      capturePixels: pixels,
      // Exactly the display's own pixels: never below, and never upscaled.
      capturedAtNativeResolution:
        pixels.width === nativeCaptureSize(context.display).width &&
        pixels.height === nativeCaptureSize(context.display).height,
    };
  });
  const frozenFacts = await Promise.all(
    contexts.map((context) =>
      evaluateIn(
        context.window,
        `(() => {
          const canvas = document.getElementById("ink");
          const pixel = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
          return { frozen: document.body.dataset.frozen === "true", opaqueCentre: pixel[3] === 255,
                   badge: document.getElementById("badge-detail").textContent,
                   title: document.getElementById("badge-title").textContent };
        })()`,
        { frozen: false, opaqueCentre: false, badge: "no answer", title: "no answer" },
      ),
    ),
  );
  expect(geometry.every((entry) => entry.boundsMatchDisplay), "an overlay did not cover its display exactly");
  expect(geometry.every((entry) => entry.alwaysOnTop), "an overlay was not always on top");
  expect(proof.overlayLevel === "screen-saver", "the frozen overlay was not raised to the screen-saver level");
  expect(frozenFacts.every((entry) => entry.frozen && entry.opaqueCentre), "an overlay did not draw the frozen screen");
  expect(helper.isArmed === false, "the helper stayed armed while the frozen selector was open");
  expect(
    geometry.every((entry) => entry.capturedAtNativeResolution),
    `a frozen frame was not the display's native size: ${JSON.stringify(geometry)}`,
  );

  // Select a region on the display under the cursor, through the same bridge
  // the renderer uses.
  const cursorDisplay = displayForPoint(displays, screen.getCursorScreenPoint()) ?? displays[0]!;
  const target = contexts.find((context) => context.display.id === cursorDisplay.id) ?? contexts[0]!;
  const rect = { x: 10, y: 20, width: 200, height: 100 };
  const imageSize = target.capture.getSize();
  const expected = computeRegionCropPixels({
    rect,
    displayWidth: target.display.bounds.width,
    displayHeight: target.display.bounds.height,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
  });
  holdProofTrace("region-submit");
  // The overlay is torn down right after it answers, so the reply to this
  // call can be lost with it; completion is read from the hold run instead.
  void evaluateIn(
    target.window,
    `window.kePen.submitShotRegion({ displayId: ${target.display.id}, rect: ${JSON.stringify(rect)} })`,
    null,
    5_000,
  );
  await waitFor(() => proof.runsCompleted >= 1, 10_000, "delivery");
  holdProofTrace("delivered");
  const firstClipboard = proof.clipboardImages[0];
  expect(proof.clipboardImages.length === 1, "the selection did not reach the clipboard exactly once");
  expect(
    firstClipboard !== undefined &&
      firstClipboard.width === expected.width &&
      firstClipboard.height === expected.height,
    `the clipboard image was ${JSON.stringify(firstClipboard)}, expected ${JSON.stringify(expected)}`,
  );
  const localCopies = await readdir(path.join(picturesRoot, "KE Shot")).catch(() => [] as string[]);
  let localCopyMode = "";
  if (localCopies[0]) {
    const info = await stat(path.join(picturesRoot, "KE Shot", localCopies[0]));
    localCopyMode = (info.mode & 0o777).toString(8);
  }
  expect(localCopies.length === 1, "the local safety copy was not written exactly once");

  // Hold #2 arrives once KE Pen re-arms; Escape must cancel with nothing copied.
  await waitFor(() => proof.holdsReceived >= 2, 8_000, "the second hold");
  await waitFor(() => overlays.size === expectedOverlays && pendingShotRegion !== null, 10_000, "the second overlays");
  const second = [...overlays.values()];
  await waitForAsync(async () => {
    const ready = await Promise.all(
      second.map((context) => evaluateIn(context.window, "document.body.dataset.ready === 'true'", false)),
    );
    return ready.every(Boolean);
  }, 10_000, "the second overlay renderers");
  holdProofTrace("escape");
  if (proof.show) {
    second[0]!.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  } else {
    await evaluateIn(
      second[0]!.window,
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
      false,
    );
  }
  await waitFor(() => proof.runsCompleted >= 2, 10_000, "the cancel");
  holdProofTrace("cancelled");
  expect(proof.clipboardImages.length === 1, "Escape still put something on the clipboard");

  // Hold #3: a right click cancels too, for when Escape cannot reach the
  // overlay (Windows focus rules), again with nothing copied.
  await waitFor(() => proof.holdsReceived >= 3, 8_000, "the third hold");
  await waitFor(() => overlays.size === expectedOverlays && pendingShotRegion !== null, 10_000, "the third overlays");
  const third = [...overlays.values()];
  await waitForAsync(async () => {
    const ready = await Promise.all(
      third.map((context) => evaluateIn(context.window, "document.body.dataset.ready === 'true'", false)),
    );
    return ready.every(Boolean);
  }, 10_000, "the third overlay renderers");
  holdProofTrace("right-click");
  await evaluateIn(
    third[0]!.window,
    "document.getElementById('ink').dispatchEvent(new PointerEvent('pointerdown', { button: 2, pointerId: 7, bubbles: true }))",
    false,
  );
  await waitFor(() => proof.runsCompleted >= 3, 10_000, "the right-click cancel");
  holdProofTrace("right-click-cancelled");
  expect(proof.clipboardImages.length === 1, "a right click still put something on the clipboard");
  await waitFor(() => helper.isArmed, 3_000, "re-arming after the cancel").catch(() => {
    failures.push("the helper was not re-armed after the selector closed");
  });

  // Ordering: the freeze completes before any overlay exists, is shown or
  // takes focus, and no tray rebuild happens between the hold and the freeze.
  const index = (event: string, from = 0): number =>
    proof.trace.findIndex((entry, position) => position >= from && entry.event === event);
  const holdIndex = index("hold-received");
  const captureComplete = index("capture-complete", holdIndex);
  const firstOverlay = index("overlay-created", holdIndex);
  const firstShow = proof.trace.findIndex(
    (entry, position) => position >= holdIndex && entry.event.startsWith("overlay-show:"),
  );
  const firstFocus = index("focus", holdIndex);
  const trayBeforeFreeze = proof.trace
    .slice(holdIndex, captureComplete)
    .some((entry) => entry.event === "tray-update");
  const painted = index("overlays-painted", holdIndex);
  // Every overlay of the first hold is shown only after its own frozen frame
  // was drawn (each display goes up as soon as it is ready).
  const firstRunEnd = index("region-submit", holdIndex);
  const firstRun = proof.trace.slice(holdIndex, firstRunEnd < 0 ? undefined : firstRunEnd);
  const shows = firstRun.filter((entry) => entry.event.startsWith("overlay-show:"));
  const eachPaintedBeforeShown =
    shows.length === expectedOverlays &&
    shows.every((show) => {
      const id = show.event.slice("overlay-show:".length);
      const paintedAt = firstRun.findIndex((entry) => entry.event === `overlay-painted:${id}`);
      return paintedAt >= 0 && paintedAt < firstRun.indexOf(show);
    });
  const ordering = {
    captureBeforeOverlayCreated: captureComplete >= 0 && captureComplete < firstOverlay,
    captureBeforeOverlayShown: captureComplete >= 0 && captureComplete < firstShow,
    frozenFramePaintedBeforeShown: eachPaintedBeforeShown,
    showBeforeFocus: firstShow >= 0 && firstShow < firstFocus,
    noTrayRebuildBeforeFreeze: !trayBeforeFreeze,
  };
  expect(Object.values(ordering).every(Boolean), `ordering failed: ${JSON.stringify(ordering)}`);
  const at = (i: number): number => proof.trace[i]?.atMs ?? Number.NaN;

  await helper.stop();
  // The crop came from this machine's real screen: keep only its facts.
  await rm(picturesRoot, { recursive: true, force: true });

  Object.assign(result, {
    captureSource: proof.captureSource,
    overlays: geometry.length,
    geometry,
    frozenOverlay: frozenFacts.map((entry) => ({ frozen: entry.frozen, opaqueCentre: entry.opaqueCentre })),
    badge: frozenFacts[0]?.badge ?? null,
    badgeTitle: frozenFacts[0]?.title ?? null,
    overlayLevel: proof.overlayLevel,
    ordering,
    timingsMs: {
      holdToCaptureComplete: at(captureComplete) - at(holdIndex),
      holdToFrozenFramePainted: at(painted) - at(holdIndex),
      holdToFirstOverlayShown: at(firstShow) - at(holdIndex),
      holdToOverlaysReady: at(index("overlays-ready")) - at(holdIndex),
    },
    clipboardWrites: proof.clipboardImages.length,
    clipboardImage: firstClipboard ?? null,
    expectedCrop: expected,
    localCopies: localCopies.length,
    localCopyMode,
    escapeMethod: proof.show ? "sendInputEvent" : "dom-keydown",
    rightClickCancelled: proof.runsCompleted >= 3 && proof.clipboardImages.length === 1,
    holdsReceived: proof.holdsReceived,
    notices: proof.notices,
    trace: proof.trace,
    failures,
    passed: failures.length === 0,
  });
  const receipt = path.join(directory, "hold-proof.json");
  await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (failures.length > 0) {
    process.stderr.write(`PEN_HOLD_PROOF_FAILED ${failures.join("; ")}\n`);
    app.exit(1);
    return;
  }
  process.stdout.write(`PEN_HOLD_PROOF_OK ${JSON.stringify({ receipt })}\n`);
  app.exit(0);
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Hold proof timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Hold proof timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function updateShotSettings(patch: Partial<ShotSettings>): Promise<void> {
  if (!shot) return;
  const next = await shot.settings.update(patch);
  if (patch.showInDock !== undefined) applyDockVisibility(next.showInDock);
  if (patch.middleHoldDelayMs !== undefined) holdHelper?.configure(next.middleHoldDelayMs);
  if (patch.middleHoldCapture !== undefined) {
    if (next.middleHoldCapture) holdHelper?.start();
    else {
      stopHoldSetupWait();
      await holdHelper?.stop();
    }
  }
  refreshHoldArm();
  updateTrayMenu();
}

// A settings write can fail on a full or read-only disk. Electron has already
// flipped the menu item by then, so a silent rejection would leave the tray
// claiming a state neither the app nor the file actually holds.
function applyShotSetting(patch: Partial<ShotSettings>): void {
  void updateShotSettings(patch).catch((error: unknown) => {
    updateTrayMenu();
    void dialog.showMessageBox({
      type: "error",
      title: "KE Shot could not save that setting",
      message:
        error instanceof Error ? error.message : "KE Shot could not write its settings file.",
      detail: `The previous setting is still in effect.\n\n${shot?.settings.file ?? ""}`,
    });
  });
}

function applyDockVisibility(showInDock = shot?.settings.current.showInDock ?? false): void {
  if (process.platform !== "darwin") return;
  if (showInDock) void app.dock?.show();
  else app.dock?.hide();
}

// A plain Dock click stays the screenshot button (the "activate" handler);
// right-click is where the pen lives, above macOS's own Dock entries.
function applyDockMenu(): void {
  if (process.platform !== "darwin") return;
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: "Capture Screenshot", click: () => void runShot() },
      { label: "Draw with KE Pen", click: () => void togglePen() },
    ]),
  );
}

function applyTrayTooltip(penRegistered: boolean, shotRegistered: boolean): void {
  if (!tray) return;
  const unavailable = [
    ...(penRegistered ? [] : ["Pen"]),
    ...(shotRegistered ? [] : ["Shot"]),
  ];
  tray.setToolTip(
    unavailable.length === 0
      ? "KE Shot and KE Pen by K&E Studios — click for the menu"
      : `KE Pen — global shortcut unavailable for KE ${unavailable.join(" and KE ")}; use this menu`,
  );
}

function registerIpc(): void {
  ipcMain.handle("pen:bootstrap", (event) => {
    const context = contextFor(event);
    const isShot = overlayMode === "shot";
    const baseline = overlayBaseline(overlayMode, overlayFrozen);
    holdProofTrace("overlay-bootstrap");
    return {
      mode: overlayMode,
      displayId: context.display.id,
      screenWidth: context.display.bounds.width,
      screenHeight: context.display.bounds.height,
      // KE Shot crops in the main process, so the hotkey overlay never pays for
      // a full-screen data URL it would only throw away.
      baselineDataUrl:
        baseline === "frozen-jpeg"
          ? `data:image/jpeg;base64,${context.capture.toJPEG(90).toString("base64")}`
          : baseline === "png"
            ? context.capture.toDataURL()
            : "",
      frozen: baseline === "frozen-jpeg",
      pointerDisplay: overlayPointerDisplayId === null || overlayPointerDisplayId === context.display.id,
      shortcut: baseline === "frozen-jpeg" ? "" : isShot ? shotShortcutLabel : SHORTCUT_LABEL,
    };
  });

  ipcMain.on("pen:begin-stroke", (event) => {
    const context = contextFor(event);
    if (phase !== "drawing") {
      event.returnValue = false;
      return;
    }
    activeDisplayId ??= context.display.id;
    event.returnValue = activeDisplayId === context.display.id;
  });

  ipcMain.handle("pen:release-display", (event) => {
    const context = contextFor(event);
    if (phase === "drawing" && activeDisplayId === context.display.id) {
      activeDisplayId = null;
      return true;
    }
    return false;
  });

  ipcMain.handle("pen:submit-shot-region", (event, input: unknown) => {
    const context = contextFor(event);
    if (overlayMode !== "shot" || phase !== "drawing" || !pendingShotRegion) {
      throw new Error("KE Shot is not accepting a region right now.");
    }
    if (activeDisplayId !== null && activeDisplayId !== context.display.id) {
      throw new Error("KE Shot is not accepting a region from this display.");
    }
    const rect = validateRect((input as { rect?: unknown } | null)?.rect, "shot region");
    const size = context.capture.getSize();
    const pixels = computeRegionCropPixels({
      rect,
      displayWidth: context.display.bounds.width,
      displayHeight: context.display.bounds.height,
      imageWidth: size.width,
      imageHeight: size.height,
    });
    const png = context.capture.crop(pixels).toPNG();
    // Tear the overlay down after this reply so the sender is still alive.
    setImmediate(() => finishShotOverlay(png.byteLength > 0 ? png : null));
    return { ok: true };
  });

  ipcMain.handle("pen:submit-annotation", async (event, input: unknown) => {
    const context = contextFor(event);
    if (overlayMode !== "pen" || phase !== "drawing" || activeDisplayId !== context.display.id) {
      throw new Error("Pen is not accepting a mark from this display.");
    }
    const payload = validatePayload(input, context);
    const image = decodePngDataUrl(payload.image.dataUrl);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: AnnotationRecord = {
      schema: "dev.kestudios.pen.annotation.v1",
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      source: {
        displayID: Math.max(0, Math.trunc(Math.abs(context.display.id))),
        screenFramePoints: {
          x: context.display.bounds.x,
          y: context.display.bounds.y,
          width: context.display.bounds.width,
          height: context.display.bounds.height,
        },
      },
      selection: {
        strokeBoundsPoints: validateRect(payload.strokeBoundsPoints, "stroke bounds"),
        cropRectPixels: validateRect(payload.cropRectPixels, "crop rectangle"),
        normalizedStrokes: validateStrokes(payload.normalizedStrokes),
        coordinateNote: "Normalized stroke coordinates use a top-left origin inside the returned crop.",
      },
      image: {
        file: "crop.png",
        mimeType: "image/png",
        width: payload.image.width,
        height: payload.image.height,
        sha256: createHash("sha256").update(image).digest("hex"),
        includesInk: true,
      },
      credit: {
        creator: "William Keenan",
        studio: "K&E Studios",
        url: "https://kestudios.dev/?ref=pen",
        product: "Pen",
      },
    };

    await store.create(record, image);
    currentAnnotationId = id;
    setPhase("queued");
    makeOverlaysClickThrough();
    startPolling();
    return { id };
  });

  ipcMain.on("pen:overlay-ready", (event) => {
    const context = overlays.get(event.sender.id);
    if (!context || context.window.isDestroyed()) return;
    paintedOverlays.add(event.sender.id);
    holdProofTrace(`overlay-painted:${event.sender.id}`);
    // Frozen selector: each display goes up as soon as its own frozen frame is
    // drawn, the pointer's display first, without waiting for the others.
    if (revealOverlaysOnPaint) revealOverlay(event.sender.id, context.window);
    overlayPaintWaiter?.();
  });

  ipcMain.on("pen:cancel", (event) => {
    contextFor(event);
    void cancelPen("Cancelled by the user with Escape.");
  });
}

async function togglePen(): Promise<void> {
  if (phase !== "idle" || activating) {
    await cancelPen("Cancelled by the user from the KE Pen tray menu.");
    return;
  }
  await activatePen();
}

// A macOS region capture runs entirely outside the phase machine, so "idle" is
// not enough on its own: opening the Pen overlay on top of a live crosshair
// would capture KE Pen's own dim layer and badge, and leave the overlay unable
// to receive input because screencapture owns the event tap.
function shotOwnsTheScreen(): boolean {
  return overlayMode !== "shot" && (shot?.busy() ?? false);
}

async function activatePen(): Promise<void> {
  // A hold capture in flight owns the screen from its freeze to its selector.
  if (phase !== "idle" || activating || holdInFlight || shotOwnsTheScreen()) return;
  setActivating(true);
  try {
    if (!(await ensureScreenAccess())) return;
    const captures = await captureDisplays();
    if (captures.length === 0) {
      throw new Error(
        "KE Pen could not capture a display. Grant screen-capture permission and try again.",
      );
    }

    activeDisplayId = null;
    currentAnnotationId = null;
    setPhase("drawing");
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    for (const capture of captures) {
      await createOverlay(capture.display, capture.image);
    }
    for (const context of overlays.values()) {
      context.window.showInactive();
    }
    const focusWindow = [...overlays.values()].find(
      (context) => context.display.id === cursorDisplay.id,
    )?.window;
    if (process.platform === "darwin") app.focus({ steal: true });
    focusWindow?.show();
    focusWindow?.focus();
  } catch (error) {
    closeOverlays();
    setPhase("idle");
    await showError(error);
  } finally {
    setActivating(false);
  }
}

interface ShotOverlayOptions {
  // Captures taken before anything was shown: hold to capture freezes first.
  frozen?: CapturedDisplay[];
  // Draw the frozen image under the selector instead of the live screen.
  showFrozen?: boolean;
}

// Windows and Linux have no system region picker, so the KE Shot hotkey reuses
// the Pen overlay windows in a rubber-band mode. Hold to capture uses the same
// windows on every platform, over the frozen screen it captured first.
async function captureShotRegionWithOverlay(options: ShotOverlayOptions = {}): Promise<Buffer | null> {
  if (phase !== "idle" || activating) return null;
  setActivating(true);
  const frozen = options.showFrozen === true && options.frozen !== undefined;
  try {
    const captures = options.frozen ?? (await captureDisplays());
    if (captures.length === 0) {
      throw new Error(
        "KE Shot could not capture a display. Grant screen-capture permission and try again.",
      );
    }

    overlayMode = "shot";
    overlayFrozen = frozen;
    activeDisplayId = null;
    currentAnnotationId = null;
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlayPointerDisplayId = cursorDisplay.id;
    setPhase("drawing");
    paintedOverlays.clear();
    shownOverlays.clear();
    // The display under the pointer is created, drawn and shown first.
    const ordered = [...captures].sort(
      (a, b) => Number(b.display.id === cursorDisplay.id) - Number(a.display.id === cursorDisplay.id),
    );
    // Nothing is shown and no focus moves until a display's frozen frame is
    // drawn, so an open menu stays open until the frozen copy covers it.
    revealOverlaysOnPaint = frozen;
    try {
      for (const capture of ordered) {
        await createOverlay(capture.display, capture.image, { frozen });
      }
      if (frozen) await waitForOverlaysPainted(1_500);
    } finally {
      revealOverlaysOnPaint = false;
    }
    for (const [id, context] of overlays) {
      revealOverlay(id, context.window);
    }
    const focusWindow = [...overlays.values()].find(
      (context) => context.display.id === cursorDisplay.id,
    )?.window;
    // A frozen selector is opened from another app's menu, so KE Pen has to
    // take keyboard focus for Escape to reach it.
    focusOverlay(focusWindow, frozen && process.platform === "darwin");
    return await new Promise<Buffer | null>((resolve) => {
      pendingShotRegion = resolve;
    });
  } catch (error) {
    finishShotOverlay(null);
    throw error;
  } finally {
    setActivating(false);
  }
}

// Middle clicks must pass straight through from the moment an overlay starts
// coming up, so the helper is disarmed before any capture or window work.
function setActivating(value: boolean): void {
  activating = value;
  refreshHoldArm();
}

function finishShotOverlay(region: Buffer | null): void {
  const resolve = pendingShotRegion;
  pendingShotRegion = null;
  if (overlayMode !== "shot" && !resolve) return;
  const wasFrozen = overlayFrozen;
  closeOverlays();
  activeDisplayId = null;
  overlayMode = "pen";
  overlayFrozen = false;
  overlayPointerDisplayId = null;
  shownOverlays.clear();
  setPhase("idle");
  if (wasFrozen) handFocusBack();
  resolve?.(region);
}

// The frozen selector took focus from whatever app the person was in. Once it
// closes, give that app its focus back unless KE Pen has a window of its own up.
function handFocusBack(): void {
  if (process.platform !== "darwin" || IS_HOLD_PROOF) return;
  if (BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())) {
    return;
  }
  app.hide();
}

function waitForOverlaysPainted(timeoutMs: number): Promise<void> {
  const allPainted = (): boolean => [...overlays.keys()].every((id) => paintedOverlays.has(id));
  if (allPainted()) {
    holdProofTrace("overlays-painted");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (painted: boolean): void => {
      clearTimeout(timer);
      overlayPaintWaiter = null;
      holdProofTrace(painted ? "overlays-painted" : "overlays-paint-timeout");
      resolve();
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    overlayPaintWaiter = () => {
      if (allPainted()) finish(true);
    };
  });
}

function revealOverlay(id: number, window: BrowserWindow): void {
  if (shownOverlays.has(id) || window.isDestroyed()) return;
  shownOverlays.add(id);
  showOverlayInactive(id, window);
  // Starts the frozen frame's dim fade-in from the moment it is on screen.
  window.webContents.send("pen:overlay-shown");
}

function showOverlayInactive(id: number, window: BrowserWindow): void {
  holdProofTrace(`overlay-show:${id}`);
  if (holdProof && !holdProof.show) return;
  window.showInactive();
}

function focusOverlay(window: BrowserWindow | undefined, stealAppFocus: boolean): void {
  holdProofTrace("focus");
  if (holdProof && !holdProof.show) return;
  if (stealAppFocus) app.focus({ steal: true });
  window?.show();
  window?.focus();
}

async function ensureScreenAccess(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return true;

  // One throwaway capture attempt makes macOS register KE Pen in the Screen
  // Recording list (and prompt on newer macOS) before we show guidance.
  await desktopCapturer
    .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
    .catch(() => undefined);
  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return true;

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "KE Pen",
    message: "Give KE Pen Screen Recording access",
    detail:
      "KE Pen only captures the region you draw around, and macOS requires Screen Recording " +
      "permission for that local crop.\n\n" +
      "macOS ties the approval to each exact build of KE Pen. If KE Pen already shows as " +
      "enabled in System Settings › Privacy & Security › Screen Recording, that switch belongs " +
      "to an older build — toggle it off and back on (or remove KE Pen with the − button, then " +
      "add it again).\n\n" +
      "KE Pen relaunches itself automatically as soon as access goes live.",
    buttons: ["Open System Settings", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    watchForScreenGrant();
  }
  return false;
}

// A grant made while the app is running never applies to the running process,
// so poll for it and relaunch once it lands. Gives up quietly after 5 minutes.
function watchForScreenGrant(): void {
  stopPermissionWatch();
  let ticks = 0;
  permissionWatchTimer = setInterval(() => {
    ticks += 1;
    if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
      stopPermissionWatch();
      app.relaunch();
      app.exit(0);
    } else if (ticks > 150) {
      stopPermissionWatch();
    }
  }, 2_000);
}

function stopPermissionWatch(): void {
  if (permissionWatchTimer) clearInterval(permissionWatchTimer);
  permissionWatchTimer = null;
}

interface CapturedDisplay {
  display: Display;
  image: NativeImage;
}

async function captureDisplays(): Promise<CapturedDisplay[]> {
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: captureThumbnailSize(displays),
    fetchWindowIcons: false,
  });
  // Every screen is fitted into one shared thumbnail size, which upscales a
  // lower-resolution display beside a Retina one. Bring each frame back to
  // that display's own pixels so a capture there is native size, not larger.
  return matchCapturesToDisplays(
    displays,
    sources,
    screen.getPrimaryDisplay().id,
    (image) => image.isEmpty(),
  ).map((capture) =>
    needsNativeResize(capture.image.getSize(), capture.display)
      ? { ...capture, image: capture.image.resize({ ...nativeCaptureSize(capture.display), quality: "best" }) }
      : capture,
  );
}

interface OverlayOptions {
  frozen?: boolean;
}

async function createOverlay(
  display: Display,
  capture: NativeImage,
  options: OverlayOptions = {},
): Promise<void> {
  const frozen = options.frozen === true;
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    // The frozen screen must cover the menu bar and the Dock pixel for pixel,
    // which macOS only allows a window that may be larger than the work area.
    enableLargerThanScreen: frozen,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setMenuBarVisibility(false);
  if (frozen) {
    // Above the menu bar, the Dock and any open menu, so the live screen can
    // never draw over the frozen one and misregister the selection.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setBounds(display.bounds);
    if (holdProof) holdProof.overlayLevel = "screen-saver";
  } else {
    window.setAlwaysOnTop(true);
  }
  if (process.platform !== "win32") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const webContentsId = window.webContents.id;
  overlays.set(webContentsId, { capture, display, window });
  window.on("closed", () => overlays.delete(webContentsId));
  holdProofTrace("overlay-created");
  await window.loadFile(path.join(__dirname, "ui", "index.html"));
}

function makeOverlaysClickThrough(): void {
  for (const context of overlays.values()) {
    if (process.platform === "darwin" || process.platform === "win32") {
      context.window.setIgnoreMouseEvents(true, { forward: true });
    } else {
      context.window.setIgnoreMouseEvents(true);
    }
    context.window.setFocusable(false);
    context.window.blur();
  }
}

function startPolling(): void {
  stopPolling();
  statusTimer = setInterval(() => void pollStatus(), 200);
  void pollStatus();
}

function stopPolling(): void {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

async function pollStatus(): Promise<void> {
  if (isPolling || !currentAnnotationId || phase === "idle" || phase === "clearing") return;
  isPolling = true;
  try {
    const record = await store.read(currentAnnotationId);
    if (record.status === "pending") setPhase("queued");
    if (record.status === "reading") setPhase("reading");
    if (record.status === "completing") {
      setPhase("completing");
      if (record.clearAfter && new Date(record.clearAfter).getTime() <= Date.now()) {
        await store.setStatus(record.id, "complete");
        fadeAndClose();
      }
    }
    if (record.status === "complete" || record.status === "cancelled") fadeAndClose();
  } catch (error) {
    await cancelPen(error instanceof Error ? error.message : "Pen lost its current annotation.");
  } finally {
    isPolling = false;
  }
}

async function cancelPen(reason: string): Promise<void> {
  if (overlayMode === "shot") {
    finishShotOverlay(null);
    return;
  }
  stopPolling();
  if (currentAnnotationId) {
    try {
      await store.setStatus(currentAnnotationId, "cancelled", reason);
    } catch {
      // The annotation may have been removed by an explicit history clear.
    }
  }
  closeOverlays();
  activeDisplayId = null;
  currentAnnotationId = null;
  setPhase("idle");
}

function fadeAndClose(): void {
  if (phase === "clearing") return;
  stopPolling();
  setPhase("clearing");
  setTimeout(() => {
    closeOverlays();
    activeDisplayId = null;
    currentAnnotationId = null;
    setPhase("idle");
  }, 260);
}

function closeOverlays(): void {
  for (const context of overlays.values()) {
    if (!context.window.isDestroyed()) context.window.destroy();
  }
  overlays.clear();
}

function setPhase(nextPhase: PenPhase): void {
  const changed = nextPhase !== phase;
  phase = nextPhase;
  for (const context of overlays.values()) {
    if (!context.window.isDestroyed()) context.window.webContents.send("pen:phase", nextPhase);
  }
  // The status poll calls this five times a second with the same phase, and
  // rebuilding the tray menu that often can dismiss it while it is open.
  if (changed) {
    updateTrayMenu();
    refreshHoldArm();
  }
}

function createTray(): void {
  // macOS gets a purpose-built transparent template glyph. Keep the explicit
  // template flag as well as the Template filename so Electron and macOS never
  // render the monochrome nib as an opaque bitmap.
  const icon =
    process.platform === "darwin"
      ? nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"))
      : nativeImage
          .createFromPath(path.join(__dirname, "assets", "pen-icon.png"))
          .resize({ width: 24, height: 24 });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("KE Pen by K&E Studios — click to draw");
  tray.on("click", () => void togglePen());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  holdProofTrace("tray-update");
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([...shotMenuSection(), ...penMenuSection()]));
}

function shotMenuSection(): MenuItemConstructorOptions[] {
  if (!shot) return [];
  const runtime = shot;
  const settings = runtime.settings.current;
  const history = runtime.history.entries;
  const latest = history.find((entry) => entry.url !== null);
  const pending = runtime.pendingCount();
  const recent: MenuItemConstructorOptions[] = history.slice(0, 10).map((entry) => ({
    label: shotEntryLabel(entry),
    submenu: [
      {
        label: "Copy link",
        enabled: entry.url !== null,
        click: () => {
          if (entry.url) clipboard.writeText(entry.url);
        },
      },
      {
        label: "Open in browser",
        enabled: entry.url !== null,
        click: () => {
          if (entry.url) void shell.openExternal(entry.url);
        },
      },
      {
        label: "Show local copy",
        enabled: entry.localPath !== null,
        click: () => {
          if (entry.localPath) shell.showItemInFolder(entry.localPath);
        },
      },
      {
        label: "Delete from endpoint…",
        enabled: entry.id !== null && !runtime.busy(),
        click: () => confirmDeleteShot(entry),
      },
    ],
  }));
  if (recent.length === 0) recent.push({ label: "No shots yet", enabled: false });
  if (pending > 0) {
    recent.push(
      { type: "separator" },
      {
        label: `Retry failed uploads (${pending})`,
        click: () => void runtime.retryPending(),
      },
    );
  }

  const copyModes: MenuItemConstructorOptions[] = (["image", "link", "both"] as CopyMode[]).map(
    (mode) => ({
      label: COPY_MODE_LABELS[mode],
      type: "radio",
      checked: settings.copyMode === mode,
      click: () => applyShotSetting({ copyMode: mode }),
    }),
  );

  const dockItem: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: "Show in Dock",
            type: "checkbox",
            checked: settings.showInDock,
            click: () => applyShotSetting({ showInDock: !settings.showInDock }),
          },
        ]
      : [];

  return [
    { label: "KE Shot", enabled: false },
    {
      label: `Capture region   ${shotShortcutLabel}`.trimEnd(),
      enabled: !runtime.busy() && phase === "idle",
      click: () => void runShot(),
    },
    {
      label: "Copy last link",
      enabled: latest !== undefined,
      click: () => {
        if (latest?.url) clipboard.writeText(latest.url);
      },
    },
    {
      label: "Open last shot",
      enabled: latest !== undefined,
      click: () => {
        if (latest?.url) void shell.openExternal(latest.url);
      },
    },
    { label: "Recent shots", submenu: recent },
    { type: "separator" },
    { label: "Copy to clipboard", submenu: copyModes },
    {
      label: "Save a local copy",
      type: "checkbox",
      checked: settings.saveLocalCopy,
      click: () => applyShotSetting({ saveLocalCopy: !settings.saveLocalCopy }),
    },
    ...dockItem,
    ...holdMenuItems(settings),
    { label: "Open settings file…", click: () => void shell.openPath(runtime.settings.file) },
    { type: "separator" },
  ];
}

// "Hold middle button to capture" lives beside the other KE Shot settings.
function holdMenuItems(settings: ShotSettings): MenuItemConstructorOptions[] {
  if (!holdCaptureSupported(process.platform)) return [];
  const delays: MenuItemConstructorOptions[] = holdDelayChoices(settings.middleHoldDelayMs).map(
    (ms) => ({
      label: holdDelayLabel(ms),
      type: "radio",
      checked: settings.middleHoldDelayMs === ms,
      click: () => applyShotSetting({ middleHoldDelayMs: ms }),
    }),
  );
  const items: MenuItemConstructorOptions[] = [
    {
      label: "Hold middle button to capture",
      type: "checkbox",
      checked: settings.middleHoldCapture,
      click: () => applyShotSetting({ middleHoldCapture: !settings.middleHoldCapture }),
    },
    { label: "How long to hold", enabled: settings.middleHoldCapture, submenu: delays },
  ];
  if (!settings.middleHoldCapture) return items;
  const state = holdStatus?.state;
  if (state === "needs-permission") {
    items.push({
      label: "Hold to capture: allow in System Settings…",
      click: () => explainHoldPermission({ focus: true }),
    });
  } else if (state === "failed") {
    items.push({
      label: "Hold to capture stopped — Restart",
      click: () => holdHelper?.restart(),
    });
  } else if (state === "unavailable") {
    items.push({ label: "Hold to capture isn't available in this build", enabled: false });
  }
  return items;
}

function confirmDeleteShot(entry: ShotHistoryEntry): void {
  void (async () => {
    const runtime = shot;
    if (!runtime) return;
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "KE Shot",
      message: "Delete this shot from your endpoint?",
      detail:
        "Your endpoint stops serving it. This cannot recall bytes a chat app, an unfurl " +
        "service, or a CDN already fetched. Any local copy stays on this machine.",
      buttons: ["Delete", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    await runtime.deleteShot(entry.key);
  })();
}

function shotEntryLabel(entry: ShotHistoryEntry): string {
  const stamp = entry.createdAt.length > 0 ? entry.createdAt.replace("T", " ").slice(0, 19) : "shot";
  if (entry.status === "uploaded") return `${stamp}   copy link`;
  if (entry.status === "pending") return `${stamp}   upload failed`;
  return `${stamp}   local only`;
}

function penMenuSection(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    { label: "KE Pen", enabled: false },
    {
      label: "Agent Displays…",
      enabled: agentDisplays !== null,
      click: () => void agentDisplays?.openSwitcher(),
    },
    ...(agentDisplayStartupError
      ? [
          {
            label: "Agent Displays unavailable",
            enabled: false,
            toolTip: agentDisplayStartupError,
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    { type: "separator" },
    {
      label: phase === "idle" ? `Draw with KE Pen   ${SHORTCUT_LABEL}` : "Cancel KE Pen",
      enabled: phase !== "idle" || !shotOwnsTheScreen(),
      click: () => void togglePen(),
    },
    { type: "separator" },
    {
      label: "Clear local Pen history",
      click: () =>
        void (async () => {
          if (phase !== "idle") await cancelPen("Cleared with Pen history.");
          await store.clearHistory();
        })(),
    },
    { label: "Open local Pen data", click: () => void shell.openPath(store.root) },
    { type: "separator" },
    {
      label: "Copy AI setup",
      click: () => void copyAiSetup(),
    },
    {
      label: "Free downloads and setup",
      click: () => void shell.openExternal("https://kestudios.dev/pen?ref=pen-app"),
    },
    {
      label: "Visit kestudios.dev",
      click: () => void shell.openExternal("https://kestudios.dev/?ref=pen-app"),
    },
    {
      label: "About KE Pen",
      click: () =>
        void dialog.showMessageBox({
          type: "info",
          title: "KE Pen",
          message: "Point at the bug. Your AI gets the point.",
          detail: `Created by William Keenan at K&E Studios. Completely free and open source.\n\nVersion ${app.getVersion()} · kestudios.dev`,
        }),
    },
    { type: "separator" },
    { label: "Quit KE Pen", click: () => app.quit() },
  ];
  return template;
}

async function copyAiSetup(): Promise<void> {
  try {
    const appImagePath = process.env.APPIMAGE;
    const bundledServerPath = path.join(process.resourcesPath, "mcp", "index.js");
    const serverPath = packagedMcpServerPath({
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      ...(appImagePath ? { appImagePath } : {}),
    });
    let appImageRuntimePath: string | undefined;
    if (serverPath !== bundledServerPath) {
      await mkdir(path.dirname(serverPath), { recursive: true, mode: 0o700 });
      await copyFile(bundledServerPath, serverPath);
      await chmod(serverPath, 0o600);

      // AppImage's mount/extract wrapper is not a transparent stdio transport.
      // Keep the GUI AppImage where the user put it, but copy its packaged
      // Electron/Node runtime into this owner-only MCP directory. Linux loads
      // data and shared libraries from beside the executable, so the complete
      // packaged runtime must stay together. The AI host then launches the
      // embedded server directly with no display, wrapper, system Node.js,
      // listening port, or network dependency.
      const runtimeDirectory = path.join(path.dirname(serverPath), "runtime");
      await cp(path.dirname(process.execPath), runtimeDirectory, {
        recursive: true,
        force: true,
      });
      appImageRuntimePath = path.join(runtimeDirectory, path.basename(process.execPath));
      await chmod(runtimeDirectory, 0o700);
      await chmod(appImageRuntimePath, 0o700);
      await chmod(path.join(runtimeDirectory, "chrome-sandbox"), 0o700);
    }
    if (appImagePath && !appImageRuntimePath) {
      throw new Error("KE Pen could not prepare its private AppImage MCP runtime.");
    }
    const executablePath = packagedExecutablePath({
      platform: process.platform,
      executablePath: process.execPath,
      ...(appImagePath && appImageRuntimePath ? { appImagePath, appImageRuntimePath } : {}),
    });
    clipboard.writeText(createMcpHostConfig(executablePath, serverPath));
    await dialog.showMessageBox({
      type: "info",
      title: "KE Pen AI setup copied",
      message: "Paste this into your AI host's MCP configuration, then restart the host.",
      detail:
        "The copied setup runs the MCP server already inside this KE Pen installation. " +
        "It does not install software, open a port, or send any screen image by itself.",
    });
  } catch (error: unknown) {
    await dialog.showMessageBox({
      type: "error",
      title: "KE Pen could not copy AI setup",
      message: error instanceof Error ? error.message : "The embedded MCP server was unavailable.",
      detail: "No configuration was copied. Reinstall KE Pen and try again.",
    });
  }
}

function contextFor(event: IpcMainInvokeEvent | IpcMainEvent): OverlayContext {
  const context = overlays.get(event.sender.id);
  if (!context || context.window.isDestroyed()) {
    throw new Error("Pen refused a message from an unknown window.");
  }
  return context;
}

function validatePayload(input: unknown, context: OverlayContext): AnnotationPayload {
  if (!input || typeof input !== "object") throw new Error("Pen received an invalid annotation.");
  const payload = input as Partial<AnnotationPayload>;
  if (
    payload.displayId !== context.display.id ||
    payload.screenWidth !== context.display.bounds.width ||
    payload.screenHeight !== context.display.bounds.height ||
    !payload.image ||
    typeof payload.image.dataUrl !== "string" ||
    !Number.isInteger(payload.image.width) ||
    !Number.isInteger(payload.image.height) ||
    payload.image.width <= 0 ||
    payload.image.height <= 0
  ) {
    throw new Error("Pen received annotation data that did not match this display.");
  }
  return payload as AnnotationPayload;
}

function validateRect(input: unknown, label: string): AnnotationRecord["selection"]["cropRectPixels"] {
  if (!input || typeof input !== "object") throw new Error(`Pen received an invalid ${label}.`);
  const rect = input as Record<string, unknown>;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`Pen received an invalid ${label}.`);
  }
  if ((rect.width as number) <= 0 || (rect.height as number) <= 0) {
    throw new Error(`Pen received an empty ${label}.`);
  }
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  };
}

function validateStrokes(input: unknown): AnnotationRecord["selection"]["normalizedStrokes"] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_000) {
    throw new Error("Pen received invalid normalized strokes.");
  }
  return input.map((stroke) => {
    if (!Array.isArray(stroke) || stroke.length === 0 || stroke.length > 100_000) {
      throw new Error("Pen received an invalid normalized stroke.");
    }
    return stroke.map((point) => {
      if (!point || typeof point !== "object") throw new Error("Pen received an invalid point.");
      const candidate = point as Record<string, unknown>;
      if (
        typeof candidate.x !== "number" ||
        typeof candidate.y !== "number" ||
        typeof candidate.t !== "number" ||
        ![candidate.x, candidate.y, candidate.t].every(Number.isFinite) ||
        candidate.x < 0 ||
        candidate.x > 1 ||
        candidate.y < 0 ||
        candidate.y > 1
      ) {
        throw new Error("Pen received an invalid normalized point.");
      }
      return { x: candidate.x, y: candidate.y, t: candidate.t };
    });
  });
}

function decodePngDataUrl(dataUrl: string): Buffer {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("Pen only accepts PNG annotations.");
  const image = Buffer.from(dataUrl.slice(prefix.length), "base64");
  if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Pen image is empty or exceeds the 16 MB local safety limit.");
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!image.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error("Pen refused image bytes that were not a PNG.");
  }
  return image;
}

async function showError(error: unknown): Promise<void> {
  if (isQuitting) return;
  await dialog.showMessageBox({
    type: "error",
    title: "KE Pen could not start",
    message: error instanceof Error ? error.message : "KE Pen could not open the drawing overlay.",
    detail:
      process.platform === "linux"
        ? "On Linux, use an X11 or XWayland desktop session and allow the system screen-capture prompt."
        : "Allow screen-capture permission for KE Pen, then try again from the tray icon.",
  });
}
