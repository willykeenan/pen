# KE Pen applied-system card

## What it is

KE Pen is a native macOS visual-intent layer for MCP-capable AI hosts. A person
draws over any application, Pen creates a local crop around the mark, and the
mark remains visible until the AI explicitly acknowledges completion.

The applied-system contribution is the interaction contract, not a new model:

1. the person marks the live interface;
2. Pen stores only the padded marked crop locally;
3. `pen_read` returns that crop without clearing the mark;
4. the AI reasons or acts under its existing authority;
5. `pen_complete` records a short understanding summary and schedules the fade.

Visual context informs the AI. It never grants permission to edit files, spend,
send, deploy, purchase, or take another consequential action.

## Components

- A Swift menu-bar app and click-through full-screen overlay for macOS 13+.
- A local Node.js 20+ stdio MCP server with exactly `pen_status`, `pen_read`,
  and `pen_complete`.
- A user-owned annotation store under
  `~/Library/Application Support/KE Pen/`.
- No cloud backend, account, telemetry, ads, or listening network port.

## Evidence

The repository includes deterministic Node and Swift tests for tool discovery,
lifecycle transitions, path containment, crop bounds and ink inclusion, the
global shortcut, attribution, and the waiting-overlay click-through boundary.
The public artifact is also checked for exact architecture, bundle metadata,
embedded MCP discovery, and strict ad-hoc code-signature validity.

These checks establish the local implementation and packaged release. They do
not establish outside-user adoption, universal host compatibility, or a
Developer ID/notarized macOS release.

## Privacy and security boundary

Pen itself never uploads the crop. The configured AI host may transmit MCP
tool results to its model provider, so users should apply that provider's
privacy and retention terms and avoid marking secrets they would not send.
Annotation IDs are schema-validated, reads remain inside Pen's local data root,
image reads are capped, and the server uses stdio only.

## Current limitations

- Apple Silicon only in the first public release.
- macOS 13 or newer and Screen Recording permission are required.
- Node.js 20 or newer is required for the bundled MCP server.
- The release is ad-hoc signed, not Developer ID signed, notarized, or stapled.
- The host-specific MCP configuration is still manual.
- No claim of model training, autonomous authority, or production-wide
  compatibility is made.

Created by William Keenan at K&E Studios. Version 0.2.1 is completely free and
open source under the MIT license, with no paid tier or feature gate. See
[kestudios.dev/pen](https://kestudios.dev/pen?ref=github-pen).
