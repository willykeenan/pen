import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { presentShotNotice } from "../desktop/shot-toast.js";
import { shotLinkToastBounds } from "../desktop/shot-toast-core.js";

const evidenceDirectory = process.env.KE_PEN_TOAST_EVIDENCE_DIR;
if (!evidenceDirectory) throw new Error("KE_PEN_TOAST_EVIDENCE_DIR is required.");

if (process.platform === "darwin") app.setActivationPolicy("accessory");

void main().catch((error: unknown) => {
  process.stderr.write(
    `PEN_SHOT_LINK_TOAST_RUNTIME_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
  );
  app.exit(1);
});

async function main(): Promise<void> {
  await app.whenReady();
  await mkdir(evidenceDirectory, { recursive: true });

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const expectedBounds = shotLinkToastBounds(display.workArea);
  const privateViewerFixture = "https://private.example.test/image/not-rendered";
  presentShotNotice(
    "KE Shot link ready",
    privateViewerFixture,
    privateViewerFixture,
  );

  const toast = await waitForToast();
  await delay(250);
  const renderedHtml = await toast.webContents.executeJavaScript(
    "document.documentElement.outerHTML",
    true,
  );
  const renderedText = await toast.webContents.executeJavaScript("document.body.innerText", true);
  const image = await toast.webContents.capturePage();
  await writeFile(path.join(evidenceDirectory, "shot-link-toast.png"), image.toPNG());

  const result = {
    contract: "ke.pen.shot-link-toast.runtime.v1",
    visible: toast.isVisible(),
    focused: toast.isFocused(),
    bounds: toast.getBounds(),
    expectedBounds,
    textPresent: String(renderedText).includes("KE Shot link ready"),
    privateViewerUrlInRenderer: String(renderedHtml).includes(privateViewerFixture),
    rendererSandboxed: toast.webContents.getLastWebPreferences().sandbox === true,
    rendererNodeIntegration: toast.webContents.getLastWebPreferences().nodeIntegration === true,
    dismissClosed: false,
  };

  await toast.webContents.executeJavaScript(
    "document.querySelector('a.dismiss')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))",
    true,
  );
  result.dismissClosed = await waitForDismiss();

  const passed =
    result.visible &&
    !result.focused &&
    JSON.stringify(result.bounds) === JSON.stringify(result.expectedBounds) &&
    result.textPresent &&
    !result.privateViewerUrlInRenderer &&
    result.rendererSandboxed &&
    !result.rendererNodeIntegration &&
    result.dismissClosed;

  await writeFile(
    path.join(evidenceDirectory, "shot-link-toast-runtime.json"),
    `${JSON.stringify({ ...result, passed }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (!passed) {
    process.stderr.write(`PEN_SHOT_LINK_TOAST_RUNTIME_FAILED ${JSON.stringify(result)}\n`);
    app.exit(1);
  } else {
    process.stdout.write("PEN_SHOT_LINK_TOAST_RUNTIME_OK\n");
    app.exit(0);
  }
}

async function waitForToast(): Promise<BrowserWindow> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const candidate = BrowserWindow.getAllWindows().find(
      (window) => window.getTitle() === "KE Shot link ready" && window.isVisible(),
    );
    if (candidate) return candidate;
    await delay(25);
  }
  throw new Error("The KE Shot link popup did not become visible.");
}

async function waitForDismiss(): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!BrowserWindow.getAllWindows().some((window) => window.getTitle() === "KE Shot link ready")) {
      return true;
    }
    await delay(25);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
