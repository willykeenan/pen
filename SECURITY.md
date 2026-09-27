# Security model

KE Pen intentionally has a narrow boundary:

- the desktop app requests the operating system's screen-capture access and, on
  macOS, Accessibility for the optional hold-to-capture helper;
- the renderer is sandboxed, context-isolated, and loads packaged local content;
- the macOS KE Shot link card is sandboxed and never receives the private URL;
  its fixed local route asks the main process to open the validated URL;
- navigation and new renderer windows are denied;
- captures and annotation records remain local, user-owned files;
- the MCP server uses stdio only and opens no listening network port;
- Agent Display commands cross a local IPC socket or named pipe, never TCP; its
  random broker secret and auth file are owner-only, and the Unix socket itself
  is mode `0600` at a short hashed temporary path;
- tool inputs, annotation IDs, normalized strokes, PNG signatures, checksums,
  and paths are validated;
- image reads are confined to KE Pen's data directory and capped at 16 MB;
- `pen_complete` can change only the current annotation's lifecycle state.

## No KE Studios access

The public source and installers contain no KE Studios credential, private API
endpoint, internal filesystem path, agent-room client, admin hook, or fallback
upload destination. The visible `kestudios.dev` and GitHub links are ordinary
public documentation links; they do not authenticate the app or grant access
to any KE Studios account, service, machine, agent, repository, or message
channel. KE Shot networking remains disabled until the user supplies both an
HTTPS endpoint they own and its token. Agent visual references produce a local
capability envelope but deliberately contain no message transport.

Agent visual references use a separate owner-only local store and a 256-bit
installation secret. Each reference is bound to one sender, one different
recipient, one image checksum, one random generation, one expiry, and a
caller-supplied idempotency key whose raw value is never stored. The routed
capability is derived with HMAC-SHA-256 and only its digest is persisted.
Reads require both the capability and an exact current runtime-identity match.
Wrong recipients and wrong capabilities receive the same bounded denial.

Only explicit PNG data URLs or existing inked Pen annotations are accepted.
PNG signatures, dimensions, byte limits, optional region bounds, checksums,
record schemas, UUIDs, and store paths are validated. The feature has no
capture primitive, file-path input, clipboard API, popup, UI, network client,
public upload, list/history tool, or direct message transport. Creating a
reference returns `sent: false`; a separate existing governed agent-message
action is required to route the one-recipient envelope. Retries deduplicate;
conflicting reuse of an idempotency key fails closed; expiry deletes the bytes
and rotates the capability generation so an old envelope cannot revive them.

Agent visual references do not automatically consume or forward Agent Display
snapshots, owner tokens, renderer state, or human Pen/KE Shot flows. The full
abuse analysis and residual risks are recorded in
[`docs/AGENT_VISUAL_REFERENCES_THREAT_MODEL.md`](./docs/AGENT_VISUAL_REFERENCES_THREAT_MODEL.md).

## Agent Display boundary

Agent Displays are app-hosted offscreen Electron surfaces, not operating-system
monitors. Every surface has an independent non-persistent browser partition and
visible synthetic cursor. Input uses Electron's per-renderer input API and is
never emitted as a macOS `CGEvent`, Accessibility action, or native pointer
move. The hardware cursor remains exclusively available to the person.

Each claim is bound to one exact agent/task identity and receives a 256-bit
capability returned once. Only its SHA-256 digest is retained. One controller
exists per surface: agent, human, or none. Taking human control immediately
rejects agent actions; Stop revokes both controllers, destroys the renderer,
and clears partition storage. Ready sessions expire after 30 minutes without
authenticated activity. App restart and renderer failure mark sessions
interrupted and require exact-identity recovery with a rotated capability.
The broker caps live offscreen renderers at 32 and refuses further claims until
one is stopped.

Packaged fixtures and one locked loopback HTTP/HTTPS origin are the only
navigation targets. The request gate also covers scripts, images, fetches,
WebSockets, and other subresources, so localhost content cannot use the surface
to contact a public or second local origin. Popups, downloads, cross-origin
redirects, embedded URL credentials, and all browser permission requests are
denied. Snapshots are capped at 16 MB.

