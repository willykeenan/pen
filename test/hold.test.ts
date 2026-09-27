import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureThumbnailSize,
  displayForPoint,
  matchCapturesToDisplays,
  nativeCaptureSize,
  needsNativeResize,
  type CaptureDisplay,
} from "../desktop/display-capture-core.js";
import {
  badgeCorner,
  FROZEN_DIM_FADE_MS,
  FROZEN_IDLE_CANCEL_MS,
  frozenDimAlpha,
  regionPointerAction,
  SELECTOR_DIM_ALPHA,
  shotBadgeDetail,
  startsPenStroke,
} from "../desktop/overlay-core.js";
import {
  clampHoldDelay,
  encodeHoldCommand,
  formatHoldDelay,
  HOLD_DEFAULT_DELAY_MS,
  HOLD_LINE_MAX,
  HOLD_RESTART_DELAYS_MS,
  HOLD_READY_TIMEOUT_MS,
  holdCaptureSupported,
  holdDelayChoices,
  holdDelayLabel,
  holdHelperPath,
  HoldLineSplitter,
  holdSetupStep,
  overlayBaseline,
  parseHoldMessage,
  planHoldRestart,
  runHoldFlow,
  shouldArmHold,
  shouldOfferHoldSetup,
  type HoldArmInput,
} from "../desktop/hold-core.js";
import {
  HOLD_SETUP_CONTINUE_URL,
  HOLD_SETUP_LATER_URL,
  HOLD_SETUP_OFF_URL,
  holdSetupBounds,
  holdSetupDocument,
  holdSetupParagraphs,
  holdSetupRoute,
} from "../desktop/hold-setup-core.js";
import {
  HoldHelperSupervisor,
  type HoldHelperStatus,
  type HoldTimers,
} from "../desktop/hold-helper.js";
import { defaultSettings, normalizeSettings, SettingsStore } from "../desktop/settings.js";
import { computeRegionCropPixels } from "../desktop/shot-core.js";

const PICTURES = resolve(sep === "\\" ? "C:\\Users\\tester\\Pictures" : "/Users/tester/Pictures");
const FAKE_HELPER = fileURLToPath(new URL("./fixtures/fake-hold-helper.mjs", import.meta.url));

// ---- Settings -------------------------------------------------------------------

test("hold to capture is on by default where it is supported and never on Linux", () => {
  const mac = defaultSettings(PICTURES, "darwin");
  assert.equal(mac.middleHoldCapture, true);
  assert.equal(mac.middleHoldDelayMs, 500);
  assert.equal(mac.middleHoldIntroduced, "");
  assert.equal(mac.middleHoldPrompted, "");
  assert.equal(defaultSettings(PICTURES, "win32").middleHoldCapture, true);
  assert.equal(defaultSettings(PICTURES, "linux").middleHoldCapture, false);
  assert.equal(holdCaptureSupported("darwin"), true);
  assert.equal(holdCaptureSupported("win32"), true);
  assert.equal(holdCaptureSupported("linux"), false);

  const linux = normalizeSettings(
    { middleHoldCapture: true, middleHoldDelayMs: 750 },
    defaultSettings(PICTURES, "linux"),
    "linux",
  );
  assert.equal(linux.middleHoldCapture, false, "a hand-edited file cannot switch it on for Linux");
  assert.equal(linux.middleHoldDelayMs, 750);
});

test("hold delay settings are clamped to 200–1500 ms and hostile values fall back", () => {
  const defaults = defaultSettings(PICTURES, "darwin");
  const read = (value: unknown) =>
    normalizeSettings({ middleHoldDelayMs: value }, defaults, "darwin").middleHoldDelayMs;
  assert.equal(read(50), 200);
  assert.equal(read(200), 200);
  assert.equal(read(333.4), 333);
  assert.equal(read(1500), 1500);
  assert.equal(read(99_999), 1500);
  assert.equal(read("750"), 500);
  assert.equal(read(Number.NaN), 500);
  assert.equal(read(null), 500);
  const off = normalizeSettings(
    { middleHoldCapture: false, middleHoldIntroduced: "0.6.0", middleHoldPrompted: "0.6.0" },
    defaults,
    "darwin",
  );
  assert.equal(off.middleHoldCapture, false);
  assert.equal(off.middleHoldIntroduced, "0.6.0");
  assert.equal(off.middleHoldPrompted, "0.6.0");
  const marks = normalizeSettings(
    { middleHoldIntroduced: 7, middleHoldPrompted: "0.6.0\u0000; rm -rf /" },
    defaults,
    "darwin",
  );
  assert.equal(marks.middleHoldIntroduced, "");
  assert.equal(marks.middleHoldPrompted, "");
  const hostile = normalizeSettings({ middleHoldCapture: "yes" }, defaults, "win32");
  assert.equal(hostile.middleHoldCapture, true);
  assert.equal(clampHoldDelay(undefined), HOLD_DEFAULT_DELAY_MS);
  assert.deepEqual(holdDelayChoices(500), [200, 350, 500, 750, 1000, 1500]);
  assert.deepEqual(holdDelayChoices(420), [200, 350, 420, 500, 750, 1000, 1500]);
});

