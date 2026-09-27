import { computeCropGeometry, type PenPoint, type PenRect } from "./crop-geometry.js";
import {
  badgeCorner,
  FROZEN_BADGE_TITLE,
  FROZEN_BORDER_COLOR,
  FROZEN_DIM_FADE_MS,
  FROZEN_IDLE_CANCEL_MS,
  frozenDimAlpha,
  LIVE_BADGE_TITLE,
  regionPointerAction,
  SELECTOR_DIM_ALPHA,
  shotBadgeDetail,
  startsPenStroke,
  type BadgeCorner,
} from "./overlay-core.js";

interface Bootstrap {
  mode: "pen" | "shot";
  displayId: number;
  screenWidth: number;
  screenHeight: number;
  baselineDataUrl: string;
  // Hold to capture: the overlay shows the screen as it was when the hold
  // fired, so menus that have since closed are still there to select.
  frozen?: boolean;
  // The display under the pointer carries the full instructions.
  pointerDisplay?: boolean;
  shortcut: string;
}

interface PenBridge {
  bootstrap(): Promise<Bootstrap>;
  beginStroke(): boolean;
  releaseDisplay(): Promise<boolean>;
  submitAnnotation(payload: unknown): Promise<{ id: string }>;
  submitShotRegion(payload: unknown): Promise<{ ok: boolean }>;
  cancel(): void;
  overlayReady(): void;
  onPhase(callback: (phase: string) => void): void;
  onShown(callback: () => void): void;
}

declare global {
  interface Window {
    kePen: PenBridge;
  }
}

const canvas = requiredElement<HTMLCanvasElement>("ink");
const badgeTitle = requiredElement<HTMLElement>("badge-title");
const badgeDetail = requiredElement<HTMLElement>("badge-detail");
const context = requiredCanvasContext(canvas);

let bootstrap: Bootstrap;
let baseline: HTMLImageElement;
let phase = "drawing";
let strokes: PenPoint[][] = [];
let currentStroke: PenPoint[] | null = null;
let activePointerId: number | null = null;
let finalizeTimer: number | undefined;
let startedAt = performance.now();
let regionOrigin: { x: number; y: number } | null = null;
let regionPoint: { x: number; y: number } | null = null;
let regionSubmitted = false;
let frozenImage: HTMLImageElement | null = null;
let frozenShownAt: number | null = null;
let frozenIdleTimer: number | undefined;
let shotBadgeCorner: BadgeCorner = "top-left";

window.kePen.onPhase((nextPhase) => {
  phase = nextPhase;
  renderBadge();
  if (nextPhase === "clearing") {
    document.body.classList.add("clearing");
  }
});

void initialize();

async function initialize(): Promise<void> {
  bootstrap = await window.kePen.bootstrap();
  if (bootstrap.mode === "shot") {
    if (bootstrap.frozen && bootstrap.baselineDataUrl.length > 0) {
      frozenImage = await loadImage(bootstrap.baselineDataUrl);
      document.body.dataset.frozen = "true";
    }
    initializeShot();
    if (frozenImage) {
      window.kePen.onShown(startFrozenFadeIn);
      armFrozenIdleCancel();
    }
    document.body.dataset.ready = "true";
    // The frozen frame is drawn: KE Pen may show this window and take focus
    // without the live screen (and a closing menu) ever showing through.
    window.kePen.overlayReady();
    return;
  }
  baseline = await loadImage(bootstrap.baselineDataUrl);
  resizeCanvas();
  renderBadge();
  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("keydown", handleKeyDown);
}

