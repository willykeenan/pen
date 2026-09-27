# Hold-to-capture threat model

## Security objective

Let the person hold the middle mouse button to freeze the screen and select a
region, so menus and hover states that close when KE Pen is reached for can be
captured, without letting KE Pen (or anything that can talk to it) observe more
input than that one button, lose or invent clicks, keep swallowing clicks after
KE Pen is gone, or post input of anyone's choosing.

The implementation is a small native helper, `ke-pen-hold-helper`, supervised
by KE Pen's main process over stdio. On macOS it is an active session event
tap; on Windows a low-level mouse hook (`WH_MOUSE_LL`). Linux is not supported.

## Trust boundaries

- The person controls the physical mouse and approves the macOS Accessibility
  permission for KE Pen in System Settings.
- KE Pen's main process owns the helper: it starts it, arms and disarms it, and
  stops it. The helper starts disarmed and never arms itself.
- The helper's stdin accepts four fixed commands (`config`, `arm`, `disarm`,
  `quit`); its stdout carries `ready`, `active`, `needs-permission`, `hold`,
  `tap-restored` and `error` messages. Neither direction carries a position,
  click count, timestamp, key or event description.
- Other processes running as the same user, other event taps and hooks
  (mouse remappers, accessibility tools) and elevated windows on Windows are
  outside KE Pen's control.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Input overcollection (keylogging, click tracking) | The macOS tap mask covers only "other mouse" down/up/dragged, and the callback returns every button other than number 2 untouched on its first line. The Windows hook passes every message except middle down/up, and looks at moves only while a middle press is pending. The press origin is kept in memory for one press to tell a drag from a hold; nothing is logged, stored or sent. | The operating system hands the helper every "other mouse" event (macOS has no middle-only mask). The helper ignores them, but a modified helper binary could not be prevented from reading them; verify release checksums or build from source. |
| Confused deputy: another process borrows KE Pen's Accessibility approval to click | The stdin protocol has no command that carries coordinates, buttons or events; unknown keys, commands, versions and oversized lines are refused (`verify:public` pins the four commands and their keys). The only events the helper ever posts are copies of the middle-button events it swallowed, re-posted unchanged. | A same-user process could spawn the helper itself and arm it, making middle-button holds report to that process instead of KE Pen. It gains no input capability beyond seeing that a hold happened. |
| Lost clicks | A quick press is replayed as a down/up pair at its original location on release. A drag past the slop replays the down first and passes the rest. Disarming mid-press, a tap reset (macOS disables slow taps) and helper shutdown (stdin EOF, quit, SIGTERM, parent exit) all give a held click back. A property test over 100,000 random steps checks every swallowed down resolves exactly once. | A helper killed with SIGKILL, or crashing, while a press is pending loses that one click; the next click is unaffected (integration-tested). A hold that fires while KE Pen is already busy is swallowed and ignored. |
| Orphaned helper swallowing clicks after KE Pen exits | The helper exits on stdin EOF (KE Pen's pipe closing for any reason), on its parent's exit (kqueue / process handle), on SIGTERM, and on `quit`. On macOS it also refuses to start as an orphan. | None known beyond the instant between parent death and EOF delivery. |
| Replays looping or double-counting | Replays carry a private tag (event-source user data on macOS, `dwExtraInfo` on Windows) and are passed through untouched. | Another tool that strips or rewrites event user data could make a replay look new; it would then be treated as a fresh press and replayed again on release, not lost. |
| Capture of unintended content | The freeze happens only after a still hold of 200–1500 ms (500 ms default) while KE Pen is idle. Nothing leaves the machine unless the person drags a region and has configured their own upload endpoint; Escape cancels with nothing copied. The frozen images stay in memory and are discarded when the selector closes. | A deliberate still press longer than the delay before a middle-drag becomes a capture instead; the delay and an off switch are in the tray. |
| Selector misregistration | Frozen overlays are placed at the screen-saver level with exact display bounds (including the menu bar and Dock) and shown only after their frozen frame is painted; the crop comes from the lossless capture held by the main process using the same display-to-pixel mapping as the existing KE Shot overlay. The runtime proof asserts bounds, level and exact crop size. | A display added or removed between the freeze and the selection is not reflected until the next hold. |
| Stale or missing permission (macOS) | macOS attributes the helper to KE Pen (its responsible process). KE Pen explains the Accessibility approval once, opens the exact pane, and the helper picks the approval up without a relaunch. The explanation names the stale-toggle remedy for rebuilt, differently signed copies. | Unsigned public builds lose the approval when the binary changes; the person has to toggle KE Pen off and on again. |
| Hook removal and timing (Windows) | The hook procedure is O(1); replays and output run on the message loop and a writer thread; the hook is re-installed every ten minutes while idle. | UIPI blocks replays into elevated (administrator) windows, so a quick middle click over one is lost. Security software may flag an unsigned executable that installs a global mouse hook. |
| Supervisor runaway | Restarts back off from 0.5 to 30 seconds and stop after six failures in two minutes; a helper from another build (version or protocol mismatch) is refused; no ready within five seconds is a failure. `hold-status.json` (owner-only) records state, version and restart count only. | Repeated manual restarts from the tray are allowed by design. |

## Explicit non-goals

- Observing the keyboard, other mouse buttons, scrolling or pointer position
  outside a pending middle press.
- Posting any input other than the person's own held-back middle click.
- Any agent-controlled or remote input path. Agents still have no real-desktop
  input in KE Pen.
- Linux support (Wayland forbids global interception; X11 uses the middle click
  for primary-selection paste).

## Release checks

`npm run test:native` (state machine, protocol, property test) on all three
operating systems; `npm run check`; `npm run verify:hold:proof` (isolated real
Electron runtime with a fake helper: freeze before any overlay is created,
painted, shown or focused; exact crop to an in-memory clipboard; Escape copies
nothing); `npm run verify:hold:mac` (synthetic CGEvents through the real helper:
click replay after release, hold at threshold with nothing leaking, drag
pass-through, disarm replay, an `NSMenu` staying open through a hold while a
disarmed control click closes it, stdin-EOF replay, SIGKILL recovery);
`npm run verify:package` (helper present, universal and signed on macOS,
reports this version and protocol 1, starts and quits cleanly); and
`npm run verify:public` (no private paths in native sources or helper binaries,
four-command stdin contract).
