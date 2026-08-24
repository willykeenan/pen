import type {
  AgentDisplayAction,
  AgentDisplayPermissionTruth,
  AgentDisplaySessionView,
} from "../src/agent-display-protocol.js";

interface DisplaySnapshot {
  sessions: AgentDisplaySessionView[];
  permissions: AgentDisplayPermissionTruth;
  boundary: string;
  selectedSessionId?: string | null;
  frame?: { dataUrl: string; width: number; height: number } | null;
}
interface DisplayBridge {
  bootstrap(): Promise<DisplaySnapshot>;
  refresh(sessionId: string | null): Promise<DisplaySnapshot>;
  takeControl(sessionId: string): Promise<unknown>;
  returnControl(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  act(sessionId: string, action: AgentDisplayAction): Promise<unknown>;
}

declare global {
  interface Window {
    keAgentDisplays: DisplayBridge;
  }
}

const sessionList = requiredElement<HTMLElement>("session-list");
const emptyState = requiredElement<HTMLElement>("empty-state");
const workspace = requiredElement<HTMLElement>("workspace");
const selectedTitle = requiredElement<HTMLElement>("selected-title");
const selectedMeta = requiredElement<HTMLElement>("selected-meta");
const controllerPill = requiredElement<HTMLElement>("controller-pill");
const statePill = requiredElement<HTMLElement>("state-pill");
const takeControl = requiredElement<HTMLButtonElement>("take-control");
const stopButton = requiredElement<HTMLButtonElement>("stop-display");
const viewport = requiredElement<HTMLElement>("viewport");
const frame = requiredElement<HTMLImageElement>("display-frame");
const cursor = requiredElement<HTMLElement>("agent-cursor");
const cursorLabel = requiredElement<HTMLElement>("cursor-label");
const lastAction = requiredElement<HTMLElement>("last-action");
const permissionTruth = requiredElement<HTMLElement>("permission-truth");
const sessionTruth = requiredElement<HTMLElement>("session-truth");
const liveStatus = requiredElement<HTMLElement>("live-status");

let snapshot: DisplaySnapshot;
let selectedSessionId: string | null = null;
let refreshing = false;
let timer: number | undefined;

void initialize();

async function initialize(): Promise<void> {
  snapshot = await window.keAgentDisplays.bootstrap();
  selectedSessionId = snapshot.sessions.find((session) => session.state === "ready")?.sessionId ??
    snapshot.sessions[0]?.sessionId ??
    null;
  bindControls();
  await refresh();
  timer = window.setInterval(() => void refresh(), 400);
  window.addEventListener("beforeunload", () => window.clearInterval(timer));
}

function bindControls(): void {
  takeControl.addEventListener("click", () => void toggleControl());
  stopButton.addEventListener("click", () => void stopSelected());
  viewport.addEventListener("pointermove", (event) => void forwardPointer("move", event));
  viewport.addEventListener("click", (event) => void forwardPointer("click", event));
  viewport.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void forwardPointer("click", event, "right");
  });
  viewport.addEventListener("wheel", (event) => {
    const session = selectedSession();
    if (!session || session.controller !== "human") return;
    event.preventDefault();
    const point = displayPoint(event, session);
    void window.keAgentDisplays.act(session.sessionId, {
      type: "scroll",
      ...point,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    });
  }, { passive: false });
  viewport.addEventListener("keydown", (event) => void forwardKey(event));
  window.addEventListener("resize", positionCursor);
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await window.keAgentDisplays.refresh(selectedSessionId);
    if (selectedSessionId && !snapshot.sessions.some((session) => session.sessionId === selectedSessionId)) {
      selectedSessionId = snapshot.sessions[0]?.sessionId ?? null;
      snapshot = await window.keAgentDisplays.refresh(selectedSessionId);
    }
    render();
  } catch (error) {
    liveStatus.textContent = error instanceof Error ? error.message : "Agent Displays could not refresh.";
    liveStatus.dataset.state = "error";
  } finally {
    refreshing = false;
  }
}

