import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentDisplayClient, AgentDisplayClientError } from "./agent-display-client.js";
import type { AgentDisplayAction } from "./agent-display-protocol.js";

const claimResultSchema = z.object({
  session: z.object({ sessionId: z.string().uuid() }).passthrough(),
  ownerToken: z.string().min(32).max(256),
  boundary: z.object({
    kind: z.string(),
    nativeMacOSMonitor: z.boolean(),
    nativeSystemCursor: z.boolean(),
    realDesktopInput: z.boolean(),
    explanation: z.string(),
  }),
});
const snapshotResultSchema = z.object({
  session: z.object({ sessionId: z.string().uuid() }).passthrough(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  imageBase64: z.string().min(1),
});

export async function penDisplayClaim(
  client: AgentDisplayClient,
  input: {
    agentId: string;
    taskId: string;
    label: string;
    width?: number | undefined;
    height?: number | undefined;
    targetUrl?: string | undefined;
  },
): Promise<CallToolResult> {
  return safeTool(async () => {
    const result = claimResultSchema.parse(
      await client.request({
        method: "claim",
        params: {
          agentId: input.agentId,
          taskId: input.taskId,
          label: input.label,
          width: input.width ?? 1_440,
          height: input.height ?? 900,
          ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
        },
      }),
    );
    return textResult({
      ok: true,
      ...result,
      tokenHandling:
        "ownerToken is a session capability. Reuse it only for this display, do not quote it to the user, and stop the display when testing ends.",
    });
  });
}

export async function penDisplayStatus(
  client: AgentDisplayClient,
  input: { sessionId?: string | undefined },
): Promise<CallToolResult> {
  return safeTool(async () =>
    textResult(
      await client.request({
        method: "status",
        params: input.sessionId ? { sessionId: input.sessionId } : {},
      }),
    ),
  );
}

export async function penDisplayNavigate(
  client: AgentDisplayClient,
  input: { sessionId: string; ownerToken: string; url: string },
): Promise<CallToolResult> {
  return safeTool(async () =>
    textResult(
      await client.request({
        method: "navigate",
        params: input,
      }),
    ),
  );
}

export async function penDisplayAct(
  client: AgentDisplayClient,
  input: { sessionId: string; ownerToken: string; action: AgentDisplayAction },
): Promise<CallToolResult> {
  return safeTool(async () =>
    textResult(
      await client.request({
        method: "act",
        params: input,
      }),
    ),
  );
}

export async function penDisplaySnapshot(
  client: AgentDisplayClient,
  input: { sessionId: string; ownerToken: string },
): Promise<CallToolResult> {
  return safeTool(async () => {
    const result = snapshotResultSchema.parse(
      await client.request({ method: "snapshot", params: input }),
    );
    const image = Buffer.from(result.imageBase64, "base64");
    if (image.byteLength === 0 || image.byteLength > 16 * 1024 * 1024) {
      throw new AgentDisplayClientError(
        "SNAPSHOT_TOO_LARGE",
        "The isolated display snapshot was empty or exceeded 16 MB.",
      );
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              session: result.session,
              boundary:
                "App-hosted isolated test surface. The screenshot contains no native system cursor and proves no control of the real desktop.",
            },
            null,
            2,
          ),
        },
        { type: "image", data: image.toString("base64"), mimeType: result.mimeType },
      ],
    };
  });
}

export async function penDisplayHeartbeat(
  client: AgentDisplayClient,
  input: { sessionId: string; ownerToken: string },
): Promise<CallToolResult> {
  return safeTool(async () =>
    textResult(await client.request({ method: "heartbeat", params: input })),
  );
}

export async function penDisplayStop(
  client: AgentDisplayClient,
  input: { sessionId: string; ownerToken: string; reason?: string | undefined },
): Promise<CallToolResult> {
  return safeTool(async () =>
    textResult(
      await client.request({
        method: "stop",
        params: {
          sessionId: input.sessionId,
          ownerToken: input.ownerToken,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      }),
    ),
  );
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function safeTool(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              code:
                error instanceof AgentDisplayClientError
                  ? error.code
                  : "AGENT_DISPLAY_TOOL_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "KE Pen could not complete the agent display request.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}
