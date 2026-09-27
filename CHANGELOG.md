# Changelog

All notable changes to KE Pen. Earlier releases are described in
[`.github/RELEASE_NOTES_v*.md`](./.github/) and on the
[GitHub releases page](https://github.com/willykeenan/pen/releases).

## 0.6.0 — 2026-09-27

### Added

- **Hold to capture.** Hold the middle mouse button (500 ms by default,
  200–1500 ms in the tray) and KE Pen freezes every display before it shows a
  window or moves focus, then opens the KE Shot selector over the frozen image.
  Menus, tooltips, and hover states that close when you reach for a shortcut
  can now be captured. Drag a region for the normal KE Shot flow (clipboard
  first, local copy, optional upload); Esc cancels.
- Quick middle clicks are held back only until release and then given back at
  the same spot; moving more than a few pixels hands the press straight back,
  so middle-drags (Blender, CAD, browser autoscroll) keep working.
- Tray: **Hold middle button to capture** (on by default on macOS and Windows),
  **Hold delay**, and a status item when macOS Accessibility is needed or the
  helper has stopped.
- `ke-pen-hold-helper`: a small native helper (macOS event tap, Windows
  low-level mouse hook) that watches only the middle button, starts disarmed,
  accepts four fixed stdio commands, and stops with KE Pen.
- macOS: a one-time plain explanation of the Accessibility approval that opens
  the exact System Settings pane; the approval is picked up without a restart.
- `hold-status.json` (owner-only) records the helper's state, version, and
  restart count.
- New settings keys: `middleHoldCapture`, `middleHoldDelayMs`,
  `middleHoldPermissionExplained`.
- `docs/MIDDLE_HOLD_CAPTURE_THREAT_MODEL.md`.

### Verification

- `npm run test:native`: C state machine and protocol tests, including a
  100,000-step property test, on macOS, Windows, and Linux.
- `npm run verify:hold:proof`: real Electron runtime proof (freeze before any
  selector window exists, exact crop, Escape copies nothing).
- `npm run verify:hold:mac`: synthetic CGEvent integration test through the
  real helper, including an open menu that stays open through a hold.
- `verify:package` and `verify:public` now check the packaged helper and the
  helper's four-command contract.

### Unchanged

- KE Shot still ships with no endpoint or token; nothing is uploaded until you
  configure your own.
- Agents still have no real-desktop input. The only native input KE Pen posts
  is the person's own held-back middle click.
- Linux: hold to capture is not supported.
