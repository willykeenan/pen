import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { AnnotationStore } from "./store.js";

export const AGENT_VISUAL_REFERENCE_SCHEMA =
  "dev.kestudios.pen.agent-visual-reference.v1" as const;
export const AGENT_VISUAL_ROUTE_SCHEMA =
  "dev.kestudios.pen.agent-visual-reference.route.v1" as const;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8_192;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_ACTIVE_REFERENCES = 128;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const agentIdentitySchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._+\-/]*$/, "Use a stable task or agent identifier.");

const pixelRegionSchema = z
  .object({
    x: z.number().int().nonnegative().max(MAX_IMAGE_EDGE),
    y: z.number().int().nonnegative().max(MAX_IMAGE_EDGE),
    width: z.number().int().positive().max(MAX_IMAGE_EDGE),
    height: z.number().int().positive().max(MAX_IMAGE_EDGE),
  })
  .strict();

export const agentVisualSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("png-data-url"),
      dataUrl: z.string().min(1).max(12_000_000),
      includesInk: z.boolean().optional(),
      region: pixelRegionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pen-annotation"),
      annotationId: z.string().uuid(),
    })
    .strict(),
]);

export const agentVisualCreateInputSchema = z
  .object({
    recipientId: agentIdentitySchema,
    direction: z.string().trim().min(1).max(2_000),
    idempotencyKey: z.string().trim().min(8).max(200),
    expiresInSeconds: z.number().int().min(60).max(3_600).optional(),
    source: agentVisualSourceSchema,
  })
  .strict();

