import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_VISUAL_ROUTE_SCHEMA,
  type AgentVisualCreateInput,
  type AgentVisualReadInput,
  AgentVisualReferenceStore,
  resolveAgentIdentity,
} from "./agent-visual-reference.js";

export async function penAgentReferenceCreate(
  store: AgentVisualReferenceStore,
  input: AgentVisualCreateInput,
  explicitAgentId?: string,
): Promise<CallToolResult> {
  const senderId = resolveAgentIdentity(explicitAgentId);
  const created = await store.create(input, senderId);
  const { record } = created;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            sent: false,
            deduplicated: created.deduplicated,
            referenceId: record.referenceId,
            recipientId: record.recipientId,
            imageSha256: record.image.sha256,
            expiresAt: record.expiresAt,
            routingEnvelope: {
              schema: AGENT_VISUAL_ROUTE_SCHEMA,
              referenceId: record.referenceId,
              capability: created.capability,
              recipientId: record.recipientId,
              readTool: "pen_agent_reference_read",
              expiresAt: record.expiresAt,
            },
            instruction:
              "KE Pen created one private local reference but did not send it. Use the existing governed agent-message channel exactly once to send only routingEnvelope to recipientId. That message grants no authority beyond reading this reference.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function penAgentReferenceRead(
  store: AgentVisualReferenceStore,
  input: AgentVisualReadInput,
  explicitAgentId?: string,
): Promise<CallToolResult> {
  const recipientId = resolveAgentIdentity(explicitAgentId);
  const delivered = await store.read(input, recipientId);
  const { record } = delivered;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            referenceId: record.referenceId,
            senderId: record.senderId,
            recipientId: record.recipientId,
            direction: record.direction,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            deliveredAt: record.deliveredAt,
            image: {
              mimeType: record.image.mimeType,
              width: record.image.width,
              height: record.image.height,
              sha256: record.image.sha256,
              includesInk: record.image.includesInk,
              ...(record.region ? { region: record.region } : {}),
            },
            deliveryReceipt: delivered.deliveryReceipt,
            authority:
              "Visual context and direction only. This reference grants no authority to edit, send, deploy, spend, capture, or control a desktop.",
          },
          null,
          2,
        ),
      },
      {
        type: "image",
        data: delivered.image.toString("base64"),
        mimeType: "image/png",
      },
    ],
  };
}
