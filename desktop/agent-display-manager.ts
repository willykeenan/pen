import {
  BrowserWindow,
  ipcMain,
  systemPreferences,
  type IpcMainInvokeEvent,
  type NativeImage,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentDisplayResourceAllowed,
  agentDisplayActionSchema,
  normalizeAgentDisplayTarget,
  type AgentDisplayAction,
  type AgentDisplayBrokerRequest,
  type AgentDisplayPermissionTruth,
  type AgentDisplaySessionView,
} from "../src/agent-display-protocol.js";
import { AgentDisplayError, AgentDisplayRegistry } from "./agent-display-registry.js";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

interface AgentSurface {
  sessionId: string;
  window: BrowserWindow;
  internalUrl: string;
  lastFrame: NativeImage | null;
}

export class AgentDisplayManager {
  private readonly registry: AgentDisplayRegistry;
  private readonly surfaces = new Map<string, AgentSurface>();
  private switcher: BrowserWindow | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ipcRegistered = false;
  private shuttingDown = false;

  constructor(stateFile: string) {
    this.registry = new AgentDisplayRegistry(stateFile);
  }

  async initialize(): Promise<void> {
    this.shuttingDown = false;
    await this.registry.loadAndInterrupt();
    this.registerIpc();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 60_000);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const surface of this.surfaces.values()) await this.disposeSurface(surface);
    this.surfaces.clear();
    if (this.switcher && !this.switcher.isDestroyed()) this.switcher.destroy();
    this.switcher = null;
  }

  async handleBrokerRequest(request: AgentDisplayBrokerRequest): Promise<unknown> {
    switch (request.method) {
      case "claim": {
        const claimed = await this.registry.claim(request.params);
        try {
          await this.createSurface(claimed.session);
          if (request.params.targetUrl) {
            await this.navigate(
              claimed.session.sessionId,
              claimed.ownerToken,
              request.params.targetUrl,
            );
          }
        } catch (error) {
          await this.stopSurface(
            claimed.session.sessionId,
            "The isolated renderer or its initial target failed to start.",
          );
          throw error;
        }
        return {
          ...claimed,
          boundary: {
            kind: "app-hosted-offscreen-display",
            nativeMacOSMonitor: false,
            nativeSystemCursor: false,
            realDesktopInput: false,
            explanation:
              "This is an isolated Electron testing surface with a synthetic cursor. It does not move the Mac's real cursor or create a monitor in System Settings.",
          },
        };
      }
      case "status":
        return this.status(request.params.sessionId);
      case "navigate":
        return this.navigate(request.params.sessionId, request.params.ownerToken, request.params.url);
      case "act":
        return this.agentAct(
          request.params.sessionId,
          request.params.ownerToken,
          request.params.action,
        );
      case "snapshot":
        return this.snapshot(request.params.sessionId, request.params.ownerToken);
      case "heartbeat":
        return {
          session: await this.registry.heartbeat(
            request.params.sessionId,
            request.params.ownerToken,
          ),
        };
      case "stop": {
        const session = await this.registry.stop(request.params.sessionId, {
          token: request.params.ownerToken,
          reason: request.params.reason ?? "Stopped by the owning agent.",
        });
        await this.stopSurface(session.sessionId, session.stopReason ?? "Stopped.", false);
        return { session };
      }
    }
  }

  async openSwitcher(showWindow = true): Promise<BrowserWindow> {
    if (this.switcher && !this.switcher.isDestroyed()) {
      if (showWindow) {
        this.switcher.show();
        this.switcher.focus();
      }
      return this.switcher;
    }
    const window = new BrowserWindow({
      width: 960,
      height: 680,
      useContentSize: true,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: "KE Pen · Agent Displays",
      backgroundColor: "#0d1016",
      webPreferences: {
        preload: path.join(__dirname, "agent-display-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    window.setMenuBarVisibility(false);
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => {
      if (this.switcher === window) this.switcher = null;
    });
    this.switcher = window;
    await window.loadFile(path.join(__dirname, "agent-ui", "displays.html"));
    if (showWindow) window.show();
    return window;
  }

  async seedProofFixtures(): Promise<{
    concurrentAgentInputs: number;
    firstSessionAcceptedOwnValue: boolean;
    secondSessionAcceptedOwnValue: boolean;
    untouchedHumanSessionStayedEmpty: boolean;
  }> {
    const fixtures = [
      {
        agentId: "codex:01a035df",
        taskId: "agent-display-workspaces",
        label: "Codex · Checkout QA",
        width: 1_440,
        height: 900,
      },
      {
        agentId: "claude:visual-review",
        taskId: "accessibility-pass",
        label: "Claude · Visual review",
        width: 1_280,
        height: 800,
      },
      {
        agentId: "grok:worker-07",
        taskId: "responsive-fixture",
        label: "Grok · Mobile fixture",
        width: 900,
        height: 700,
      },
    ];
    const claims: Array<{ session: AgentDisplaySessionView; ownerToken: string }> = [];
    for (const fixture of fixtures) {
      const claimed = await this.registry.claim(fixture);
      await this.createSurface(claimed.session, true);
      claims.push(claimed);
    }
    const [firstResult, secondResult] = await Promise.all([
      this.exerciseProofSurface(claims[0]!, "codex-surface-value"),
      this.exerciseProofSurface(claims[1]!, "claude-surface-value"),
    ]);
    const untouched = await this.readProofFixture(claims[2]!.session.sessionId);
    await this.registry.takeHumanControl(claims[2]!.session.sessionId);
    const proof = {
      concurrentAgentInputs: 2,
      firstSessionAcceptedOwnValue:
        firstResult.value === "codex-surface-value" &&
        firstResult.result.includes("codex-surface-value"),
      secondSessionAcceptedOwnValue:
        secondResult.value === "claude-surface-value" &&
        secondResult.result.includes("claude-surface-value"),
      untouchedHumanSessionStayedEmpty: untouched.value === "",
    };
    if (
      !proof.firstSessionAcceptedOwnValue ||
      !proof.secondSessionAcceptedOwnValue ||
      !proof.untouchedHumanSessionStayedEmpty
    ) {
      throw new AgentDisplayError(
        "PROOF_MULTI_AGENT_ISOLATION_FAILED",
        "Concurrent proof input did not stay inside its assigned offscreen surface.",
      );
    }
    return proof;
  }

  async captureSwitcher(): Promise<{ image: NativeImage; accessibility: unknown }> {
    const window = await this.openSwitcher(false);
    await wait(800);
    const image = await window.webContents.capturePage();
    const accessibility = await window.webContents.executeJavaScript(`(() => {
      const viewport = document.getElementById('viewport');
      viewport?.focus({preventScroll: true});
      window.scrollTo(0, 0);
      return ({
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => ({level: node.tagName, text: node.textContent?.trim()})),
      controls: [...document.querySelectorAll('button,[role="button"],[role="tab"]')].map((node) => ({text: node.textContent?.trim(), disabled: node.hasAttribute('disabled'), ariaPressed: node.getAttribute('aria-pressed')})),
      sessionOptions: document.querySelectorAll('[role="option"]').length,
      viewport: viewport ? {tabIndex: viewport.tabIndex, ariaLabel: viewport.getAttribute('aria-label')} : null,
      keyboardFocusTarget: document.activeElement?.id ?? null,
      controller: document.getElementById('controller-pill')?.textContent?.trim() ?? null,
      liveRegions: [...document.querySelectorAll('[aria-live]')].map((node) => node.textContent?.trim()),
      overflow: {width: document.documentElement.scrollWidth, viewport: window.innerWidth},
      contentSize: {width: window.innerWidth, height: window.innerHeight}
    });
    })()`);
    return { image, accessibility };
  }

  private status(sessionId?: string): {
    sessions: AgentDisplaySessionView[];
    permissions: AgentDisplayPermissionTruth;
    boundary: string;
  } {
    return {
      sessions: this.registry.list(sessionId),
      permissions: permissionTruth(),
      boundary:
        "App-hosted offscreen test displays only. No macOS virtual monitor, native multi-cursor, or real-desktop input is claimed.",
    };
  }

  private async navigate(sessionId: string, token: string, rawUrl: string): Promise<unknown> {
    const target = normalizeAgentDisplayTarget(rawUrl);
    const session = await this.registry.setTargetOrigin(sessionId, token, target.origin);
    const surface = this.requireSurface(sessionId);
    surface.lastFrame = null;
    await withTimeout(
      surface.window.loadURL(target.url),
      20_000,
      "The isolated display did not finish navigation within 20 seconds.",
    );
    surface.window.webContents.invalidate();
    await this.waitForSurfaceFrame(surface, 2_000);
    if (!surface.lastFrame) {
      throw new AgentDisplayError(
        "DISPLAY_FRAME_UNAVAILABLE",
        "The isolated display navigated but did not produce a render frame.",
      );
    }
    return { session, url: redactUrl(target.url) };
  }

  private async agentAct(
    sessionId: string,
    token: string,
    action: AgentDisplayAction,
  ): Promise<unknown> {
    this.registry.requireAgent(sessionId, token);
    await this.dispatchInput(sessionId, action);
    return { session: await this.registry.recordAction(sessionId, token, action) };
  }

  private async humanAct(sessionId: string, action: AgentDisplayAction): Promise<unknown> {
    this.registry.requireHuman(sessionId);
    await this.dispatchInput(sessionId, action);
    return { session: await this.registry.recordHumanAction(sessionId, action) };
  }

  private async snapshot(sessionId: string, token: string): Promise<unknown> {
    this.registry.requireAgent(sessionId, token);
    const image = await this.captureSurface(sessionId, true);
    // A human handoff may occur while Chromium produces a fresh frame. Never
    // return a frame captured after the agent lost control.
    this.registry.requireAgent(sessionId, token);
    const png = image.toPNG();
    if (png.byteLength <= MAX_SNAPSHOT_BYTES) {
      return {
        session: this.registry.list(sessionId)[0],
        mimeType: "image/png",
        imageBase64: png.toString("base64"),
      };
    }
    const jpeg = image.toJPEG(82);
    if (jpeg.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new AgentDisplayError(
        "SNAPSHOT_TOO_LARGE",
        "The isolated display snapshot exceeded the 16 MB safety limit.",
      );
    }
    return {
      session: this.registry.list(sessionId)[0],
      mimeType: "image/jpeg",
      imageBase64: jpeg.toString("base64"),
    };
  }

  private async createSurface(session: AgentDisplaySessionView, proof = false): Promise<void> {
    if (this.surfaces.has(session.sessionId)) return;
    const window = new BrowserWindow({
      width: session.width,
      height: session.height,
      show: false,
      frame: false,
      backgroundColor: "#f4f1ea",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        offscreen: true,
        backgroundThrottling: false,
        partition: `ke-pen-agent-${session.sessionId}-${randomUUID()}`,
      },
    });
    const internalFile = path.join(__dirname, "agent-ui", "surface.html");
    const internalUrl = pathToFileURL(internalFile).toString();
    const internalDirectoryUrl = pathToFileURL(`${path.dirname(internalFile)}${path.sep}`).toString();
    const surface: AgentSurface = {
      sessionId: session.sessionId,
      window,
      internalUrl,
      lastFrame: null,
    };
    this.surfaces.set(session.sessionId, surface);
    window.webContents.setFrameRate(30);
    window.webContents.on("paint", (_event, _dirty, image) => {
      surface.lastFrame = image;
    });
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const active = this.registry.list(session.sessionId)[0];
      callback({
        cancel: !agentDisplayResourceAllowed(
          details.url,
          internalDirectoryUrl,
          active?.targetOrigin ?? null,
        ),
      });
    });
    window.webContents.session.on("will-download", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const gate = (event: Electron.Event, url: string) => {
      if (!this.navigationAllowed(session.sessionId, url, internalUrl)) event.preventDefault();
    };
    window.webContents.on("will-navigate", gate);
    window.webContents.on("will-redirect", gate);
    window.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      void this.registry.interrupt(
        session.sessionId,
        `The isolated renderer stopped (${details.reason}); no real desktop input occurred.`,
      );
      this.destroySurface(surface);
      this.surfaces.delete(session.sessionId);
    });
    await window.loadFile(internalFile, {
      query: {
        label: session.label,
        task: session.taskId,
        color: session.cursor.color,
        proof: proof ? "1" : "0",
      },
    });
    window.webContents.invalidate();
    await this.waitForSurfaceFrame(surface, 2_000);
  }

  private navigationAllowed(sessionId: string, rawUrl: string, internalUrl: string): boolean {
    if (rawUrl.startsWith(internalUrl)) return true;
    const session = this.registry.list(sessionId)[0];
    if (!session?.targetOrigin) return false;
    try {
      return new URL(rawUrl).origin === session.targetOrigin;
    } catch {
      return false;
    }
  }

  private async dispatchInput(sessionId: string, action: AgentDisplayAction): Promise<void> {
    const surface = this.requireSurface(sessionId);
    const contents = surface.window.webContents;
    if (contents.isDestroyed()) throw new AgentDisplayError("DISPLAY_INTERRUPTED", "The display renderer is unavailable.");
    const session = this.registry.list(sessionId)[0];
    if (!session) throw new AgentDisplayError("DISPLAY_NOT_FOUND", "That agent display does not exist.");
    const x = "x" in action ? clamp(Math.round(action.x), 0, session.width - 1) : session.cursor.x;
    const y = "y" in action ? clamp(Math.round(action.y), 0, session.height - 1) : session.cursor.y;
    switch (action.type) {
      case "move":
        contents.sendInputEvent({ type: "mouseMove", x, y, movementX: 0, movementY: 0 });
        break;
      case "click":
        contents.sendInputEvent({ type: "mouseMove", x, y, movementX: 0, movementY: 0 });
        contents.sendInputEvent({ type: "mouseDown", x, y, button: action.button, clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x, y, button: action.button, clickCount: 1 });
        break;
      case "type":
        contents.insertText(action.text);
        break;
      case "key": {
        const modifiers = action.modifiers as Array<"shift" | "control" | "alt" | "meta">;
        contents.sendInputEvent({ type: "keyDown", keyCode: action.key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: action.key, modifiers });
        break;
      }
      case "scroll":
        contents.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: action.deltaX,
          deltaY: action.deltaY,
          canScroll: true,
        });
        break;
    }
  }

  private async exerciseProofSurface(
    claim: { session: AgentDisplaySessionView; ownerToken: string },
    value: string,
  ): Promise<{ value: string; result: string }> {
    const surface = this.requireSurface(claim.session.sessionId);
    const points = (await surface.window.webContents.executeJavaScript(`(() => {
      const center = (id) => {
        const bounds = document.getElementById(id)?.getBoundingClientRect();
        if (!bounds) throw new Error('Missing proof control');
        return {x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2};
      };
      return {input: center('fixture-input'), submit: center('fixture-submit')};
    })()`)) as { input: { x: number; y: number }; submit: { x: number; y: number } };
    await this.agentAct(claim.session.sessionId, claim.ownerToken, {
      type: "click",
      ...points.input,
      button: "left",
    });
    await wait(30);
    await this.agentAct(claim.session.sessionId, claim.ownerToken, { type: "type", text: value });
    await wait(30);
    await this.agentAct(claim.session.sessionId, claim.ownerToken, {
      type: "click",
      ...points.submit,
      button: "left",
    });
    await wait(60);
    return this.readProofFixture(claim.session.sessionId);
  }

  private async readProofFixture(sessionId: string): Promise<{ value: string; result: string }> {
    const surface = this.requireSurface(sessionId);
    return (await surface.window.webContents.executeJavaScript(`(() => ({
      value: document.getElementById('fixture-input')?.value ?? '',
      result: document.getElementById('fixture-result')?.textContent ?? ''
    }))()`)) as { value: string; result: string };
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    ipcMain.handle("agent-display:bootstrap", (event) => {
      this.assertSwitcher(event);
      return this.status();
    });
    ipcMain.handle("agent-display:refresh", async (event, sessionId: unknown) => {
      if (this.shuttingDown) {
        return { ...this.status(), selectedSessionId: null, frame: null };
      }
      this.assertSwitcher(event);
      const id = sessionId === null ? null : parseSessionId(sessionId);
      let frame: Awaited<ReturnType<AgentDisplayManager["previewFrame"]>> | null = null;
      if (id && this.surfaces.has(id)) {
        try {
          frame = await this.previewFrame(id);
        } catch {
          // Keep controller and Stop available even if Chromium has not painted
          // a frame yet. Snapshot calls still fail closed with a clear error.
        }
      }
      return { ...this.status(), selectedSessionId: id, frame };
    });
    ipcMain.handle("agent-display:take-control", async (event, sessionId: unknown) => {
      this.assertSwitcher(event);
      return { session: await this.registry.takeHumanControl(parseSessionId(sessionId)) };
    });
    ipcMain.handle("agent-display:return-control", async (event, sessionId: unknown) => {
      this.assertSwitcher(event);
      return { session: await this.registry.returnAgentControl(parseSessionId(sessionId)) };
    });
    ipcMain.handle("agent-display:stop", async (event, sessionId: unknown) => {
      this.assertSwitcher(event);
      const id = parseSessionId(sessionId);
      const session = await this.registry.stop(id, { reason: "Stopped and revoked by William." });
      await this.stopSurface(id, session.stopReason ?? "Stopped.", false);
      return { session };
    });
    ipcMain.handle("agent-display:human-act", async (event, sessionId: unknown, input: unknown) => {
      this.assertSwitcher(event);
      return this.humanAct(parseSessionId(sessionId), agentDisplayActionSchema.parse(input));
    });
  }

  private assertSwitcher(event: IpcMainInvokeEvent): void {
    if (!this.switcher || this.switcher.isDestroyed() || event.sender.id !== this.switcher.webContents.id) {
      throw new AgentDisplayError("UNTRUSTED_DISPLAY_WINDOW", "KE Pen refused an Agent Displays message from an unknown window.");
    }
  }

  private async previewFrame(sessionId: string): Promise<{
    dataUrl: string;
    width: number;
    height: number;
  }> {
    let image = await this.captureSurface(sessionId);
    const size = image.getSize();
    if (size.width > 1_200) image = image.resize({ width: 1_200 });
    const resized = image.getSize();
    return { dataUrl: image.toDataURL(), width: resized.width, height: resized.height };
  }

  private async captureSurface(sessionId: string, forceFresh = false): Promise<NativeImage> {
    const surface = this.requireSurface(sessionId);
    if (forceFresh) surface.lastFrame = null;
    if (!surface.lastFrame) {
      surface.window.webContents.invalidate();
      await this.waitForSurfaceFrame(surface, 2_000);
    }
    if (!surface.lastFrame) {
      throw new AgentDisplayError(
        "DISPLAY_FRAME_UNAVAILABLE",
        "The isolated display has not produced a render frame yet.",
      );
    }
    return surface.lastFrame;
  }

  private async waitForSurfaceFrame(surface: AgentSurface, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!surface.lastFrame && Date.now() < deadline) await wait(25);
  }

  private async cleanup(): Promise<void> {
    const expired = await this.registry.cleanupStale();
    for (const sessionId of expired) await this.stopSurface(sessionId, "Stale display expired.", false);
  }

  private async stopSurface(sessionId: string, reason: string, updateRegistry = true): Promise<void> {
    const surface = this.surfaces.get(sessionId);
    if (surface) {
      await this.disposeSurface(surface);
      this.surfaces.delete(sessionId);
    }
    if (updateRegistry) await this.registry.interrupt(sessionId, reason);
  }

  private destroySurface(surface: AgentSurface): void {
    if (!surface.window.isDestroyed()) surface.window.destroy();
  }

  private async disposeSurface(surface: AgentSurface): Promise<void> {
    const contents = surface.window.webContents;
    if (!contents.isDestroyed()) await contents.session.clearStorageData().catch(() => undefined);
    this.destroySurface(surface);
  }

  private requireSurface(sessionId: string): AgentSurface {
    const surface = this.surfaces.get(sessionId);
    if (!surface || surface.window.isDestroyed()) {
      throw new AgentDisplayError(
        "DISPLAY_INTERRUPTED",
        "This display has no live renderer. Claim or recover the exact agent display again.",
      );
    }
    return surface;
  }
}

function permissionTruth(): AgentDisplayPermissionTruth {
  let screenRecording: AgentDisplayPermissionTruth["screenRecording"] = "unknown";
  let accessibility: AgentDisplayPermissionTruth["accessibility"] = "not-applicable";
  if (process.platform === "darwin") {
    const observed = systemPreferences.getMediaAccessStatus("screen");
    screenRecording = ["granted", "denied", "not-determined", "restricted"].includes(observed)
      ? (observed as AgentDisplayPermissionTruth["screenRecording"])
      : "unknown";
    accessibility = systemPreferences.isTrustedAccessibilityClient(false)
      ? "granted"
      : "not-granted";
  }
  return {
    screenRecording,
    accessibility,
    isolatedDisplayNeedsScreenRecording: false,
    isolatedDisplayNeedsAccessibility: false,
    realDesktopControl: "not-implemented",
  };
}

function parseSessionId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ) {
    throw new AgentDisplayError("INVALID_DISPLAY_ID", "KE Pen refused an invalid display identifier.");
  }
  return input;
}

function redactUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return `${parsed.origin}/…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentDisplayError("NAVIGATION_TIMEOUT", message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
