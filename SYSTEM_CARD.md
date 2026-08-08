# KE Pen applied-system card

## What it is

KE Pen is a cross-platform visual-intent layer for MCP-capable AI hosts. A
person draws over any application, KE Pen creates a local crop around the mark,
and the mark remains visible until the AI explicitly acknowledges completion.

The contribution is the interaction contract, not a new model:

1. the person marks the live interface;
2. KE Pen stores only the padded marked crop locally;
3. `pen_read` returns that crop without clearing the mark;
4. the AI reasons or acts under its existing authority;
5. `pen_complete` records a bounded summary and schedules the fade.

Visual context informs the AI. It never grants permission to edit files, spend,
send, deploy, purchase, or take another consequential action.

## Components

- One sandboxed Electron tray app and transparent drawing overlay for macOS,
  Windows, and Linux.
- A local Node.js 20+ stdio MCP server with exactly `pen_status`, `pen_read`,
  and `pen_complete`.
- A platform-native, user-owned annotation directory with a shared schema.
- No cloud backend, account, telemetry, ads, remote code, or listening port.

## Evidence contract

Deterministic tests cover tool discovery, lifecycle transitions, path
containment, image limits, cross-platform data paths, crop bounds, pixel-scale
mapping, and edge clamping. The CI matrix builds on macOS, Windows, and Linux;
each packaging lane boots the packaged executable before publishing its
artifact and SHA-256 manifest.

Those checks establish source and packaged-runtime behavior on the tested
runners. They do not establish outside-user adoption, every desktop
environment, every MCP host, or signed/notarized distribution.

## Privacy and security boundary

KE Pen itself never uploads the crop. The configured AI host may transmit MCP
tool results to its model provider, so users should apply that provider's
privacy and retention terms. Renderer sandboxing and context isolation remain
enabled; the UI loads packaged local content only. Annotation identifiers and
paths are validated, PNG reads are capped at 16 MB, and MCP uses stdio only.

## Current limitations

- macOS 13+ universal, Windows 10/11 x64, and Linux x64 are the release targets.
- Linux overlay reliability requires X11 or XWayland; native Wayland remains
  compositor-dependent.
- Node.js 20+ and manual MCP host configuration are required.
- The first release is unsigned and not Apple-notarized or Windows-signed.
- No claim of model training, autonomous authority, broad adoption, or
  universal host compatibility is made.

Created by William Keenan at K&E Studios. Version 0.3.0 is completely free and
open source under the MIT license, with no paid tier or feature gate. See
[kestudios.dev/pen](https://kestudios.dev/pen?ref=github-pen).
