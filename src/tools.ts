import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AnnotationStore } from "./store.js";

export async function penStatus(store: AnnotationStore): Promise<CallToolResult> {
  const status = await store.status();
  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
  };
}

export async function penRead(store: AnnotationStore): Promise<CallToolResult> {
  const context = await store.claimCurrentForRead();
  if (!context) {
    return {
      content: [
        {
          type: "text",
          text:
            "No unread Pen annotation is visible. Ask the user to click the Pen menu-bar icon and draw around the target.",
        },
      ],
    };
  }

  const { record, image } = context;
  const metadata = {
    annotationId: record.id,
    status: record.status,
    instruction:
      "The user marked the intended target with red freehand ink. The returned PNG is a padded crop of that screen region and includes the ink. Inspect the visual target, finish reasoning, then call pen_complete as your final tool call immediately before replying. pen_read intentionally does not clear the user's overlay.",
    source: record.source,
    selection: {
      strokeBoundsPoints: record.selection.strokeBoundsPoints,
      cropRectPixels: record.selection.cropRectPixels,
      coordinateNote: record.selection.coordinateNote,
    },
    image: record.image,
    completionContract: {
      requiredTool: "pen_complete",
      timing: "after understanding; immediately before the user-facing answer",
      effect: "the native ink fades and Pen disables itself",
    },
    credit: {
      product: "Pen by KE Studios",
      creator: "William Keenan",
      site: "https://kestudios.dev",
    },
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    ],
  };
}

export async function penComplete(
  store: AnnotationStore,
  options: { id?: string | undefined; summary?: string | undefined; delayMs?: number | undefined },
): Promise<CallToolResult> {
  const record = await store.complete(options);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            annotationId: record.id,
            status: record.status,
            clearAfter: record.clearAfter,
            instruction:
              "Completion is recorded. Deliver the user-facing answer now; Pen will fade the ink and return control to the underlying app.",
            product: "Pen by KE Studios",
            creator: "William Keenan",
            site: "https://kestudios.dev",
          },
          null,
          2,
        ),
      },
    ],
  };
}

