# Agent Displays threat model

## Security objective

Give multiple local agents independent visible cursors and testing displays
without letting any agent move the native pointer, type into the real desktop,
read unrelated screen content, cross another agent's surface, or silently keep
control after human intervention, app failure, or inactivity.

The implementation boundary is an app-hosted Electron compositor. It is not a
macOS virtual-display driver and does not create a monitor in System Settings.
Each surface hosts packaged fixture content or one loopback web application.

## Trust boundaries

- William controls the native desktop and the Agent Displays switcher.
- Each exact `agentId` + `taskId` owns one session and one 256-bit capability.
- The KE Pen desktop process owns the broker, controller state, renderers, and
  redacted session ledger.
- The MCP host receives a capability and any snapshot it explicitly requests.
- A selected loopback test server is separate local software and may observe
  requests or input sent to its own origin.
- The configured AI/model provider is outside KE Pen's privacy boundary.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Agent seizes the real mouse or keyboard | Input is sent only with Electron `webContents.sendInputEvent`/`insertText` to the assigned offscreen renderer. No Accessibility action, `CGEvent`, native cursor API, or desktop-control primitive exists in this subsystem. | A future maintainer could add a system-input dependency; deterministic source tests fail on known primitives and review remains required. |
| Two agents fight over one surface | One active claim per exact agent/task; every action requires that session's capability; cross-session tokens fail; controller is exactly agent, human, or none. | A compromised same-user process that reads the ephemeral broker secret and capability from its owning AI host can act as that owner until Stop or expiry. |
| Agent acts while William is inspecting | `Take control` atomically changes the controller to human; agent calls fail with `HUMAN_HAS_CONTROL`; `Return to agent` is explicit. | Already queued input inside Electron before the handoff cannot be withdrawn, so the switcher exposes the last safe action and controller state. |
| Hidden persistence after Stop or crash | Stop revokes control, destroys the renderer, and clears its memory partition. Restart converts ready sessions to interrupted and rotates the capability on exact-identity recovery. Idle sessions expire after 30 minutes; stopped/expired records are removed after 24 hours. | Process termination can prevent best-effort storage clearing, but the partition is non-persistent and is not restored. |
| Public-network exfiltration | Only packaged fixture files, `data:` resources, and the first locked loopback origin are accepted. Top-level navigation, redirects, subresources, fetches, and WebSockets are origin-gated. Permissions, downloads, and popups are denied. | A loopback application is trusted for its own content and can retain input it receives; use a disposable local test server. DNS rebinding is avoided by allowing literal loopback/localhost targets only, but a hostile local process can still bind the selected port. |
| Secret leakage through disk or status | Raw session capabilities are returned once and never persisted; only a SHA-256 digest is stored. Typed text, page content, screenshots, and URL path/query/fragment are excluded from the ledger and status. Files/socket are owner-only. | Same-user malware and the configured MCP/model host are outside the protection boundary. Agent/task labels and the locked origin are visible to the local user. |
| Renderer escape or privilege request | Renderer sandboxing, context isolation, no Node integration, web security, permission denial, download denial, popup denial, and separate partitions are enabled. | Electron/Chromium vulnerabilities remain; keep the runtime current and do not use these surfaces for hostile untrusted code. |
| Misleading TCC claims | The switcher reports macOS Screen Recording and Accessibility truth without prompting. It states both are unnecessary for isolated displays and that real-desktop control is not implemented. | Normal KE Pen annotation capture separately needs Screen Recording. Permission status alone does not prove user acceptance. |
| Snapshot overcollection | Snapshot requires the session capability, captures only that offscreen surface, is capped at 16 MB, and is returned in memory without Agent Display history. | The AI host/provider may retain the returned image under its own terms. |
| Local broker exposure | Unix socket/named pipe and auth file are local; Unix artifacts are `0600`, the state directory is `0700`, the socket uses a short hashed temporary path to respect macOS path limits, every request carries a random broker secret, and request/response sizes and time are bounded. No TCP listener is created. | Windows named-pipe ACL behavior depends on Electron/Node and the logged-in user context; packaging review should verify ACLs on Windows before a public claim of parity. |
| Renderer resource exhaustion | New claims fail closed after 32 simultaneous ready surfaces; inactivity expiry and Stop release surfaces. | Thirty-two maximum-size Chromium surfaces can still use substantial memory; operators should Stop finished displays and lower the ceiling in a future host-policy layer if measured pressure requires it. |

## Explicit non-goals

- Multiple physical or hardware cursors.
- A macOS display device visible to arbitrary native applications.
- Remote desktop control, Accessibility automation, or Screen Recording bypass.
- Public-web browsing, file URLs, downloads, clipboard mutation, uploads, or
  invisible agent-to-agent screenshot delivery.
- Authority to send, deploy, purchase, or take any action outside the selected
  local test surface.

## Release checks

Before integration, run the complete typecheck/test/build suite, inspect a real
960 × 680 switcher render, verify exact content dimensions and no horizontal
overflow, inspect keyboard-focus/accessibility facts, review stored state for
redaction, and verify the pushed candidate commit matches the remote branch.
Packaging, installation, TCC changes, and live Activity Monitor integration are
separate authority and acceptance gates.

Proof mode keeps its switcher hidden, uses the accessory activation policy on
macOS, and captures the real Electron render without taking foreground focus.