function initializeShot(): void {
  badgeTitle.textContent = frozenImage ? FROZEN_BADGE_TITLE : LIVE_BADGE_TITLE;
  resizeCanvas();
  renderBadge();
  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("pointerdown", handleRegionPointerDown);
  canvas.addEventListener("pointermove", handleRegionPointerMove);
  canvas.addEventListener("pointerup", handleRegionPointerUp);
  canvas.addEventListener("pointercancel", handleRegionPointerCancel);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// The frozen frame goes up exactly as the screen was, so showing it is not a
// visible cut; then the dim fades in over a moment.
function startFrozenFadeIn(): void {
  if (frozenShownAt !== null) return;
  frozenShownAt = performance.now();
  const step = (): void => {
    draw();
    if (frozenShownAt !== null && performance.now() - frozenShownAt < FROZEN_DIM_FADE_MS) {
      window.requestAnimationFrame(step);
    }
  };
  window.requestAnimationFrame(step);
}

// A forgotten freeze closes itself after a minute without input.
function armFrozenIdleCancel(): void {
  window.clearTimeout(frozenIdleTimer);
  frozenIdleTimer = window.setTimeout(() => {
    if (!regionSubmitted) window.kePen.cancel();
  }, FROZEN_IDLE_CANCEL_MS);
}

function handleRegionPointerDown(event: PointerEvent): void {
  if (frozenImage) armFrozenIdleCancel();
  if (regionSubmitted || regionOrigin) return;
  // The selection is a primary-button drag. A right or middle click cancels;
  // the middle press that opened a hold selector never reaches it, because
  // the helper swallows that press from start to finish.
  const action = regionPointerAction(event.button);
  if (action === "cancel") {
    event.preventDefault();
    window.kePen.cancel();
    return;
  }
  if (action !== "select") return;
  if (!window.kePen.beginStroke()) return;
  activePointerId = event.pointerId;
  regionOrigin = { x: event.clientX, y: event.clientY };
  regionPoint = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  draw();
  renderBadge();
}

function handleRegionPointerMove(event: PointerEvent): void {
  if (frozenImage) armFrozenIdleCancel();
  moveBadgeAwayFrom([{ x: event.clientX, y: event.clientY }, ...(regionOrigin ? [regionOrigin] : [])]);
  if (event.pointerId !== activePointerId || !regionOrigin) return;
  regionPoint = { x: event.clientX, y: event.clientY };
  draw();
  renderBadge();
}

function handleRegionPointerUp(event: PointerEvent): void {
  if (event.pointerId !== activePointerId || !regionOrigin) return;
  regionPoint = { x: event.clientX, y: event.clientY };
  const rect = currentRegion();
  activePointerId = null;
  if (!rect || rect.width < 2 || rect.height < 2) {
    window.kePen.cancel();
    return;
  }
  regionSubmitted = true;
  void submitRegion(rect);
}

function handleRegionPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  activePointerId = null;
  regionOrigin = null;
  regionPoint = null;
  draw();
  renderBadge();
}

async function submitRegion(rect: PenRect): Promise<void> {
  try {
    await window.kePen.submitShotRegion({
      displayId: bootstrap.displayId,
      screenWidth: bootstrap.screenWidth,
      screenHeight: bootstrap.screenHeight,
      rect,
    });
  } catch (error) {
    regionSubmitted = false;
    badgeDetail.textContent =
      error instanceof Error ? error.message : "KE Shot could not capture that region.";
  }
}

function currentRegion(): PenRect | null {
  if (!regionOrigin || !regionPoint) return null;
  const x = Math.min(regionOrigin.x, regionPoint.x);
  const y = Math.min(regionOrigin.y, regionPoint.y);
  return {
    x,
    y,
    width: Math.abs(regionPoint.x - regionOrigin.x),
    height: Math.abs(regionPoint.y - regionOrigin.y),
  };
}

function handlePointerDown(event: PointerEvent): void {
  // Ink is a primary-button stroke only: a middle press (the hold-to-capture
  // habit) or a right click must never draw a dot and send it to the AI.
  if (!startsPenStroke(event.button)) return;
  if (phase !== "drawing" || currentStroke) return;
  const allowed = window.kePen.beginStroke();
  if (!allowed || phase !== "drawing") return;

  window.clearTimeout(finalizeTimer);
  activePointerId = event.pointerId;
  startedAt = performance.now();
  currentStroke = [sample(event)];
  canvas.setPointerCapture(event.pointerId);
  draw();
}

