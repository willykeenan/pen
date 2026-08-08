import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AnnotationStore } from "../src/store.js";
import type { AnnotationRecord } from "../src/types.js";

type PenPhase = "idle" | "drawing" | "queued" | "reading" | "completing" | "clearing";

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
let isPolling = false;
let isQuitting = false;

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
  app.on("before-quit", () => {
    isQuitting = true;
    stopPolling();
    closeOverlays();
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app.whenReady().then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    await store.cancelOrphanedCurrent();
    createTray();
    const shortcutRegistered = globalShortcut.register(SHORTCUT, () => void togglePen());
    if (!shortcutRegistered) {
      tray?.setToolTip("KE Pen — global shortcut unavailable; click the tray icon to draw");
    }
    if (ACTIVATE_ON_START) await activatePen();
  });
}

function registerIpc(): void {
  ipcMain.handle("pen:bootstrap", (event) => {
    const context = contextFor(event);
    return {
      displayId: context.display.id,
      screenWidth: context.display.bounds.width,
      screenHeight: context.display.bounds.height,
      baselineDataUrl: context.capture.toDataURL(),
      shortcut: SHORTCUT_LABEL,
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

  ipcMain.handle("pen:submit-annotation", async (event, input: unknown) => {
    const context = contextFor(event);
    if (phase !== "drawing" || activeDisplayId !== context.display.id) {
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

async function activatePen(): Promise<void> {
  if (phase !== "idle" || activating) return;
  activating = true;
  try {
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
  phase = nextPhase;
  for (const context of overlays.values()) {
    if (!context.window.isDestroyed()) context.window.webContents.send("pen:phase", nextPhase);
  }
  updateTrayMenu();
}

function createTray(): void {
  const iconPath = path.join(__dirname, "assets", "pen-icon.png");
  const base = nativeImage.createFromPath(iconPath);
  const icon = base.resize({
    width: process.platform === "darwin" ? 18 : 24,
    height: process.platform === "darwin" ? 18 : 24,
  });
  tray = new Tray(icon);
  tray.setToolTip("KE Pen by K&E Studios — click to draw");
  tray.on("click", () => void togglePen());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: phase === "idle" ? `Draw with KE Pen   ${SHORTCUT_LABEL}` : "Cancel KE Pen",
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
  tray.setContextMenu(Menu.buildFromTemplate(template));
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
