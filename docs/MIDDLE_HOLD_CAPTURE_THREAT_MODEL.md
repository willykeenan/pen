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
  permission for the helper, listed as `ke-pen-hold-helper`, in System
  Settings. KE Pen itself never asks for Accessibility.
- KE Pen's main process owns the helper: it starts it, arms and disarms it, and
  stops it. The helper starts disarmed and never arms itself.
- The helper's stdin accepts five fixed commands (`config`, `arm`, `disarm`,
  `prompt`, `quit`); its stdout carries `ready`, `active`, `needs-permission`, `hold`,
  `tap-restored` and `error` messages. Neither direction carries a position,
  click count, timestamp, key or event description.
- Other processes running as the same user, other event taps and hooks
  (mouse remappers, accessibility tools) and elevated windows on Windows are
  outside KE Pen's control.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Input overcollection (keylogging, click tracking) | The macOS tap mask covers only "other mouse" down/up/dragged, and the callback returns every button other than number 2 untouched on its first line. The Windows hook passes every message except middle down/up, and looks at moves only while a middle press is pending. The press origin is kept in memory for one press to tell a drag from a hold; nothing is logged, stored or sent. | The operating system hands the helper every event its tap or hook covers: on macOS every "other mouse" button (there is no middle-only mask), on Windows every mouse message, including left and right buttons, the wheel and moves. The helper passes them on untouched, but a modified helper binary could not be prevented from reading them; verify release checksums or build from source. |
