import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  defaultSettings,
  normalizeSettings,
  parseSettingsDocument,
  SettingsStore,
  ShotHistoryStore,
} from "../desktop/settings.js";
import {
  addShotToHistory,
  buildUploadHeaders,
  computeRegionCropPixels,
  describeUploadFailure,
  encodeShotTitle,
  formatAccelerator,
  formatShotBaseName,
  nextAvailableName,
  normalizeHistory,
  parseErrorEnvelope,
  parseShotResponse,
  planUploadRetry,
  readPngDimensions,
  shotDeleteUrl,
  type ShotHistoryEntry,
} from "../desktop/shot-core.js";

// Built with the platform's own path rules, not written as POSIX literals: the
// settings module resolves directories through node:path, so a hard-coded
// "/Users/…" string only ever matches on macOS and Linux and fails the Windows
// leg of CI for a separator, not for a defect.
const PICTURES = resolve(sep === "\\" ? "C:\\Users\\tester\\Pictures" : "/Users/tester/Pictures");
const SHOTS_DIR = resolve(sep === "\\" ? "C:\\Users\\tester\\Shots" : "/Users/tester/Shots");

test("KE Shot settings default to uploading disabled until a token is configured", () => {
  const settings = defaultSettings(PICTURES, "darwin");
  assert.equal(settings.shotEndpoint, "");
  assert.equal(settings.shotToken, "");
  assert.equal(settings.copyMode, "image");
  assert.equal(settings.saveLocalCopy, true);
  assert.equal(settings.localCopyDir, join(PICTURES, "KE Shot"));
  assert.equal(settings.shotShortcut, "Command+Shift+2");
  assert.equal(settings.showInDock, true);
  assert.equal(defaultSettings(PICTURES, "win32").shotShortcut, "Control+Shift+2");
  assert.equal(defaultSettings(PICTURES, "linux").showInDock, false);
});

test("settings normalisation keeps good values and refuses hostile ones", () => {
  const defaults = defaultSettings(PICTURES, "darwin");
  const normalized = normalizeSettings(
    {
      shotEndpoint: "  https://example.test/api/shot  ",
      shotToken: "  shot_live_abc123  ",
      copyMode: "both",
      saveLocalCopy: false,
      localCopyDir: SHOTS_DIR,
      shotShortcut: "Control+Alt+9",
      showInDock: false,
      extra: "ignored",
    },
    defaults,
  );
  assert.equal(normalized.shotEndpoint, "https://example.test/api/shot");
  assert.equal(normalized.shotToken, "shot_live_abc123");
  assert.equal(normalized.copyMode, "both");
  assert.equal(normalized.saveLocalCopy, false);
  assert.equal(normalized.localCopyDir, SHOTS_DIR);
  assert.equal(normalized.shotShortcut, "Control+Alt+9");
  assert.equal(normalized.showInDock, false);

  const hostile = normalizeSettings(
    {
      shotEndpoint: "javascript:alert(1)",
      shotToken: "line\nbreak",
      copyMode: "everything",
      saveLocalCopy: "yes",
      shotShortcut: "Shift",
      showInDock: 1,
    },
    defaults,
  );
  assert.equal(hostile.shotEndpoint, "");
  assert.equal(hostile.shotToken, "");
  // A deleted endpoint key has to disable uploading exactly like a deleted
  // token: there is no fallback host to quietly reinstate.
  assert.equal(normalizeSettings({}, defaults).shotEndpoint, "");
  assert.equal(normalizeSettings({ shotEndpoint: undefined }, defaults).shotEndpoint, "");
  assert.equal(hostile.copyMode, defaults.copyMode);
  assert.equal(hostile.saveLocalCopy, defaults.saveLocalCopy);
  assert.equal(hostile.shotShortcut, defaults.shotShortcut);
  assert.equal(hostile.showInDock, defaults.showInDock);
});

test("a corrupt settings file falls back to defaults instead of throwing", () => {
  const defaults = defaultSettings(PICTURES, "darwin");
  assert.deepEqual(parseSettingsDocument("{ not json", defaults), defaults);
  assert.deepEqual(parseSettingsDocument("[1, 2, 3]", defaults), defaults);
  assert.deepEqual(parseSettingsDocument("null", defaults), defaults);
});

