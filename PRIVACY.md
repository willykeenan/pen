# Privacy

KE Pen has no account, cloud backend, analytics, ads, or telemetry.

## What changed in 0.4.0

Through 0.3.0, KE Pen made **no outbound network requests of any kind**. That is
no longer unconditionally true, and it would be dishonest to leave the old
sentence standing.

Version 0.4.0 adds **KE Shot**, a capture-and-share mode. When KE Shot uploads a
capture it makes a real HTTPS request carrying your screen content off the
machine. That request is bounded as follows:

- It goes only to the `shotEndpoint` you wrote into your own settings file.
  There is no built-in service, no default account, and no fallback host. A
  fresh install ships `shotEndpoint` empty, and deleting the key from the file
  disables uploading exactly the way deleting the token does.
- The endpoint must be `https`. A plain `http` address is refused, so the
  token and your screen content are never put on the wire in cleartext. The one
  exception is `localhost` / `127.0.0.1`, which does not leave the machine.
- It happens only when you take a shot, never on launch, on a timer, or in the
  background.
- It does not happen at all when `shotEndpoint` or `shotToken` is empty, which
  is the shipped default. Out of the box KE Shot copies to the clipboard and
  saves a local PNG and makes no network calls.
- Redirects are refused, so the request cannot be bounced to a host you did not
  configure.
- Nothing else is sent: no identifiers, no usage counts, no error reports, no
  window titles, no file names.

One other outbound request exists, and only when you ask for it: **Recent shots
▸ Delete from endpoint…** sends a `DELETE` to that same endpoint, with the same
token and no image data, after asking you to confirm.

Uploading is publishing. Once a capture reaches your endpoint, deleting it there
does not recall copies already fetched by a chat app, an unfurl service, or a
CDN. Do not capture anything you would not hand over permanently.

## What is stored locally

When you activate the pen, the desktop app captures the visible display locally
so it can crop the area you mark. The crop and a small JSON record are stored in
your user data directory:

- macOS: `~/Library/Application Support/KE Pen/`
- Windows: `%APPDATA%\KE Pen\`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ke-pen/`

Set `KE_PEN_HOME` to use another local directory. The MCP server reads those
files and returns the selected image to the AI host you configured.

KE Shot keeps its own two files in the app's user-data directory:
`settings.json` (your endpoint, token, and preferences) and `shots.json` (the
last 25 shot links so the tray menu can offer them). Both are written with
owner-only `0600` permissions. The token exists only in `settings.json`; it is
never committed to the repository, embedded in the built app, or logged.

KE Shot also writes a PNG of each capture to `localCopyDir`
(`Pictures/KE Shot` by default) while **Save a local copy** is enabled, and
always writes one when an upload fails so a capture is never lost.

## Your AI host

KE Pen itself does not upload the marked crop. Your AI host may send MCP tool
results to its configured model provider, so that provider's privacy and
retention terms still apply. Do not circle secrets you would not send to that
provider.

Use **Clear local Pen history** from the tray menu to delete retained
annotations. That command does not touch KE Shot's local PNGs, its settings, or
anything already uploaded — delete those yourself.