test("the settings store persists hold settings without rewriting other keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ke-pen-hold-settings-"));
  try {
    const store = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
    await store.load();
    await store.update({ middleHoldDelayMs: 5_000 });
    assert.equal(store.current.middleHoldDelayMs, 1500);
    await store.update({ middleHoldCapture: false });
    const onDisk = JSON.parse(await readFile(store.file, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.middleHoldDelayMs, 1500);
    assert.equal(onDisk.middleHoldCapture, false);
    assert.equal(onDisk.shotEndpoint, "");
    const reloaded = new SettingsStore({ directory, picturesDirectory: PICTURES, platform: "darwin" });
    await reloaded.load();
    assert.equal(reloaded.current.middleHoldCapture, false);
    assert.equal(reloaded.current.middleHoldDelayMs, 1500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Protocol -------------------------------------------------------------------

test("commands encode to the helper's five fixed lines, with the delay clamped", () => {
  assert.equal(encodeHoldCommand({ cmd: "arm" }), '{"cmd":"arm"}\n');
  assert.equal(encodeHoldCommand({ cmd: "prompt" }), '{"cmd":"prompt"}\n');
  assert.equal(encodeHoldCommand({ cmd: "disarm" }), '{"cmd":"disarm"}\n');
  assert.equal(encodeHoldCommand({ cmd: "quit" }), '{"cmd":"quit"}\n');
  assert.equal(encodeHoldCommand({ cmd: "config", thresholdMs: 750 }), '{"cmd":"config","thresholdMs":750}\n');
  assert.equal(encodeHoldCommand({ cmd: "config", thresholdMs: 10 }), '{"cmd":"config","thresholdMs":200}\n');
  assert.equal(encodeHoldCommand({ cmd: "config", thresholdMs: 1e9 }), '{"cmd":"config","thresholdMs":1500}\n');
});

test("helper messages are parsed through a strict whitelist", () => {
  assert.deepEqual(
    parseHoldMessage(
      '{"v":1,"type":"ready","name":"ke-pen-hold-helper","version":"0.6.0","protocol":1,"platform":"darwin"}',
    ),
    { type: "ready", name: "ke-pen-hold-helper", version: "0.6.0", protocol: 1, platform: "darwin" },
  );
  assert.deepEqual(parseHoldMessage('{"v":1,"type":"active"}'), { type: "active" });
  assert.deepEqual(parseHoldMessage('{"v":1,"type":"hold","seq":4}'), { type: "hold", seq: 4 });
  assert.deepEqual(parseHoldMessage('{"v":1,"type":"needs-permission","permission":"accessibility"}'), {
    type: "needs-permission",
    permission: "accessibility",
  });
  assert.deepEqual(parseHoldMessage('{"v":1,"type":"tap-restored","reason":"timeout"}'), {
    type: "tap-restored",
    reason: "timeout",
  });
  assert.deepEqual(parseHoldMessage('{"v":1,"type":"error","code":"unknown-key"}'), {
    type: "error",
    code: "unknown-key",
  });

  // Anything carrying a position, an unknown type, or the wrong version is dropped.
  for (const line of [
    '{"v":1,"type":"hold","seq":1,"x":10,"y":20}',
    '{"v":2,"type":"hold","seq":1}',
    '{"type":"hold","seq":1}',
    '{"v":1,"type":"hold","seq":0}',
    '{"v":1,"type":"hold","seq":1.5}',
    '{"v":1,"type":"click"}',
    '{"v":1,"type":"constructor"}',
    '{"v":1,"type":"__proto__"}',
    '{"v":1,"type":"error","code":"has space"}',
    '{"v":1,"type":"ready","name":"other","version":"1","protocol":1,"platform":"x"}',
    "[1,2]",
    "not json",
    "",
    `{"v":1,"type":"error","code":"${"a".repeat(HOLD_LINE_MAX)}"}`,
  ]) {
    assert.equal(parseHoldMessage(line), null, line.slice(0, 60));
  }
});

test("the stdout splitter reassembles lines and discards a runaway line", () => {
  const splitter = new HoldLineSplitter();
  assert.deepEqual(splitter.push('{"v":1,"ty'), []);
  assert.deepEqual(splitter.push('pe":"active"}\r\n{"v":1,"type":"hold","seq":1}\n'), [
    '{"v":1,"type":"active"}',
    '{"v":1,"type":"hold","seq":1}',
  ]);
  assert.deepEqual(splitter.push("x".repeat(HOLD_LINE_MAX + 10)), []);
  assert.deepEqual(splitter.push('more\n{"v":1,"type":"active"}\n'), ['{"v":1,"type":"active"}']);
});

// ---- Restart policy and arm gate ------------------------------------------------------

test("restarts back off 0.5 s → 30 s and give up after six failures in two minutes", () => {
  const now = 1_000_000;
  const failures: number[] = [];
  const delays: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    failures.push(now);
    const plan = planHoldRestart(failures, now);
    assert.equal(plan.giveUp, false);
    delays.push(plan.delayMs);
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000]);
  failures.push(now);
  assert.equal(planHoldRestart(failures, now).giveUp, true);
  // Old failures age out of the window.
  const later = planHoldRestart([...failures, now + 200_000], now + 200_000);
  assert.equal(later.giveUp, false);
  assert.deepEqual(later.recentFailures, [now + 200_000]);
  assert.equal(later.delayMs, 500);
  assert.equal(HOLD_RESTART_DELAYS_MS.at(-1), 30_000);
});

test("the helper is armed only while KE Pen could really open the selector", () => {
  const ready: HoldArmInput = {
    enabled: true,
    helperActive: true,
    phase: "idle",
    activating: false,
    shotBusy: false,
    holdInFlight: false,
  };
  assert.equal(shouldArmHold(ready), true);
  const blockers: Array<Partial<HoldArmInput>> = [
    { enabled: false },
    { helperActive: false },
    { phase: "drawing" }, // a Pen or KE Shot overlay is open
    { phase: "queued" },
    { phase: "clearing" },
    { activating: true },
    { shotBusy: true }, // screencapture -i, an upload, or a retry is running
    { holdInFlight: true }, // re-entrancy: a hold capture is already underway
  ];
  for (const blocker of blockers) {
    assert.equal(shouldArmHold({ ...ready, ...blocker }), false, JSON.stringify(blocker));
  }
});

test("the helper is found beside the app executable or in the Windows resources", () => {
  assert.equal(
    holdHelperPath({
      platform: "darwin",
      isPackaged: true,
      executablePath: "/Applications/KE Pen.app/Contents/MacOS/KE Pen",
      resourcesPath: "/Applications/KE Pen.app/Contents/Resources",
      appPath: "/Applications/KE Pen.app/Contents/Resources/app.asar",
    }),
    "/Applications/KE Pen.app/Contents/MacOS/ke-pen-hold-helper",
  );
  assert.equal(
    holdHelperPath({
      platform: "darwin",
      isPackaged: false,
      executablePath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      resourcesPath: "/x",
      appPath: "/repo",
    }),
    "/repo/dist/native/darwin/ke-pen-hold-helper",
  );
  assert.equal(
    holdHelperPath({
      platform: "win32",
      isPackaged: true,
      executablePath: "C:\\Program Files\\KE Pen\\KE Pen.exe",
      resourcesPath: "C:\\Program Files\\KE Pen\\resources",
      appPath: "C:\\Program Files\\KE Pen\\resources\\app.asar",
    }),
    "C:\\Program Files\\KE Pen\\resources\\hold\\ke-pen-hold-helper.exe",
  );
  assert.equal(
    holdHelperPath({ platform: "linux", isPackaged: true, executablePath: "/opt/ke-pen", resourcesPath: "/opt", appPath: "/opt" }),
    null,
  );
});

// ---- Multi-display ------------------------------------------------------------------

const RETINA: CaptureDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  size: { width: 1440, height: 900 },
  scaleFactor: 2,
};
const LEFT_1X: CaptureDisplay = {
  id: 2,
  bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
};

