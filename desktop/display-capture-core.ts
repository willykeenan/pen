// Pure display bookkeeping for KE Pen's full-screen captures: how large a
// thumbnail to ask for, which captured source belongs to which display, and
// which display a point is on. Kept out of main.ts so multi-display cases are
// unit-tested without Electron.

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureDisplay {
  id: number;
  bounds: CaptureRect;
  size: { width: number; height: number };
  scaleFactor: number;
}

export interface CaptureSource<Image> {
  display_id: string;
  thumbnail: Image;
}

// One size for every source: the largest physical width and height across
// displays, so no display is captured below its native resolution.
export function captureThumbnailSize(displays: readonly CaptureDisplay[]): { width: number; height: number } {
  if (displays.length === 0) return { width: 1, height: 1 };
  return {
    width: Math.max(...displays.map((display) => Math.ceil(display.size.width * display.scaleFactor))),
    height: Math.max(...displays.map((display) => Math.ceil(display.size.height * display.scaleFactor))),
  };
}

// A display's own pixel size. desktopCapturer fits every screen into the one
// shared thumbnail size, which upscales a lower-resolution display beside a
// Retina one; frames are brought back to exactly this size before use.
export function nativeCaptureSize(display: CaptureDisplay): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
  };
}

export function needsNativeResize(
  image: { width: number; height: number },
  display: CaptureDisplay,
): boolean {
  const native = nativeCaptureSize(display);
  return image.width !== native.width || image.height !== native.height;
}

// Matches by exact display id first; falls back to list order when the counts
// agree, and to the only source for the primary display. A display with no
// usable source is dropped rather than shown with somebody else's pixels.
export function matchCapturesToDisplays<Display extends { id: number }, Image>(
  displays: readonly Display[],
  sources: readonly CaptureSource<Image>[],
  primaryId: number,
  isEmpty: (image: Image) => boolean,
): Array<{ display: Display; image: Image }> {
  return displays.flatMap((display, index) => {
    const exact = sources.find((source) => source.display_id === String(display.id));
    const indexed = sources.length === displays.length ? sources[index] : undefined;
    const single = display.id === primaryId && sources.length === 1 ? sources[0] : undefined;
    const source = exact ?? indexed ?? single;
    if (!source || isEmpty(source.thumbnail)) return [];
    return [{ display, image: source.thumbnail }];
  });
}

function contains(bounds: CaptureRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}

// The display under a point, or the nearest one when the point sits in a gap
// between displays of different sizes.
export function displayForPoint<Display extends { bounds: CaptureRect }>(
  displays: readonly Display[],
  point: { x: number; y: number },
): Display | null {
  const inside = displays.find((display) => contains(display.bounds, point));
  if (inside) return inside;
  let best: Display | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    const dx = Math.max(x - point.x, 0, point.x - (x + width - 1));
    const dy = Math.max(y - point.y, 0, point.y - (y + height - 1));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}
