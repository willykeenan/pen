# Agent visual references threat model

## Security objective

Allow one agent to point one explicitly chosen agent at one bounded screenshot
or inked Pen region plus a short direction, without changing William's human KE
Pen flow or creating capture, message-send, desktop-control, clipboard, public
upload, history-listing, or broader action authority.

## Trust boundaries

- The sender and recipient run as the same operating-system user and can reach
  the same KE Pen data directory.
- Each MCP runtime supplies a stable `KE_PEN_AGENT_ID` or `CODEX_THREAD_ID`.
- KE Pen validates local records, image bounds, recipient identity, expiry, and
  a per-reference capability.
- The existing governed agent-message channel chooses and delivers to the
  recipient. KE Pen does not implement, bypass, or authorize that send.
- The MCP/model hosts may retain any image they receive. Same-user malware is
  outside this protocol's protection boundary.

## Assets intentionally protected

- The image and bounded direction before their short expiry.
- Separation between recipient tasks.
- Human Pen annotation lifecycle and KE Shot behavior.
- Agent Display owner tokens, snapshots, state, and controller boundaries.
- The absence of a browseable visual-reference or capture history.

## Abuse cases and controls

| Abuse case | Control | Residual risk |
|---|---|---|
| Accidental send to or read by the wrong agent | Create accepts one scalar recipient identity; read derives the current runtime identity and requires an exact match plus the routed capability. There is no broadcast input. | A compromised same-user process can impersonate an identity or read the local secret. |
| Duplicate delivery on retry | Sender supplies an idempotency key. The same live sender/recipient/key/image/direction returns the same reference and capability; conflicting reuse fails closed. | The external message channel owns its own delivery retry behavior; KE Pen can deduplicate reference creation, not a malicious second send. |
| Capability copied after expiry | References default to 15 minutes and max at 60. Expired bytes are removed. Re-creating the same deterministic ID uses a fresh random generation, so the old capability remains invalid. | A recipient or model host may retain an image it already read. |
| Capability or source metadata leaks at rest | Only the capability digest and idempotency hash are stored. The raw capability, raw idempotency key, source annotation ID, source app, desktop path, and message content are excluded. POSIX modes are `0700`/`0600`; Windows inherits the current user's application-data ACL. | Sender/recipient identities, direction, dimensions, hashes, and timestamps remain visible to the local OS user until pruning. |
| Broad screen or file collection | Create accepts only explicit PNG bytes or one validated inked annotation already inside KE Pen's confined store. There is no screenshot call, arbitrary file path, directory enumeration, or screen-capture API. | The caller controls the PNG pixels and must avoid secrets it would not send to the recipient/model provider. |
| Hidden public upload or implicit send | The implementation imports no network or message client and returns `sent: false`. The sender must separately invoke the existing governed message channel with the envelope. | That channel and its provider remain separate trust boundaries. |
| Human workflow interference | Reference creation from an annotation uses a read-only context method and does not claim, complete, clear, cancel, popup, focus, launch, or alter clipboard state. No new human UI exists. | The normal human Pen and KE Shot paths retain their documented permissions and risks. |
| Agent Display boundary collapse | No reference code imports Agent Display modules or accepts display session IDs, snapshots, broker secrets, or owner tokens. There is no automatic bridge. | An already-authorized caller could explicitly re-encode visual bytes it possesses; KE Pen does not grant or automate that upstream access. |
| Storage exhaustion | One image, 8 MB max, 8192 pixels per edge, 32 megapixels max, 128 active references, one-hour max expiry, and automatic expired pruning. | A hostile same-user process can still consume disk outside KE Pen. |

## Authority statement

A delivered visual reference conveys visual context and direction only. It does
not authorize editing, sending other messages, purchasing, spending, deploying,
capturing a screen, controlling a desktop, or any other consequential action.