The macOS permission display reports the real current TCC state but does not
request it. Isolated displays need neither Screen Recording nor Accessibility.
Normal KE Pen screen marking still needs Screen Recording because it captures
the visible display. Agents still have no real-desktop input: the only native
input KE Pen ever posts is the person's own held-back middle click, given back
unchanged (see the hold-to-capture boundary below).

The complete abuse analysis and residual risks are recorded in
[`docs/AGENT_DISPLAYS_THREAT_MODEL.md`](./docs/AGENT_DISPLAYS_THREAT_MODEL.md).

## Hold-to-capture boundary

`ke-pen-hold-helper` is the only native component that touches real input, and
it is deliberately narrow:

- the operating system hands it every event its hook or tap covers, and it acts
  only on the middle mouse button: on macOS an active session event tap for
  "other" mouse buttons (down, up and drag) that returns every button except
  the middle one untouched, first thing; on Windows a low-level mouse hook,
  which Windows calls for every mouse message (buttons, wheel and moves), that
  passes everything on except middle-button messages and looks at moves only
  while a middle press is pending. Nothing it sees is stored;
- it starts **disarmed** and is armed only by KE Pen's main process, and only
  while KE Pen is idle and could open the selector;
- its stdin accepts exactly five commands—`config`, `arm`, `disarm`,
  `prompt`, `quit`—none of which can carry a position, a button, or an event,
  so no process can use it to post input of its choosing; the only events it
  posts are copies of the person's own swallowed middle-button events, and
  `prompt` only asks macOS to show its own Accessibility alert for the helper;
- its own replays are tagged and passed through, so they cannot loop;
- it exits when stdin closes, when KE Pen exits, on `quit`, and on SIGTERM, and
  gives back any click it is still holding when it stops;
- on macOS the **Accessibility approval belongs to the helper, not to KE
  Pen**: the helper re-executes itself as its own "responsible process"
  (macOS's disclaim spawn attribute), so macOS checks and lists
  `ke-pen-hold-helper` itself. KE Pen never asks for Accessibility. KE Pen is an
  Electron app whose `RunAsNode` fuse must stay on for the embedded MCP server,
  so anything that can start KE Pen's executable could run code as KE Pen; with
  the approval on the helper, that code gets nothing more than KE Pen's Screen
  Recording approval (unchanged from 0.5), never the ability to post input;
- packaged builds turn off the other ways to run code as KE Pen (the
  `NODE_OPTIONS` and `--inspect` fuses, and loading the app from anywhere but
  its asar), and ignore the development-only `--hold-proof` switch and its
  helper override entirely;
- the helper is signed with its own identifier (`dev.kestudios.pen.hold-helper`)
  and the hardened runtime, then the whole bundle is signed and sealed, both by
  the same signer. The published macOS download is signed with K&E Studios'
  self-signed certificate (`KE Studios Local Code Signing`; not an Apple
  Developer ID), so macOS keeps the helper's approval across updates signed
  with it. Builds from source, and CI builds, are signed **ad hoc** unless
  `KE_PEN_MAC_SIGN_IDENTITY` names a certificate, and macOS treats each such
  build's helper as new code that needs approving again.

The full analysis and residual risks are in
[`docs/MIDDLE_HOLD_CAPTURE_THREAT_MODEL.md`](./docs/MIDDLE_HOLD_CAPTURE_THREAT_MODEL.md).

The AI host and model provider are separate trust boundaries. Review their
tool-call UI, network behavior, and privacy policy before sharing sensitive
screen content.

The macOS and Windows downloads are not commercially code-signed (the macOS
app carries K&E Studios' self-signed certificate), and the macOS build is not
notarized. Verify the published SHA-256 manifest or
build from the public source if this warning is unacceptable.

Report security issues privately to william@kestudios.dev.
