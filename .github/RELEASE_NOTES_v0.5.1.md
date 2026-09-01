# KE Pen 0.5.1

KE Pen 0.5.1 makes the macOS **KE Shot link ready** confirmation durable while
the display is shared or recorded.

## What changed

- A successful link upload now opens a KE Pen-owned top-right card instead of
  relying on Notification Center.
- The card appears without taking focus and stays clickable for 12 seconds.
- It follows the display where the capture happened and clamps to that
  display's usable bounds.
- Clicking **Open** opens only the exact validated private viewer link.
- The sandboxed renderer receives fixed local content and never receives the
  private viewer URL.
- Windows, Linux, and non-link notices keep their native notification path.

## Why

macOS deliberately suppresses Notification Center banners while a display is
shared or recorded. The earlier foreground-app timing workaround could not
override that system policy, so successful uploads could complete without a
visible banner. The app-owned card removes that system dependency.

## Verification

The release includes unit coverage for placement, route allowlisting, and
renderer isolation, plus a real Electron runtime gate that proves the card is
visible, top-right, unfocused, dismissible, sandboxed, and contains no private
viewer URL.

## Unchanged boundaries

- KE Shot still ships with no endpoint or token configured.
- Uploads still require the user's own endpoint and token.
- Redirects remain refused, response links remain HTTPS-only, and the private
  token is never logged or embedded in the app.
- Public downloads remain unsigned and are not Apple-notarized.

[Download KE Pen 0.5.1](https://kestudios.dev/pen?ref=github-pen) ·
[GitHub release](https://github.com/willykeenan/pen/releases/tag/v0.5.1)
