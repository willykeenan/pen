<p align="center">
  <img src="assets/pen-icon.svg" width="128" height="128" alt="KE Pen app icon" />
</p>

# KE Pen

**Point at the bug. Your AI gets the point.**

Pen is a free native macOS overlay for developers. Click the menu-bar pen,
draw around anything on any screen, and keep working in your AI client. Pen
crops that exact visual context for MCP and leaves the red ink on screen until
the AI says it has understood it. Then the AI clears and disables the pen.

Created by **William Keenan at [K&E Studios](https://kestudios.dev/?ref=pen)**.
Free forever under the MIT license.

[Free Preview and install guide](https://kestudios.dev/pen) ·
[Applied-system card](./SYSTEM_CARD.md)

> **Public Preview boundary:** the first downloadable build is for Apple
> Silicon on macOS 13+. It is ad-hoc signed, not Developer ID signed or Apple
> notarized, and its bundled MCP server currently requires Node.js 20+.

## The entire interaction

1. Press `Control-Option-Command-P` from any app, or click the pen in the macOS menu bar.
2. Draw one or more freehand strokes around the thing you mean.
   When the mark is queued, the overlay becomes click-through and returns focus
   to the app you were using while keeping the ink visible.
3. Tell your MCP-capable AI “look at the pen” (or ask the actual question).
4. The AI calls `pen_read`, reasons over the cropped image, then calls
   `pen_complete` immediately before its reply.
5. The ink fades and input returns to the app underneath it.

No screenshot dragging, clipboard, upload account, prompt box, or manual clear.
Escape remains a human-controlled cancel path.

The installed app carries its own bundled MCP server at
`Pen.app/Contents/Resources/mcp/index.js`; an AI host does not need this source
checkout or its `node_modules` directory after installation.

## Install the free Preview

Download the latest DMG from [kestudios.dev/pen](https://kestudios.dev/pen),
drag `Pen.app` to Applications, then right-click **Open** for the first launch.
The right-click step is required because the current free Preview is not yet
Apple-notarized. Grant Screen Recording when macOS asks; Pen uses it only to
create the marked local crop.

Install Node.js 20 or newer, then add the MCP configuration shown below to your
AI host.

## Build from source

Requirements: macOS 13+, Xcode Command Line Tools, Node.js 20+.

```bash
npm install
npm run build
open "dist/Pen.app"
```

macOS will ask for Screen Recording permission the first time. Pen needs that
permission only to create the local crop it gives to MCP.

## Connect MCP

Build first, then point any stdio MCP host at the generated server:

```json
{
  "mcpServers": {
    "pen": {
      "command": "node",
      "args": ["/absolute/path/to/pen/dist/mcp/index.js"]
    }
  }
}
```

After installing `Pen.app` in Applications, the stable local configuration is:

```json
{
  "mcpServers": {
    "pen": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Applications/Pen.app/Contents/Resources/mcp/index.js"]
    }
  }
}
```

The current local build requires Node.js 20 or newer to host that bundled MCP
file. A future signed distribution can embed its runtime so customers do not
need Node installed.

The packaged npm command will be `npx -y @kestudios/pen-mcp` after publication.
The package name was unclaimed when this MVP was created; it has not been
published from this checkout.

## MCP tools

| Tool | Contract |
|---|---|
| `pen_status` | Reports whether ink is waiting without reading screen content. |
| `pen_read` | Returns the current cropped PNG plus bounded metadata; ink stays visible. |
| `pen_complete` | Records understanding and schedules the native overlay to fade just before the AI reply. |

The completion handshake is the product: reading context never silently grants
permission to clear it.

## Local data contract

The app and MCP server coordinate through
`~/Library/Application Support/KE Pen/`. Set `KE_PEN_HOME` for development or
tests. The current schema is `dev.kestudios.pen.annotation.v1`.

See [PRIVACY.md](./PRIVACY.md), [SECURITY.md](./SECURITY.md), and
[NOTICE.md](./NOTICE.md). Maintainers can create the exact public artifact with
`npm run package:preview`; the DMG and its SHA-256 file are written under
`dist/`.
