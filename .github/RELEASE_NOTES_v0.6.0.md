# KE Pen 0.6.0

KE Pen 0.6.0 adds **hold to capture**: hold the middle mouse button for half a
second and KE Pen freezes the screen, open menus included, then lets you drag
out a capture from the frozen picture.

## What changed

- Hold the middle mouse button still for 0.5 s (you can pick 0.2 s to 1.5 s in
  the tray). KE Pen takes a picture of every display at that moment, before it
  shows anything or takes focus, so the menu or tooltip you were looking at is
  still in it.
- The KE Shot selector opens over that picture. It first looks exactly like
  your screen, then dims slightly and gets a thin red border so you can tell it
  is a picture. Drag a region and it goes on your clipboard right away, like
  any KE Shot capture.
- To cancel: press Esc, click without dragging, or right-click. If you walk
  away, it closes by itself after a minute.
- A quick middle click still works: it is held back until you let go, then
  given back in the same place. Middle-dragging (Blender, CAD tools, browser
  autoscroll) is handed straight back and keeps working.
- In the tray: **Hold middle button to capture** (on by default on macOS and
  Windows) and **How long to hold**.
- Fixed: a middle or right click on the Pen drawing overlay no longer sends a
  stray dot to your AI.

## macOS permission

Holding the middle button back from other apps needs Accessibility. That
approval goes to a small helper, which System Settings lists as
**ke-pen-hold-helper**, not to KE Pen itself. After you install, once you have
stopped typing for a few seconds, a small KE Pen card in the top-right corner
explains this once; choose **Continue**, then **Open System Settings** in the
macOS prompt, and switch **ke-pen-hold-helper** on. KE Pen says **Hold to capture is ready** a moment
later. No restart needed.

Windows needs no permission. Linux is not supported.

## Why

Menus and hover states close the moment you reach for a screenshot shortcut or
click on KE Pen. Holding the middle button needs no focus change, and the
picture is taken before KE Pen does anything visible, so what was on screen is
what you capture.

## Checks behind this release

- The helper's click logic is tested in C, including a 100,000-step random
  test that every held press ends exactly once, as a click or as a capture.
- A real-app test confirms the picture is taken before any window appears,
  that each display's picture is its real size, that the selection reaches the
  clipboard at the right size, and that Esc and a right-click copy nothing.
- On macOS a test drives the real helper with simulated mouse events: quick
  clicks come back after release, holds fire on time with nothing leaking to
  apps, drags pass through, an open menu stays open through a hold, the helper
  recovers when macOS pauses it, and it asks for its own permission.
- On Windows the same kind of test runs in CI with simulated input, including a
  helper that Windows cuts off while it is stalled.
- The packaged app is checked for a signed helper with its own identity, a
  signed app bundle, and locked-down Electron settings.

## Good to know

- The macOS app is signed with K&E Studios' own certificate, not an Apple
  Developer ID, and is not notarized: the first time, right-click the app and
  choose **Open**. Because the certificate stays the same, macOS keeps your
  approvals when you update to a later version signed with it.
- The helper only acts on the middle button, never reads the keyboard, and
  never saves, sends or logs where you click. It makes no network requests and
  stops when KE Pen stops.
- Agents still have no control of your real desktop, and KE Shot still ships
  with no upload endpoint configured.

[Downloads for macOS, Windows, and Linux are attached below](https://github.com/willykeenan/pen/releases/tag/v0.6.0).