function handlePointerMove(event: PointerEvent): void {
  if (event.pointerId !== activePointerId || !currentStroke || phase !== "drawing") return;
  const point = sample(event);
  const previous = currentStroke.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.8) return;
  currentStroke.push(point);
  draw();
}

function handlePointerUp(event: PointerEvent): void {
  if (event.pointerId !== activePointerId || !currentStroke || phase !== "drawing") return;
  const point = sample(event);
  currentStroke.push(point);
  if (
    currentStroke.length === 2 &&
    Math.hypot(point.x - currentStroke[0]!.x, point.y - currentStroke[0]!.y) < 1
  ) {
    currentStroke.push({ x: point.x + 2, y: point.y + 2, t: point.t });
  }
  strokes.push(currentStroke);
  currentStroke = null;
  activePointerId = null;
  draw();
  finalizeTimer = window.setTimeout(() => void finalizeAnnotation(), 700);
}

function handlePointerCancel(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  currentStroke = null;
  activePointerId = null;
  draw();
}

function handleKeyDown(event: KeyboardEvent): void {
  if (frozenImage) armFrozenIdleCancel();
  if (event.key === "Escape") {
    event.preventDefault();
    window.kePen.cancel();
    return;
  }
  if (bootstrap?.mode === "shot") return;
  if (phase === "drawing" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    window.clearTimeout(finalizeTimer);
    strokes.pop();
    if (strokes.length === 0) void window.kePen.releaseDisplay();
    draw();
  }
}

async function finalizeAnnotation(): Promise<void> {
  if (phase !== "drawing" || strokes.length === 0) return;
  try {
    const geometry = computeCropGeometry({
      screenWidth: bootstrap.screenWidth,
      screenHeight: bootstrap.screenHeight,
      imageWidth: baseline.naturalWidth,
      imageHeight: baseline.naturalHeight,
      strokes,
    });
    const crop = document.createElement("canvas");
    crop.width = geometry.cropRectPixels.width;
    crop.height = geometry.cropRectPixels.height;
    const cropContext = crop.getContext("2d");
    if (!cropContext) throw new Error("Pen could not create the marked image.");

    const rect = geometry.cropRectPixels;
    cropContext.drawImage(
      baseline,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    cropContext.strokeStyle = "rgba(255, 58, 42, 0.98)";
    cropContext.lineWidth = geometry.lineWidthPixels;
    cropContext.lineCap = "round";
    cropContext.lineJoin = "round";
    const scaleX = baseline.naturalWidth / bootstrap.screenWidth;
    const scaleY = baseline.naturalHeight / bootstrap.screenHeight;
    for (const stroke of strokes) {
      cropContext.beginPath();
      stroke.forEach((point, index) => {
        const x = point.x * scaleX - rect.x;
        const y = point.y * scaleY - rect.y;
        if (index === 0) cropContext.moveTo(x, y);
        else cropContext.lineTo(x, y);
      });
      cropContext.stroke();
    }

    phase = "queued";
    renderBadge();
    await window.kePen.submitAnnotation({
      displayId: bootstrap.displayId,
      screenWidth: bootstrap.screenWidth,
      screenHeight: bootstrap.screenHeight,
      strokeBoundsPoints: geometry.strokeBoundsPoints,
      cropRectPixels: geometry.cropRectPixels,
      normalizedStrokes: geometry.normalizedStrokes,
      image: {
        dataUrl: crop.toDataURL("image/png"),
        width: crop.width,
        height: crop.height,
      },
    });
  } catch (error) {
    phase = "drawing";
    badgeDetail.textContent = error instanceof Error ? error.message : "Pen could not send this mark.";
  }
}

function resizeCanvas(): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  draw();
}

