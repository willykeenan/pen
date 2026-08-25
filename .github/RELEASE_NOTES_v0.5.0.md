# KE Pen 0.5.0

KE Pen 0.5.0 keeps the complete 0.4.6 cross-platform install-to-AI setup and
adds the latest bounded agent workflows.

## What is included

- **KE Pen** — draw around the exact part of the screen an MCP-capable AI
  should inspect; the ink remains until the AI completes the Pen handshake.
- **KE Shot** — capture a region to the clipboard and a local PNG. Successful
  user-configured link uploads once again present the clickable macOS banner.
- **Copy AI setup** — copies configuration for the MCP server embedded in the
  installed app. Desktop users do not need a separate Node.js or npm install.
- **Agent Displays** — isolated app-hosted loopback test surfaces with separate
  software cursors, one exact owner per surface, explicit human handoff,
  Stop/revoke, expiry, and memory-only browser storage. They never move the
  hardware cursor or control the real desktop.
- **Agent visual references** — one sender can create one short-lived PNG or
  inked-region reference for one chosen recipient. KE Pen does not send it;
  the existing governed agent-message channel must route the capability. The
  recipient gets visual context and direction, not additional authority.

## Safe fresh-install boundary

- There is no KE Studios account, credential, private endpoint, analytics,
  telemetry, or admin connection in the source or installers.
- KE Shot ships with both `shotEndpoint` and `shotToken` empty. Out of the box
  it copies and saves locally and makes no upload request. A user may configure
  only an HTTPS endpoint they own; redirects are refused.
- Agent visual references use owner-only local storage, exact recipient and
  capability checks, bounded expiry, deduplicated creation, and no public
  upload, UI, clipboard, capture-history, or message client.
- Agent Displays accept only the packaged fixture or one locked loopback
  origin. Public and cross-origin requests, browser permissions, downloads,
  popups, and embedded URL credentials are refused.

## Install

- macOS 13+, Intel or Apple Silicon: universal DMG or ZIP
- Windows 10/11 x64: installer or ZIP
- Linux x64: AppImage, DEB, or tar.gz on X11/XWayland

These public builds are not commercially signed or notarized. macOS may
require right-clicking the app and choosing **Open**, Windows may show
SmartScreen, and Linux may require `chmod +x` for the AppImage. SHA-256
manifests are attached for every artifact.

[Download and first-minute setup](https://kestudios.dev/pen?ref=github-release) ·
[Privacy](https://github.com/willykeenan/pen/blob/v0.5.0/PRIVACY.md) ·
[Security model](https://github.com/willykeenan/pen/blob/v0.5.0/SECURITY.md)
