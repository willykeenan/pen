# Security model

KE Pen intentionally has a narrow boundary:

- the desktop app requests only the operating system's screen-capture access;
- the renderer is sandboxed, context-isolated, and loads packaged local content;
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
the visible display. Real-desktop input is not implemented.

The complete abuse analysis and residual risks are recorded in
[`docs/AGENT_DISPLAYS_THREAT_MODEL.md`](./docs/AGENT_DISPLAYS_THREAT_MODEL.md).

The AI host and model provider are separate trust boundaries. Review their
tool-call UI, network behavior, and privacy policy before sharing sensitive
screen content.

The initial macOS and Windows downloads are not commercially code-signed, and
the macOS build is not notarized. Verify the published SHA-256 manifest or
build from the public source if this warning is unacceptable.

Report security issues privately to william@kestudios.dev.