function draw(): void {
  if (bootstrap?.mode === "shot") {
    drawRegion();
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  context.strokeStyle = "rgba(255, 58, 42, 0.98)";
  context.lineWidth = 4;
  context.lineCap = "round";
  context.lineJoin = "round";
  const visibleStrokes = currentStroke ? [...strokes, currentStroke] : strokes;
  for (const stroke of visibleStrokes) {
    context.beginPath();
    stroke.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  }
}

function drawRegion(): void {
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const width = bootstrap?.screenWidth ?? window.innerWidth;
  const height = bootstrap?.screenHeight ?? window.innerHeight;
  if (frozenImage) {
    // The frozen screen fills the display exactly; the live screen underneath
    // never shows through.
    context.imageSmoothingQuality = "high";
    context.drawImage(frozenImage, 0, 0, width, height);
  }
  const dim = frozenImage
    ? frozenDimAlpha(frozenShownAt === null ? null : performance.now() - frozenShownAt)
    : SELECTOR_DIM_ALPHA;
  if (dim > 0) {
    context.fillStyle = `rgba(9, 9, 12, ${dim.toFixed(3)})`;
    context.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }
  if (frozenImage && frozenShownAt !== null) {
    // A thin inset accent border: this is a picture of the screen, not the
    // screen. It is only drawn here; the capture comes from the main process.
    context.strokeStyle = FROZEN_BORDER_COLOR;
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, window.innerWidth - 1, window.innerHeight - 1);
  }
  const rect = currentRegion();
  if (!rect || rect.width < 1 || rect.height < 1) return;
  if (frozenImage) {
    const scaleX = frozenImage.naturalWidth / width;
    const scaleY = frozenImage.naturalHeight / height;
    context.drawImage(
      frozenImage,
      rect.x * scaleX,
      rect.y * scaleY,
      rect.width * scaleX,
      rect.height * scaleY,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );
  } else {
    context.clearRect(rect.x, rect.y, rect.width, rect.height);
  }
  context.strokeStyle = "rgba(255, 58, 42, 0.98)";
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

// Keeps the badge off whatever the person is pointing at or selecting.
function moveBadgeAwayFrom(points: Array<{ x: number; y: number }>): void {
  if (bootstrap?.mode !== "shot") return;
  const box = document.getElementById("badge")?.getBoundingClientRect();
  if (!box) return;
  const next = badgeCorner(
    shotBadgeCorner,
    points,
    { width: window.innerWidth, height: window.innerHeight },
    { width: box.width, height: box.height },
  );
  if (next === shotBadgeCorner) return;
  shotBadgeCorner = next;
  document.body.dataset.badgeCorner = next;
}

function renderBadge(): void {
  if (bootstrap?.mode === "shot") {
    badgeDetail.textContent = shotBadgeDetail({
      frozen: frozenImage !== null,
      pointerDisplay: bootstrap.pointerDisplay !== false,
      selection: currentRegion(),
      shortcut: bootstrap.shortcut,
    });
    document.body.dataset.phase = phase;
    return;
  }
  const labels: Record<string, string> = {
    drawing: `DRAW · release to send · ${bootstrap?.shortcut ?? ""}`,
    queued: "AI IS LOOKING · ink stays until reply",
    reading: "UNDERSTOOD · waiting for reply",
    completing: "REPLY READY · clearing",
    clearing: "REPLY READY · clearing",
  };
  badgeDetail.textContent = labels[phase] ?? phase.toUpperCase();
  document.body.dataset.phase = phase;
}

function sample(event: PointerEvent): PenPoint {
  return {
    x: event.clientX,
    y: event.clientY,
    t: (performance.now() - startedAt) / 1_000,
  };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Pen could not load the screen capture."));
    image.src = source;
  });
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Pen is missing ${id}.`);
  return element as T;
}

function requiredCanvasContext(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const drawingContext = element.getContext("2d");
  if (!drawingContext) throw new Error("Pen could not initialize its drawing canvas.");
  return drawingContext;
}
