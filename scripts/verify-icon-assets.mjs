import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

async function inspectPng(relativePath) {
  const file = path.join(root, relativePath);
  const png = await readFile(file);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${relativePath} is not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageChunks = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      imageChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  assert.equal(bitDepth, 8, `${relativePath} must use 8-bit channels`);
  assert.equal(colorType, 6, `${relativePath} must retain RGBA pixels`);
  assert.equal(interlace, 0, `${relativePath} must be non-interlaced`);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(imageChunks));
  assert.equal(inflated.length, height * (stride + 1), `${relativePath} has an unexpected scanline size`);

  let rawOffset = 0;
  let previous = Buffer.alloc(stride);
  let minimumAlpha = 255;
  let maximumAlpha = 0;
  let visiblePixels = 0;
  const corners = [];

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[rawOffset];
    rawOffset += 1;
    const encoded = inflated.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const row = Buffer.allocUnsafe(stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const value = encoded[x];
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 0xff;
      else if (filter === 2) row[x] = (value + above) & 0xff;
      else if (filter === 3) row[x] = (value + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) row[x] = (value + paeth(left, above, upperLeft)) & 0xff;
      else assert.fail(`${relativePath} uses unsupported PNG filter ${filter}`);
    }

    for (let x = 0; x < width; x += 1) {
      const alpha = row[x * bytesPerPixel + 3];
      minimumAlpha = Math.min(minimumAlpha, alpha);
      maximumAlpha = Math.max(maximumAlpha, alpha);
      if (alpha > 0) visiblePixels += 1;
      if ((x === 0 || x === width - 1) && (y === 0 || y === height - 1)) corners.push(alpha);
    }
    previous = row;
  }

  return { relativePath, width, height, minimumAlpha, maximumAlpha, visiblePixels, corners };
}

const specifications = [
  { file: "assets/pen-icon.png", width: 1024, height: 1024, maximumVisibleRatio: 0.98 },
  { file: "assets/trayTemplate.png", width: 18, height: 18, maximumVisibleRatio: 0.65 },
  { file: "assets/trayTemplate@2x.png", width: 36, height: 36, maximumVisibleRatio: 0.65 },
];

const receipts = [];
for (const specification of specifications) {
  const receipt = await inspectPng(specification.file);
  assert.equal(receipt.width, specification.width, `${specification.file} has the wrong width`);
  assert.equal(receipt.height, specification.height, `${specification.file} has the wrong height`);
  assert.equal(receipt.minimumAlpha, 0, `${specification.file} has no transparent pixels`);
  assert.equal(receipt.maximumAlpha, 255, `${specification.file} has no fully opaque pixels`);
  assert.deepEqual(receipt.corners, [0, 0, 0, 0], `${specification.file} corners must be transparent`);
  const visibleRatio = receipt.visiblePixels / (receipt.width * receipt.height);
  assert.ok(visibleRatio > 0.02, `${specification.file} has no visible glyph`);
  assert.ok(visibleRatio < specification.maximumVisibleRatio, `${specification.file} has an opaque background`);
  receipts.push({ ...receipt, visibleRatio: Number(visibleRatio.toFixed(4)) });
}

process.stdout.write(`${JSON.stringify({ ok: true, icons: receipts }, null, 2)}\n`);
