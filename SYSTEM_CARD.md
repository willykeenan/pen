# KE Pen applied-system card

## What it is

KE Pen is a cross-platform visual-intent layer for MCP-capable AI hosts. A
person draws over any application, KE Pen creates a local crop around the mark,
and the mark remains visible until the AI explicitly acknowledges completion.

Version 0.4.0 adds **KE Shot**, a capture-and-share mode in the same app: one
hotkey, one dragged region, the image on the clipboard before any disk or
network work, and optionally a link from an endpoint the user owns.

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
- KE Shot: the native macOS region picker on darwin, an equivalent overlay
  marquee on Windows and Linux, a clipboard-first delivery path, local PNG
  copies, and a bounded 25-entry link history.
- No cloud backend, account, telemetry, ads, remote code, or listening port.

## Evidence contract

Deterministic tests cover tool discovery, lifecycle transitions, path
containment, image limits, cross-platform data paths, crop bounds, pixel-scale
mapping, and edge clamping. KE Shot adds offline tests for settings
normalisation and corrupt-file fallback, hand-edited keys surviving a tray
toggle, local filename collisions, bounded history with in-place duplicate
replacement, the retry decision per HTTP status class and per endpoint error
code, delete-URL derivation, upload header construction, region-to-pixel
mapping, refusal of cleartext endpoints, and rejection of malformed or hostile
endpoint responses. The CI matrix builds on macOS, Windows, and Linux;
each packaging lane boots the packaged executable before publishing its
artifact and SHA-256 manifest.

Those checks establish source and packaged-runtime behavior on the tested
runners. They do not establish outside-user adoption, every desktop
environment, every MCP host, or signed/notarized distribution.

## Privacy and security boundary

KE Pen itself never uploads the marked crop. The configured AI host may transmit
MCP tool results to its model provider, so users should apply that provider's
privacy and retention terms. Renderer sandboxing and context isolation remain
enabled; the UI loads packaged local content only. Annotation identifiers and
paths are validated, PNG reads are capped at 16 MB, and MCP uses stdio only.

KE Shot is a **material change to the network posture** and is stated plainly
rather than buried. Through 0.3.0 the app made no outbound request of any kind.
KE Shot makes two, both to the same user-owned endpoint and both user-initiated:
an HTTPS POST of the captured image at the moment they take a shot, and a
confirmed HTTPS DELETE when they choose to unpublish one from the tray. There is
no default account and no fallback host; an empty endpoint or token — the
shipped default — means no request is ever made. Cleartext `http` endpoints are
refused outside loopback, redirects are refused, the request carries no
identifier beyond the user's own bearer token, and the token lives only in an
owner-only local settings file, never in the repository, the built bundle, or a
log line. Responses are validated before use: the share and image links must
parse as `https` URLs before the app will open or copy them.
Uploading is publishing, and deletion at the endpoint cannot recall bytes a chat
app or CDN already fetched.

## Current limitations

- macOS 13+ universal, Windows 10/11 x64, and Linux x64 are the release targets.
- Linux overlay reliability requires X11 or XWayland; native Wayland remains
  compositor-dependent.
- Node.js 20+ and manual MCP host configuration are required.
- KE Shot ships no endpoint. Uploading requires the user to run their own and
  paste an endpoint and token into a local settings file; changing the KE Shot
  hotkey requires restarting the app. Deleting a shot depends on the user's own
  endpoint implementing `DELETE /<id>`.
- The first release is unsigned and not Apple-notarized or Windows-signed.
- No claim of model training, autonomous authority, broad adoption, or
  universal host compatibility is made.

Created by William Keenan at K&E Studios. Version 0.4.0 is completely free and
open source under the MIT license, with no paid tier or feature gate. See
[kestudios.dev/pen](https://kestudios.dev/pen?ref=github-pen).