test("captures are matched to displays by id, then order, then the lone primary", () => {
  const empty = (image: string) => image.length === 0;
  // Exact ids win even when the sources arrive in another order.
  assert.deepEqual(
    matchCapturesToDisplays([RETINA, LEFT_1X], [
      { display_id: "2", thumbnail: "left" },
      { display_id: "1", thumbnail: "retina" },
    ], 1, empty).map((entry) => [entry.display.id, entry.image]),
    [
      [1, "retina"],
      [2, "left"],
    ],
  );
  // No ids (as on some Windows setups): list order, when the counts agree.
  assert.deepEqual(
    matchCapturesToDisplays([RETINA, LEFT_1X], [
      { display_id: "", thumbnail: "first" },
      { display_id: "", thumbnail: "second" },
    ], 1, empty).map((entry) => entry.image),
    ["first", "second"],
  );
  // One unlabelled source only ever belongs to the primary display.
  assert.deepEqual(
    matchCapturesToDisplays([RETINA, LEFT_1X], [{ display_id: "", thumbnail: "only" }], 1, empty).map(
      (entry) => [entry.display.id, entry.image],
    ),
    [[1, "only"]],
  );
  // A display without a usable source is dropped, never given other pixels.
  assert.deepEqual(
    matchCapturesToDisplays([RETINA, LEFT_1X], [
      { display_id: "1", thumbnail: "retina" },
      { display_id: "9", thumbnail: "stray" },
      { display_id: "8", thumbnail: "stray2" },
    ], 1, empty).map((entry) => entry.display.id),
    [1],
  );
  assert.deepEqual(
    matchCapturesToDisplays([RETINA, LEFT_1X], [
      { display_id: "1", thumbnail: "" },
      { display_id: "2", thumbnail: "left" },
    ], 1, empty).map((entry) => entry.display.id),
    [2],
  );
});

