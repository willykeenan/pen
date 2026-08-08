export interface PenPoint {
  x: number;
  y: number;
  t: number;
}

export interface PenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropGeometry {
  strokeBoundsPoints: PenRect;
  cropRectPixels: PenRect;
  normalizedStrokes: PenPoint[][];
  lineWidthPixels: number;
}

export interface CropGeometryInput {
  screenWidth: number;
  screenHeight: number;
  imageWidth: number;
  imageHeight: number;
  strokes: PenPoint[][];
  paddingPoints?: number;
}

const MAX_STROKES = 1_000;
const MAX_POINTS_PER_STROKE = 100_000;

export function computeCropGeometry(input: CropGeometryInput): CropGeometry {
  const { screenWidth, screenHeight, imageWidth, imageHeight, strokes } = input;
  const padding = input.paddingPoints ?? 44;
  for (const [name, value] of Object.entries({
    screenWidth,
    screenHeight,
    imageWidth,
    imageHeight,
    padding,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Pen received an invalid ${name}.`);
    }
  }
  if (strokes.length === 0 || strokes.length > MAX_STROKES) {
    throw new Error("Draw a visible stroke before sending it to the AI.");
  }

  const points: PenPoint[] = [];
  for (const stroke of strokes) {
    if (stroke.length === 0 || stroke.length > MAX_POINTS_PER_STROKE) {
      throw new Error("Pen received an invalid stroke.");
    }
    for (const point of stroke) {
      if (![point.x, point.y, point.t].every(Number.isFinite)) {
        throw new Error("Pen received a non-finite stroke point.");
      }
      points.push(point);
    }
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const strokeBoundsPoints: PenRect = {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 2),
    height: Math.max(maxY - minY, 2),
  };

  const left = clamp(strokeBoundsPoints.x - padding, 0, screenWidth);
  const top = clamp(strokeBoundsPoints.y - padding, 0, screenHeight);
  const right = clamp(
    strokeBoundsPoints.x + strokeBoundsPoints.width + padding,
    0,
    screenWidth,
  );
  const bottom = clamp(
    strokeBoundsPoints.y + strokeBoundsPoints.height + padding,
    0,
    screenHeight,
  );
  if (right - left < 1 || bottom - top < 1) {
    throw new Error("Pen could not crop the selected screen region.");
  }

  const scaleX = imageWidth / screenWidth;
  const scaleY = imageHeight / screenHeight;
  const pixelLeft = clamp(Math.floor(left * scaleX), 0, imageWidth - 1);
  const pixelTop = clamp(Math.floor(top * scaleY), 0, imageHeight - 1);
  const pixelRight = clamp(Math.ceil(right * scaleX), pixelLeft + 1, imageWidth);
  const pixelBottom = clamp(Math.ceil(bottom * scaleY), pixelTop + 1, imageHeight);
  const cropRectPixels: PenRect = {
    x: pixelLeft,
    y: pixelTop,
    width: pixelRight - pixelLeft,
    height: pixelBottom - pixelTop,
  };

  const normalizedStrokes = strokes.map((stroke) =>
    stroke.map((point) => ({
      x: clamp(
        (point.x * scaleX - cropRectPixels.x) / cropRectPixels.width,
        0,
        1,
      ),
      y: clamp(
        (point.y * scaleY - cropRectPixels.y) / cropRectPixels.height,
        0,
        1,
      ),
      t: point.t,
    })),
  );

  return {
    strokeBoundsPoints,
    cropRectPixels,
    normalizedStrokes,
    lineWidthPixels: Math.max(4, ((scaleX + scaleY) / 2) * 4),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
