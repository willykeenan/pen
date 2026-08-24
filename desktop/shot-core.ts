export type CopyMode = "image" | "link" | "both";

export type ShotStatus = "uploaded" | "pending" | "local";

export interface ShotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShotResponse {
  id: string;
  url: string;
  imageUrl: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  deduped: boolean;
}

export interface ShotHistoryEntry {
  key: string;
  status: ShotStatus;
  createdAt: string;
  id: string | null;
  url: string | null;
  imageUrl: string | null;
  localPath: string | null;
  bytes: number;
  error: string | null;
}

export interface UploadHeaderInput {
  token: string;
  contentType: string;
  width?: number | null | undefined;
  height?: number | null | undefined;
  title?: string | null | undefined;
}

export interface ShotErrorEnvelope {
  code: string | null;
  message: string | null;
}

export interface RetryPlan {
  retry: boolean;
  delayMs: number;
}

export interface ShotNotificationPresentation {
  hideApp: boolean;
  delayMs: number;
}

export interface RegionCropInput {
  rect: ShotRect;
  displayWidth: number;
  displayHeight: number;
  imageWidth: number;
  imageHeight: number;
}

export const SHOT_HISTORY_LIMIT = 25;
export const SHOT_UPLOAD_ATTEMPTS = 3;
export const MAX_SHOT_TITLE_LENGTH = 200;

const COPY_MODES: readonly CopyMode[] = ["image", "link", "both"];
const SHOT_STATUSES: readonly ShotStatus[] = ["uploaded", "pending", "local"];
const SHOT_ID_PATTERN = /^[0-9A-Za-z]{8,64}$/;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Plain http: would put the bearer token and the screen contents on the wire in
// cleartext, which every document about this product says never happens. A
// loopback host is the one place that cannot leave the machine.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
// Codes the endpoint uses for conditions that a second identical upload cannot
// fix: retrying only pushes the same megabytes at a server that already said no.
const TERMINAL_ERROR_CODES = new Set([
  "not_configured",
  "environment_locked",
  "invalid_request",
  "invalid_source",
  "invalid_title",
]);

// A Dock-launched capture leaves KE Pen as macOS's foreground application even
// after the native region picker closes. macOS accepts notifications from the
// foreground app but suppresses their visual banner, which also removes the
// user's direct click-through to the fresh viewer. Hide only for successful
// link notifications and leave a short handoff for LaunchServices to publish
// the new non-focal state before Notification.show().
export function planShotNotificationPresentation(
  platform: NodeJS.Platform,
  hasViewerLink: boolean,
): ShotNotificationPresentation {
  return platform === "darwin" && hasViewerLink
    ? { hideApp: true, delayMs: 150 }
    : { hideApp: false, delayMs: 0 };
}

export function isCopyMode(value: unknown): value is CopyMode {
  return typeof value === "string" && COPY_MODES.includes(value as CopyMode);
}

