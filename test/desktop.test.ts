import assert from "node:assert/strict";
import test from "node:test";
import { computeCropGeometry } from "../desktop/crop-geometry.js";

test("cross-platform crop geometry maps display points to screenshot pixels", () => {
  const geometry = computeCropGeometry({
    screenWidth: 1_440,
    screenHeight: 900,
    imageWidth: 2_880,
    imageHeight: 1_800,
    strokes: [
      [
        { x: 100, y: 120, t: 0 },
        { x: 300, y: 260, t: 0.4 },
      ],
    ],
  });

  assert.deepEqual(geometry.strokeBoundsPoints, { x: 100, y: 120, width: 200, height: 140 });
  assert.deepEqual(geometry.cropRectPixels, { x: 112, y: 152, width: 576, height: 456 });
  assert.equal(geometry.lineWidthPixels, 8);
  assert.ok(geometry.normalizedStrokes[0]![0]!.x > 0);
  assert.ok(geometry.normalizedStrokes[0]![1]!.x < 1);
});

test("cross-platform crop geometry clamps marks at display edges", () => {
  const geometry = computeCropGeometry({
    screenWidth: 800,
    screenHeight: 600,
    imageWidth: 800,
    imageHeight: 600,
    strokes: [[{ x: 2, y: 3, t: 0 }]],
  });

  assert.deepEqual(geometry.cropRectPixels, { x: 0, y: 0, width: 48, height: 49 });
  assert.equal(geometry.normalizedStrokes[0]![0]!.x, 2 / 48);
  assert.equal(geometry.normalizedStrokes[0]![0]!.y, 3 / 49);
});

test("cross-platform crop geometry rejects empty and non-finite marks", () => {
  assert.throws(
    () =>
      computeCropGeometry({
        screenWidth: 800,
        screenHeight: 600,
        imageWidth: 800,
        imageHeight: 600,
        strokes: [],
      }),
    /visible stroke/,
  );
  assert.throws(
    () =>
      computeCropGeometry({
        screenWidth: 800,
        screenHeight: 600,
        imageWidth: 800,
        imageHeight: 600,
        strokes: [[{ x: Number.NaN, y: 3, t: 0 }]],
      }),
    /non-finite/,
  );
});