test("mixed 1x and 2x displays capture at native size and crop to the right pixels", () => {
  assert.deepEqual(captureThumbnailSize([RETINA, LEFT_1X]), { width: 2880, height: 1800 });
  assert.deepEqual(captureThumbnailSize([]), { width: 1, height: 1 });
  const rect = { x: 10, y: 20, width: 200, height: 100 };
  assert.deepEqual(
    computeRegionCropPixels({ rect, displayWidth: 1440, displayHeight: 900, imageWidth: 2880, imageHeight: 1800 }),
    { x: 20, y: 40, width: 400, height: 200 },
  );
  assert.deepEqual(
    computeRegionCropPixels({ rect, displayWidth: 1920, displayHeight: 1080, imageWidth: 1920, imageHeight: 1080 }),
    { x: 10, y: 20, width: 200, height: 100 },
  );
  // A 1x display captured into the shared 2880-wide thumbnail still maps.
  assert.deepEqual(
    computeRegionCropPixels({ rect, displayWidth: 1920, displayHeight: 1080, imageWidth: 2880, imageHeight: 1620 }),
    { x: 15, y: 30, width: 300, height: 150 },
  );
});

test("the display under the cursor is found on negative origins and across gaps", () => {
  assert.equal(displayForPoint([RETINA, LEFT_1X], { x: -10, y: 500 })?.id, 2);
  assert.equal(displayForPoint([RETINA, LEFT_1X], { x: 700, y: 400 })?.id, 1);
  // Below the shorter display, nearest wins.
  assert.equal(displayForPoint([RETINA, LEFT_1X], { x: 100, y: 1000 })?.id, 1);
  assert.equal(displayForPoint([RETINA, LEFT_1X], { x: -100, y: 1250 })?.id, 2);
  assert.equal(displayForPoint([], { x: 0, y: 0 }), null);
});

test("the hotkey selector still gets no background while the hold selector gets the frozen screen", () => {
  assert.equal(overlayBaseline("shot", false), "none");
  assert.equal(overlayBaseline("shot", true), "frozen-jpeg");
  assert.equal(overlayBaseline("pen", false), "png");
  assert.equal(overlayBaseline("pen", true), "png");
});

// ---- Freeze, then select ---------------------------------------------------------------

