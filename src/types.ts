import { z } from "zod";

const penPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  t: z.number().finite(),
});

const penRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export const annotationRecordSchema = z
  .object({
    schema: z.literal("dev.kestudios.pen.annotation.v1"),
    id: z.string().uuid(),
    status: z.enum(["pending", "reading", "completing", "complete", "cancelled"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    readAt: z.string().datetime({ offset: true }).optional(),
    clearAfter: z.string().datetime({ offset: true }).optional(),
    completionSummary: z.string().max(2_000).optional(),
    cancelReason: z.string().max(2_000).optional(),
    source: z.object({
      appName: z.string().max(300).optional(),
      bundleIdentifier: z.string().max(500).optional(),
      displayID: z.number().int().nonnegative(),
      screenFramePoints: penRectSchema,
    }),
    selection: z.object({
      strokeBoundsPoints: penRectSchema,
      cropRectPixels: penRectSchema,
      normalizedStrokes: z.array(z.array(penPointSchema).max(100_000)).max(1_000),
      coordinateNote: z.string().max(1_000),
    }),
    image: z.object({
      file: z.string().min(1).max(200),
      mimeType: z.literal("image/png"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      includesInk: z.boolean(),
    }),
    credit: z.object({
      creator: z.literal("William Keenan"),
      studio: z.literal("K&E Studios"),
      url: z.string().url(),
      product: z.literal("Pen"),
    }),
  })
  .passthrough();

export const currentPointerSchema = z.object({
  schema: z.literal("dev.kestudios.pen.current.v1"),
  id: z.string().uuid(),
});

export type AnnotationRecord = z.infer<typeof annotationRecordSchema>;
export type AnnotationStatus = AnnotationRecord["status"];

export interface PenContext {
  record: AnnotationRecord;
  image: Buffer;
}

export interface PenStatusView {
  available: boolean;
  annotation?: {
    id: string;
    status: AnnotationStatus;
    createdAt: string;
    updatedAt: string;
    sourceApp?: string;
    image: {
      width: number;
      height: number;
      includesInk: boolean;
    };
  };
  product: "Pen by KE Studios";
  creator: "William Keenan";
  site: "https://kestudios.dev";
}