export const agentVisualReadInputSchema = z
  .object({
    referenceId: z.string().uuid(),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const agentVisualReferenceRecordSchema = z
  .object({
    schema: z.literal(AGENT_VISUAL_REFERENCE_SCHEMA),
    referenceId: z.string().uuid(),
    senderId: agentIdentitySchema,
    recipientId: agentIdentitySchema,
    direction: z.string().trim().min(1).max(2_000),
    idempotencyHash: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.string().regex(/^[a-f0-9]{32}$/),
    capabilitySha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    deliveredAt: z.string().datetime({ offset: true }).optional(),
    sourceKind: z.enum(["png-data-url", "pen-annotation"]),
    region: pixelRegionSchema.optional(),
    image: z
      .object({
        file: z.literal("reference.png"),
        mimeType: z.literal("image/png"),
        width: z.number().int().positive().max(MAX_IMAGE_EDGE),
        height: z.number().int().positive().max(MAX_IMAGE_EDGE),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        includesInk: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AgentVisualCreateInput = z.infer<typeof agentVisualCreateInputSchema>;
export type AgentVisualReadInput = z.infer<typeof agentVisualReadInputSchema>;
export type AgentVisualReferenceRecord = z.infer<typeof agentVisualReferenceRecordSchema>;

export interface AgentVisualReferenceCreated {
  record: AgentVisualReferenceRecord;
  capability: string;
  deduplicated: boolean;
}

export interface AgentVisualReferenceRead {
  record: AgentVisualReferenceRecord;
  image: Buffer;
  deliveryReceipt: string;
}

export class AgentVisualReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentVisualReferenceError";
  }
}

interface ResolvedImage {
  bytes: Buffer;
  width: number;
  height: number;
  includesInk: boolean;
  sourceKind: AgentVisualReferenceRecord["sourceKind"];
  region?: z.infer<typeof pixelRegionSchema>;
}

export class AgentVisualReferenceStore {
  readonly root: string;
  readonly referencesRoot: string;
  readonly secretPath: string;

  constructor(
    readonly annotationStore: AnnotationStore,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.root = resolve(annotationStore.root, "agent-visual-references");
    this.referencesRoot = join(this.root, "references");
    this.secretPath = join(this.root, "capability-secret.bin");
  }

  async create(
    rawInput: AgentVisualCreateInput,
    rawSenderId: string,
  ): Promise<AgentVisualReferenceCreated> {
    const input = agentVisualCreateInputSchema.parse(rawInput);
    const senderId = agentIdentitySchema.parse(rawSenderId);
    if (input.recipientId === senderId) {
      throw new AgentVisualReferenceError(
        "An agent visual reference must name one different recipient agent.",
      );
    }

    const now = this.clock();
    await this.ensurePrivateRoots();
    await this.pruneExpired(now);
    const resolved = await this.resolveImage(input.source);
    const imageSha256 = sha256(resolved.bytes);
    const idempotencyHash = sha256(
      Buffer.from(`${senderId}\u0000${input.recipientId}\u0000${input.idempotencyKey}`),
    );
    const referenceId = uuidFromDigest(idempotencyHash);
    const directory = this.referenceDirectory(referenceId);

    const existing = await this.readRecordIfPresent(referenceId);
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      this.assertIdempotentMatch(existing, {
        input,
        senderId,
        idempotencyHash,
        imageSha256,
        resolved,
      });
      return {
        record: existing,
        capability: await this.deriveCapability(existing),
        deduplicated: true,
      };
    }
    if (existing) await rm(directory, { recursive: true, force: true });

    const activeCount = await this.activeReferenceCount(now);
    if (activeCount >= MAX_ACTIVE_REFERENCES) {
      throw new AgentVisualReferenceError(
        "KE Pen reached its bounded active-reference limit. Wait for an existing reference to expire.",
      );
    }

    const generation = randomBytes(16).toString("hex");
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + (input.expiresInSeconds ?? 900) * 1_000,
    ).toISOString();
    const baseRecord = {
      schema: AGENT_VISUAL_REFERENCE_SCHEMA,
      referenceId,
      senderId,
      recipientId: input.recipientId,
      direction: input.direction,
      idempotencyHash,
      generation,
      capabilitySha256: "0".repeat(64),
      createdAt,
      expiresAt,
      sourceKind: resolved.sourceKind,
      ...(resolved.region ? { region: resolved.region } : {}),
      image: {
        file: "reference.png" as const,
        mimeType: "image/png" as const,
        width: resolved.width,
        height: resolved.height,
        sha256: imageSha256,
        includesInk: resolved.includesInk,
      },
    };
    const capability = await this.deriveCapability(baseRecord);
    const record = agentVisualReferenceRecordSchema.parse({
      ...baseRecord,
      capabilitySha256: sha256(Buffer.from(capability)),
    });

    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const raced = await this.readRecord(referenceId);
      this.assertIdempotentMatch(raced, {
        input,
        senderId,
        idempotencyHash,
        imageSha256,
        resolved,
      });
      return {
        record: raced,
        capability: await this.deriveCapability(raced),
        deduplicated: true,
      };
    }

    try {
      await this.atomicWrite(join(directory, record.image.file), resolved.bytes);
      await this.writeRecord(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { record, capability, deduplicated: false };
  }

  async read(
    rawInput: AgentVisualReadInput,
    rawRecipientId: string,
  ): Promise<AgentVisualReferenceRead> {
    const input = agentVisualReadInputSchema.parse(rawInput);
    const recipientId = agentIdentitySchema.parse(rawRecipientId);
    const record = await this.readRecord(input.referenceId);
    const now = this.clock();
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      await rm(this.referenceDirectory(record.referenceId), { recursive: true, force: true });
      throw new AgentVisualReferenceError("This agent visual reference expired and was removed.");
    }

    const capabilitySha256 = sha256(Buffer.from(input.capability));
    if (
      record.recipientId !== recipientId ||
      !constantTimeHexEqual(capabilitySha256, record.capabilitySha256)
    ) {
      throw new AgentVisualReferenceError(
        "This visual reference is not addressed and authorized for the current agent.",
      );
    }

    const path = join(this.referenceDirectory(record.referenceId), record.image.file);
    const imageStat = await stat(path);
    if (!imageStat.isFile() || imageStat.size <= 0 || imageStat.size > MAX_IMAGE_BYTES) {
      throw new AgentVisualReferenceError("The visual reference image is missing or out of bounds.");
    }
    const image = await readFile(path);
    const parsed = parsePng(image);
    if (
      sha256(image) !== record.image.sha256 ||
      parsed.width !== record.image.width ||
      parsed.height !== record.image.height
    ) {
      throw new AgentVisualReferenceError("The visual reference failed its integrity check.");
    }

    const deliveredRecord = record.deliveredAt
      ? record
      : agentVisualReferenceRecordSchema.parse({
          ...record,
          deliveredAt: now.toISOString(),
        });
    if (!record.deliveredAt) await this.writeRecord(deliveredRecord);
    return {
      record: deliveredRecord,
      image,
      deliveryReceipt: sha256(
        Buffer.from(
          `${record.referenceId}\u0000${record.senderId}\u0000${record.recipientId}\u0000${record.image.sha256}`,
        ),
      ),
    };
  }

  async readRecord(referenceId: string): Promise<AgentVisualReferenceRecord> {
    const path = join(this.referenceDirectory(referenceId), "reference.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isNotFound(error)) {
        throw new AgentVisualReferenceError("Agent visual reference not found.");
      }
      throw error;
    }
    return agentVisualReferenceRecordSchema.parse(raw);
  }

  private async readRecordIfPresent(
    referenceId: string,
  ): Promise<AgentVisualReferenceRecord | null> {
    try {
      return await this.readRecord(referenceId);
    } catch (error) {
      if (error instanceof AgentVisualReferenceError && error.message.endsWith("not found.")) {
        return null;
      }
      throw error;
    }
  }

  private async resolveImage(
    source: AgentVisualCreateInput["source"],
  ): Promise<ResolvedImage> {
    if (source.kind === "pen-annotation") {
      const context = await this.annotationStore.context(source.annotationId);
      if (context.image.byteLength <= 0 || context.image.byteLength > MAX_IMAGE_BYTES) {
        throw new AgentVisualReferenceError(
          "The marked-region reference is empty or exceeds the 8 MB limit.",
        );
      }
      if (!context.record.image.includesInk) {
        throw new AgentVisualReferenceError(
          "A marked-region reference must use a Pen annotation that includes ink.",
        );
      }
      const parsed = parsePng(context.image);
      return {
        bytes: context.image,
        width: parsed.width,
        height: parsed.height,
        includesInk: true,
        sourceKind: source.kind,
      };
    }

    const image = decodePngDataUrl(source.dataUrl);
    const parsed = parsePng(image);
    if (source.region) assertRegionInsideImage(source.region, parsed.width, parsed.height);
    return {
      bytes: image,
      width: parsed.width,
      height: parsed.height,
      includesInk: source.includesInk ?? false,
      sourceKind: source.kind,
      ...(source.region ? { region: source.region } : {}),
    };
  }

  private assertIdempotentMatch(
    record: AgentVisualReferenceRecord,
    expected: {
      input: AgentVisualCreateInput;
      senderId: string;
      idempotencyHash: string;
      imageSha256: string;
      resolved: ResolvedImage;
    },
  ): void {
    const sameRegion = JSON.stringify(record.region ?? null) === JSON.stringify(expected.resolved.region ?? null);
    const same =
      record.senderId === expected.senderId &&
      record.recipientId === expected.input.recipientId &&
      record.direction === expected.input.direction &&
      record.idempotencyHash === expected.idempotencyHash &&
      record.image.sha256 === expected.imageSha256 &&
      record.image.includesInk === expected.resolved.includesInk &&
      record.sourceKind === expected.resolved.sourceKind &&
      sameRegion;
    if (!same) {
      throw new AgentVisualReferenceError(
        "The idempotency key is already bound to different visual-reference content or direction.",
      );
    }
  }

  private async deriveCapability(
    record: Pick<
      AgentVisualReferenceRecord,
      "referenceId" | "recipientId" | "generation" | "image"
    >,
  ): Promise<string> {
    const secret = await this.readOrCreateSecret();
    return createHmac("sha256", secret)
      .update(
        `${record.referenceId}\u0000${record.recipientId}\u0000${record.generation}\u0000${record.image.sha256}`,
      )
      .digest("base64url");
  }

  private async readOrCreateSecret(): Promise<Buffer> {
    await this.ensurePrivateRoots();
    try {
      const created = randomBytes(32);
      await writeFile(this.secretPath, created, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const secret = await readFile(this.secretPath);
    if (secret.byteLength !== 32) {
      throw new AgentVisualReferenceError("The local visual-reference capability secret is invalid.");
    }
    if (process.platform !== "win32") await chmod(this.secretPath, 0o600);
    return secret;
  }

  private async ensurePrivateRoots(): Promise<void> {
    await mkdir(this.referencesRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.root, 0o700);
      await chmod(this.referencesRoot, 0o700);
    }
  }

  private async activeReferenceCount(now: Date): Promise<number> {
    let count = 0;
    for (const entry of await readdir(this.referencesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const record = await this.readRecordIfPresent(entry.name);
      if (record && new Date(record.expiresAt).getTime() > now.getTime()) count += 1;
    }
    return count;
  }

  private async pruneExpired(now: Date): Promise<void> {
    await this.ensurePrivateRoots();
    for (const entry of await readdir(this.referencesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const record = await this.readRecordIfPresent(entry.name);
      if (record && new Date(record.expiresAt).getTime() <= now.getTime()) {
        await rm(this.referenceDirectory(record.referenceId), { recursive: true, force: true });
      }
    }
  }

  private referenceDirectory(referenceId: string): string {
    if (!isUuid(referenceId)) {
      throw new AgentVisualReferenceError("KE Pen refused an invalid visual-reference identifier.");
    }
    const directory = resolve(this.referencesRoot, referenceId.toLowerCase());
    const prefix = `${resolve(this.referencesRoot)}${sep}`;
    if (!directory.startsWith(prefix)) {
      throw new AgentVisualReferenceError("KE Pen refused a path outside its visual-reference store.");
    }
    return directory;
  }

  private async writeRecord(record: AgentVisualReferenceRecord): Promise<void> {
    const validated = agentVisualReferenceRecordSchema.parse(record);
    const path = join(this.referenceDirectory(validated.referenceId), "reference.json");
    await this.atomicWrite(path, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`));
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  }
}

export function resolveAgentIdentity(
  explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = explicit?.trim() || environment.KE_PEN_AGENT_ID?.trim() || environment.CODEX_THREAD_ID?.trim();
  if (!candidate) {
    throw new AgentVisualReferenceError(
      "Agent visual references require KE_PEN_AGENT_ID or CODEX_THREAD_ID so reads fail closed to one recipient.",
    );
  }
  return agentIdentitySchema.parse(candidate);
}

function decodePngDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match?.[1]) {
    throw new AgentVisualReferenceError("Agent visual references accept one explicit PNG data URL.");
  }
  const image = Buffer.from(match[1], "base64");
  if (image.byteLength <= 0 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new AgentVisualReferenceError("The visual reference is empty or exceeds the 8 MB limit.");
  }
  return image;
}

function parsePng(image: Buffer): { width: number; height: number } {
  if (
    image.byteLength < 24 ||
    !image.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    image.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new AgentVisualReferenceError("The visual reference is not a valid PNG image.");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new AgentVisualReferenceError(
      "The PNG dimensions exceed the bounded visual-reference limits.",
    );
  }
  return { width, height };
}

function assertRegionInsideImage(
  region: z.infer<typeof pixelRegionSchema>,
  width: number,
  height: number,
): void {
  if (region.x + region.width > width || region.y + region.height > height) {
    throw new AgentVisualReferenceError("The marked region must stay inside the supplied PNG.");
  }
}

function uuidFromDigest(hexDigest: string): string {
  const bytes = Buffer.from(hexDigest.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST",
  );
}
