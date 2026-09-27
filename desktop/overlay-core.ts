// Pure rules for the overlay renderer: which pointer buttons do what, the
// frozen selector's look and timeout, and where its badge sits. No DOM and no
// Node imports, so the renderer bundles it and the unit tests run it directly.

// PointerEvent.button: 0 primary, 1 middle (auxiliary), 2 secondary.
export const PRIMARY_BUTTON = 0;
export const MIDDLE_BUTTON = 1;
export const SECONDARY_BUTTON = 2;

// Pen ink is a primary-button stroke. A middle press (the hold-to-capture
// habit) or a right click must never draw a dot and send it to the AI.
export function startsPenStroke(button: number): boolean {
  return button === PRIMARY_BUTTON;
}

export type RegionPointerAction = "select" | "cancel" | "ignore";

// In the KE Shot selector the primary button drags a region; a right or
// middle click is the quickest way out when Escape cannot reach the overlay.
export function regionPointerAction(button: number): RegionPointerAction {
  if (button === PRIMARY_BUTTON) return "select";
  if (button === MIDDLE_BUTTON || button === SECONDARY_BUTTON) return "cancel";
  return "ignore";
}

// The frozen selector covers every display, the menu bar and the Dock. If it
// is left alone this long it closes, so a forgotten freeze never looks like a
// hung machine.
export const FROZEN_IDLE_CANCEL_MS = 60_000;

// The frozen frame first appears exactly as the screen was, then the dim fades
// in and a thin accent border marks it as a picture, not the live screen.
export const SELECTOR_DIM_ALPHA = 0.38;
export const FROZEN_DIM_FADE_MS = 120;
export const FROZEN_BORDER_COLOR = "rgba(255, 58, 42, 0.6)";

export function frozenDimAlpha(msSinceShown: number | null): number {
  if (msSinceShown === null || !Number.isFinite(msSinceShown) || msSinceShown <= 0) return 0;
  if (msSinceShown >= FROZEN_DIM_FADE_MS) return SELECTOR_DIM_ALPHA;
  return (SELECTOR_DIM_ALPHA * msSinceShown) / FROZEN_DIM_FADE_MS;
}

export interface ShotBadgeInput {
  frozen: boolean;
  // Only the display under the pointer carries the full instructions.
  pointerDisplay: boolean;
  selection: { width: number; height: number } | null;
  shortcut: string;
}

export const FROZEN_BADGE_TITLE = "SHOT · FROZEN";
export const LIVE_BADGE_TITLE = "SHOT · K&E STUDIOS";

export function shotBadgeDetail(input: ShotBadgeInput): string {
  const { selection } = input;
  if (selection && selection.width >= 1 && selection.height >= 1) {
    return `${Math.round(selection.width)} × ${Math.round(selection.height)} · release to capture`;
  }
  if (!input.pointerDisplay) return "Esc or click to cancel";
  const shortcut = !input.frozen && input.shortcut ? ` · ${input.shortcut}` : "";
  return `Drag to capture · Esc or click to cancel${shortcut}`;
}

export type BadgeCorner = "top-left" | "bottom-right";

export const BADGE_MARGIN = 18;
export const BADGE_AVOID_DISTANCE = 120;

export interface BadgeBox {
  width: number;
  height: number;
}

function badgeRect(corner: BadgeCorner, viewport: BadgeBox, badge: BadgeBox) {
  if (corner === "top-left") {
    return { left: BADGE_MARGIN, top: BADGE_MARGIN, right: BADGE_MARGIN + badge.width, bottom: BADGE_MARGIN + badge.height };
  }
  return {
    left: viewport.width - BADGE_MARGIN - badge.width,
    top: viewport.height - BADGE_MARGIN - badge.height,
    right: viewport.width - BADGE_MARGIN,
    bottom: viewport.height - BADGE_MARGIN,
  };
}

function distanceToRect(point: { x: number; y: number }, rect: ReturnType<typeof badgeRect>): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

// The badge starts top-left, which is where menu-bar menus drop down, the
// very thing a frozen capture is usually aimed at. When the pointer (or the
// selection being dragged) comes near it, it moves to the opposite corner.
export function badgeCorner(
  current: BadgeCorner,
  points: ReadonlyArray<{ x: number; y: number }>,
  viewport: BadgeBox,
  badge: BadgeBox,
): BadgeCorner {
  const near = (corner: BadgeCorner): boolean =>
    points.some((point) => distanceToRect(point, badgeRect(corner, viewport, badge)) < BADGE_AVOID_DISTANCE);
  if (!near(current)) return current;
  const other: BadgeCorner = current === "top-left" ? "bottom-right" : "top-left";
  return near(other) ? current : other;
}
