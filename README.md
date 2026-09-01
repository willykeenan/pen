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

KE Pen 0.5.1 makes the successful macOS link confirmation a KE Pen-owned,
clickable top-right card. It no longer depends on Notification Center, which
macOS can deliberately mute while a display is shared or recorded. The card
does not take focus when it appears, and its sandboxed renderer never receives
the private viewer URL; only the main process opens the validated link.

KE Pen 0.5.0 adds two agent-only layers. **Agent Displays** let
every exact agent/task claim a separate app-hosted test canvas with its own
visible software cursor. Those cursors operate concurrently inside separate
offscreen browser profiles; they never move or replace the computer's single
native cursor. William can open the Agent Displays switcher, enter one canvas,
take exclusive control, return it to its agent, or Stop and revoke it.
**Agent visual references** let one agent privately point one chosen agent at
one explicit PNG or inked Pen region plus a short direction. They run entirely
in the background and add no human button, popup, clipboard action, capture,
public upload, or history browser.

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

The public builds are not commercially code-signed or notarized. macOS may
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
body limit; the confirmation card says so when it happens, because the
clipboard still holds the lossless original. If the upload fails the capture
is always still written to disk and the tray offers **Retry failed uploads**.

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
Agent Displays do not capture the desktop and do not inject system input, so
their isolated canvases require neither Screen Recording nor Accessibility.

## Agent Displays

Agent Displays solve the one-hardware-cursor limitation with a software
compositor inside KE Pen. Each claim is bound to an exact `agentId` and
`taskId`, receives one unguessable session capability, and owns one independent
offscreen browser profile and cursor. A 1440 × 900 canvas is the default; sizes
from 640 × 480 through 2560 × 1600 are supported. KE Pen permits up to 32 live
surfaces at once, then fails closed until an inactive surface is stopped; this
keeps a faulty or hostile agent from exhausting the Mac with renderers.

The surface may load KE Pen's packaged fixture or one `localhost`, `127.0.0.1`,
or `[::1]` HTTP/HTTPS origin. The first target locks the session to that origin.
Public URLs, embedded URL credentials, cross-origin subresources, popups,
downloads, redirects to another origin, and browser permissions are refused.
Storage is memory-only and is cleared when the renderer stops.

Open **Agent Displays…** from the KE Pen tray menu to switch between surfaces.
Only one controller exists per surface:

- while the agent has control, William's switcher is view-only;
- **Take control** atomically pauses agent input and routes switcher keyboard,
  pointer, and scroll events only to that offscreen canvas;
- **Return to agent** restores agent input; and
- **Stop** revokes the capability, destroys the renderer, and clears its
  memory-only browser storage.

Ready and interrupted sessions expire after 30 minutes without authenticated activity. If KE
Pen or a renderer crashes, the persisted redacted record becomes
`interrupted`; the exact agent/task may recover the same session identity with
a newly rotated capability. Stopped and expired records are removed after 24
hours.

This is deliberately not advertised as a macOS virtual monitor. It does not
appear in System Settings or accept arbitrary native applications. It is the
strongest bounded implementation KE Pen can provide without installing a
virtual-display driver or allowing agents to seize the real desktop.

## Agent visual references

An agent calls `pen_agent_reference_create` with exactly one recipient, one
direction, one idempotency key, and either explicit PNG bytes or the ID of one
existing inked Pen annotation. KE Pen validates and copies that single image
into an owner-only local store, caps it at 8 MB and 8192 pixels per edge, and
returns a short-lived capability envelope. It does **not** send the envelope.
The sender routes that envelope exactly once through its existing governed
agent-message channel to the named recipient.

The recipient calls `pen_agent_reference_read`. KE Pen derives the current task
identity from `KE_PEN_AGENT_ID` or `CODEX_THREAD_ID`, requires an exact match to
the addressed recipient, verifies the capability and image checksum, and
returns the PNG plus the sender's direction. Retrying the same idempotency key
returns the same live reference; changing its image or direction fails closed.
References expire after 15 minutes by default and may be bounded from 1 to 60
minutes. An expired reference becomes unreadable immediately; its bytes are
removed on that read or the next reference creation. A recreated reference
gets a new capability generation, so an old envelope cannot revive it. There
is deliberately no list or capture-history tool.