test("the hold flow freezes every display before any selector window or focus", async () => {
  const order: string[] = [];
  let releaseFreeze: () => void = () => undefined;
  const frozen = new Promise<void>((resolve) => {
    releaseFreeze = resolve;
  });
  const flow = runHoldFlow<string>({
    ensureAccess: async () => {
      order.push("access");
      return true;
    },
    freeze: async () => {
      order.push("freeze-start");
      await frozen;
      order.push("freeze-done");
      return ["display-1", "display-2"];
    },
    select: async (frames) => {
      order.push(`select:${frames.join(",")}`);
      order.push("focus");
      return Buffer.from("png");
    },
    deliver: async (capture) => {
      order.push("deliver-start");
      const png = await capture();
      order.push(`delivered:${png?.toString() ?? "null"}`);
    },
    trace: (event) => order.push(`trace:${event}`),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!order.some((entry) => entry.startsWith("select") || entry === "focus"));
  releaseFreeze();
  assert.equal(await flow, "delivered");
  assert.deepEqual(order, [
    "access",
    "trace:capture-start",
    "freeze-start",
    "freeze-done",
    "trace:capture-complete",
    "deliver-start",
    "select:display-1,display-2",
    "focus",
    "delivered:png",
  ]);
});

test("the hold flow stops before freezing without access and fails without displays", async () => {
  let froze = false;
  assert.equal(
    await runHoldFlow({
      ensureAccess: async () => false,
      freeze: async () => {
        froze = true;
        return [1];
      },
      select: async () => null,
      deliver: async () => undefined,
    }),
    "no-access",
  );
  assert.equal(froze, false);
  let selected = false;
  await assert.rejects(
    runHoldFlow({
      ensureAccess: async () => true,
      freeze: async () => [],
      select: async () => {
        selected = true;
        return null;
      },
      deliver: async (capture) => {
        await capture();
      },
    }),
    /could not capture a display/,
  );
  assert.equal(selected, false);
});

// ---- Wording and setup rules ---------------------------------------------------------

test("the hold delay is shown in one unit, and 0.2 s says it may catch slow clicks", () => {
  assert.equal(formatHoldDelay(500), "0.5 s");
  assert.equal(formatHoldDelay(1000), "1 s");
  assert.equal(formatHoldDelay(350), "0.35 s");
  assert.equal(formatHoldDelay(1500), "1.5 s");
  assert.equal(formatHoldDelay(50), "0.2 s");
  assert.deepEqual(holdDelayChoices(500).map(holdDelayLabel), [
    "0.2 s (may catch slow clicks)",
    "0.35 s",
    "0.5 s (default)",
    "0.75 s",
    "1 s",
    "1.5 s",
  ]);
  assert.equal(holdDelayLabel(420), "0.42 s");
});

test("macOS setup asks macOS once per version, then opens the settings pane", () => {
  assert.equal(holdSetupStep("", "0.6.0"), "prompt");
  assert.equal(holdSetupStep("0.5.9", "0.6.0"), "prompt");
  assert.equal(holdSetupStep("0.6.0", "0.6.0"), "open-settings");
  const offer = (state: string, introducedVersion: string, platform: NodeJS.Platform = "darwin") =>
    shouldOfferHoldSetup({ platform, state, introducedVersion, appVersion: "0.6.0" });
  assert.equal(offer("needs-permission", ""), true);
  assert.equal(offer("needs-permission", "0.5.9"), true, "a new version needs a fresh approval");
  assert.equal(offer("needs-permission", "0.6.0"), false, "offered automatically once per version");
  assert.equal(offer("active", ""), false);
  assert.equal(offer("needs-permission", "", "win32"), false);
});

test("mixed-DPI frames are brought to each display's own pixels, so crops are native size", () => {
  // desktopCapturer letterbox-fits every screen into the one shared size.
  const shared = captureThumbnailSize([RETINA, LEFT_1X]);
  const scale = Math.min(shared.width / 1920, shared.height / 1080);
  const fitted = { width: Math.round(1920 * scale), height: Math.round(1080 * scale) };
  assert.deepEqual(fitted, { width: 2880, height: 1620 });
  assert.equal(needsNativeResize(fitted, LEFT_1X), true);
  assert.deepEqual(nativeCaptureSize(LEFT_1X), { width: 1920, height: 1080 });
  assert.equal(needsNativeResize({ width: 2880, height: 1800 }, RETINA), false);
  const native = nativeCaptureSize(LEFT_1X);
  const crop = computeRegionCropPixels({
    rect: { x: 10, y: 20, width: 200, height: 100 },
    displayWidth: 1920,
    displayHeight: 1080,
    imageWidth: native.width,
    imageHeight: native.height,
  });
  assert.deepEqual({ width: crop.width, height: crop.height }, { width: 200, height: 100 });
});

test("the macOS setup card is a scriptless page with three fixed routes, not a modal dialog", () => {
  assert.equal(holdSetupRoute(HOLD_SETUP_CONTINUE_URL), "continue");
  assert.equal(holdSetupRoute(HOLD_SETUP_LATER_URL), "later");
  assert.equal(holdSetupRoute(HOLD_SETUP_OFF_URL), "off");
  assert.equal(holdSetupRoute("https://example.com/"), null);
  assert.equal(holdSetupRoute("ke-pen-hold://continue/extra"), null);

  const copy = holdSetupParagraphs({ delay: "0.75 s", staleEntryHint: false });
  assert.match(copy[0]!, /for 0\.75 s and KE Pen freezes the screen/);
  assert.match(copy[0]!, /A quick middle click still works; it just lands when you let go\./);
  assert.match(copy[1]!, /\u201cke-pen-hold-helper\u201d/);
  assert.match(copy[1]!, /never saves, sends or logs where you click/);
  assert.equal(copy.length, 2);
  assert.equal(holdSetupParagraphs({ delay: "0.5 s", staleEntryHint: true }).length, 3);

  const html = holdSetupDocument({ delay: "<b>0.5 s</b>", staleEntryHint: false });
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<b>0\.5 s<\/b>/, "text is escaped");
  for (const url of [HOLD_SETUP_CONTINUE_URL, HOLD_SETUP_LATER_URL, HOLD_SETUP_OFF_URL]) {
    assert.ok(html.includes(`href="${url}"`));
  }
  assert.deepEqual(holdSetupBounds({ x: 0, y: 25, width: 1440, height: 875 }), {
    x: 962,
    y: 43,
    width: 460,
    height: 318,
  });
  assert.throws(() => holdSetupBounds({ x: 0, y: 0, width: 0, height: 900 }));

  // The explanation never blocks KE Pen's main loop with a modal message box.
  const main = readFileSync(new URL("../desktop/main.ts", import.meta.url), "utf8");
  const explain = main.slice(main.indexOf("function explainHoldPermission("), main.indexOf("async function continueHoldSetup("));
  assert.doesNotMatch(explain, /showMessageBox/);
  assert.match(explain, /showInactive\(\)/);
});