export function formatShotBaseName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${day} at ${time}`;
}

export function nextAvailableName(
  base: string,
  extension: string,
  isTaken: (candidate: string) => boolean,
): string {
  const first = `${base}${extension}`;
  if (!isTaken(first)) return first;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base} (${index})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("KE Shot could not find a free filename for the local copy.");
}

export function addShotToHistory(
  history: readonly ShotHistoryEntry[],
  entry: ShotHistoryEntry,
  limit = SHOT_HISTORY_LIMIT,
): ShotHistoryEntry[] {
  const cap = Math.max(1, Math.trunc(limit));
  const matches = (existing: ShotHistoryEntry): boolean =>
    existing.key === entry.key || (entry.id !== null && existing.id === entry.id);
  const at = history.findIndex(matches);
  // A re-recorded shot — a successful retry, or a delete — keeps its place in
  // the list. Promoting it to the head would make "Copy last link" hand back a
  // days-old capture.
  if (at === -1) return [entry, ...history].slice(0, cap);
  return history
    .map((existing, index) => (index === at ? entry : existing))
    .filter((existing, index) => index === at || !matches(existing))
    .slice(0, cap);
}

export function normalizeHistory(input: unknown, limit = SHOT_HISTORY_LIMIT): ShotHistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const entries: ShotHistoryEntry[] = [];
  for (const candidate of input) {
    const entry = normalizeHistoryEntry(candidate);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, Math.max(1, Math.trunc(limit)));
}

function normalizeHistoryEntry(input: unknown): ShotHistoryEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.key !== "string" || raw.key.length === 0 || raw.key.length > 128) return null;
  const status = SHOT_STATUSES.includes(raw.status as ShotStatus)
    ? (raw.status as ShotStatus)
    : "local";
  return {
    key: raw.key,
    status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt.slice(0, 64) : "",
    id: typeof raw.id === "string" && SHOT_ID_PATTERN.test(raw.id) ? raw.id : null,
    url: optionalHttpUrl(raw.url),
    imageUrl: optionalHttpUrl(raw.imageUrl),
    localPath: typeof raw.localPath === "string" && raw.localPath.length > 0 ? raw.localPath : null,
    bytes: typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? Math.max(0, Math.trunc(raw.bytes)) : 0,
    error: typeof raw.error === "string" && raw.error.length > 0 ? raw.error.slice(0, 400) : null,
  };
}

export function encodeShotTitle(title: string): string {
  const characters = [...title.normalize("NFC")].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    // C0 and C1 controls both have to go: an endpoint that rejects U+0080-U+009F
    // would fail the whole upload over one invisible character in a title.
    return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
  });
  // Truncating by code point never splits a surrogate pair, which would make
  // encodeURIComponent throw and abort the capture before it is ever sent.
  const printable = truncateCodePoints(characters, MAX_SHOT_TITLE_LENGTH).trim();
  if (printable.length === 0) return "";
  return encodeURIComponent(printable).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function truncateCodePoints(characters: readonly string[], maxUnits: number): string {
  const kept: string[] = [];
  let units = 0;
  for (const character of characters) {
    if (units + character.length > maxUnits) break;
    kept.push(character);
    units += character.length;
  }
  return kept.join("");
}

export function buildUploadHeaders(input: UploadHeaderInput): Record<string, string> {
  const token = input.token.trim();
  if (token.length === 0) throw new Error("KE Shot has no upload token configured.");
  if (!HEADER_VALUE_PATTERN.test(token)) {
    throw new Error("KE Shot refused an upload token containing unsupported characters.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": input.contentType,
  };
  const width = positiveInteger(input.width);
  const height = positiveInteger(input.height);
  if (width) headers["X-Shot-Width"] = String(width);
  if (height) headers["X-Shot-Height"] = String(height);
  const title = input.title ? encodeShotTitle(input.title) : "";
  if (title.length > 0) headers["X-Shot-Title"] = title;
  return headers;
}

export function planUploadRetry(
  attempt: number,
  status: number | null,
  errorCode: string | null = null,
  maxAttempts = SHOT_UPLOAD_ATTEMPTS,
): RetryPlan {
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0 };
  // The endpoint answers some permanent misconfigurations with a 5xx, so the
  // machine-readable code outranks the status when it names one of them.
  if (errorCode !== null && TERMINAL_ERROR_CODES.has(errorCode)) {
    return { retry: false, delayMs: 0 };
  }
  const retryable = status === null || status >= 500 || status === 429;
  if (!retryable) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: 500 * 2 ** Math.max(0, attempt - 1) };
}

// The delete rail lives under the endpoint the person configured, never under a
// hard-coded host: whoever receives the upload is who gets asked to drop it.
export function shotDeleteUrl(endpoint: string, id: string): string {
  if (!SHOT_ID_PATTERN.test(id)) {
    throw new Error("KE Shot cannot delete a shot with an unrecognised identifier.");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("KE Shot has no valid endpoint configured.");
  }
  if (!isSecureShotUrl(parsed)) {
    throw new Error("KE Shot has no valid endpoint configured.");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${id}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function parseShotResponse(input: unknown): ShotResponse {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The shot endpoint returned a response KE Shot could not read.");
  }
  const body = input as Record<string, unknown>;
  if (typeof body.id !== "string" || !SHOT_ID_PATTERN.test(body.id)) {
    throw new Error("The shot endpoint returned an invalid shot identifier.");
  }
  return {
    id: body.id,
    url: requireHttpUrl(body.url, "share link"),
    imageUrl: requireHttpUrl(body.imageUrl, "image link"),
    bytes: optionalCount(body.bytes),
    width: optionalCount(body.width),
    height: optionalCount(body.height),
    createdAt:
      typeof body.createdAt === "string" && body.createdAt.length > 0 && body.createdAt.length <= 64
        ? body.createdAt
        : new Date().toISOString(),
    deduped: body.deduped === true,
  };
}

export function describeUploadFailure(status: number, body: string): string {
  const stated = parseErrorEnvelope(body).message;
  if (stated) return stated;
  if (status === 401 || status === 403) return "The shot endpoint rejected the configured token.";
  if (status === 413) return "That capture was larger than the shot endpoint accepts.";
  if (status === 415) return "The shot endpoint refused that image type.";
  if (status === 404) return "The shot endpoint URL was not found.";
  return `The shot endpoint returned HTTP ${status}.`;
}

export function parseErrorEnvelope(body: string): ShotErrorEnvelope {
  const empty: ShotErrorEnvelope = { code: null, message: null };
  if (body.length === 0 || body.length > 8_192) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const raw = parsed as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const code = typeof raw.error === "string" ? raw.error.trim() : "";
  return {
    code: ERROR_CODE_PATTERN.test(code) ? code : null,
    message: message.length > 0 ? message.slice(0, 300) : null,
  };
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

export function computeRegionCropPixels(input: RegionCropInput): ShotRect {
  const { rect, displayWidth, displayHeight, imageWidth, imageHeight } = input;
  for (const [name, value] of Object.entries({
    displayWidth,
    displayHeight,
    imageWidth,
    imageHeight,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`KE Shot received an invalid ${name}.`);
    }
  }
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    throw new Error("KE Shot received a non-finite region.");
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error("KE Shot received an empty region.");
  }

  const left = clamp(rect.x, 0, displayWidth);
  const top = clamp(rect.y, 0, displayHeight);
  const right = clamp(rect.x + rect.width, 0, displayWidth);
  const bottom = clamp(rect.y + rect.height, 0, displayHeight);
  const scaleX = imageWidth / displayWidth;
  const scaleY = imageHeight / displayHeight;
  const pixelLeft = clamp(Math.floor(left * scaleX), 0, imageWidth - 1);
  const pixelTop = clamp(Math.floor(top * scaleY), 0, imageHeight - 1);
  const pixelRight = clamp(Math.ceil(right * scaleX), pixelLeft + 1, imageWidth);
  const pixelBottom = clamp(Math.ceil(bottom * scaleY), pixelTop + 1, imageHeight);
  return {
    x: pixelLeft,
    y: pixelTop,
    width: pixelRight - pixelLeft,
    height: pixelBottom - pixelTop,
  };
}

export function formatAccelerator(
  accelerator: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const tokens = accelerator
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  if (platform === "darwin") {
    return tokens.map((token) => macSymbol(token)).join("");
  }
  return tokens.map((token) => portableToken(token)).join("+");
}

function macSymbol(token: string): string {
  const key = token.toLowerCase();
  if (key === "command" || key === "cmd" || key === "commandorcontrol" || key === "cmdorctrl") {
    return "⌘";
  }
  if (key === "super" || key === "meta") return "⌘";
  if (key === "control" || key === "ctrl") return "⌃";
  if (key === "alt" || key === "option") return "⌥";
  if (key === "shift") return "⇧";
  return token.length === 1 ? token.toUpperCase() : token;
}

function portableToken(token: string): string {
  const key = token.toLowerCase();
  if (key === "command" || key === "cmd" || key === "commandorcontrol" || key === "cmdorctrl") {
    return "Ctrl";
  }
  if (key === "control" || key === "ctrl") return "Ctrl";
  if (key === "alt" || key === "option") return "Alt";
  if (key === "shift") return "Shift";
  return token.length === 1 ? token.toUpperCase() : token;
}

function requireHttpUrl(value: unknown, label: string): string {
  const url = optionalHttpUrl(value);
  if (!url) throw new Error(`The shot endpoint returned an invalid ${label}.`);
  return url;
}

function optionalHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!isSecureShotUrl(parsed)) return null;
  return parsed.toString();
}

export function isSecureShotUrl(parsed: URL): boolean {
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

function optionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function positiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