| Confused deputy: another process borrows the helper's Accessibility approval to click | The stdin protocol has no command that carries coordinates, buttons or events; unknown keys, commands, versions and oversized lines are refused (`verify:public` pins the five commands and their keys). The only events the helper ever posts are copies of the middle-button events it swallowed, re-posted unchanged; `prompt` only asks macOS to show its own alert. | A same-user process could spawn the helper itself and arm it, making middle-button holds report to that process instead of KE Pen. It gains no input capability beyond seeing that a hold happened. |
| Code running as KE Pen borrows an Accessibility approval (Electron: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`, a replaced app folder, the development proof switch) | The approval is not KE Pen's: at start the helper re-executes itself with macOS's disclaim-responsibility spawn attribute, so macOS checks and lists the helper's own code (integration-tested: the helper is its own responsible process and asks for its own approval even when started by an approved terminal). A helper that cannot disclaim refuses to run. Packaged builds turn off the `NODE_OPTIONS` and `--inspect` fuses and load the app only from its asar (`verify:package` reads both slices of the universal binary), and ignore `--hold-proof` and `KE_PEN_HOLD_HELPER_OVERRIDE` (`app.isPackaged`). | `RunAsNode` stays on because the embedded MCP server is started as KE Pen's executable in Node mode, so a same-user process can still run code as KE Pen and use KE Pen's **Screen Recording** approval, exactly as in 0.5. It cannot post input through KE Pen, and starting the helper itself gains nothing beyond the row above. Moving the MCP server to its own runtime so `RunAsNode` can be turned off is planned. |
| Lost clicks | A quick press is replayed as a down/up pair at its original location on release. A drag past the slop replays the down first and passes the rest. Disarming mid-press and helper shutdown (stdin EOF, quit, SIGTERM, parent exit) give a held click back. After macOS disables a stalled tap (it only says so with the next event, which has already reached the app), a one-second watchdog and the hold timer re-enable it and read the physical button state: a press that is still held stays a hold and its release is still swallowed; a press whose release went by is given back as a click and never reported as a hold. A property test over 100,000 random steps checks every swallowed down resolves exactly once, including resets with the button up, still down, or pressed again. | A helper killed with SIGKILL, or crashing, while a press is pending loses that one click; the next click is unaffected (integration-tested). A hold that fires while KE Pen is already busy is swallowed and ignored. A release in the last few milliseconds before the threshold can land either way. |
| Orphaned helper swallowing clicks after KE Pen exits | The helper exits on stdin EOF (KE Pen's pipe closing for any reason), on its parent's exit (kqueue / process handle), on SIGTERM, and on `quit`. On macOS it also refuses to start as an orphan. | None known beyond the instant between parent death and EOF delivery. |
| Replays looping or double-counting | Replays carry a private tag (event-source user data on macOS, `dwExtraInfo` on Windows) and are passed through untouched. | Another tool that strips or rewrites event user data could make a replay look new; it would then be treated as a fresh press and replayed again on release, not lost. |
| Capture of unintended content | The freeze happens only after a still hold of 200–1500 ms (500 ms default) while KE Pen is idle. Nothing leaves the machine unless the person drags a region and has configured their own upload endpoint; Escape cancels with nothing copied. The frozen images stay in memory and are discarded when the selector closes. | A deliberate still press longer than the delay before a middle-drag becomes a capture instead; the delay and an off switch are in the tray. |
| Selector misregistration | Frozen overlays are placed at the screen-saver level with exact display bounds (including the menu bar and Dock) and shown only after their frozen frame is painted; the crop comes from the lossless capture held by the main process using the same display-to-pixel mapping as the existing KE Shot overlay. The runtime proof asserts bounds, level and exact crop size. | A display added or removed between the freeze and the selection is not reflected until the next hold. |
| Stale, missing or withdrawn permission (macOS) | Nothing appears at launch: the tray says the helper is waiting, and the one-time explanation waits for a few idle seconds so it cannot catch a keystroke. **Continue** shows macOS's own alert for the helper once per version, the settings pane after that, never both. The helper polls for the approval every two seconds and needs no relaunch; while running it re-checks the approval every three seconds and, if it was withdrawn, removes the tap, gives back any held click and reports that it is waiting again. A tap that cannot be created although approved exits the helper, so KE Pen backs off and offers a restart instead of asking for a permission that is already there. | Ad hoc signed public builds are new code to macOS after every update, so the approval has to be given again; a stale entry may have to be removed with − first. |
| Hook removal and timing (Windows) | The hook procedure is O(1); replays and output run on the message loop and a writer thread. Windows only drops a hook whose thread stopped answering, so a 200 ms heartbeat watches for such stalls: after one the hook is re-installed and a press the helper may have lost is given back rather than reported as a hold (the hold timer checks first). The hook is also re-installed every 30 seconds whatever the state, and a press with no hook call for far longer than its threshold is reset. Replays go out as one `SendInput` batch and only move the pointer when it is farther than the drag slop from where the click belongs, putting it back where it is now. A CI behaviour test drives the real helper with `SendInput`, including a frozen helper whose hook Windows drops. | UIPI blocks replays into elevated (administrator) windows, so a quick middle click over one is lost. Windows may refuse the selector keyboard focus, so Escape may not reach it; any click cancels. Security software may flag an unsigned executable that installs a global mouse hook. |
| Supervisor runaway | Restarts back off from 0.5 to 30 seconds and stop after six failures in two minutes; a helper from another build (version or protocol mismatch) is refused; no ready within five seconds is a failure. `hold-status.json` (owner-only) records state, version and restart count only. | Repeated manual restarts from the tray are allowed by design. |

## Explicit non-goals

- Observing the keyboard, other mouse buttons, scrolling or pointer position
  outside a pending middle press.
- Posting any input other than the person's own held-back middle click (and,
  on Windows, the pointer moves needed to give it back at the right spot).
- Any agent-controlled or remote input path. Agents still have no real-desktop
  input in KE Pen.
- Linux support (Wayland forbids global interception; X11 uses the middle click
  for primary-selection paste).

## Release checks

`npm run test:native` (state machine, protocol, property test) on all three
operating systems; `npm run check`; `npm run verify:hold:proof` (isolated real
Electron runtime with a fake helper: freeze before any overlay is created,
each overlay shown only after its own frozen frame is painted, frames at each
display's native size, exact crop to an in-memory clipboard, Escape and a right
click copy nothing); `npm run verify:hold:mac` (synthetic CGEvents through the
real helper: click replay after release, hold at threshold with nothing
leaking, drag pass-through, disarm replay, an `NSMenu` staying open through a
hold while a disarmed control click closes it, a frozen helper whose tap macOS
disables keeping a held press and giving back a released one, the helper being
its own responsible process, stdin-EOF replay, SIGKILL recovery);
`npm run verify:hold:win` (the same through `SendInput` into a test window on
Windows CI, including a frozen helper whose hook Windows drops);
`npm run verify:package` (helper present, universal and signed with its own
identifier on macOS, reports this version and protocol 1, starts and quits
cleanly; the whole bundle sealed by the same signer; Electron fuses as listed
above in every slice); and `npm run verify:public` (no private paths in native
sources or helper binaries, five-command stdin contract).