// ---- Overlay pointer rules --------------------------------------------------------------

test("only a primary-button stroke draws Pen ink; middle and right presses never do", () => {
  assert.equal(startsPenStroke(0), true);
  assert.equal(startsPenStroke(1), false);
  assert.equal(startsPenStroke(2), false);
  assert.equal(startsPenStroke(3), false);
  // The renderer really uses the rule, first thing in the Pen pointer handler.
  const renderer = readFileSync(new URL("../desktop/renderer.ts", import.meta.url), "utf8");
  const handler = renderer.slice(renderer.indexOf("function handlePointerDown("));
  const firstLines = handler.split("\n").slice(0, 5).join("\n");
  assert.match(firstLines, /if \(!startsPenStroke\(event\.button\)\) return;/);
});

test("in the KE Shot selector a right or middle click cancels and only the primary button selects", () => {
  assert.equal(regionPointerAction(0), "select");
  assert.equal(regionPointerAction(1), "cancel");
  assert.equal(regionPointerAction(2), "cancel");
  assert.equal(regionPointerAction(3), "ignore");
  const renderer = readFileSync(new URL("../desktop/renderer.ts", import.meta.url), "utf8");
  const handler = renderer.slice(renderer.indexOf("function handleRegionPointerDown("));
  assert.match(handler.slice(0, 900), /regionPointerAction\(event\.button\)[\s\S]*window\.kePen\.cancel\(\)/);
});

test("the frozen frame appears undimmed, fades in, and closes itself after a quiet minute", () => {
  assert.equal(frozenDimAlpha(null), 0);
  assert.equal(frozenDimAlpha(0), 0);
  assert.ok(Math.abs(frozenDimAlpha(FROZEN_DIM_FADE_MS / 2) - SELECTOR_DIM_ALPHA / 2) < 1e-9);
  assert.equal(frozenDimAlpha(FROZEN_DIM_FADE_MS), SELECTOR_DIM_ALPHA);
  assert.equal(frozenDimAlpha(10_000), SELECTOR_DIM_ALPHA);
  assert.equal(FROZEN_IDLE_CANCEL_MS, 60_000);
});

test("the selector badge names each cancel path once and stays off what you point at", () => {
  const detail = (patch: Partial<Parameters<typeof shotBadgeDetail>[0]>) =>
    shotBadgeDetail({ frozen: true, pointerDisplay: true, selection: null, shortcut: "⌘⇧2", ...patch });
  assert.equal(detail({}), "Drag to capture · Esc or click to cancel");
  assert.equal(detail({ frozen: false }), "Drag to capture · Esc or click to cancel · ⌘⇧2");
  assert.equal(detail({ pointerDisplay: false }), "Esc or click to cancel");
  assert.equal(detail({ selection: { width: 200.4, height: 99.6 } }), "200 × 100 · release to capture");
  assert.doesNotMatch(detail({}), /FROZEN/);

  const viewport = { width: 1440, height: 900 };
  const badge = { width: 245, height: 55 };
  assert.equal(badgeCorner("top-left", [{ x: 700, y: 450 }], viewport, badge), "top-left");
  // Aiming at the menu bar, just under the badge: it moves out of the way.
  assert.equal(badgeCorner("top-left", [{ x: 60, y: 90 }], viewport, badge), "bottom-right");
  // A selection spanning both corners leaves it where it is.
  assert.equal(
    badgeCorner("top-left", [{ x: 20, y: 20 }, { x: 1420, y: 880 }], viewport, badge),
    "top-left",
  );
  assert.equal(badgeCorner("bottom-right", [{ x: 1400, y: 860 }], viewport, badge), "top-left");
});

// ---- Packaged-build boundary ---------------------------------------------------------------

