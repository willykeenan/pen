import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  AgentDisplayAction,
  AgentDisplayController,
  AgentDisplaySessionView,
  AgentDisplayState,
} from "../src/agent-display-protocol.js";

const palette = ["#ff6b4a", "#66d9ff", "#9b8cff", "#74d99f", "#ffd166", "#ff7eb6"];
const storedSessionSchema = z.object({
  sessionId: z.string().uuid(),
  agentId: z.string().min(1).max(180),
  taskId: z.string().min(1).max(180),
  label: z.string().min(1).max(100),
  width: z.number().int().min(640).max(2_560),
  height: z.number().int().min(480).max(1_600),
  state: z.enum(["ready", "interrupted", "stopped", "expired"]),
  controller: z.enum(["agent", "human", "none"]),
  targetOrigin: z.string().url().nullable(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    visible: z.boolean(),
    color: z.string().regex(/^#[a-f0-9]{6}$/i),
    updatedAt: z.string().datetime({ offset: true }),
  }),
  lastAction: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  stoppedAt: z.string().datetime({ offset: true }).optional(),
  stopReason: z.string().max(300).optional(),
});
const registryFileSchema = z.object({
  schema: z.literal("dev.kestudios.pen.agent-display.sessions.v1"),
  updatedAt: z.string().datetime({ offset: true }),
  sessions: z.array(storedSessionSchema).max(500),
});

type StoredSession = z.infer<typeof storedSessionSchema>;

export class AgentDisplayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentDisplayError";
    this.code = code;
  }
}

export class AgentDisplayRegistry {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly stateFile: string;
  private readonly now: () => Date;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(stateFile: string, now: () => Date = () => new Date()) {
    this.stateFile = stateFile;
    this.now = now;
  }

  async loadAndInterrupt(): Promise<void> {
    try {
      const parsed = registryFileSchema.parse(JSON.parse(await readFile(this.stateFile, "utf8")));
      for (const record of parsed.sessions) {
        const session = { ...record };
        if (session.state === "ready") {
          session.state = "interrupted";
          session.controller = "none";
          session.lastAction = "app_restarted";
          session.lastSeenAt = this.isoNow();
          session.stopReason = "KE Pen restarted; no hidden test browser was restored.";
        }
        this.sessions.set(session.sessionId, session);
      }
      await this.persist();
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.persist();
    }
  }

