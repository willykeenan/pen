import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { clipboard, nativeImage, Notification, shell, type NativeImage } from "electron";
import type { SettingsStore, ShotHistoryStore, ShotSettings } from "./settings.js";
import {
  buildUploadHeaders,
  describeUploadFailure,
  formatShotBaseName,
  nextAvailableName,
  parseErrorEnvelope,
  parseShotResponse,
  planUploadRetry,
  readPngDimensions,
  shotDeleteUrl,
  type CopyMode,
  type ShotHistoryEntry,
  type ShotResponse,
} from "./shot-core.js";

export interface ShotRuntimeOptions {
  settings: SettingsStore;
  history: ShotHistoryStore;
  captureRegion(): Promise<Buffer | null>;
  onChange(): void;
}

export interface ShotRuntime {
  readonly settings: SettingsStore;
  readonly history: ShotHistoryStore;
  busy(): boolean;
  run(): Promise<void>;
  retryPending(): Promise<void>;
  deleteShot(key: string): Promise<void>;
  pendingCount(): number;
}

type Degradation = "jpeg" | "jpeg+downscale";

interface UploadPayload {
  body: Buffer;
  contentType: string;
  width: number | null;
  height: number | null;
  degraded: Degradation | null;
}

interface UploadResult {
  response: ShotResponse;
  degraded: Degradation | null;
}

interface ShotHttpResult {
  ok: boolean;
  status: number;
  text: string;
}

// Vercel serverless functions reject bodies above 4.5 MB with their own error
// shape, so KE Shot re-encodes below that before it ever leaves the machine.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
// The client timeout has to outlast the endpoint's own execution limit. If it
// fires first, "timed out" would not mean "the server stopped working", and the
// retry could publish a second copy of the same confidential capture.
const UPLOAD_TIMEOUT_MS = 45_000;
const DELETE_TIMEOUT_MS = 20_000;
// An endpoint answering with an endless body must not be able to exhaust the
// main process; the documented reply is a few hundred bytes of JSON.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_DOWNSCALE_WIDTH = 640;