test("the settings store writes an owner-only file and reloads what it saved", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ke-shot-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
  await store.load();
  assert.equal(store.current.shotToken, "");

  await store.update({ copyMode: "link", saveLocalCopy: false });
  if (process.platform !== "win32") {
    const mode = (await stat(store.file)).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const reloaded = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
  await reloaded.load();
  assert.equal(reloaded.current.copyMode, "link");
  assert.equal(reloaded.current.saveLocalCopy, false);

  await writeFile(store.file, "{{{", "utf8");
  const broken = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
  await broken.load();
  assert.equal(broken.current.copyMode, "image");
  assert.equal(await readFile(store.file, "utf8"), "{{{");
});

test("a tray toggle merges onto the file instead of over-writing what it holds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ke-shot-merge-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
  // A token the normalizer refuses, plus a key it has never heard of. Both
  // belong to whoever hand-edited the file.
  await writeFile(
    store.file,
    JSON.stringify({ shotToken: "bad token with spaces", futureKey: 7, copyMode: "image" }),
    "utf8",
  );
  await store.load();
  assert.equal(store.current.shotToken, "");

  await store.update({ copyMode: "link" });
  const written = JSON.parse(await readFile(store.file, "utf8")) as Record<string, unknown>;
  assert.equal(written.shotToken, "bad token with spaces");
  assert.equal(written.futureKey, 7);
  assert.equal(written.copyMode, "link");
});

