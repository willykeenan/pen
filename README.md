<p align="center">
  <img src="assets/pen-icon.svg" width="128" height="128" alt="KE Pen app icon" />
</p>

# KE Pen

**Point at the bug. Your AI gets the point.**

KE Pen is a completely free desktop drawing overlay for macOS, Windows, and
Linux. Draw around anything on screen, keep working in your MCP-capable AI
client, and let the AI inspect the exact marked crop. The red ink stays visible
until the AI explicitly says it understood the mark.

Created by **William Keenan at [K&E Studios](https://kestudios.dev/?ref=pen)**.
Free and open source under the MIT license—no paid tier or feature gate.

[Get KE Pen free](https://kestudios.dev/pen?ref=github-pen) ·
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

## The entire interaction

1. Press `⌃⌥⌘P` on macOS or `Ctrl+Alt+P` on Windows/Linux, or click the KE Pen tray icon.
2. Draw one or more red strokes around the thing you mean.
3. Tell your MCP-capable AI “look at the pen” or ask the actual question.
4. The AI calls `pen_read`, reasons over the cropped image, then calls
   `pen_complete` immediately before its reply.
5. The ink fades and input returns to the app underneath it.

Reading never silently clears the mark. Escape is always a human-controlled
cancel path while drawing.

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
most consistent setup on every operating system is to install the public GitHub
package after Node.js 20 or newer:

```bash
npm install --global github:willykeenan/pen#v0.3.0
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

KE Pen has no account, telemetry, ads, cloud backend, or listening network port.
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
