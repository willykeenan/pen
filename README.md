# Pen

**Point at the bug. Your AI gets the point.**

Pen is a free native macOS overlay for developers. Click the menu-bar pen,
draw around anything on any screen, and keep working in your AI client. Pen
crops that exact visual context for MCP and leaves the red ink on screen until
the AI says it has understood it. Then the AI clears and disables the pen.

Created by **William Keenan at [K&E Studios](https://kestudios.dev/?ref=pen)**.
Free forever under the MIT license.

## The entire interaction

1. Press `Control-Option-Command-P` from any app, or click the pen in the macOS menu bar.
2. Draw one or more freehand strokes around the thing you mean.
3. Tell your MCP-capable AI “look at the pen” (or ask the actual question).
4. The AI calls `pen_read`, reasons over the cropped image, then calls
   `pen_complete` immediately before its reply.
5. The ink fades and input returns to the app underneath it.

No screenshot dragging, clipboard, upload account, prompt box, or manual clear.
Escape remains a human-controlled cancel path.

The installed app carries its own bundled MCP server at
`Pen.app/Contents/Resources/mcp/index.js`; an AI host does not need this source
checkout or its `node_modules` directory after installation.

## Build the MVP

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
[NOTICE.md](./NOTICE.md).
