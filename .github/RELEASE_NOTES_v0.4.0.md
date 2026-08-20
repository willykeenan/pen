# KE Shot joins KE Pen — still completely free

KE Pen 0.4.0 ships **KE Shot**, the capture-and-share half of the same app, on
macOS, Windows, and Linux. There is still no paid tier, account, checkout,
telemetry, or feature gate. The app and source stay MIT licensed.

## Download

- **macOS:** universal DMG or ZIP for Intel and Apple Silicon, macOS 13+
- **Windows:** x64 installer or portable ZIP for Windows 10/11
- **Linux:** x64 AppImage, DEB, or tar.gz for X11/XWayland sessions

Every installer is built and boot-checked on its matching GitHub Actions runner.
Use `KE-Pen-0.4.0-SHA256SUMS.txt` to verify the exact files.

## What KE Shot does

Press `⌘⇧2` on macOS or `Ctrl+Shift+2` on Windows and Linux, drag a region, and
the image is on your clipboard immediately — before any disk or network work —
so you can paste it straight into an AI chat. On macOS the Dock icon is also a
capture button and the selection UI is the native one. Windows and Linux get an
equivalent rubber-band overlay.

Everything after the clipboard is optional. A local PNG copy is on by default.
Uploading is **off** until you put your own endpoint and token in the settings
file.

## What that means for the network posture

Through 0.3.0 the app made no outbound request of any kind. KE Shot makes two,
both to the endpoint you configured yourself and both started by you: the
upload when you take a shot, and a confirmed delete when you choose to unpublish
one from **Recent shots**. There is no default host — `shotEndpoint` ships
empty. Cleartext `http` endpoints are refused outside loopback, redirects are
refused, and the token lives only in an owner-only local settings file.

Uploading is publishing. Deleting a shot stops your endpoint serving it, but it
cannot recall bytes a chat app, an unfurl service, or a CDN already fetched.

## KE Pen is unchanged

Draw around anything, ask your MCP-capable AI host to look at the Pen. `pen_read`
returns only the bounded marked crop, and the red ink remains visible until the
host calls `pen_complete`. Visual context informs the AI. It never grants
authority to edit, send, spend, deploy, purchase, or take another consequential
action.

## Current boundaries

These builds are unsigned. macOS and Windows may show a first-launch warning.
Linux overlay support requires X11 or XWayland; native Wayland positioning
remains compositor-dependent. The MCP server requires Node.js 20+ and manual
host configuration. Deleting a shot depends on your own endpoint implementing
`DELETE /<id>`.

[Download and setup guide](https://kestudios.dev/pen?ref=github-release) ·
[Applied-system card](https://github.com/willykeenan/pen/blob/main/SYSTEM_CARD.md)
