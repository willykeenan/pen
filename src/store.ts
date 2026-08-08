import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix as posixPath, resolve, sep, win32 as winPath } from "node:path";
import {
  annotationRecordSchema,
  currentPointerSchema,
  type AnnotationRecord,
  type PenContext,
  type PenStatusView,
} from "./types.js";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export class PenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenStoreError";
  }
}

export function defaultPenHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): string {
  const pathApi = platform === "win32" ? winPath : posixPath;
  const configured = environment.KE_PEN_HOME?.trim();
  if (configured) {
    return pathApi.resolve(configured.replace(/^~(?=$|[\\/])/, userHome));
  }

  if (platform === "darwin") {
    return pathApi.join(userHome, "Library", "Application Support", "KE Pen");
  }
  if (platform === "win32") {
    const roaming = environment.APPDATA?.trim();
    return roaming
      ? pathApi.join(pathApi.resolve(roaming), "KE Pen")
      : pathApi.join(userHome, "AppData", "Roaming", "KE Pen");
  }

  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  return xdgDataHome
    ? pathApi.join(pathApi.resolve(xdgDataHome), "ke-pen")
    : pathApi.join(userHome, ".local", "share", "ke-pen");
}

export class AnnotationStore {
  readonly root: string;
  readonly annotationsRoot: string;

  constructor(root = defaultPenHome()) {
    this.root = resolve(root);
    this.annotationsRoot = join(this.root, "annotations");
  }

  async status(): Promise<PenStatusView> {
    const record = await this.current();
    const available = Boolean(record && ["pending", "reading"].includes(record.status));
    const base = {
      available,
      product: "Pen by KE Studios" as const,
      creator: "William Keenan" as const,
      site: "https://kestudios.dev" as const,
    };
    if (!record) return base;

    return {
      ...base,
      annotation: {
        id: record.id,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.source.appName ? { sourceApp: record.source.appName } : {}),
        image: {
          width: record.image.width,
          height: record.image.height,
          includesInk: record.image.includesInk,
        },
      },
    };
  }

  async current(): Promise<AnnotationRecord | null> {
    const pointerPath = join(this.root, "current.json");
    let pointerBytes: Buffer;
    try {
      pointerBytes = await readFile(pointerPath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    const pointer = currentPointerSchema.parse(JSON.parse(pointerBytes.toString("utf8")));
    try {
      return await this.read(pointer.id);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(id: string): Promise<AnnotationRecord> {
    const recordPath = join(this.annotationDirectory(id), "annotation.json");
    const raw = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
    return annotationRecordSchema.parse(raw);
  }

  async claimCurrentForRead(): Promise<PenContext | null> {
    let record = await this.current();
    if (!record || !["pending", "reading"].includes(record.status)) return null;

    if (record.status === "pending") {
      const now = new Date().toISOString();
      record = {
        ...record,
        status: "reading",
        updatedAt: now,
        readAt: now,
      };
      await this.write(record);
    }

    return {
      record,
      image: await this.readImage(record),
    };
  }

  async complete(options: {
    id?: string | undefined;
    summary?: string | undefined;
    delayMs?: number | undefined;
  }): Promise<AnnotationRecord> {
    const current = await this.current();
    const id = options.id ?? current?.id;
    if (!id) throw new PenStoreError("There is no current Pen annotation to complete.");

    let record = await this.read(id);
    if (current?.id !== id) {
      throw new PenStoreError("pen_complete only accepts the current visible annotation.");
    }
    if (!["pending", "reading", "completing"].includes(record.status)) {
      throw new PenStoreError(`Annotation ${id} is already ${record.status}.`);
    }

    const now = new Date();
    const delayMs = Math.min(Math.max(Math.round(options.delayMs ?? 1_000), 250), 5_000);
    record = {
      ...record,
      status: "completing",
      updatedAt: now.toISOString(),
      clearAfter: new Date(now.getTime() + delayMs).toISOString(),
      completionSummary:
        options.summary?.trim() || "The AI confirmed it understood the marked screen region.",
    };
    await this.write(record);
    return record;
  }

  async create(record: AnnotationRecord, image: Buffer): Promise<AnnotationRecord> {
    const validated = annotationRecordSchema.parse(record);
    if (validated.status !== "pending") {
      throw new PenStoreError("A new Pen annotation must begin in pending state.");
    }
    if (basename(validated.image.file) !== validated.image.file) {
      throw new PenStoreError("Pen refused an image path outside its annotation directory.");
    }
    if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) {
      throw new PenStoreError("Pen image is empty or exceeds the 16 MB local safety limit.");
    }

    const digest = createHash("sha256").update(image).digest("hex");
    if (digest !== validated.image.sha256) {
      throw new PenStoreError("Pen refused an image whose checksum did not match its annotation.");
    }

    const directory = this.annotationDirectory(validated.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const imagePath = join(directory, validated.image.file);
    await this.atomicWrite(imagePath, image);
    await this.write(validated);
    await this.atomicWrite(
      join(this.root, "current.json"),
      Buffer.from(
        `${JSON.stringify(
          { schema: "dev.kestudios.pen.current.v1", id: validated.id },
          null,
          2,
        )}\n`,
      ),
    );
    return validated;
  }

  async setStatus(
    id: string,
    status: AnnotationRecord["status"],
    cancelReason?: string,
  ): Promise<AnnotationRecord> {
    const record = await this.read(id);
    const updated: AnnotationRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      ...(cancelReason ? { cancelReason } : {}),
    };
    await this.write(updated);
    return updated;
  }

  async cancelOrphanedCurrent(): Promise<void> {
    const record = await this.current();
    if (!record || !["pending", "reading", "completing"].includes(record.status)) return;
    await this.setStatus(
      record.id,
      "cancelled",
      "Desktop overlay restarted before completion.",
    );
  }

  async clearHistory(): Promise<void> {
    await rm(this.annotationsRoot, { recursive: true, force: true });
    await rm(join(this.root, "current.json"), { force: true });
    await mkdir(this.annotationsRoot, { recursive: true, mode: 0o700 });
  }

  async write(record: AnnotationRecord): Promise<void> {
    const validated = annotationRecordSchema.parse(record);
    const path = join(this.annotationDirectory(validated.id), "annotation.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.atomicWrite(path, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`));
  }

  private annotationDirectory(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new PenStoreError("Pen refused an invalid annotation identifier.");
    }
    const directory = resolve(this.annotationsRoot, id.toLowerCase());
    const prefix = `${resolve(this.annotationsRoot)}${sep}`;
    if (!directory.startsWith(prefix)) {
      throw new PenStoreError("Pen refused a path outside its annotation store.");
    }
    return directory;
  }

  private async readImage(record: AnnotationRecord): Promise<Buffer> {
    if (basename(record.image.file) !== record.image.file) {
      throw new PenStoreError("Pen refused an image path outside its annotation directory.");
    }
    const path = resolve(this.annotationDirectory(record.id), record.image.file);
    const prefix = `${this.annotationDirectory(record.id)}${sep}`;
    if (!path.startsWith(prefix)) {
      throw new PenStoreError("Pen refused an image path outside its annotation directory.");
    }
    const imageStat = await stat(path);
    if (!imageStat.isFile() || imageStat.size > MAX_IMAGE_BYTES) {
      throw new PenStoreError("Pen image is missing or exceeds the 16 MB local safety limit.");
    }
    return readFile(path);
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}
