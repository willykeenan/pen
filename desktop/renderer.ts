import { computeCropGeometry, type PenPoint, type PenRect } from "./crop-geometry.js";

interface Bootstrap {
  mode: "pen" | "shot";
  displayId: number;
  screenWidth: number;
  screenHeight: number;
  baselineDataUrl: string;
  shortcut: string;
}

interface PenBridge {
  bootstrap(): Promise<Bootstrap>;
  beginStroke(): boolean;
  releaseDisplay(): Promise<boolean>;
  submitAnnotation(payload: unknown): Promise<{ id: string }>;
  submitShotRegion(payload: unknown): Promise<{ ok: boolean }>;
  cancel(): void;
  onPhase(callback: (phase: string) => void): void;
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
    initializeShot();
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
  badgeTitle.textContent = "SHOT · K&E STUDIOS";
  resizeCanvas();
  renderBadge();
  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("pointerdown", handleRegionPointerDown);
  canvas.addEventListener("pointermove", handleRegionPointerMove);
  canvas.addEventListener("pointerup", handleRegionPointerUp);
  canvas.addEventListener("pointercancel", handleRegionPointerCancel);
  window.addEventListener("keydown", handleKeyDown);
}

function handleRegionPointerDown(event: PointerEvent): void {
  if (regionSubmitted || regionOrigin) return;
  if (!window.kePen.beginStroke()) return;
  activePointerId = event.pointerId;
  regionOrigin = { x: event.clientX, y: event.clientY };
  regionPoint = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  draw();
  renderBadge();
}

function handleRegionPointerMove(event: PointerEvent): void {
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
  context.fillStyle = "rgba(9, 9, 12, 0.38)";
  context.fillRect(0, 0, window.innerWidth, window.innerHeight);
  const rect = currentRegion();
  if (!rect || rect.width < 1 || rect.height < 1) return;
  context.clearRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = "rgba(255, 58, 42, 0.98)";
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

function renderBadge(): void {
  if (bootstrap?.mode === "shot") {
    const rect = currentRegion();
    badgeDetail.textContent =
      rect && rect.width >= 1 && rect.height >= 1
        ? `${Math.round(rect.width)} × ${Math.round(rect.height)} · release to capture`
        : `DRAG A REGION · Esc to cancel${bootstrap.shortcut ? ` · ${bootstrap.shortcut}` : ""}`;
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