  async claim(input: {
    agentId: string;
    taskId: string;
    label: string;
    width: number;
    height: number;
  }): Promise<{ session: AgentDisplaySessionView; ownerToken: string }> {
    const existing = [...this.sessions.values()].find(
      (session) =>
        session.agentId === input.agentId &&
        session.taskId === input.taskId &&
        (session.state === "ready" || session.state === "interrupted"),
    );
    if (existing?.state === "ready") {
      throw new AgentDisplayError(
        "DISPLAY_ALREADY_CLAIMED",
        "This exact agent and task already owns an active display. Stop it or use its existing token.",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const now = this.isoNow();
    const sessionId = existing?.sessionId ?? randomUUID();
    const record: StoredSession = {
      sessionId,
      agentId: input.agentId,
      taskId: input.taskId,
      label: input.label,
      width: input.width,
      height: input.height,
      state: "ready",
      controller: "agent",
      targetOrigin: null,
      tokenHash: hashToken(token),
      cursor: {
        x: input.width / 2,
        y: input.height / 2,
        visible: true,
        color: colorFor(`${input.agentId}:${input.taskId}`),
        updatedAt: now,
      },
      lastAction: existing ? "recovered" : "claimed",
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    };
    this.sessions.set(sessionId, record);
    await this.persist();
    return { session: publicSession(record), ownerToken: token };
  }

  list(sessionId?: string): AgentDisplaySessionView[] {
    return [...this.sessions.values()]
      .filter((session) => !sessionId || session.sessionId === sessionId)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map(publicSession);
  }

  requireAgent(sessionId: string, token: string): StoredSession {
    const session = this.requireSession(sessionId);
    if (!safeTokenEqual(session.tokenHash, token)) {
      throw new AgentDisplayError("INVALID_DISPLAY_TOKEN", "The display capability token is invalid.");
    }
    if (session.state !== "ready") {
      throw new AgentDisplayError("DISPLAY_NOT_ACTIVE", `This display is ${session.state}.`);
    }
    if (session.controller !== "agent") {
      throw new AgentDisplayError(
        "HUMAN_HAS_CONTROL",
        "William currently controls this display. Wait until he returns control to the agent.",
      );
    }
    return session;
  }

  async recordAction(sessionId: string, token: string, action: AgentDisplayAction): Promise<AgentDisplaySessionView> {
    const session = this.requireAgent(sessionId, token);
    const now = this.isoNow();
    if ("x" in action && "y" in action) {
      session.cursor = {
        ...session.cursor,
        x: clamp(action.x, 0, session.width - 1),
        y: clamp(action.y, 0, session.height - 1),
        visible: true,
        updatedAt: now,
      };
    }
    session.lastAction = safeActionName(action.type);
    session.lastSeenAt = now;
    await this.persist();
    return publicSession(session);
  }

  async heartbeat(sessionId: string, token: string): Promise<AgentDisplaySessionView> {
    const session = this.requireAgent(sessionId, token);
    session.lastSeenAt = this.isoNow();
    session.lastAction = "heartbeat";
    await this.persist();
    return publicSession(session);
  }

  async setTargetOrigin(sessionId: string, token: string, origin: string): Promise<AgentDisplaySessionView> {
    const session = this.requireAgent(sessionId, token);
    if (session.targetOrigin && session.targetOrigin !== origin) {
      throw new AgentDisplayError(
        "CROSS_ORIGIN_NAVIGATION_REFUSED",
        `This display is isolated to ${session.targetOrigin}. Stop it and claim a new display for another origin.`,
      );
    }
    session.targetOrigin = origin;
    session.lastAction = "navigated";
    session.lastSeenAt = this.isoNow();
    await this.persist();
    return publicSession(session);
  }

  async takeHumanControl(sessionId: string): Promise<AgentDisplaySessionView> {
    const session = this.requireReady(sessionId);
    session.controller = "human";
    session.lastAction = "human_took_control";
    session.lastSeenAt = this.isoNow();
    await this.persist();
    return publicSession(session);
  }

  async returnAgentControl(sessionId: string): Promise<AgentDisplaySessionView> {
    const session = this.requireReady(sessionId);
    session.controller = "agent";
    session.lastAction = "human_returned_control";
    session.lastSeenAt = this.isoNow();
    await this.persist();
    return publicSession(session);
  }

  async recordHumanAction(sessionId: string, action: AgentDisplayAction): Promise<AgentDisplaySessionView> {
    const session = this.requireReady(sessionId);
    if (session.controller !== "human") {
      throw new AgentDisplayError(
        "HUMAN_DOES_NOT_HAVE_CONTROL",
        "Take control of this display before sending human input.",
      );
    }
    const now = this.isoNow();
    if ("x" in action && "y" in action) {
      session.cursor = {
        ...session.cursor,
        x: clamp(action.x, 0, session.width - 1),
        y: clamp(action.y, 0, session.height - 1),
        visible: true,
        updatedAt: now,
      };
    }
    session.lastAction = `human_${safeActionName(action.type)}`;
    session.lastSeenAt = now;
    await this.persist();
    return publicSession(session);
  }

  async interrupt(sessionId: string, reason: string): Promise<AgentDisplaySessionView> {
    const session = this.requireSession(sessionId);
    if (session.state !== "ready") return publicSession(session);
    session.state = "interrupted";
    session.controller = "none";
    session.cursor.visible = false;
    session.lastAction = "surface_interrupted";
    session.lastSeenAt = this.isoNow();
    session.stopReason = reason.slice(0, 300);
    await this.persist();
    return publicSession(session);
  }

  async stop(
    sessionId: string,
    options: { token?: string; reason: string },
  ): Promise<AgentDisplaySessionView> {
    const session = this.requireSession(sessionId);
    if (options.token && !safeTokenEqual(session.tokenHash, options.token)) {
      throw new AgentDisplayError("INVALID_DISPLAY_TOKEN", "The display capability token is invalid.");
    }
    session.state = "stopped";
    session.controller = "none";
    session.cursor.visible = false;
    session.lastAction = "stopped";
    session.lastSeenAt = this.isoNow();
    session.stoppedAt = session.lastSeenAt;
    session.stopReason = options.reason.slice(0, 300);
    await this.persist();
    return publicSession(session);
  }

  async cleanupStale(idleMs = 30 * 60_000, retentionMs = 24 * 60 * 60_000): Promise<string[]> {
    const now = this.now().getTime();
    const expired: string[] = [];
    for (const session of this.sessions.values()) {
      const lastSeen = new Date(session.lastSeenAt).getTime();
      if (session.state === "ready" && now - lastSeen > idleMs) {
        session.state = "expired";
        session.controller = "none";
        session.cursor.visible = false;
        session.lastAction = "stale_session_expired";
        session.stoppedAt = this.isoNow();
        session.stopReason = "No authenticated display activity arrived before the stale-session limit.";
        expired.push(session.sessionId);
      }
      if (
        (session.state === "stopped" || session.state === "expired") &&
        session.stoppedAt &&
        now - new Date(session.stoppedAt).getTime() > retentionMs
      ) {
        this.sessions.delete(session.sessionId);
      }
    }
    await this.persist();
    return expired;
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AgentDisplayError("DISPLAY_NOT_FOUND", "That agent display does not exist.");
    return session;
  }

  private requireReady(sessionId: string): StoredSession {
    const session = this.requireSession(sessionId);
    if (session.state !== "ready") {
      throw new AgentDisplayError("DISPLAY_NOT_ACTIVE", `This display is ${session.state}.`);
    }
    return session;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private persist(): Promise<void> {
    const write = async () => {
      const payload = registryFileSchema.parse({
        schema: "dev.kestudios.pen.agent-display.sessions.v1",
        updatedAt: this.isoNow(),
        sessions: [...this.sessions.values()],
      });
      const directory = dirname(this.stateFile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(directory, 0o700);
      const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
      if (process.platform !== "win32") await chmod(this.stateFile, 0o600);
    };
    const result = this.persistQueue.then(write, write);
    this.persistQueue = result.catch(() => undefined);
    return result;
  }
}

function publicSession(session: StoredSession): AgentDisplaySessionView {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    taskId: session.taskId,
    label: session.label,
    width: session.width,
    height: session.height,
    state: session.state,
    controller: session.controller,
    targetOrigin: session.targetOrigin,
    cursor: { ...session.cursor },
    lastAction: session.lastAction,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
    ...(session.stopReason ? { stopReason: session.stopReason } : {}),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeTokenEqual(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const observed = Buffer.from(hashToken(token), "hex");
  return expected.length === observed.length && timingSafeEqual(expected, observed);
}

function colorFor(identity: string): string {
  const value = Number.parseInt(createHash("sha256").update(identity).digest("hex").slice(0, 8), 16);
  return palette[value % palette.length] ?? palette[0]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function safeActionName(type: AgentDisplayAction["type"]): string {
  return {
    move: "moved_cursor",
    click: "clicked",
    type: "typed_redacted_text",
    key: "pressed_key",
    scroll: "scrolled",
  }[type];
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}