export function createShotRuntime(options: ShotRuntimeOptions): ShotRuntime {
  let running = false;
  let unconfiguredNoticeShown = false;

  return {
    settings: options.settings,
    history: options.history,
    busy: () => running,
    pendingCount: () => options.history.entries.filter(isRetryable).length,

    async run(): Promise<void> {
      if (running) return;
      running = true;
      options.onChange();
      try {
        const png = await options.captureRegion();
        if (!png) return;
        // The clipboard write is the whole product promise: it happens before
        // any disk or network work so a paste right after release always lands.
        const image = readCapture(png);
        clipboard.writeImage(image);
        await deliver(png, image);
      } catch (error) {
        notify("KE Shot failed", messageFor(error));
      } finally {
        running = false;
        options.onChange();
      }
    },

    async retryPending(): Promise<void> {
      if (running) return;
      running = true;
      options.onChange();
      try {
        const settings = options.settings.current;
        if (!isUploadConfigured(settings)) {
          noticeUnconfigured();
          return;
        }
        let recovered = 0;
        let abandoned = 0;
        for (const entry of options.history.entries.filter(isRetryable)) {
          const png = await readFile(entry.localPath!).catch(() => null);
          if (!png) {
            // The safety net is gone, so the entry can never succeed. Leaving it
            // pending would keep a retry count on screen that never goes down.
            await options.history.add({
              ...entry,
              status: "local",
              localPath: null,
              error: "The local copy for this capture is no longer on disk.",
            });
            abandoned += 1;
            continue;
          }
          try {
            const result = await uploadShot(png, readCapture(png), settings);
            await options.history.add(
              uploadedEntry(entry.key, result.response, entry.localPath, png.byteLength, entry.createdAt),
            );
            recovered += 1;
          } catch {
            // Leave the entry pending; the local file is still the safety net.
          }
        }
        notify(
          recovered > 0 ? "KE Shot uploads recovered" : "KE Shot uploads still failing",
          recovered > 0
            ? `${recovered} saved capture${recovered === 1 ? "" : "s"} now have links.`
            : abandoned > 0
              ? "Some local copies are gone, so those captures were dropped from the retry list."
              : "The endpoint is still unreachable. Your local copies are untouched.",
        );
      } finally {
        running = false;
        options.onChange();
      }
    },

    async deleteShot(key: string): Promise<void> {
      if (running) return;
      const entry = options.history.entries.find((candidate) => candidate.key === key);
      if (!entry || entry.id === null) return;
      const settings = options.settings.current;
      if (!isUploadConfigured(settings)) {
        noticeUnconfigured();
        return;
      }
      running = true;
      options.onChange();
      try {
        const result = await sendDelete(
          shotDeleteUrl(settings.shotEndpoint, entry.id),
          settings.shotToken,
        );
        // A 404 means the endpoint no longer has it, which is the outcome asked
        // for, so it counts as success rather than an error to argue with.
        if (!result.ok && result.status !== 404) {
          throw new Error(describeUploadFailure(result.status, result.text));
        }
        await options.history.add({
          ...entry,
          status: "local",
          id: null,
          url: null,
          imageUrl: null,
          error: null,
        });
        notify(
          "Shot deleted from your endpoint",
          "It cannot recall bytes a chat app, unfurl service, or CDN already fetched.",
        );
      } catch (error) {
        notify("KE Shot could not delete that shot", messageFor(error));
      } finally {
        running = false;
        options.onChange();
      }
    },
  };

  async function deliver(png: Buffer, image: NativeImage): Promise<void> {
    const settings = options.settings.current;
    const key = randomUUID();
    const capturedAt = new Date();
    let localPath = settings.saveLocalCopy
      ? await saveLocalCopy(png, settings.localCopyDir, capturedAt).catch(() => null)
      : null;

    if (!isUploadConfigured(settings)) {
      await options.history.add({
        key,
        status: "local",
        createdAt: capturedAt.toISOString(),
        id: null,
        url: null,
        imageUrl: null,
        localPath,
        bytes: png.byteLength,
        error: null,
      });
      noticeUnconfigured();
      return;
    }

    try {
      const result = await uploadShot(png, image, settings);
      await options.history.add(
        uploadedEntry(key, result.response, localPath, png.byteLength, null),
      );
      applyCopyMode(settings.copyMode, image, result.response.url);
      notify(
        "KE Shot link ready",
        `${result.response.url}${degradedNote(result.degraded)}`,
        result.response.url,
      );
    } catch (error) {
      // Never lose the capture: force a local copy even when the setting is off.
      if (!localPath) {
        localPath = await saveLocalCopy(png, settings.localCopyDir, capturedAt).catch(() => null);
      }
      await options.history.add({
        key,
        status: localPath ? "pending" : "local",
        createdAt: capturedAt.toISOString(),
        id: null,
        url: null,
        imageUrl: null,
        localPath,
        bytes: png.byteLength,
        error: messageFor(error),
      });
      notify(
        "Saved locally — upload failed",
        localPath
          ? `${messageFor(error)} Retry from the KE Shot tray menu.`
          : messageFor(error),
      );
    }
  }

  function noticeUnconfigured(): void {
    if (unconfiguredNoticeShown) return;
    unconfiguredNoticeShown = true;
    notify(
      "KE Shot is not uploading yet",
      "Add shotEndpoint and shotToken to the settings file, then restart KE Pen.",
    );
  }
}

function isUploadConfigured(settings: ShotSettings): boolean {
  return settings.shotEndpoint.length > 0 && settings.shotToken.length > 0;
}

function isRetryable(entry: ShotHistoryEntry): boolean {
  return entry.status === "pending" && Boolean(entry.localPath);
}

// An undecodable capture yields an empty NativeImage rather than throwing, and
// writing that to the clipboard would erase whatever the person already had.
function readCapture(png: Buffer): NativeImage {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("KE Shot could not read the captured image.");
  return image;
}

function uploadedEntry(
  key: string,
  result: ShotResponse,
  localPath: string | null,
  bytes: number,
  capturedAt: string | null,
): ShotHistoryEntry {
  return {
    key,
    status: "uploaded",
    // A retry re-uploads an older capture, so the moment it was taken outranks
    // the moment the server finally accepted it.
    createdAt: capturedAt && capturedAt.length > 0 ? capturedAt : result.createdAt,
    id: result.id,
    url: result.url,
    imageUrl: result.imageUrl,
    localPath,
    bytes: result.bytes ?? bytes,
    error: null,
  };
}

async function uploadShot(
  png: Buffer,
  image: NativeImage,
  settings: ShotSettings,
): Promise<UploadResult> {
  const payload = prepareUploadPayload(png, image);
  // No X-Shot-Title on purpose: the only title on hand would be the frontmost
  // window's, and PRIVACY.md promises no window titles ever leave the machine.
  const headers = buildUploadHeaders({
    token: settings.shotToken,
    contentType: payload.contentType,
    width: payload.width,
    height: payload.height,
  });

  for (let attempt = 1; ; attempt += 1) {
    let status: number | null = null;
    let errorCode: string | null = null;
    let terminal = false;
    let failure = "KE Shot could not reach the upload endpoint.";
    let success: string | null = null;
    try {
      const result = await postShot(settings.shotEndpoint, headers, payload.body);
      if (result.ok) {
        success = result.text;
      } else {
        status = result.status;
        errorCode = parseErrorEnvelope(result.text).code;
        failure = describeUploadFailure(result.status, result.text);
      }
    } catch (error) {
      status = null;
      failure = transportFailureMessage(error);
      // A redirect refusal means the token has already gone to a host that is
      // not the configured one. Sending it twice more helps nobody.
      terminal = isRedirectRefusal(error) || isOversizedResponse(error);
    }
    if (success !== null) {
      return { response: parseShotResponse(safeJson(success)), degraded: payload.degraded };
    }

    const plan = terminal
      ? { retry: false, delayMs: 0 }
      : planUploadRetry(attempt, status, errorCode);
    if (!plan.retry) throw new Error(failure);
    await delay(plan.delayMs);
  }
}

