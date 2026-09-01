import { app, BrowserWindow, Notification, screen, shell } from "electron";
import {
  SHOT_LINK_TOAST_DISMISS_URL,
  SHOT_LINK_TOAST_DURATION_MS,
  SHOT_LINK_TOAST_OPEN_URL,
  shotLinkToastBounds,
  shotLinkToastDocument,
  shotLinkToastRoute,
  type ShotLinkToastDetail,
} from "./shot-toast-core.js";

let activeLinkToast: BrowserWindow | null = null;
let activeLinkToastTimer: ReturnType<typeof setTimeout> | null = null;

export function presentShotNotice(
  title: string,
  body: string,
  viewerUrl?: string,
  detail: ShotLinkToastDetail = null,
): void {
  if (process.platform === "darwin" && viewerUrl) {
    presentMacLinkToast(viewerUrl, title, body, detail);
    return;
  }
  presentNativeNotice(title, body, viewerUrl);
}

function presentMacLinkToast(
  viewerUrl: string,
  fallbackTitle: string,
  fallbackBody: string,
  detail: ShotLinkToastDetail,
): void {
  closeActiveLinkToast();

  let bounds;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    bounds = shotLinkToastBounds(display.workArea);
  } catch {
    presentNativeNotice(fallbackTitle, fallbackBody, viewerUrl);
    return;
  }

  // Restore the app the person was using before the native capture picker.
  // The window is then shown without activating it or depending on Notification
  // Center, which macOS intentionally mutes while a display is shared.
  app.hide();
  const toast = new BrowserWindow({
    ...bounds,
    title: "KE Shot link ready",
    show: false,
    frame: false,
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#17181a",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  activeLinkToast = toast;
  toast.accessibleTitle = "KE Shot link ready";
  toast.setMenu(null);
  toast.setAlwaysOnTop(true, "pop-up-menu");
  toast.setContentProtection(true);

  const closeIfCurrent = (): void => {
    if (activeLinkToast !== toast) return;
    closeActiveLinkToast();
  };
  const route = (destination: string): void => {
    const action = shotLinkToastRoute(destination);
    if (action === "open") {
      closeIfCurrent();
      void shell.openExternal(viewerUrl).catch(() => undefined);
    } else if (action === "dismiss") {
      closeIfCurrent();
    }
  };

  const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(shotLinkToastDocument(detail))}`;
  toast.webContents.on("will-navigate", (event, destination) => {
    if (destination === documentUrl) return;
    event.preventDefault();
    route(destination);
  });
  toast.webContents.setWindowOpenHandler(({ url: destination }) => {
    route(destination);
    return { action: "deny" };
  });
  toast.webContents.on("will-attach-webview", (event) => event.preventDefault());
  toast.once("closed", () => {
    if (activeLinkToast === toast) {
      activeLinkToast = null;
      clearActiveLinkToastTimer();
    }
  });

  void toast
    .loadURL(documentUrl)
    .then(() => {
      if (toast.isDestroyed() || activeLinkToast !== toast) return;
      toast.showInactive();
      activeLinkToastTimer = setTimeout(closeIfCurrent, SHOT_LINK_TOAST_DURATION_MS);
    })
    .catch(() => {
      if (activeLinkToast !== toast) return;
      closeIfCurrent();
      presentNativeNotice(fallbackTitle, fallbackBody, viewerUrl);
    });
}

function closeActiveLinkToast(): void {
  clearActiveLinkToastTimer();
  const toast = activeLinkToast;
  activeLinkToast = null;
  if (toast && !toast.isDestroyed()) toast.destroy();
}

function clearActiveLinkToastTimer(): void {
  if (activeLinkToastTimer !== null) clearTimeout(activeLinkToastTimer);
  activeLinkToastTimer = null;
}

function presentNativeNotice(title: string, body: string, url?: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (url) {
    notification.on("click", () => void shell.openExternal(url).catch(() => undefined));
  }
  notification.show();
}
