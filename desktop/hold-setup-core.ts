// The macOS hold-to-capture setup card: a small KE Pen-owned window instead of
// a modal dialog. A modal message box blocks KE Pen's main loop (no hotkeys,
// no helper messages, no quit or logout) for as long as it is left open, which
// is unacceptable for a card that can appear while the person is away.
//
// The card's page has no script and no network access. It can only navigate
// to one of three fixed routes, which the main process maps to actions.

export interface HoldSetupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const HOLD_SETUP_CONTINUE_URL = "ke-pen-hold://continue/";
export const HOLD_SETUP_LATER_URL = "ke-pen-hold://later/";
export const HOLD_SETUP_OFF_URL = "ke-pen-hold://off/";

export type HoldSetupRoute = "continue" | "later" | "off";

const CARD_WIDTH = 460;
const CARD_HEIGHT = 318;
const CARD_MARGIN = 18;

export function holdSetupRoute(destination: string): HoldSetupRoute | null {
  if (destination === HOLD_SETUP_CONTINUE_URL) return "continue";
  if (destination === HOLD_SETUP_LATER_URL) return "later";
  if (destination === HOLD_SETUP_OFF_URL) return "off";
  return null;
}

// Top-right of the display under the pointer, below the menu bar, clamped to
// the usable area: where KE Pen's other cards appear, away from the middle of
// whatever the person is doing.
export function holdSetupBounds(workArea: HoldSetupRect): HoldSetupRect {
  const values = [workArea.x, workArea.y, workArea.width, workArea.height];
  if (!values.every(Number.isFinite) || workArea.width <= 0 || workArea.height <= 0) {
    throw new Error("KE Pen cannot place its setup card on an invalid display.");
  }
  const width = Math.max(1, Math.min(CARD_WIDTH, Math.floor(workArea.width - CARD_MARGIN * 2)));
  const height = Math.max(1, Math.min(CARD_HEIGHT, Math.floor(workArea.height - CARD_MARGIN * 2)));
  return {
    x: Math.round(workArea.x + workArea.width - width - CARD_MARGIN),
    y: Math.round(workArea.y + CARD_MARGIN),
    width,
    height,
  };
}

export interface HoldSetupCopy {
  // Already formatted, e.g. "0.5 s".
  delay: string;
  // The helper was already asked for this version: say how to clear a stale
  // System Settings entry.
  staleEntryHint: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function holdSetupParagraphs(copy: HoldSetupCopy): string[] {
  const paragraphs = [
    `Hold the middle mouse button for ${copy.delay} and KE Pen freezes the screen, open menus ` +
      "included, so you can drag out a capture. A quick middle click still works; it just lands " +
      "when you let go.",
    "So a menu stays open while you hold, a small KE Pen helper has to catch the middle button " +
      "before other apps see it. macOS calls this Accessibility: choose Continue, then allow " +
      "“ke-pen-hold-helper” in System Settings › Privacy & Security › Accessibility. " +
      "The helper only watches the middle button, never the keyboard or other buttons, and never " +
      "saves, sends or logs where you click.",
  ];
  if (copy.staleEntryHint) {
    paragraphs.push(
      "If ke-pen-hold-helper is already listed and switched on, that entry belongs to an older " +
        "version: select it, remove it with −, then choose Continue again.",
    );
  }
  return paragraphs;
}

export function holdSetupDocument(copy: HoldSetupCopy): string {
  const body = holdSetupParagraphs(copy)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
    <meta name="color-scheme" content="dark">
    <title>Hold to capture</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        display: flex;
        flex-direction: column;
        padding: 18px 20px 16px;
        color: #f8f7f3;
        background: linear-gradient(145deg, #222327, #17181a);
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 15px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      h1 { margin: 0 0 8px; font-size: 15px; line-height: 1.25; letter-spacing: -0.01em; }
      p { margin: 0 0 8px; color: #c9cbd1; font-size: 12px; line-height: 1.42; }
      nav { display: flex; gap: 8px; justify-content: flex-end; margin-top: auto; padding-top: 6px; }
      a {
        padding: 7px 13px;
        color: #f8f7f3;
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 9px;
        font-size: 13px;
        font-weight: 600;
      }
      a:hover { background: rgba(255, 255, 255, 0.08); }
      a:focus-visible { outline: 3px solid #ffb45f; outline-offset: 1px; }
      a.primary { color: #16120d; border-color: transparent; background: linear-gradient(145deg, #ffca79, #ff9b43); }
      a.quiet { margin-right: auto; color: #aeb0b6; border-color: transparent; font-weight: 500; }
      @media (prefers-reduced-motion: no-preference) {
        body { animation: arrive 150ms ease-out; }
        @keyframes arrive { from { opacity: 0; transform: translateY(-6px); } }
      }
    </style>
  </head>
  <body role="dialog" aria-labelledby="title">
    <h1 id="title">Hold the middle mouse button to capture</h1>
      ${body}
    <nav>
      <a class="quiet" href="${HOLD_SETUP_OFF_URL}">Turn off hold to capture</a>
      <a href="${HOLD_SETUP_LATER_URL}">Not now</a>
      <a class="primary" href="${HOLD_SETUP_CONTINUE_URL}">Continue</a>
    </nav>
  </body>
</html>`;
}