function prepareUploadPayload(png: Buffer, image: NativeImage): UploadPayload {
  if (png.byteLength <= MAX_UPLOAD_BYTES) {
    const size = readPngDimensions(png);
    return {
      body: png,
      contentType: "image/png",
      width: size?.width ?? null,
      height: size?.height ?? null,
      degraded: null,
    };
  }

  let current = image;
  let body = current.toJPEG(80);
  let degraded: Degradation = "jpeg";
  while (body.byteLength > MAX_UPLOAD_BYTES && current.getSize().width > MIN_DOWNSCALE_WIDTH) {
    const width = Math.max(MIN_DOWNSCALE_WIDTH, Math.round(current.getSize().width * 0.75));
    current = current.resize({ width });
    body = current.toJPEG(80);
    degraded = "jpeg+downscale";
  }
  const size = current.getSize();
  return { body, contentType: "image/jpeg", width: size.width, height: size.height, degraded };
}

// The clipboard holds the lossless PNG while the link points at this re-encoded
// copy, so the substitution has to be said out loud rather than discovered.
function degradedNote(degraded: Degradation | null): string {
  if (degraded === null) return "";
  if (degraded === "jpeg") return "\nRe-encoded as JPEG to fit the 4 MB upload limit.";
  return "\nRe-encoded as a smaller JPEG to fit the 4 MB upload limit.";
}

async function postShot(
  endpoint: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<ShotHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: toRequestBody(body),
      signal: controller.signal,
      redirect: "error",
    });
    // The body is read inside the timeout. Clearing the timer the moment the
    // headers land would leave a slow endpoint able to wedge KE Shot forever.
    const text = await readBoundedText(response);
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function sendDelete(url: string, token: string): Promise<ShotHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token.trim()}` },
      signal: controller.signal,
      redirect: "error",
    });
    const text = await readBoundedText(response);
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    throw new Error(transportFailureMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(OVERSIZED_RESPONSE);
  }
  const stream = response.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(OVERSIZED_RESPONSE);
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// The raw bytes go on the wire untouched — no multipart wrapper, no base64.
function toRequestBody(bytes: Buffer) {
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

const OVERSIZED_RESPONSE = "The shot endpoint returned a response that was too large to read.";

function transportFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "The shot endpoint did not answer in time.";
  }
  if (isOversizedResponse(error)) return OVERSIZED_RESPONSE;
  if (isRedirectRefusal(error)) {
    return "The shot endpoint tried to redirect the request, which KE Shot refuses.";
  }
  return "KE Shot could not reach the upload endpoint.";
}

function isOversizedResponse(error: unknown): boolean {
  return error instanceof Error && error.message === OVERSIZED_RESPONSE;
}

function isRedirectRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message.toLowerCase().includes("redirect")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function applyCopyMode(mode: CopyMode, image: NativeImage, url: string): void {
  if (mode === "image") return;
  // Seconds of upload have passed since the capture went on the clipboard. If
  // anything else was copied in the meantime, that copy belongs to the person;
  // the notification still carries the link.
  if (!clipboardStillHoldsShot(image)) return;
  if (mode === "link") clipboard.writeText(url);
  else clipboard.write({ text: url, image });
}

function clipboardStillHoldsShot(image: NativeImage): boolean {
  const current = clipboard.readImage();
  if (current.isEmpty()) return false;
  const held = current.getSize();
  const expected = image.getSize();
  return held.width === expected.width && held.height === expected.height;
}

async function saveLocalCopy(png: Buffer, directory: string, at: Date): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const taken = new Set(await readdir(directory).catch(() => [] as string[]));
  const name = nextAvailableName(formatShotBaseName(at), ".png", (candidate) => taken.has(candidate));
  const target = path.join(directory, name);
  await writeFile(target, png, { mode: 0o600 });
  return target;
}

function notify(title: string, body: string, url?: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (url) notification.on("click", () => void shell.openExternal(url));
  notification.show();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The shot endpoint returned a response KE Shot could not read.");
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "KE Shot hit an unknown error.";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
