# A smoother first night with KE Pen

KE Pen 0.4.1 makes the first-use path much shorter while keeping the same local,
free, inspectable security boundary.

## Download

- **macOS:** universal DMG or ZIP for Intel and Apple Silicon, macOS 13+
- **Windows:** x64 installer or portable ZIP for Windows 10/11
- **Linux:** x64 AppImage, DEB, or tar.gz for X11/XWayland sessions

Every installer is built and boot-checked on its matching GitHub Actions runner.
Use `KE-Pen-0.4.1-SHA256SUMS.txt` to verify the exact files.

## New: Copy AI setup

Install and launch KE Pen, open its tray/menu-bar menu, then choose **Copy AI
setup**. Paste that JSON into an MCP-capable AI host and restart the host. The
configuration runs the MCP server already embedded in the app, so the normal
path no longer needs a separate Node.js or npm installation.

The packaged bridge is exercised during the macOS, Windows, and Linux release
builds before the release is published.

## Also included

- The branded Pen mark is now the app and tray identity.
- A plain macOS Dock click captures a screenshot; right-click exposes both
  **Capture Screenshot** and **Draw with KE Pen**.
- The existing KE Shot capture, clipboard-first behavior, local-only defaults,
  bounded upload protocol, and explicit Pen read/complete handshake are intact.

## Safety boundary

KE Pen has no account, telemetry, ads, default upload host, or listening network
port. Fresh installs make no outbound request. The optional KE Shot upload stays
off until the user supplies both an endpoint and token. The copied AI setup does
not install software or transmit images; the configured AI host may send a
marked crop to its own model provider when the user asks it to read the Pen.

These builds remain unsigned. macOS may require right-click → **Open**, Windows
may show SmartScreen, and Linux may require `chmod +x` for the AppImage. Linux
overlay support requires X11 or XWayland; native Wayland behavior remains
compositor-dependent.

[Download and setup guide](https://kestudios.dev/pen?ref=github-release) ·
[Security model](https://github.com/willykeenan/pen/blob/main/SECURITY.md) ·
[Applied-system card](https://github.com/willykeenan/pen/blob/main/SYSTEM_CARD.md)