test("an unreadable settings file is never replaced with defaults", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const directory = await mkdtemp(join(tmpdir(), "ke-shot-locked-"));
  t.after(async () => {
    await chmod(join(directory, "settings.json"), 0o600).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  const store = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
  const original = JSON.stringify({ copyMode: "both", shotToken: "shot_live_keepme" });
  await writeFile(store.file, original, "utf8");
  await chmod(store.file, 0o000);

  await store.load();
  assert.equal(store.current.copyMode, "image");

  await chmod(store.file, 0o600);
  assert.equal(await readFile(store.file, "utf8"), original);
});

test("local copies are named by capture time and never overwrite each other", () => {
  const at = new Date(2026, 7, 20, 9, 5, 3);
  assert.equal(formatShotBaseName(at), "2026-08-20 at 09.05.03");

  const taken = new Set(["2026-08-20 at 09.05.03.png", "2026-08-20 at 09.05.03 (2).png"]);
  assert.equal(
    nextAvailableName("2026-08-20 at 09.05.03", ".png", (candidate) => taken.has(candidate)),
    "2026-08-20 at 09.05.03 (3).png",
  );
  assert.equal(nextAvailableName("fresh", ".png", () => false), "fresh.png");
});

test("shot history stays bounded and replaces an entry rather than duplicating it", () => {
  let history: ShotHistoryEntry[] = [];
  for (let index = 0; index < 30; index += 1) {
    history = addShotToHistory(history, entry(`key-${index}`, `idAAAAAA${index}`));
  }
  assert.equal(history.length, 25);
  assert.equal(history[0]?.key, "key-29");
  assert.equal(history.at(-1)?.key, "key-5");

  const retried = addShotToHistory(history, { ...entry("key-29", "idAAAAAA29"), status: "pending" });
  assert.equal(retried.length, 25);
  assert.equal(retried[0]?.status, "pending");
  assert.equal(retried.filter((candidate) => candidate.key === "key-29").length, 1);

  const sameServerId = addShotToHistory(history, entry("key-fresh", "idAAAAAA29"));
  assert.equal(sameServerId.filter((candidate) => candidate.id === "idAAAAAA29").length, 1);

  // A recovered upload must not jump the queue: "Copy last link" reads the head
  // of this list, and promoting a two-day-old retry there hands back the wrong
  // shot.
  const stale = addShotToHistory(history, { ...entry("key-6", "idAAAAAA6"), status: "uploaded" });
  assert.equal(stale[0]?.key, "key-29");
  assert.equal(stale.findIndex((candidate) => candidate.key === "key-6"), 23);
});

test("history normalisation drops junk records and non-http links", () => {
  const normalized = normalizeHistory([
    null,
    "nope",
    { key: "ok", status: "uploaded", url: "javascript:alert(1)", imageUrl: 42, bytes: "big" },
    { status: "uploaded" },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.url, null);
  assert.equal(normalized[0]?.imageUrl, null);
  assert.equal(normalized[0]?.bytes, 0);
  assert.deepEqual(normalizeHistory({ not: "an array" }), []);
});

test("uploads retry on network, 429, and 5xx failures and never on other 4xx", () => {
  assert.deepEqual(planUploadRetry(1, null), { retry: true, delayMs: 500 });
  assert.deepEqual(planUploadRetry(2, 503), { retry: true, delayMs: 1_000 });
  assert.deepEqual(planUploadRetry(1, 429), { retry: true, delayMs: 500 });
  assert.equal(planUploadRetry(3, 500).retry, false);
  assert.equal(planUploadRetry(1, 400).retry, false);
  assert.equal(planUploadRetry(1, 401).retry, false);
  assert.equal(planUploadRetry(1, 413).retry, false);
  assert.equal(planUploadRetry(1, 415).retry, false);
});

test("a permanent endpoint misconfiguration is never retried, whatever its status", () => {
  // The endpoint answers an unset token or a non-production deployment with a
  // 500. Retrying pushes the same megabytes at a server that will never accept
  // a byte, and holds the capture hotkey shut while it does it.
  assert.equal(planUploadRetry(1, 500, "not_configured").retry, false);
  assert.equal(planUploadRetry(1, 500, "environment_locked").retry, false);
  assert.equal(planUploadRetry(1, 500, "invalid_title").retry, false);
  assert.equal(planUploadRetry(1, 500, "server_error").retry, true);
  assert.equal(planUploadRetry(1, 503, null).retry, true);

  assert.deepEqual(parseErrorEnvelope(JSON.stringify({ error: "not_configured", message: "No token." })), {
    code: "not_configured",
    message: "No token.",
  });
  assert.deepEqual(parseErrorEnvelope("<html>502</html>"), { code: null, message: null });
  assert.deepEqual(parseErrorEnvelope(JSON.stringify({ error: "../../etc" })), {
    code: null,
    message: null,
  });
});

test("delete URLs hang off the configured endpoint and refuse hostile input", () => {
  assert.equal(
    shotDeleteUrl("https://example.test/api/shot", "aB3dEf9hJk2mNp4qRs6tUv"),
    "https://example.test/api/shot/aB3dEf9hJk2mNp4qRs6tUv",
  );
  assert.equal(
    shotDeleteUrl("https://example.test/api/shot/?debug=1", "aB3dEf9hJk2mNp4qRs6tUv"),
    "https://example.test/api/shot/aB3dEf9hJk2mNp4qRs6tUv",
  );
  assert.throws(() => shotDeleteUrl("https://example.test/api/shot", "../../etc/passwd"), /identifier/);
  assert.throws(() => shotDeleteUrl("", "aB3dEf9hJk2mNp4qRs6tUv"), /no valid endpoint/);
  assert.throws(
    () => shotDeleteUrl("http://example.test/api/shot", "aB3dEf9hJk2mNp4qRs6tUv"),
    /no valid endpoint/,
  );
});

test("cleartext endpoints are refused everywhere except loopback", () => {
  const defaults = defaultSettings(PICTURES, "darwin");
  assert.equal(
    normalizeSettings({ shotEndpoint: "http://example.test/api/shot" }, defaults).shotEndpoint,
    "",
  );
  assert.equal(
    normalizeSettings({ shotEndpoint: "http://localhost:3000/api/shot" }, defaults).shotEndpoint,
    "http://localhost:3000/api/shot",
  );
  assert.equal(
    normalizeSettings({ shotEndpoint: "http://127.0.0.1:3000/api/shot" }, defaults).shotEndpoint,
    "http://127.0.0.1:3000/api/shot",
  );
  assert.throws(
    () =>
      parseShotResponse({
        id: "aB3dEf9hJk2mNp4qRs6tUv",
        url: "http://example.test/image/aB3dEf9hJk2mNp4qRs6tUv",
        imageUrl: "https://example.test/i/aB3dEf9hJk2mNp4qRs6tUv.png",
      }),
    /invalid share link/,
  );
});

test("upload headers carry the bearer token, sniffable type, and encoded metadata", () => {
  const headers = buildUploadHeaders({
    token: "shot_live_abc123",
    contentType: "image/png",
    width: 1_440,
    height: 900.7,
    title: "Quarterly review — draft",
  });
  assert.deepEqual(headers, {
    Authorization: "Bearer shot_live_abc123",
    "Content-Type": "image/png",
    "X-Shot-Width": "1440",
    "X-Shot-Height": "900",
    "X-Shot-Title": "Quarterly%20review%20%E2%80%94%20draft",
  });

  const minimal = buildUploadHeaders({ token: "t0ken", contentType: "image/jpeg", width: 0, height: null });
  assert.deepEqual(minimal, { Authorization: "Bearer t0ken", "Content-Type": "image/jpeg" });

  assert.throws(() => buildUploadHeaders({ token: "   ", contentType: "image/png" }), /no upload token/);
  assert.throws(
    () => buildUploadHeaders({ token: "bad\r\nX-Injected: 1", contentType: "image/png" }),
    /unsupported characters/,
  );
  assert.equal(encodeShotTitle("  control  chars  "), "control%20chars");
  assert.equal(encodeShotTitle("   "), "");
  assert.equal(encodeShotTitle("x".repeat(500)).length, 200);
  // C1 controls are invisible and get a title rejected outright; a title cut
  // mid-surrogate makes encodeURIComponent throw and kills the whole upload.
  assert.equal(encodeShotTitle("build\u0085log"), "buildlog");
  assert.equal(encodeShotTitle(`${"x".repeat(199)}\u{1F600}`), "x".repeat(199));
  assert.doesNotThrow(() => encodeShotTitle("\u{1F600}".repeat(300)));
});

test("shot responses are validated and hostile bodies are rejected", () => {
  const parsed = parseShotResponse({
    id: "aB3dEf9hJk2mNp4qRs6tUv",
    url: "https://kestudios.dev/image/aB3dEf9hJk2mNp4qRs6tUv",
    imageUrl: "https://kestudios.dev/i/aB3dEf9hJk2mNp4qRs6tUv.png",
    bytes: 48_211,
    width: 1_440,
    height: 900,
    createdAt: "2026-08-20T09:05:03.000Z",
    deduped: true,
  });
  assert.equal(parsed.id, "aB3dEf9hJk2mNp4qRs6tUv");
  assert.equal(parsed.url, "https://kestudios.dev/image/aB3dEf9hJk2mNp4qRs6tUv");
  assert.equal(parsed.bytes, 48_211);
  assert.equal(parsed.deduped, true);

  const sparse = parseShotResponse({
    id: "aB3dEf9hJk2mNp4qRs6tUv",
    url: "https://kestudios.dev/image/aB3dEf9hJk2mNp4qRs6tUv",
    imageUrl: "https://kestudios.dev/i/aB3dEf9hJk2mNp4qRs6tUv.png",
    width: null,
    height: null,
  });
  assert.equal(sparse.width, null);
  assert.equal(sparse.deduped, false);

  assert.throws(() => parseShotResponse("ok"), /could not read/);
  assert.throws(() => parseShotResponse([]), /could not read/);
  assert.throws(() => parseShotResponse({ url: "https://kestudios.dev/image/x" }), /invalid shot identifier/);
  assert.throws(
    () =>
      parseShotResponse({
        id: "../../etc/passwd",
        url: "https://kestudios.dev/image/x",
        imageUrl: "https://kestudios.dev/i/x.png",
      }),
    /invalid shot identifier/,
  );
  assert.throws(
    () =>
      parseShotResponse({
        id: "aB3dEf9hJk2mNp4qRs6tUv",
        url: "javascript:alert(document.cookie)",
        imageUrl: "https://kestudios.dev/i/x.png",
      }),
    /invalid share link/,
  );
  assert.throws(
    () =>
      parseShotResponse({
        id: "aB3dEf9hJk2mNp4qRs6tUv",
        url: "https://kestudios.dev/image/x",
        imageUrl: "file:///etc/passwd",
      }),
    /invalid image link/,
  );
});

test("upload failures explain themselves with or without a JSON error body", () => {
  assert.equal(
    describeUploadFailure(413, JSON.stringify({ error: "too_large", message: "Shot exceeds 4 MB." })),
    "Shot exceeds 4 MB.",
  );
  assert.equal(describeUploadFailure(401, ""), "The shot endpoint rejected the configured token.");
  assert.equal(
    describeUploadFailure(413, "FUNCTION_PAYLOAD_TOO_LARGE"),
    "That capture was larger than the shot endpoint accepts.",
  );
  assert.equal(describeUploadFailure(502, "<html>bad gateway</html>"), "The shot endpoint returned HTTP 502.");
});

test("PNG dimensions come from the IHDR header and reject non-PNG bytes", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  assert.deepEqual(readPngDimensions(png), { width: 1, height: 1 });
  assert.equal(readPngDimensions(Buffer.from("not a png at all, really not")), null);
  assert.equal(readPngDimensions(Buffer.alloc(8)), null);
});

test("region crops map display points to capture pixels on a scaled display", () => {
  assert.deepEqual(
    computeRegionCropPixels({
      rect: { x: 100, y: 120, width: 200, height: 140 },
      displayWidth: 1_440,
      displayHeight: 900,
      imageWidth: 2_880,
      imageHeight: 1_800,
    }),
    { x: 200, y: 240, width: 400, height: 280 },
  );

  assert.deepEqual(
    computeRegionCropPixels({
      rect: { x: -50, y: -50, width: 5_000, height: 5_000 },
      displayWidth: 800,
      displayHeight: 600,
      imageWidth: 800,
      imageHeight: 600,
    }),
    { x: 0, y: 0, width: 800, height: 600 },
  );

  assert.throws(
    () =>
      computeRegionCropPixels({
        rect: { x: 0, y: 0, width: 0, height: 10 },
        displayWidth: 800,
        displayHeight: 600,
        imageWidth: 800,
        imageHeight: 600,
      }),
    /empty region/,
  );
  assert.throws(
    () =>
      computeRegionCropPixels({
        rect: { x: Number.NaN, y: 0, width: 10, height: 10 },
        displayWidth: 800,
        displayHeight: 600,
        imageWidth: 800,
        imageHeight: 600,
      }),
    /non-finite/,
  );
});

test("accelerators render as native symbols on macOS and words elsewhere", () => {
  assert.equal(formatAccelerator("Command+Shift+2", "darwin"), "⌘⇧2");
  assert.equal(formatAccelerator("Control+Alt+P", "darwin"), "⌃⌥P");
  assert.equal(formatAccelerator("Control+Shift+2", "win32"), "Ctrl+Shift+2");
  assert.equal(formatAccelerator("CommandOrControl+Shift+F5", "linux"), "Ctrl+Shift+F5");
  assert.equal(formatAccelerator("", "darwin"), "");
});

test("the shot history store survives a corrupt file and persists additions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ke-shot-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new ShotHistoryStore({ directory, picturesDirectory: PICTURES });
  await writeFile(store.file, "not json", "utf8");
  assert.deepEqual(await store.load(), []);

  await store.add(entry("key-1", "idAAAAAA01"));
  const reloaded = new ShotHistoryStore({ directory, picturesDirectory: PICTURES });
  await reloaded.load();
  assert.equal(reloaded.entries.length, 1);
  assert.equal(reloaded.entries[0]?.id, "idAAAAAA01");
});

function entry(key: string, id: string): ShotHistoryEntry {
  return {
    key,
    status: "uploaded",
    createdAt: "2026-08-20T09:05:03.000Z",
    id,
    url: `https://kestudios.dev/image/${id}`,
    imageUrl: `https://kestudios.dev/i/${id}.png`,
    localPath: null,
    bytes: 1_024,
    error: null,
  };
}
