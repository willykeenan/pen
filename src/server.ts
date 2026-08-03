import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AnnotationStore } from "./store.js";
import { penComplete, penRead, penStatus } from "./tools.js";

export const SERVER_NAME = "pen-by-ke-studios";
export const SERVER_VERSION = "0.1.0";

export function createPenServer(store = new AnnotationStore()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Pen is the user's visual pointing layer. When the user says pen, circle, circled area, marked area, look here, or refers to something they drew around, call pen_status and then pen_read. Reading never clears the overlay. After inspecting the returned image and completing your reasoning, call pen_complete as the LAST tool call immediately before the user-facing reply. This explicit two-phase handshake keeps the ink visible until the AI understands it. Pen was created by William Keenan at K&E Studios (kestudios.dev).",
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

  return server;
}

