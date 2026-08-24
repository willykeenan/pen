import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const AGENT_DISPLAY_PROTOCOL = "dev.kestudios.pen.agent-display.v1" as const;
export const AGENT_DISPLAY_RESPONSE_PROTOCOL =
  "dev.kestudios.pen.agent-display.response.v1" as const;

const identity = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._+\-/]*$/, "Use a stable task or agent identifier.");
const sessionCredentials = {
  sessionId: z.string().uuid(),
  ownerToken: z.string().min(32).max(256),
};

export const agentDisplayActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    type: z.literal("click"),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    type: z.literal("type"),
    text: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("key"),
    key: z.enum([
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
    ]),
    modifiers: z.array(z.enum(["shift", "control", "alt", "meta"])).max(4).default([]),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().finite().min(-2_000).max(2_000),
    deltaY: z.number().finite().min(-2_000).max(2_000),
  }),
]);

export const agentDisplayBrokerRequestSchema = z.discriminatedUnion("method", [
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("claim"),
    params: z.object({
      agentId: identity,
      taskId: identity,
      label: z.string().trim().min(1).max(100),
      width: z.number().int().min(640).max(2_560).default(1_440),
      height: z.number().int().min(480).max(1_600).default(900),
      targetUrl: z.string().trim().min(1).max(2_048).optional(),
    }),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("status"),
    params: z.object({ sessionId: z.string().uuid().optional() }),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("navigate"),
    params: z.object({ ...sessionCredentials, url: z.string().trim().min(1).max(2_048) }),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("act"),
    params: z.object({ ...sessionCredentials, action: agentDisplayActionSchema }),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("snapshot"),
    params: z.object(sessionCredentials),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("heartbeat"),
    params: z.object(sessionCredentials),
  }),
  z.object({
    schema: z.literal(AGENT_DISPLAY_PROTOCOL),
    requestId: z.string().uuid(),
    brokerSecret: z.string().min(32).max(256),
    method: z.literal("stop"),
    params: z.object({
      ...sessionCredentials,
      reason: z.string().trim().min(1).max(300).optional(),
    }),
  }),
]);

export const agentDisplayBrokerResponseSchema = z.object({
  schema: z.literal(AGENT_DISPLAY_RESPONSE_PROTOCOL),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(1_000),
    })
    .optional(),
});

export type AgentDisplayAction = z.infer<typeof agentDisplayActionSchema>;
export type AgentDisplayBrokerRequest = z.infer<typeof agentDisplayBrokerRequestSchema>;
export type AgentDisplayBrokerResponse = z.infer<typeof agentDisplayBrokerResponseSchema>;
export type AgentDisplayState = "ready" | "interrupted" | "stopped" | "expired";
export type AgentDisplayController = "agent" | "human" | "none";

export interface AgentDisplayCursorView {
  x: number;
  y: number;
  visible: boolean;
  color: string;
  updatedAt: string;
}

export interface AgentDisplaySessionView {
  sessionId: string;
  agentId: string;
  taskId: string;
  label: string;
  width: number;
  height: number;
  state: AgentDisplayState;
  controller: AgentDisplayController;
  targetOrigin: string | null;
  cursor: AgentDisplayCursorView;
  lastAction: string;
  createdAt: string;
  lastSeenAt: string;
  stoppedAt?: string;
  stopReason?: string;
}

export interface AgentDisplayPermissionTruth {
  screenRecording: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
  accessibility: "granted" | "not-granted" | "not-applicable" | "unknown";
  isolatedDisplayNeedsScreenRecording: false;
  isolatedDisplayNeedsAccessibility: false;
  realDesktopControl: "not-implemented";
}

export interface AgentDisplayRuntimePaths {
  directory: string;
  authFile: string;
  stateFile: string;
  socket: string;
}

export function agentDisplayRuntimePaths(
  penHome: string,
  platform: NodeJS.Platform = process.platform,
): AgentDisplayRuntimePaths {
  const directory = join(penHome, "agent-displays");
  const homeHash = createHash("sha256").update(penHome).digest("hex").slice(0, 16);
  const socket =
    platform === "win32"
      ? `\\\\.\\pipe\\ke-pen-agent-displays-${homeHash}`
      : join(tmpdir(), `ke-pen-agent-displays-${homeHash}.sock`);
  return {
    directory,
    authFile: join(directory, "broker-auth.json"),
    stateFile: join(directory, "sessions.json"),
    socket,
  };
}

export function normalizeAgentDisplayTarget(input: string): { url: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Agent displays accept an absolute localhost or loopback http/https URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Agent displays refuse credentials embedded in a URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!loopback || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "Agent displays are local test surfaces. They allow http/https only on localhost or loopback.",
    );
  }
  parsed.hash = "";
  return { url: parsed.toString(), origin: parsed.origin };
}

/**
 * Keep every renderer request inside either KE Pen's packaged fixture directory
 * or the one loopback origin locked to the session. This applies to
 * subresources and WebSockets as well as top-level navigation, so a localhost
 * test page cannot quietly load or send data to a public origin.
 */
export function agentDisplayResourceAllowed(
  rawUrl: string,
  packagedFixturePrefix: string,
  targetOrigin: string | null,
): boolean {
  if (rawUrl === "about:blank" || rawUrl.startsWith(packagedFixturePrefix)) return true;
  if (rawUrl.startsWith("data:")) return true;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!targetOrigin) return false;
  if (parsed.protocol === "blob:") {
    try {
      return new URL(parsed.pathname).origin === targetOrigin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    const networkProtocol = parsed.protocol === "ws:" ? "http:" : "https:";
    return `${networkProtocol}//${parsed.host}` === targetOrigin;
  }
  return parsed.origin === targetOrigin;
}