This is a same-computer, same-user agent protocol—not an OS security boundary
or a cloud transfer service. The configured AI hosts and the existing message
channel remain separate trust boundaries. A visual reference grants only
context; it never grants authority to send anything else, edit, deploy, spend,
capture a screen, or control a desktop. Agent visual references never consume
or forward an Agent Display snapshot or capability automatically.

## Connect the MCP server

KE Pen's app and MCP server share a private local annotation directory. The
recommended setup is **Copy AI setup** in the installed app's tray menu. For a
source-based installation instead, install the public GitHub package after
Node.js 20 or newer:

```bash
npm install --global github:willykeenan/pen#v0.5.1
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
| `pen_display_claim` | Claims one isolated app-hosted display and software cursor for an exact agent/task. |
| `pen_display_status` | Returns redacted session, controller, cursor, boundary, and permission truth. |
| `pen_display_navigate` | Loads one locked loopback test origin; public/cross-origin navigation is refused. |
| `pen_display_act` | Sends bounded pointer, keyboard, typing, or scroll input only to the owned surface. |
| `pen_display_snapshot` | Returns an in-memory screenshot of the owned surface for test verification. |
| `pen_display_heartbeat` | Keeps an authenticated long-running test from expiring. |
| `pen_display_stop` | Stops and revokes the exact surface and clears its memory-only storage. |
| `pen_agent_reference_create` | Creates one private, short-lived PNG reference for one chosen recipient; it does not send. |
| `pen_agent_reference_read` | Returns that PNG and direction only when the runtime identity and capability match. |

The completion handshake is the applied system: visual context informs the AI,
but it never grants authority to edit, send, spend, deploy, purchase, or take
another consequential action.

## Local data

KE Pen has no account, telemetry, ads, or listening TCP/network port. The
desktop app exposes an owner-only local IPC socket for Agent Display commands;
it is not reachable over LAN or the internet. Through 0.3.0
it made no outbound network calls at all. As of 0.4.0 there are exactly two
internet-egress operations,
both to the endpoint you configured yourself and both started by you: KE Shot
uploading a capture at the moment you take a shot, and the delete you ask for
from **Recent shots**. No endpoint or no token means no request is ever made.
Agent Displays may load only a loopback test server on the same computer and
block public and cross-origin requests. Nothing else in the app phones
anywhere.

It stores the marked crop and lifecycle record locally:

| Platform | Default data directory |
|---|---|
| macOS | `~/Library/Application Support/KE Pen/` |
| Windows | `%APPDATA%\KE Pen\` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/ke-pen/` |

Set `KE_PEN_HOME` to override the location. The configured AI host may transmit
the returned crop to its model provider, so that provider's privacy terms still
apply. See [PRIVACY.md](./PRIVACY.md) and [SECURITY.md](./SECURITY.md).

Agent Displays add `agent-displays/sessions.json`, a `0600` redacted lifecycle
ledger, plus an ephemeral `0600` broker-auth file and local socket while KE Pen
is running. The ledger includes agent/task identity, display size, controller,
cursor coordinates, timestamps, safe action names, and at most the locked
origin. It does not retain capability tokens, typed text, page content,
screenshots, URL paths, queries, or fragments.

Agent visual references add `agent-visual-references/`. POSIX systems enforce
`0700` directories and `0600` records, PNGs, and one local capability secret;
Windows stores them inside the current user's application-data profile and
inherits that profile's ACL. Records contain only sender/recipient identity,
bounded direction, timestamps, hashes, dimensions, and delivery state. Raw
capabilities, idempotency keys, annotation IDs, source-app details, desktop
paths, and message history are not persisted. There is no list tool. The
reference is delivered only when the sender separately uses the existing
agent-message channel.

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
