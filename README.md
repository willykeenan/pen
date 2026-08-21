<p align="center">
  <img src="assets/pen-icon.svg" width="128" height="128" alt="KE Pen app icon" />
</p>

# KE Pen

**Point at the bug. Your AI gets the point.**

KE Pen is a completely free desktop drawing overlay for macOS, Windows, and
Linux. Draw around anything on screen, keep working in your MCP-capable AI
client, and let the AI inspect the exact marked crop. The red ink stays visible
until the AI explicitly says it understood the mark.

The same app also ships **KE Shot**: one hotkey, drag a region, and the image is
on your clipboard instantly—optionally uploaded to an endpoint you own, so you
get a shareable link too. See [KE Shot](#ke-shot) below.

Created by **William Keenan at [K&E Studios](https://kestudios.dev/?ref=pen)**.
Free and open source under the MIT license—no paid tier or feature gate.

[Download KE Pen](https://kestudios.dev/pen?ref=github-pen) ·
[GitHub releases](https://github.com/willykeenan/pen/releases) ·
[Applied-system card](./SYSTEM_CARD.md)

## Downloads

| Platform | Free build | Current boundary |
|---|---|---|
| macOS | Universal DMG or ZIP | macOS 13+, Intel and Apple Silicon |
| Windows | x64 installer or ZIP | Windows 10/11, 64-bit |
| Linux | x64 AppImage, DEB, or tar.gz | X11 or XWayland desktop session |

The first cross-platform release is not code-signed or notarized. macOS may
require right-click → **Open**, Windows may show SmartScreen, and Linux may
require `chmod +x` for the AppImage. The source, checksums, and native build
workflows are public so anyone can inspect or reproduce the artifacts.

### First minute after install

1. Launch KE Pen once and allow the operating system's screen-capture prompt.
2. Open the KE Pen tray/menu-bar menu and choose **Copy AI setup**.
3. Paste the copied JSON into your MCP-capable AI host's configuration and
   restart that host.
4. Press the Pen shortcut, circle something harmless, and ask the host to
   “look at the pen.”

The copied setup uses the MCP server already embedded in the installed app. It
does not need a separate Node.js or npm install, opens no listening port, and
does not upload a screen image by itself.

## The entire interaction

1. Press `⌃⌥⌘P` on macOS or `Ctrl+Alt+P` on Windows/Linux, or click the KE Pen tray icon.
2. Draw one or more red strokes around the thing you mean.
3. Tell your MCP-capable AI “look at the pen” or ask the actual question.
4. The AI calls `pen_read`, reasons over the cropped image, then calls
   `pen_complete` immediately before its reply.
5. The ink fades and input returns to the app underneath it.

Reading never silently clears the mark. Escape is always a human-controlled
cancel path while drawing.

## KE Shot

KE Shot is the capture-and-share half of the same app. Press `⌘⇧2` on macOS or
`Ctrl+Shift+2` on Windows and Linux, drag a region, and the image is on your
clipboard immediately—before any disk or network work—so you can paste it
straight into an AI chat. On macOS the Dock icon is also a capture button, and
the selection UI is the native macOS one (magnifier, pixel readout, spacebar
window mode). Windows and Linux get an equivalent rubber-band overlay.

Everything after the clipboard is optional and off by default:

| Step | Default |
|---|---|
| Copy to clipboard | Image (Link and Both are tray options) |
| Save a local copy | On, to `Pictures/KE Shot/YYYY-MM-DD at HH.MM.SS.png` |
| Upload and get a link | **Off** until you configure an endpoint and token |

**KE Shot never uploads anything until you give it an endpoint and a token.**
With either field empty it copies, saves locally, and stops there.

### Point it at your own endpoint

KE Shot has no built-in account and no hosted service you sign into. It talks
to whatever HTTPS endpoint you own. Settings live in a plain JSON file in the
app's user-data directory:

- macOS: `~/Library/Application Support/KE Pen/settings.json`
- Windows: `%APPDATA%\KE Pen\settings.json`
- Linux: `~/.config/KE Pen/settings.json`

Open it from the tray with **Open settings file…**. The exact keys:

```json
{
  "shotEndpoint": "",
  "shotToken": "",
  "copyMode": "image",
  "saveLocalCopy": true,
  "localCopyDir": "/Users/you/Pictures/KE Shot",
  "shotShortcut": "Command+Shift+2",
  "showInDock": true
}
```

That is exactly what a fresh install writes: `shotEndpoint` ships empty, so
there is no default host and nothing to opt out of. Fill in your own endpoint
and token to turn uploading on.

| Key | Meaning |
|---|---|
| `shotEndpoint` | Absolute `https` URL that receives the upload (plain `http` is accepted only for `localhost` and `127.0.0.1`). Empty, missing, or unparseable disables uploading. |
| `shotToken` | Bearer token sent to that endpoint. Empty or missing disables uploading. |
| `copyMode` | `image`, `link`, or `both`. |
| `saveLocalCopy` | Write a PNG next to every capture. |
| `localCopyDir` | Where those PNGs go. |
| `shotShortcut` | Electron accelerator string. Restart the app to re-register it. |
| `showInDock` | macOS only. |

A malformed file is ignored in favour of the defaults rather than crashing the
app, and unknown or wrong-typed keys fall back per field.

The token is only ever stored in this file, which KE Shot creates with
owner-only `0600` permissions. It is never written into the repository, the
built app bundle, or any log line.

### What your endpoint has to accept

```
POST <shotEndpoint>
  Authorization: Bearer <shotToken>
  Content-Type:  image/png            (image/jpeg when a capture is re-encoded)
  X-Shot-Width:  <integer, optional>
  X-Shot-Height: <integer, optional>
  X-Shot-Title:  <percent-encoded UTF-8, optional>
  Body: raw image bytes — not multipart, not base64

200 -> {"id","url","imageUrl","bytes","width","height","createdAt"}
```

**Recent shots ▸ Delete from endpoint…** in the tray sends the matching delete
to the same place, after a confirmation:

```
DELETE <shotEndpoint>/<id>
  Authorization: Bearer <shotToken>

200 or 404 -> KE Shot drops the link from its local history
```

KE Shot follows no redirects, times the whole exchange—headers and body—out
after 45 seconds, and caps the response it will read at 1 MB. It retries only
network errors, 429, and 5xx responses, stops early when the endpoint names a
permanent condition such as `not_configured` in the error body, and rejects a
response whose `url` or `imageUrl` is not an `https` URL. Captures above 4 MB
are re-encoded as JPEG locally first, because that is the practical serverless
body limit; the notification says so when it happens, because the clipboard
still holds the lossless original. If the upload fails the capture is always
still written to disk and the tray offers **Retry failed uploads**.

Uploading is publishing. Deleting a shot removes it from your endpoint, but it
cannot recall bytes that a chat app, unfurl service, or CDN already fetched. Do
not capture anything you would not hand over permanently.

## Install the desktop app

Download the build for your operating system from
[kestudios.dev/pen](https://kestudios.dev/pen?ref=github-pen) or the
[GitHub release](https://github.com/willykeenan/pen/releases/latest).

- macOS: open the DMG and drag **KE Pen** to Applications.
- Windows: run the x64 installer, or unzip the portable build.
- Linux: install the DEB, or make the AppImage executable and run it.

macOS asks for Screen Recording permission. Linux uses the desktop capture
portal when required. KE Pen defaults to XWayland inside a Wayland session
because native Wayland prevents reliable global overlay positioning; advanced
users can set `KE_PEN_NATIVE_WAYLAND=1`, with compositor-dependent behavior.

## Connect the MCP server

KE Pen's app and MCP server share a private local annotation directory. The
recommended setup is **Copy AI setup** in the installed app's tray menu. For a
source-based installation instead, install the public GitHub package after
Node.js 20 or newer:

```bash
npm install --global github:willykeenan/pen#v0.4.5
```

Then configure your AI host:

```json
{
  "mcpServers": {
    "pen": {
      "command": "ke-pen-mcp"
    }
  }
}
```

On Windows, use `ke-pen-mcp.cmd` if the host requires the command suffix.
You can also clone the repository, run `npm ci && npm run build:mcp`, and point
the host at `dist/mcp/index.js` with Node.js.

## MCP tools

| Tool | Contract |
|---|---|
| `pen_status` | Reports whether ink is waiting without reading screen content. |
| `pen_read` | Returns the current cropped PNG plus bounded metadata; ink stays visible. |
| `pen_complete` | Records understanding and schedules the overlay to fade just before the AI reply. |

The completion handshake is the applied system: visual context informs the AI,
but it never grants authority to edit, send, spend, deploy, purchase, or take
another consequential action.

## Local data

KE Pen has no account, telemetry, ads, or listening network port. Through 0.3.0
it made no outbound network calls at all. As of 0.4.0 there are exactly two,
both to the endpoint you configured yourself and both started by you: KE Shot
uploading a capture at the moment you take a shot, and the delete you ask for
from **Recent shots**. No endpoint or no token means no request is ever made.
Nothing else in the app phones anywhere.

It stores the marked crop and lifecycle record locally:

| Platform | Default data directory |
|---|---|
| macOS | `~/Library/Application Support/KE Pen/` |
| Windows | `%APPDATA%\KE Pen\` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/ke-pen/` |

Set `KE_PEN_HOME` to override the location. The configured AI host may transmit
the returned crop to its model provider, so that provider's privacy terms still
apply. See [PRIVACY.md](./PRIVACY.md) and [SECURITY.md](./SECURITY.md).

## Build and verify from source

Requirements: Node.js 20+ and the native packaging tools for your target OS.

```bash
npm ci
npm run check
npm run build
npm run start:desktop
```

Create a native installer on its matching operating system:

```bash
npm run package:mac
npm run package:win
npm run package:linux
```

GitHub Actions runs the shared tests on macOS, Windows, and Linux, then packages
and boots the native app on each matching runner. Release tags publish the
verified installers and SHA-256 manifests. The older Swift/AppKit macOS
prototype remains in `Sources/` as auditable implementation history; the 0.3.0
release uses the shared Electron runtime in `desktop/`.
