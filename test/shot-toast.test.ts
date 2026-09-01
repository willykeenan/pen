import assert from "node:assert/strict";
import test from "node:test";
import {
  SHOT_LINK_TOAST_DISMISS_URL,
  SHOT_LINK_TOAST_OPEN_URL,
  shotLinkToastBounds,
  shotLinkToastDocument,
  shotLinkToastRoute,
} from "../desktop/shot-toast-core.js";

test("the KE Shot link popup sits in the top-right work area on every display", () => {
  assert.deepEqual(
    shotLinkToastBounds({ x: 0, y: 25, width: 1_728, height: 1_055 }),
    { x: 1_326, y: 43, width: 384, height: 112 },
  );
  assert.deepEqual(
    shotLinkToastBounds({ x: -1_920, y: 0, width: 1_920, height: 1_080 }),
    { x: -402, y: 18, width: 384, height: 112 },
  );
});

test("the link popup stays on-screen when a display is smaller than the normal card", () => {
  assert.deepEqual(
    shotLinkToastBounds({ x: 10, y: 20, width: 300, height: 90 }),
    { x: 28, y: 38, width: 264, height: 54 },
  );
  assert.throws(
    () => shotLinkToastBounds({ x: 0, y: 0, width: Number.NaN, height: 100 }),
    /invalid display/,
  );
  assert.throws(
    () => shotLinkToastBounds({ x: 0, y: 0, width: 100, height: 0 }),
    /invalid display/,
  );
});

test("the popup renderer is static, sandboxable, and never receives the private viewer URL", () => {
  const document = shotLinkToastDocument();
  assert.match(document, /Content-Security-Policy/);
  assert.match(document, /ke-pen-toast:\/\/open\//);
  assert.match(document, /ke-pen-toast:\/\/dismiss\//);
  assert.equal(document.includes(SHOT_LINK_TOAST_OPEN_URL), true);
  assert.equal(document.includes(SHOT_LINK_TOAST_DISMISS_URL), true);
  assert.match(document, /KE Shot link ready/);
  assert.doesNotMatch(document, /https?:\/\//);
  assert.doesNotMatch(document, /<script/i);
  assert.match(shotLinkToastDocument("jpeg"), /Clipboard keeps the lossless original/);
  assert.match(shotLinkToastDocument("jpeg+downscale"), /Uploaded after resizing/);
});

test("the popup accepts only its fixed open and dismiss routes", () => {
  assert.equal(shotLinkToastRoute(SHOT_LINK_TOAST_OPEN_URL), "open");
  assert.equal(shotLinkToastRoute(SHOT_LINK_TOAST_DISMISS_URL), "dismiss");
  assert.equal(shotLinkToastRoute("https://example.test/private"), null);
  assert.equal(shotLinkToastRoute("ke-pen-toast://open/anything-else"), null);
});