test("the hold proof and its helper override are ignored by a packaged KE Pen", () => {
  const main = readFileSync(new URL("../desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /const HOLD_PROOF = app\.isPackaged\s*\?\s*undefined/);
  assert.match(main, /const override = IS_HOLD_PROOF \? process\.env\.KE_PEN_HOLD_HELPER_OVERRIDE : undefined;/);
  // KE Pen itself never asks macOS for Accessibility; the helper does.
  assert.doesNotMatch(main, /isTrustedAccessibilityClient/);
});

test("electron-builder turns off the Node.js entry points the MCP bridge does not need", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(config, /electronFuses:/);
  assert.match(config, /enableNodeOptionsEnvironmentVariable: false/);
  assert.match(config, /enableNodeCliInspectArguments: false/);
  assert.match(config, /onlyLoadAppFromAsar: true/);
  // The embedded MCP server is started as KE Pen's executable in Node mode.
  assert.match(config, /runAsNode: true/);
});

// ---- Supervisor against a fake helper process ----------------------------------------------

interface Scheduled {
  ms: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeTimers implements HoldTimers {
  current = 5_000_000;
  scheduled: Scheduled[] = [];
  now(): number {
    return this.current;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const entry: Scheduled = { ms, callback, cancelled: false };
    this.scheduled.push(entry);
    return entry;
  }
  clearTimeout(handle: unknown): void {
    if (handle) (handle as Scheduled).cancelled = true;
  }
  pending(ms?: number): Scheduled[] {
    return this.scheduled.filter((entry) => !entry.cancelled && (ms === undefined || entry.ms === ms));
  }
  fire(entry: Scheduled): void {
    entry.cancelled = true;
    entry.callback();
  }
}

interface Harness {
  supervisor: HoldHelperSupervisor;
  timers: FakeTimers;
  statuses: HoldHelperStatus[];
  holds: number[];
  log: string;
  waitFor(predicate: (status: HoldHelperStatus) => boolean, label: string): Promise<HoldHelperStatus>;
  commands(): Promise<string[]>;
  dispose(): Promise<void>;
}

async function harness(mode: string, extraEnv: NodeJS.ProcessEnv = {}, command?: string): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ke-pen-hold-supervisor-"));
  const log = join(directory, "commands.log");
  const timers = new FakeTimers();
  const statuses: HoldHelperStatus[] = [];
  const holds: number[] = [];
  const waiters: Array<{ predicate: (status: HoldHelperStatus) => boolean; resolve: (status: HoldHelperStatus) => void }> = [];
  const supervisor = new HoldHelperSupervisor({
    command: command ?? process.execPath,
    args: command ? [] : [FAKE_HELPER],
    env: {
      ...process.env,
      FAKE_HOLD_MODE: mode,
      FAKE_HOLD_VERSION: "0.6.0-test",
      FAKE_HOLD_LOG: log,
      ...extraEnv,
    },
    expectedVersion: "0.6.0-test",
    timers,
    onHold: (sequence) => holds.push(sequence),
    onStatus: (status) => {
      statuses.push(status);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(status)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(status);
        }
      }
    },
  });
  return {
    supervisor,
    timers,
    statuses,
    holds,
    log,
    waitFor: (predicate, label) =>
      new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 8_000);
        waiters.push({
          predicate,
          resolve: (status) => {
            clearTimeout(timer);
            resolvePromise(status);
          },
        });
      }),
    commands: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.length > 0),
    dispose: async () => {
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("the supervisor sends config and the arm state on ready, and quit on stop", async () => {
  const h = await harness("normal");
  try {
    h.supervisor.configure(750);
    h.supervisor.setArmed(true);
    h.supervisor.start();
    await h.waitFor((status) => status.state === "active", "active");
    await eventually(async () => (await h.commands()).length >= 2, "config and arm");
    assert.deepEqual((await h.commands()).slice(0, 2), ['{"cmd":"config","thresholdMs":750}', '{"cmd":"arm"}']);
    h.supervisor.setArmed(false);
    h.supervisor.setArmed(false); // unchanged state is not re-sent
    h.supervisor.configure(9_999);
    await eventually(async () => (await h.commands()).length >= 4, "disarm and config");
    assert.deepEqual((await h.commands()).slice(2), ['{"cmd":"disarm"}', '{"cmd":"config","thresholdMs":1500}']);
    await h.supervisor.stop();
    assert.equal(h.supervisor.current.state, "stopped");
    assert.equal((await h.commands()).at(-1), '{"cmd":"quit"}');
    assert.equal(h.supervisor.pid, null);
  } finally {
    await h.dispose();
  }
});

test("stop closes stdin, so even a helper that ignores quit exits", async () => {
  const h = await harness("normal", { FAKE_HOLD_IGNORE_QUIT: "1" });
  try {
    h.supervisor.start();
    await h.waitFor((status) => status.state === "active", "active");
    const started = Date.now();
    await h.supervisor.stop();
    assert.ok(Date.now() - started < 3_000);
    assert.equal(h.supervisor.current.state, "stopped");
  } finally {
    await h.dispose();
  }
});

test("a crashing helper restarts with back-off, gives up, and can be restarted by hand", async () => {
  const h = await harness("crash");
  try {
    h.supervisor.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.waitFor((status) => status.state === "restarting" && status.restarts === attempt + 1, `restart ${attempt + 1}`);
      const pending = h.timers.pending().filter((entry) => entry.ms !== HOLD_READY_TIMEOUT_MS);
      const restart = pending.at(-1)!;
      delays.push(restart.ms);
      h.timers.fire(restart);
    }
    assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000]);
    const failed = await h.waitFor((status) => status.state === "failed", "give up");
    assert.equal(failed.restarts, 5);
    assert.equal(h.timers.pending().filter((entry) => entry.ms !== HOLD_READY_TIMEOUT_MS).length, 0);

    h.supervisor.restart();
    await h.waitFor((status) => status.state === "restarting" && status.restarts === 7, "manual restart then crash");
    assert.equal(h.timers.pending().filter((entry) => entry.ms !== HOLD_READY_TIMEOUT_MS).at(-1)?.ms, 500);
  } finally {
    await h.dispose();
  }
});

