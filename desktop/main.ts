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
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnnotationStore } from "../src/store.js";
import type { AnnotationRecord } from "../src/types.js";
import { cancelActiveRegionCapture, captureRegion } from "./capture.js";
import { SettingsStore, ShotHistoryStore, type ShotSettings } from "./settings.js";
import { createShotRuntime, type ShotRuntime } from "./shot.js";
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
const ACTIVATE_ON_START = process.argv.includes("--activate-on-start");
const SHORTCUT = process.platform === "darwin" ? "Control+Alt+Command+P" : "Control+Alt+P";
const SHORTCUT_LABEL = process.platform === "darwin" ? "⌃⌥⌘P" : "Ctrl+Alt+P";
const COPY_MODE_LABELS: Record<CopyMode, string> = {
  image: "Image",
  link: "Link",
  both: "Both",
};

app.setName("KE Pen");
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

if (!IS_SMOKE_TEST && !app.requestSingleInstanceLock()) {
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
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app.whenReady().then(async () => {
    // Hidden until the real preference is known: reading settings takes two
    // file reads, and the icon must not flash for anyone who turned it off.
    if (process.platform === "darwin") app.dock?.hide();
    await store.cancelOrphanedCurrent();
    // KE Shot is additive: if its local state cannot be prepared, KE Pen still
    // has to come up exactly as it did before.
    await createShot().catch(() => undefined);
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
  });
}

async function createShot(): Promise<void> {
  const options = {
    directory: app.getPath("userData"),
    picturesDirectory: picturesDirectory(),
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
        captureWithOverlay: captureShotRegionWithOverlay,
      }),
    onChange: () => updateTrayMenu(),
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

async function updateShotSettings(patch: Partial<ShotSettings>): Promise<void> {
  if (!shot) return;
  const next = await shot.settings.update(patch);
  if (patch.showInDock !== undefined) applyDockVisibility(next.showInDock);
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
    return {
      mode: overlayMode,
      displayId: context.display.id,
      screenWidth: context.display.bounds.width,
      screenHeight: context.display.bounds.height,
      // KE Shot crops in the main process, so the overlay never pays for a
      // full-screen data URL it would only throw away.
      baselineDataUrl: isShot ? "" : context.capture.toDataURL(),
      shortcut: isShot ? shotShortcutLabel : SHORTCUT_LABEL,
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
  if (phase !== "idle" || activating || shotOwnsTheScreen()) return;
  activating = true;
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
    activating = false;
  }
}

// Windows and Linux have no system region picker, so KE Shot reuses the Pen
// overlay windows in a rubber-band mode. macOS never reaches this path.
async function captureShotRegionWithOverlay(): Promise<Buffer | null> {
  if (phase !== "idle" || activating) return null;
  activating = true;
  try {
    const captures = await captureDisplays();
    if (captures.length === 0) {
      throw new Error(
        "KE Shot could not capture a display. Grant screen-capture permission and try again.",
      );
    }

    overlayMode = "shot";
    activeDisplayId = null;
    currentAnnotationId = null;
    setPhase("drawing");
    for (const capture of captures) {
      await createOverlay(capture.display, capture.image);
    }
    for (const context of overlays.values()) {
      context.window.showInactive();
    }
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const focusWindow = [...overlays.values()].find(
      (context) => context.display.id === cursorDisplay.id,
    )?.window;
    focusWindow?.show();
    focusWindow?.focus();
    return await new Promise<Buffer | null>((resolve) => {
      pendingShotRegion = resolve;
    });
  } catch (error) {
    finishShotOverlay(null);
    throw error;
  } finally {
    activating = false;
  }
}

function finishShotOverlay(region: Buffer | null): void {
  const resolve = pendingShotRegion;
  pendingShotRegion = null;
  if (overlayMode !== "shot" && !resolve) return;
  closeOverlays();
  activeDisplayId = null;
  overlayMode = "pen";
  setPhase("idle");
  resolve?.(region);
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

async function captureDisplays(): Promise<Array<{ display: Display; image: NativeImage }>> {
  const displays = screen.getAllDisplays();
  const width = Math.max(
    ...displays.map((display) => Math.ceil(display.size.width * display.scaleFactor)),
  );
  const height = Math.max(
    ...displays.map((display) => Math.ceil(display.size.height * display.scaleFactor)),
  );
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const primary = screen.getPrimaryDisplay();

  return displays.flatMap((display, index) => {
    const exact = sources.find((source) => source.display_id === String(display.id));
    const indexed = sources.length === displays.length ? sources[index] : undefined;
    const single = display.id === primary.id && sources.length === 1 ? sources[0] : undefined;
    const source = exact ?? indexed ?? single;
    if (!source || source.thumbnail.isEmpty()) return [];
    return [{ display, image: source.thumbnail }];
  });
}

async function createOverlay(display: Display, capture: NativeImage): Promise<void> {
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
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
  window.setAlwaysOnTop(true);
  if (process.platform !== "win32") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const webContentsId = window.webContents.id;
  overlays.set(webContentsId, { capture, display, window });
  window.on("closed", () => overlays.delete(webContentsId));
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
  if (changed) updateTrayMenu();
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
    { label: "Open settings file…", click: () => void shell.openPath(runtime.settings.file) },
    { type: "separator" },
  ];
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
    const executablePath = packagedExecutablePath({
      platform: process.platform,
      executablePath: process.execPath,
      ...(appImagePath ? { appImagePath } : {}),
    });
    const bundledServerPath = path.join(process.resourcesPath, "mcp", "index.js");
    const serverPath = packagedMcpServerPath({
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      ...(appImagePath ? { appImagePath } : {}),
    });
    let appImageHelperDirectory: string | undefined;
    if (serverPath !== bundledServerPath) {
      await mkdir(path.dirname(serverPath), { recursive: true, mode: 0o700 });
      await copyFile(bundledServerPath, serverPath);
      await chmod(serverPath, 0o600);

      // electron-builder's AppImage wrapper adds a Chromium --no-sandbox flag
      // when its user-namespace probe fails. ELECTRON_RUN_AS_NODE has no
      // Chromium process and rejects that GUI flag, so this private, fixed
      // probe keeps the wrapper on its headless path. It is scoped only to the
      // copied MCP process environment and never changes the GUI launch.
      appImageHelperDirectory = path.join(path.dirname(serverPath), "bin");
      const unshareProbe = path.join(appImageHelperDirectory, "unshare");
      await mkdir(appImageHelperDirectory, { recursive: true, mode: 0o700 });
      await writeFile(unshareProbe, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(unshareProbe, 0o700);
    }
    clipboard.writeText(
      createMcpHostConfig(executablePath, serverPath, appImageHelperDirectory),
    );
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
