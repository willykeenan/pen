import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addShotToHistory,
  isCopyMode,
  isSecureShotUrl,
  normalizeHistory,
  SHOT_HISTORY_LIMIT,
  type CopyMode,
  type ShotHistoryEntry,
} from "./shot-core.js";

export interface ShotSettings {
  shotEndpoint: string;
  shotToken: string;
  copyMode: CopyMode;
  saveLocalCopy: boolean;
  localCopyDir: string;
  shotShortcut: string;
  showInDock: boolean;
}

export interface LocalStateOptions {
  directory: string;
  picturesDirectory: string;
  platform?: NodeJS.Platform | undefined;
}

export const SETTINGS_FILE_NAME = "settings.json";
export const HISTORY_FILE_NAME = "shots.json";

const MAX_TOKEN_LENGTH = 512;
const MAX_SHORTCUT_LENGTH = 64;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const SHORTCUT_PATTERN = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/;
const MODIFIERS = new Set([
  "command",
  "cmd",
  "commandorcontrol",
  "cmdorctrl",
  "control",
  "ctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);

export function defaultShotShortcut(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Command+Shift+2" : "Control+Shift+2";
}

export function defaultSettings(
  picturesDirectory: string,
  platform: NodeJS.Platform = process.platform,
): ShotSettings {
  return {
    // No default host. PRIVACY.md promises there is no fallback destination for
    // screen content, and the shipped settings file has to say the same thing.
    shotEndpoint: "",
    shotToken: "",
    copyMode: "image",
    saveLocalCopy: true,
    localCopyDir: path.join(picturesDirectory, "KE Shot"),
    shotShortcut: defaultShotShortcut(platform),
    showInDock: platform === "darwin",
  };
}

export function normalizeSettings(input: unknown, defaults: ShotSettings): ShotSettings {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    shotEndpoint: normalizeEndpoint(raw.shotEndpoint),
    shotToken: normalizeToken(raw.shotToken),
    copyMode: isCopyMode(raw.copyMode) ? raw.copyMode : defaults.copyMode,
    saveLocalCopy:
      typeof raw.saveLocalCopy === "boolean" ? raw.saveLocalCopy : defaults.saveLocalCopy,
    localCopyDir: normalizeDirectory(raw.localCopyDir, defaults.localCopyDir),
    shotShortcut: normalizeShortcut(raw.shotShortcut, defaults.shotShortcut),
    showInDock: typeof raw.showInDock === "boolean" ? raw.showInDock : defaults.showInDock,
  };
}

// A hand-edited settings file is the only way to configure uploading, so a
// broken file must degrade to safe defaults instead of taking the app down.
export function parseSettingsDocument(text: string, defaults: ShotSettings): ShotSettings {
  try {
    return normalizeSettings(JSON.parse(text), defaults);
  } catch {
    return { ...defaults };
  }
}

export function serializeSettings(settings: ShotSettings | Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// The normalizer is a safety filter, not an editor: a value it rejects still
// belongs to the person who typed it, so writes merge onto the document that is
// actually on disk instead of over-writing it with the normalized view.
function parseSettingsRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function patchedDocumentKeys(
  patch: Partial<ShotSettings>,
  next: ShotSettings,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof ShotSettings)[]) {
    if (patch[key] === undefined) continue;
    changed[key] = next[key];
  }
  return changed;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// An endpoint that is missing, empty, or does not parse means uploading is off.
// It never falls back to a host the person did not write down themselves, and a
// deleted key disables uploading exactly the way a deleted token does.
function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  // Cleartext http would carry the bearer token and the screen contents in the
  // open; loopback is the one address that never leaves the machine.
  if (!isSecureShotUrl(parsed)) return "";
  return parsed.toString();
}

function normalizeToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) return "";
  return TOKEN_PATTERN.test(trimmed) ? trimmed : "";
}

function normalizeDirectory(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4_096) return fallback;
  return path.resolve(trimmed);
}

function normalizeShortcut(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > MAX_SHORTCUT_LENGTH || !SHORTCUT_PATTERN.test(trimmed)) return fallback;
  const tokens = trimmed.split("+");
  const last = tokens[tokens.length - 1]!;
  if (MODIFIERS.has(last.toLowerCase())) return fallback;
  return trimmed;
}

export class SettingsStore {
  readonly file: string;
  readonly defaults: ShotSettings;
  private value: ShotSettings;
  private document: Record<string, unknown>;

  constructor(options: LocalStateOptions) {
    const platform = options.platform ?? process.platform;
    this.file = path.join(options.directory, SETTINGS_FILE_NAME);
    this.defaults = defaultSettings(options.picturesDirectory, platform);
    this.value = { ...this.defaults };
    this.document = { ...this.defaults };
  }

  get current(): ShotSettings {
    return this.value;
  }

  async load(): Promise<ShotSettings> {
    try {
      const text = await readFile(this.file, "utf8");
      const record = parseSettingsRecord(text);
      this.document = record ?? { ...this.defaults };
      this.value = normalizeSettings(record, this.defaults);
      if (process.platform !== "win32") {
        await chmod(this.file, 0o600).catch(() => undefined);
      }
    } catch (error) {
      this.document = { ...this.defaults };
      this.value = { ...this.defaults };
      // Only a missing file justifies writing one. An existing file that could
      // not be read (permissions, a lock, a bad mount) must never be replaced
      // with defaults — that would silently destroy a working configuration.
      if (isMissingFile(error)) await this.persist().catch(() => undefined);
    }
    return this.value;
  }

  async update(patch: Partial<ShotSettings>): Promise<ShotSettings> {
    const next = normalizeSettings({ ...this.value, ...patch }, this.defaults);
    const document = { ...this.document, ...patchedDocumentKeys(patch, next) };
    // Persist first: a tray checkbox must never claim a state the file on disk
    // does not hold.
    await writePrivateFile(this.file, serializeSettings(document));
    this.document = document;
    this.value = next;
    return this.value;
  }

  private async persist(): Promise<void> {
    await writePrivateFile(this.file, serializeSettings(this.document));
  }
}

export class ShotHistoryStore {
  readonly file: string;
  private value: ShotHistoryEntry[] = [];

  constructor(options: LocalStateOptions) {
    this.file = path.join(options.directory, HISTORY_FILE_NAME);
  }

  get entries(): readonly ShotHistoryEntry[] {
    return this.value;
  }

  async load(): Promise<readonly ShotHistoryEntry[]> {
    try {
      this.value = normalizeHistory(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.value = [];
    }
    return this.value;
  }

  async add(entry: ShotHistoryEntry): Promise<readonly ShotHistoryEntry[]> {
    this.value = addShotToHistory(this.value, entry, SHOT_HISTORY_LIMIT);
    await writePrivateFile(this.file, `${JSON.stringify(this.value, null, 2)}\n`);
    return this.value;
  }
}

export async function writePrivateFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
  }
}