function render(): void {
  renderList();
  renderPermissions();
  const session = selectedSession();
  const visible = Boolean(session);
  emptyState.hidden = visible;
  workspace.hidden = !visible;
  if (!session) {
    liveStatus.textContent = "No agent has claimed an isolated display yet.";
    liveStatus.dataset.state = "idle";
    return;
  }

  selectedTitle.textContent = session.label;
  selectedMeta.textContent = `${session.agentId} · ${session.width} × ${session.height}`;
  statePill.textContent = stateLabel(session.state);
  statePill.dataset.state = session.state;
  controllerPill.textContent =
    session.controller === "human"
      ? "YOU HAVE CONTROL"
      : session.controller === "agent"
        ? "AGENT HAS CONTROL"
        : "NO CONTROLLER";
  controllerPill.dataset.controller = session.controller;
  takeControl.textContent = session.controller === "human" ? "Return to agent" : "Take control";
  takeControl.disabled = session.state !== "ready";
  stopButton.disabled = session.state !== "ready";
  viewport.tabIndex = session.controller === "human" ? 0 : -1;
  viewport.dataset.controller = session.controller;
  lastAction.textContent = humanize(session.lastAction);
  sessionTruth.textContent = session.targetOrigin
    ? `${session.targetOrigin} · isolated memory-only browser profile`
    : "Local blank canvas · isolated memory-only browser profile";
  cursor.style.setProperty("--cursor-color", session.cursor.color);
  cursorLabel.textContent = session.controller === "human" ? "William" : session.label.split(" · ")[0] ?? "Agent";

  if (snapshot.frame?.dataUrl && session.state === "ready") {
    frame.src = snapshot.frame.dataUrl;
    frame.hidden = false;
    frame.onload = positionCursor;
  } else {
    frame.removeAttribute("src");
    frame.hidden = true;
  }
  cursor.hidden = !session.cursor.visible || session.state !== "ready";
  positionCursor();
  liveStatus.textContent =
    session.controller === "human"
      ? "Your input is routed only to this canvas. The agent is paused on this surface."
      : session.state === "ready"
        ? "Live isolated surface. The Mac's real cursor and desktop are untouched."
        : session.stopReason ?? `This display is ${session.state}.`;
  liveStatus.dataset.state = session.state === "ready" ? "live" : "idle";
}

function renderList(): void {
  sessionList.replaceChildren();
  for (const session of snapshot.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-card";
    button.dataset.selected = String(session.sessionId === selectedSessionId);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(session.sessionId === selectedSessionId));
    button.innerHTML = `
      <span class="cursor-dot" style="--cursor-color:${escapeAttribute(session.cursor.color)}" aria-hidden="true"></span>
      <span class="session-copy">
        <strong>${escapeHtml(session.label)}</strong>
        <span>${escapeHtml(shortIdentity(session.agentId))}</span>
      </span>
      <span class="session-state" data-state="${session.state}">${stateLabel(session.state)}</span>
    `;
    button.addEventListener("click", () => {
      selectedSessionId = session.sessionId;
      void refresh();
    });
    sessionList.append(button);
  }
}

function renderPermissions(): void {
  const screen = snapshot.permissions.screenRecording;
  const access = snapshot.permissions.accessibility;
  permissionTruth.textContent =
    `Isolated displays need neither permission. Screen Recording: ${screen}. Accessibility: ${access}. ` +
    "Real-desktop control is not implemented.";
}

async function toggleControl(): Promise<void> {
  const session = selectedSession();
  if (!session || session.state !== "ready") return;
  if (session.controller === "human") await window.keAgentDisplays.returnControl(session.sessionId);
  else await window.keAgentDisplays.takeControl(session.sessionId);
  await refresh();
  if (selectedSession()?.controller === "human") viewport.focus();
}

async function stopSelected(): Promise<void> {
  const session = selectedSession();
  if (!session || session.state !== "ready") return;
  if (!window.confirm(`Stop and revoke ${session.label}'s display?`)) return;
  await window.keAgentDisplays.stop(session.sessionId);
  await refresh();
}

async function forwardPointer(
  type: "move" | "click",
  event: MouseEvent | PointerEvent,
  button: "left" | "right" = "left",
): Promise<void> {
  const session = selectedSession();
  if (!session || session.controller !== "human") return;
  const point = displayPoint(event, session);
  await window.keAgentDisplays.act(
    session.sessionId,
    type === "move" ? { type, ...point } : { type, ...point, button },
  );
}

async function forwardKey(event: KeyboardEvent): Promise<void> {
  const session = selectedSession();
  if (!session || session.controller !== "human") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const keys = [
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ] as const;
  event.preventDefault();
  if ((keys as readonly string[]).includes(event.key)) {
    await window.keAgentDisplays.act(session.sessionId, {
      type: "key",
      key: event.key as (typeof keys)[number],
      modifiers: event.shiftKey ? ["shift"] : [],
    });
  } else if (event.key.length === 1) {
    await window.keAgentDisplays.act(session.sessionId, { type: "type", text: event.key });
  }
}

function displayPoint(event: MouseEvent | PointerEvent | WheelEvent, session: AgentDisplaySessionView) {
  const bounds = viewport.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * session.width,
    y: ((event.clientY - bounds.top) / bounds.height) * session.height,
  };
}

function positionCursor(): void {
  const session = selectedSession();
  if (!session || cursor.hidden) return;
  cursor.style.left = `${(session.cursor.x / session.width) * 100}%`;
  cursor.style.top = `${(session.cursor.y / session.height) * 100}%`;
}

function selectedSession(): AgentDisplaySessionView | undefined {
  return snapshot.sessions.find((session) => session.sessionId === selectedSessionId);
}

function shortIdentity(identity: string): string {
  return identity.length <= 24 ? identity : `${identity.slice(0, 12)}…${identity.slice(-8)}`;
}

function stateLabel(state: AgentDisplaySessionView["state"]): string {
  return { ready: "LIVE", interrupted: "INTERRUPTED", stopped: "STOPPED", expired: "EXPIRED" }[state];
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/[^#a-fA-F0-9]/g, "");
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Agent Displays is missing ${id}.`);
  return element as T;
}
