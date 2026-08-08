# The whole KE Pen is free

KE Pen 0.3.0 is the first shared desktop release for **macOS, Windows, and
Linux**. There is no limited edition, paid tier, account, checkout, telemetry,
or feature gate. The app and source are MIT licensed.

## Download

- **macOS:** universal DMG or ZIP for Intel and Apple Silicon, macOS 13+
- **Windows:** x64 installer or portable ZIP for Windows 10/11
- **Linux:** x64 AppImage, DEB, or tar.gz for X11/XWayland sessions

Every installer is built and boot-checked on its matching GitHub Actions runner.
Use `KE-Pen-0.3.0-SHA256SUMS.txt` to verify the exact files.

## What it does

Press the global shortcut or click the tray icon, draw around anything on your
screen, and ask your MCP-capable AI host to look at the Pen. `pen_read` returns
only the bounded marked crop, and the red ink remains visible until the host
calls `pen_complete`.

Visual context informs the AI. It never grants authority to edit, send, spend,
deploy, purchase, or take another consequential action.

## Current boundaries

The first cross-platform builds are unsigned. macOS and Windows may show a
first-launch warning. Linux overlay support requires X11 or XWayland; native
Wayland positioning remains compositor-dependent. The MCP server requires
Node.js 20+ and manual host configuration.

[Download and setup guide](https://kestudios.dev/pen?ref=github-release) ·
[Applied-system card](https://github.com/willykeenan/pen/blob/main/SYSTEM_CARD.md)
