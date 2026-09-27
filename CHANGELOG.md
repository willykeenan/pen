# Changelog

All notable changes to KE Pen. Earlier releases are described in
[`.github/RELEASE_NOTES_v*.md`](./.github/) and on the
[GitHub releases page](https://github.com/willykeenan/pen/releases).

## 0.6.0 — 2026-09-27

### Added

- **Hold to capture.** Hold the middle mouse button (0.5 s by default, 0.2 s
  to 1.5 s in the tray) and KE Pen freezes every display before it shows a
  window or moves focus, then opens the KE Shot selector over the frozen image.
  Menus, tooltips, and hover states that close when you reach for a shortcut
  can now be captured. Drag a region for the normal KE Shot flow (clipboard
  first, local copy, optional upload).
- The frozen selector appears exactly as the screen was, then its dim fades in
  and a thin red border marks it as a picture. The display under the pointer
  goes up first. Cancel with Esc, a click, or a right or middle click; a frozen
  selector left alone for a minute closes itself. Its badge moves out of the
  way when you point near it.
- Quick middle clicks are held back only until release and then given back at
  the same spot (they land on release). Moving more than a few pixels hands the
  press straight back, so middle-drags (Blender, CAD, browser autoscroll) keep
  working.
- Tray: **Hold middle button to capture** (on by default on macOS and Windows),
  **How long to hold**, and a status item when the helper needs approval or has
  stopped.
- `ke-pen-hold-helper`: a small native helper (macOS event tap, Windows
  low-level mouse hook) that acts only on the middle button, starts disarmed,
  accepts five fixed stdio commands, and stops with KE Pen.
- macOS: the Accessibility approval belongs to the helper, not to KE Pen, and
  System Settings lists it as `ke-pen-hold-helper`. Nothing pops up at launch;
  a one-time explanation card waits until you are idle (it takes no focus and,
  unlike a modal dialog, never blocks hotkeys or quitting), then macOS's own
  prompt, and KE Pen says when hold to capture is ready. A withdrawn approval is noticed
  within seconds.
- The helper recovers on its own when macOS disables a stalled event tap or
  Windows drops a stalled hook: a press still held stays a hold, anything
  missed is given back as a click.
- `hold-status.json` (owner-only) records the helper's state, version, and
  restart count.
- New settings keys: `middleHoldCapture`, `middleHoldDelayMs`, and the internal
  `middleHoldIntroduced` and `middleHoldPrompted`.
- `docs/MIDDLE_HOLD_CAPTURE_THREAT_MODEL.md`.

### Fixed

- A middle or right press on the Pen drawing overlay no longer draws a dot and
  sends it to your AI; only the primary button draws.
- Full-screen captures on a lower-resolution display next to a Retina display
  are now that display's native size instead of upscaled.

### Security

- Packaged builds turn off the `NODE_OPTIONS` and `--inspect` Electron fuses and
  load the app only from its asar. `RunAsNode` stays on for the embedded MCP
  server; because the Accessibility approval is the helper's, code run as KE
  Pen cannot use it.
- The development-only `--hold-proof` switch and its helper override are
  ignored by packaged builds.
- The macOS bundle is now signed as a whole (helper first, with its own
  identifier and hardened runtime), and `verify:package` checks the signature
  and every Electron fuse.

### Verification

- `npm run test:native`: C state machine and protocol tests, including a
  100,000-step property test, on macOS, Windows, and Linux CI.
- `npm run verify:hold:proof`: real Electron runtime proof (freeze before any
  selector window exists, native-size frames, exact crop, Escape and a right
  click copy nothing).
- `npm run verify:hold:mac`: synthetic CGEvent integration test through the
  real helper, including an open menu that stays open through a hold, recovery
  after macOS disables a stalled tap, and the helper holding its own approval.
- `npm run verify:hold:win`: the same through `SendInput` on Windows CI,
  including a stalled helper whose hook Windows drops.
- `verify:package` and `verify:public` check the packaged helper, signatures,
  fuses, and the helper's five-command contract.

### Unchanged

- KE Shot still ships with no endpoint or token; nothing is uploaded until you
  configure your own.
- Agents still have no real-desktop input. The only native input KE Pen posts
  is the person's own held-back middle click.
- Linux: hold to capture is not supported.
