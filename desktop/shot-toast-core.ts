export interface ShotToastRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SHOT_LINK_TOAST_OPEN_URL = "ke-pen-toast://open/";
export const SHOT_LINK_TOAST_DISMISS_URL = "ke-pen-toast://dismiss/";
export const SHOT_LINK_TOAST_DURATION_MS = 12_000;

export type ShotLinkToastRoute = "open" | "dismiss";
export type ShotLinkToastDetail = null | "jpeg" | "jpeg+downscale";

const SHOT_LINK_TOAST_WIDTH = 384;
const SHOT_LINK_TOAST_HEIGHT = 112;
const SHOT_LINK_TOAST_MARGIN = 18;

export function shotLinkToastBounds(workArea: ShotToastRect): ShotToastRect {
  const values = [workArea.x, workArea.y, workArea.width, workArea.height];
  if (!values.every(Number.isFinite) || workArea.width <= 0 || workArea.height <= 0) {
    throw new Error("KE Shot cannot place its link popup on an invalid display.");
  }

  const marginX = Math.min(
    SHOT_LINK_TOAST_MARGIN,
    Math.max(0, Math.floor((workArea.width - 1) / 2)),
  );
  const marginY = Math.min(
    SHOT_LINK_TOAST_MARGIN,
    Math.max(0, Math.floor((workArea.height - 1) / 2)),
  );
  const width = Math.max(
    1,
    Math.min(SHOT_LINK_TOAST_WIDTH, Math.floor(workArea.width - marginX * 2)),
  );
  const height = Math.max(
    1,
    Math.min(SHOT_LINK_TOAST_HEIGHT, Math.floor(workArea.height - marginY * 2)),
  );

  return {
    x: Math.round(workArea.x + workArea.width - width - marginX),
    y: Math.round(workArea.y + marginY),
    width,
    height,
  };
}

export function shotLinkToastRoute(destination: string): ShotLinkToastRoute | null {
  if (destination === SHOT_LINK_TOAST_OPEN_URL) return "open";
  if (destination === SHOT_LINK_TOAST_DISMISS_URL) return "dismiss";
  return null;
}

// The renderer never receives the private viewer URL. It can request only one
// of these two fixed routes; the main process keeps and opens the validated URL.
export function shotLinkToastDocument(detail: ShotLinkToastDetail = null): string {
  const message =
    detail === "jpeg"
      ? "Uploaded as JPEG. Clipboard keeps the lossless original."
      : detail === "jpeg+downscale"
        ? "Uploaded after resizing. Clipboard keeps the lossless original."
        : "Saved. Click to open the private viewer.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
    <meta name="color-scheme" content="dark">
    <title>KE Shot link ready</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        color: #f8f7f3;
        background: #17181a;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .open {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr) auto;
        gap: 13px;
        align-items: center;
        width: 100%;
        height: 100%;
        padding: 17px 42px 17px 17px;
        color: inherit;
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 15px;
        background: linear-gradient(145deg, #222327, #17181a);
      }
      .open:focus-visible { outline: 3px solid #ffb45f; outline-offset: -4px; }
      .mark {
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border-radius: 12px;
        color: #16120d;
        background: linear-gradient(145deg, #ffca79, #ff9b43);
        font-size: 23px;
        font-weight: 800;
      }
      .copy { min-width: 0; }
      strong { display: block; font-size: 15px; line-height: 1.25; letter-spacing: -0.01em; }
      span { display: block; margin-top: 5px; color: #b9bbc2; font-size: 12px; line-height: 1.35; }
      .action { color: #ffb45f; font-size: 13px; font-weight: 700; white-space: nowrap; }
      .dismiss {
        position: absolute;
        top: 8px;
        right: 9px;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        color: #aeb0b6;
        text-decoration: none;
        border-radius: 8px;
        font-size: 20px;
        line-height: 1;
      }
      .dismiss:hover { color: #ffffff; background: rgba(255, 255, 255, 0.08); }
      @media (prefers-reduced-motion: no-preference) {
        body { animation: arrive 150ms ease-out; }
        @keyframes arrive { from { opacity: 0; transform: translateY(-6px); } }
      }
    </style>
  </head>
  <body role="alert" aria-live="assertive">
    <a class="open" href="${SHOT_LINK_TOAST_OPEN_URL}" aria-label="KE Shot link ready. Open the private viewer.">
      <span class="mark" aria-hidden="true">K</span>
      <span class="copy"><strong>KE Shot link ready</strong><span>${message}</span></span>
      <span class="action" aria-hidden="true">Open</span>
    </a>
    <a class="dismiss" href="${SHOT_LINK_TOAST_DISMISS_URL}" aria-label="Dismiss">×</a>
  </body>
</html>`;
}