test("a helper that never says ready is killed after five seconds and restarted", async () => {
  const h = await harness("silent");
  try {
    h.supervisor.start();
    assert.equal(h.supervisor.current.state, "starting");
    const readyTimer = h.timers.pending(HOLD_READY_TIMEOUT_MS)[0];
    assert.ok(readyTimer, "a ready timeout was scheduled");
    h.timers.fire(readyTimer);
    const restarting = await h.waitFor((status) => status.state === "restarting", "restart after no ready");
    assert.equal(restarting.lastError, "no-ready");
  } finally {
    await h.dispose();
  }
});

test("a helper from another build is refused", async () => {
  const h = await harness("wrong-version");
  try {
    h.supervisor.start();
    const restarting = await h.waitFor((status) => status.state === "restarting", "restart after mismatch");
    assert.equal(restarting.lastError, "version-mismatch");
    assert.equal(h.holds.length, 0);
  } finally {
    await h.dispose();
  }
});

test("needs-permission is reported and holds are only forwarded from an active helper", async () => {
  const waiting = await harness("needs-permission");
  try {
    waiting.supervisor.start();
    await waiting.waitFor((status) => status.state === "needs-permission", "needs-permission");
  } finally {
    await waiting.dispose();
  }
  const active = await harness("hold-on-arm");
  try {
    active.supervisor.setArmed(true);
    active.supervisor.start();
    await active.waitFor((status) => status.state === "active", "active");
    await eventually(async () => active.holds.length === 1, "a hold");
    assert.deepEqual(active.holds, [1]);
  } finally {
    await active.dispose();
  }
});

test("the permission prompt is only sent to a helper that is waiting for it", async () => {
  const waiting = await harness("needs-permission");
  try {
    assert.equal(waiting.supervisor.requestPermissionPrompt(), false, "not before the helper is ready");
    waiting.supervisor.start();
    await waiting.waitFor((status) => status.state === "needs-permission", "needs-permission");
    assert.equal(waiting.supervisor.requestPermissionPrompt(), true);
    await eventually(async () => (await waiting.commands()).includes('{"cmd":"prompt"}'), "the prompt");
  } finally {
    await waiting.dispose();
  }
  const active = await harness("normal");
  try {
    active.supervisor.start();
    await active.waitFor((status) => status.state === "active", "active");
    assert.equal(active.supervisor.requestPermissionPrompt(), false, "an active helper needs no prompt");
  } finally {
    await active.dispose();
  }
});

test("a missing helper leaves hold to capture unavailable without a restart loop", async () => {
  const missing = resolve(tmpdir(), "definitely-missing-ke-pen-hold-helper");
  const h = await harness("normal", {}, missing);
  try {
    h.supervisor.start();
    const status = await h.waitFor((candidate) => candidate.state === "unavailable", "unavailable");
    assert.equal(status.lastError, "helper-missing");
    assert.equal(h.timers.pending().filter((entry) => entry.ms !== HOLD_READY_TIMEOUT_MS).length, 0);
    h.supervisor.start();
    assert.equal(h.supervisor.current.state, "unavailable");
  } finally {
    await h.dispose();
  }
});
