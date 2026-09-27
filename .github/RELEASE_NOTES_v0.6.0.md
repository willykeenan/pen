# KE Pen 0.6.0

KE Pen 0.6.0 adds **hold to capture**: hold the middle mouse button and KE Pen
freezes the screen—open menus included—then opens the KE Shot selector over
the frozen image.

## What changed

- Holding the middle mouse button still for 500 ms (200 ms to 1.5 s in the
  tray) captures every display at that instant, before KE Pen shows a window,
  moves focus, or activates itself.
- The KE Shot selector opens over the frozen image, above the menu bar and
  Dock, and only once the frozen frame is drawn. Drag a region and the crop
  goes through the normal flow: clipboard first, local copy, optional upload.
  Esc cancels.
- A quick middle click is held back only until release, then given back at the
  same spot. Moving more than a few pixels hands the press straight back, so
  middle-drag in Blender, CAD tools, and browser autoscroll keep working.
- Tray: **Hold middle button to capture** (on by default on macOS and Windows)
  and **Hold delay**.
- macOS asks once for Accessibility, with a plain explanation, and picks up the
  approval without a restart. Windows needs no permission. Linux is not
  supported.

## Why

Menus and hover states close the moment focus moves to a screenshot shortcut or
to KE Pen. Holding the middle button needs no focus change, and the freeze
happens before KE Pen does anything visible, so what was on screen is what you
select from.

## Verification

- A C state-machine suite, including a 100,000-step property test that every
  held press resolves exactly once, runs on macOS, Windows, and Linux.
- A real Electron runtime proof checks that every display is frozen before any
  selector window is created, painted, shown, or focused, that the selection
  reaches the clipboard at the exact pixel size, and that Escape copies
  nothing.
- A synthetic macOS integration test drives the real helper with CGEvents: a
  quick click is replayed after release, a long hold fires at the threshold
  with nothing reaching apps, drags pass through, an open menu stays open
  through a hold while a disarmed control click closes it, and a killed helper
  leaves nothing swallowed.
- The packaged app is checked for a universal, signed helper that reports this
  version and starts and quits cleanly.

## Unchanged boundaries

- The helper watches only the middle mouse button, never records where you
  click, makes no network request, starts disarmed, and stops with KE Pen. Its
  four-command stdin contract cannot carry positions or events.
- Agents still have no real-desktop input.
- KE Shot still ships with no endpoint or token configured.
- Public downloads remain unsigned and are not Apple-notarized. Rebuilt
  unsigned copies need the Accessibility switch toggled off and on again.

[Download KE Pen 0.6.0](https://kestudios.dev/pen?ref=github-pen) ·
[GitHub release](https://github.com/willykeenan/pen/releases/tag/v0.6.0)
