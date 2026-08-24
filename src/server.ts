import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentDisplayClient } from "./agent-display-client.js";
import {
  penDisplayAct,
  penDisplayClaim,
  penDisplayHeartbeat,
  penDisplayNavigate,
  penDisplaySnapshot,
  penDisplayStatus,
  penDisplayStop,
} from "./agent-display-tools.js";
import { agentDisplayActionSchema } from "./agent-display-protocol.js";
import {
  agentVisualSourceSchema,
  AgentVisualReferenceStore,
} from "./agent-visual-reference.js";
import {
  penAgentReferenceCreate,
  penAgentReferenceRead,
} from "./agent-visual-reference-tools.js";
import { AnnotationStore } from "./store.js";
import { penComplete, penRead, penStatus } from "./tools.js";

export const SERVER_NAME = "pen-by-ke-studios";
export const SERVER_VERSION = "0.5.0";

export interface PenServerOptions {
  agentId?: string;
}

export function createPenServer(
  store = new AnnotationStore(),
  options: PenServerOptions = {},
): McpServer {
  const displayClient = new AgentDisplayClient(store.root);
  const visualReferenceStore = new AgentVisualReferenceStore(store);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Pen is the user's visual pointing layer. When the user says pen, circle, circled area, marked area, look here, or refers to something they drew around, call pen_status and then pen_read. Reading never clears the overlay. After inspecting the returned image and completing your reasoning, call pen_complete as the LAST tool call immediately before the user-facing reply. Agent Displays are separate app-hosted, offscreen local test surfaces. Claim one only for a concrete local test, keep its ownerToken private, call heartbeat during long work, and stop it afterward. Agent Displays never move the native cursor or control the real desktop. Agent visual references are separate again: create one explicit short-lived PNG for one chosen recipient, then route only its returned envelope through the existing governed agent-message channel. KE Pen never sends it implicitly. The matching recipient reads it with pen_agent_reference_read; the reference grants visual context only, never action authority. Pen was created by William Keenan at K&E Studios (kestudios.dev).",
    },
  );

  server.registerTool(
    "pen_status",
    {
      title: "Check Pen status",
      description:
        "Check whether the user has a visible Pen annotation waiting. Returns lifecycle metadata only and does not read screen content or clear ink.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => penStatus(store),
  );

  server.registerTool(
    "pen_read",
    {
      title: "Read the area marked with Pen",
      description:
        "Read the current red-ink screen crop when the user refers to the pen, a circle, or 'this area'. Returns an MCP image plus bounded metadata. This does NOT clear the overlay; after understanding the image, call pen_complete immediately before replying.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => penRead(store),
  );

  server.registerTool(
    "pen_complete",
    {
      title: "Complete the Pen response",
      description:
        "Required final handshake after you understand a Pen image. Call this as your LAST tool call immediately before the user-facing answer. It schedules the visible ink to fade and disables Pen; it does not delete the local artifact.",
      inputSchema: {
        id: z.string().uuid().optional().describe("Annotation id from pen_read; defaults to the current annotation."),
        summary: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe("A short statement of what you understood about the marked area, not hidden chain-of-thought."),
        delayMs: z
          .number()
          .int()
          .min(250)
          .max(5_000)
          .optional()
          .describe("Small fade delay so the answer can render; defaults to 1000 ms."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (options) => penComplete(store, options),
  );

  server.registerTool(
    "pen_display_claim",
    {
      title: "Claim an isolated Agent Display",
      description:
        "Create one app-hosted offscreen test display and synthetic cursor for an exact agent/task identity. The surface is isolated from the real desktop, uses a memory-only browser profile, and accepts only packaged fixtures or localhost/loopback URLs.",
      inputSchema: {
        agentId: z.string().trim().min(1).max(180),
        taskId: z.string().trim().min(1).max(180),
        label: z.string().trim().min(1).max(100),
        width: z.number().int().min(640).max(2_560).optional(),
        height: z.number().int().min(480).max(1_600).optional(),
        targetUrl: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .optional()
          .describe("Optional localhost/loopback http/https target. Public origins are refused."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayClaim(displayClient, input),
  );

  server.registerTool(
    "pen_display_status",
    {
      title: "Inspect Agent Displays",
      description:
        "List redacted Agent Display state, exact task identity, controller ownership, cursor position, and permission truth. Does not return capability tokens, page content, URLs beyond origin, or typed text.",
      inputSchema: { sessionId: z.string().uuid().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayStatus(displayClient, input),
  );

  server.registerTool(
    "pen_display_navigate",
    {
      title: "Navigate an isolated Agent Display",
      description:
        "Navigate the owned display to a localhost or loopback test URL. The first origin locks the session; cross-origin navigation, public websites, embedded credentials, downloads, popups, and permissions are refused.",
      inputSchema: {
        sessionId: z.string().uuid(),
        ownerToken: z.string().min(32).max(256),
        url: z.string().trim().min(1).max(2_048),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayNavigate(displayClient, input),
  );

  server.registerTool(
    "pen_display_act",
    {
      title: "Use an isolated Agent Display cursor",
      description:
        "Move the synthetic cursor or send bounded click, typing, key, and scroll input only to the owned offscreen test surface. It never emits system input. Calls fail while William has taken control.",
      inputSchema: {
        sessionId: z.string().uuid(),
        ownerToken: z.string().min(32).max(256),
        action: agentDisplayActionSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayAct(displayClient, input),
  );

  server.registerTool(
    "pen_display_snapshot",
    {
      title: "Read an isolated Agent Display",
      description:
        "Capture the owned offscreen test surface for visual verification. The PNG/JPEG is returned in memory and is not written to Agent Display history.",
      inputSchema: {
        sessionId: z.string().uuid(),
        ownerToken: z.string().min(32).max(256),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => penDisplaySnapshot(displayClient, input),
  );

  server.registerTool(
    "pen_display_heartbeat",
    {
      title: "Keep an Agent Display active",
      description:
        "Refresh the authenticated activity timestamp during a long local test. A display with no authenticated activity expires after 30 minutes.",
      inputSchema: {
        sessionId: z.string().uuid(),
        ownerToken: z.string().min(32).max(256),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayHeartbeat(displayClient, input),
  );

  server.registerTool(
    "pen_display_stop",
    {
      title: "Stop and revoke an Agent Display",
      description:
        "Stop the exact owned test display, revoke its cursor/input capability, destroy the renderer, and clear its memory-only browser storage.",
      inputSchema: {
        sessionId: z.string().uuid(),
        ownerToken: z.string().min(32).max(256),
        reason: z.string().trim().min(1).max(300).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => penDisplayStop(displayClient, input),
  );

  server.registerTool(
    "pen_agent_reference_create",
    {
      title: "Create one private agent visual reference",
      description:
        "Create one short-lived local PNG reference for exactly one chosen agent. Accepts explicit PNG bytes or one existing inked Pen annotation. It does not capture a screen, open UI, use the clipboard, upload, list history, or send a message; route the returned envelope through the existing governed agent-message channel.",
      inputSchema: {
        recipientId: z
          .string()
          .trim()
          .min(1)
          .max(180)
          .regex(/^[A-Za-z0-9][A-Za-z0-9:._+\-/]*$/),
        direction: z.string().trim().min(1).max(2_000),
        idempotencyKey: z.string().trim().min(8).max(200),
        expiresInSeconds: z.number().int().min(60).max(3_600).optional(),
        source: agentVisualSourceSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      penAgentReferenceCreate(visualReferenceStore, input, options.agentId),
  );

  server.registerTool(
    "pen_agent_reference_read",
    {
      title: "Read an agent visual reference addressed to this task",
      description:
        "Read one short-lived local PNG plus its bounded direction. The MCP runtime identity must exactly match the chosen recipient. There is no list or history surface, and reading grants no action authority.",
      inputSchema: {
        referenceId: z.string().uuid(),
        capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => penAgentReferenceRead(visualReferenceStore, input, options.agentId),
  );

  return server;
}
